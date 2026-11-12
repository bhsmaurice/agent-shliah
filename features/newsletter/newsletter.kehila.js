'use strict';
const { createHash } = require('node:crypto');
const { render, sendAt } = require('./newsletter.render');
const API = 'https://api.unisoft.world/integrations/v2';

function client(key, fetcher = fetch) {
  return async function call(path, { method = 'GET', body } = {}) {
    if (!key) throw new Error('KEHILA_API_KEY absente : connexion Kehila à configurer');
    const multipart = body instanceof FormData;
    const response = await fetcher(API + path, { method, headers: { Authorization: 'Bearer ' + key, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (multipart ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const e = new Error('Kehila HTTP ' + response.status + ' ' + String(payload.error || '').slice(0, 100));
      e.uncertain = method !== 'GET' && response.status >= 500;
      throw e;
    }
    return payload.commandId ? { ...payload.data, commandId: payload.commandId } : payload.data;
  };
}

function audience(source) {
  if (!source || source.type !== 'EMAIL' || source.crmTarget) throw new Error('Audience Kehila à vérifier : format non pris en charge');
  const modes = [source.allContact === true, source.staredOnly === true, Array.isArray(source.categories) && source.categories.length > 0];
  if (modes.filter(Boolean).length !== 1 || !source.emailConfig) throw new Error('Audience ou expéditeur Kehila ambigu');
  const target = source.allContact ? { allContact: true } : source.staredOnly ? { staredOnly: true } : { categories: [...source.categories].sort() };
  const config = { ...target, emailConfig: source.emailConfig };
  return { config, hash: createHash('sha256').update(JSON.stringify(config)).digest('hex'), label: source.allContact ? 'Tous les contacts email autorisés par Kehila' : source.staredOnly ? 'Contacts locaux/épinglés' : 'Catégories : ' + config.categories.join(', ') };
}

async function inspect(key, sourceId, fetcher) {
  if (!/^[a-f0-9-]{36}$/i.test(sourceId || '')) throw new Error('Campagne de référence Kehila manquante');
  return audience(await client(key, fetcher)('/campaigns/' + sourceId));
}

async function schedule({ edition, photos, baseUrl, key, save, fetcher, now = new Date() }) {
  const scheduled = sendAt(edition.week);
  if (scheduled <= now) throw new Error('Heure d’envoi dépassée : aucune programmation automatique');
  const api = client(key, fetcher);
  const checked = await inspect(key, edition.source_campaign, fetcher);
  if (checked.hash !== edition.audience_hash) throw new Error('Audience/expéditeur modifiés depuis l’aperçu : nouvelle validation requise');
  const hosted = { ...(edition.hosted || {}) };
  for (const post of edition.document.posts) for (const id of post.photoIds) {
    if (hosted[id]) continue;
    const photo = photos[id];
    if (!photo) throw new Error('Photo absente : ' + id);
    const body = new FormData();
    body.append('file', new Blob([photo.data], { type: photo.mime }), `newsletter-${id}.${photo.mime === 'image/png' ? 'png' : 'jpg'}`);
    const upload = await api('/uploads', { method: 'POST', body });
    if (!upload || !/^https:\/\//.test(upload.url || '')) throw new Error('Téléversement photo non confirmé');
    hosted[id] = upload.url;
    await save({ hosted });
  }
  const html = render(edition.document, photos, baseUrl, { hosted });
  let templateId = edition.template_id;
  if (!templateId) {
    // Mark intent before a non-idempotent creation; never repeat an uncertain call.
    await save({ external_step: 'creating_template' });
    let template;
    try { template = await api('/email-templates', { method: 'POST', body: { name: `Newsletter ${edition.week} – v${edition.revision}`, editorType: 'AI', html } }); }
    catch (e) { e.uncertain = true; throw e; }
    templateId = template && template.id;
    if (!templateId) { const e = new Error('Création modèle non confirmée'); e.uncertain = true; throw e; }
    await save({ template_id: templateId, external_step: 'template_created' });
  }
  let campaignId = edition.campaign_id;
  if (!campaignId) {
    await save({ external_step: 'creating_campaign' });
    let campaign;
    try { campaign = await api('/campaigns', { method: 'POST', body: { type: 'EMAIL', subject: edition.document.copy.subject, emailTemplate: templateId, ...checked.config, scheduledAt: scheduled.toISOString() } }); }
    catch (e) { e.uncertain = true; throw e; }
    campaignId = campaign && campaign.id;
    if (!campaignId) { const e = new Error('Création campagne non confirmée'); e.uncertain = true; throw e; }
    await save({ campaign_id: campaignId, external_step: 'campaign_created' });
  }
  const campaign = await api('/campaigns/' + campaignId);
  if (campaign.state !== 'INIT' || campaign.emailTemplate !== templateId || campaign.subject !== edition.document.copy.subject || new Date(campaign.scheduledAt).getTime() !== scheduled.getTime() || audience(campaign).hash !== checked.hash) throw new Error('Campagne Kehila différente de la version approuvée');
  // Verify rendered content as well, not just the template reference.
  const template = await api('/email-templates/' + templateId);
  if (template.html !== html) throw new Error('Contenu Kehila modifié : validation nécessaire');
  const targets = await api('/campaigns/' + campaignId + '/targets');
  // API target shape is provider-owned: require a positive documented count.
  const targetCount = targets && targets.total;
  if (!Number.isInteger(targetCount) || targetCount < 1) throw new Error('Nombre de destinataires non confirmé');
  await save({ external_step: 'dispatching', status: 'dispatching' });
  let sent;
  try { sent = await api('/campaigns/' + campaignId + '/send', { method: 'POST' }); }
  catch (e) { e.uncertain = true; throw e; }
  const proof = await api('/campaigns/' + campaignId);
  if (!sent || !sent.commandId || !['VALIDATE', 'FINISHED'].includes(proof.state) || new Date(proof.scheduledAt).getTime() !== scheduled.getTime()) {
    const e = new Error('Mise en file non confirmée : vérifier Kehila sans renvoyer'); e.uncertain = true; throw e;
  }
  await save({ status: 'scheduled', external_step: 'queued', scheduled_at: scheduled.toISOString(), command_id: sent.commandId });
  return { campaignId, scheduledAt: scheduled.toISOString(), targetCount };
}

module.exports = { client, audience, inspect, schedule };
