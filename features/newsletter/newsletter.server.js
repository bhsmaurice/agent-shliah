'use strict';
const { randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const { paris, sendAt, fetchShabbat, collect, compose, render, escape } = require('./newsletter.render');
const kehila = require('./newsletter.kehila');
const { createWhatsApp } = require('./newsletter.whatsapp');
const START = '2026-11-19';
const SOURCE_CAMPAIGN = '99bf6828-f735-4109-aab5-b198457e77b9'; // Last observed newsletter; read only.
const PREVIEW_TO = 'bhsmaurice@gmail.com';

function upcomingWeek(now = new Date()) {
  const local = paris(now);
  const d = new Date(local.date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (4 - d.getUTCDay() + 7) % 7);
  const next = d.toISOString().slice(0, 10);
  return next < START ? START : next;
}
function buttonId(action, row) { return `nl_${action}_${row.id}_${row.revision}`; }
function parseButton(id) {
  const match = /^nl_(approve|edit)_([0-9a-f-]{36})_([1-9][0-9]*)$/.exec(id || '');
  return match ? { action: match[1], id: match[2], revision: Number(match[3]) } : null;
}
function canApprove(row, revision, now = new Date()) {
  return row && row.status === 'preview' && row.revision === revision && row.preview_sent_at && row.audience_hash && row.document && row.document.copy.missing.length === 0 && sendAt(row.week) > now;
}

function init({ app, pool, envoyerEmail, isAdmin, adminPhone, adminPassword, publicBaseUrl, anthropicKey, whatsappToken, phoneNumberId, getShabbat }) {
  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_editions (
      id UUID PRIMARY KEY, week TEXT UNIQUE NOT NULL, revision INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', document JSONB, notes TEXT NOT NULL DEFAULT '',
      preview_sent_at TIMESTAMPTZ, preview_message_id TEXT, editing_phone TEXT,
      approved_revision INT, approved_at TIMESTAMPTZ, approved_by TEXT,
      source_campaign TEXT, audience_hash TEXT, audience_label TEXT,
      hosted JSONB NOT NULL DEFAULT '{}', template_id TEXT, campaign_id TEXT,
      external_step TEXT, command_id TEXT, scheduled_at TIMESTAMPTZ,
      last_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_jobs (
      week TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      last_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (week, slot))`);
  })();
  ready.catch(() => console.error('Newsletter : initialisation impossible'));

  async function locked(work) {
    await ready;
    const db = await pool.connect();
    try {
      const r = await db.query('SELECT pg_try_advisory_lock(770, 191126) AS locked');
      if (!r.rows[0].locked) throw new Error('Newsletter déjà en cours de préparation, réessaie dans quelques instants.');
      try { return await work(); } finally { await db.query('SELECT pg_advisory_unlock(770, 191126)'); }
    } finally { db.release(); }
  }
  async function update(id, fields) {
    const allowed = ['revision','status','document','notes','preview_sent_at','preview_message_id','editing_phone','approved_revision','approved_at','approved_by','source_campaign','audience_hash','audience_label','hosted','template_id','campaign_id','external_step','command_id','scheduled_at','last_error'];
    const entries = Object.entries(fields);
    if (entries.some(([k]) => !allowed.includes(k))) throw new Error('Champ newsletter invalide');
    const values = entries.map(([k, v]) => ['document','hosted'].includes(k) && v !== null ? JSON.stringify(v) : v);
    return (await pool.query(`UPDATE newsletter_editions SET ${entries.map(([k], i) => `${k}=$${i + 2}`).join(',')}, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, ...values])).rows[0];
  }
  async function edition(week = upcomingWeek()) {
    await pool.query('INSERT INTO newsletter_editions (id,week) VALUES ($1,$2) ON CONFLICT (week) DO NOTHING', [randomUUID(), week]);
    return (await pool.query('SELECT * FROM newsletter_editions WHERE week=$1', [week])).rows[0];
  }
  const whatsapp = createWhatsApp({ token: whatsappToken, phoneNumberId, adminPhone });
  const wa = whatsapp.send;
  async function notify(body, buttons) {
    try { return await wa(body, buttons); }
    catch (e) {
      // Pending/rejected templates and immediate delivery failures fall back to email.
      await envoyerEmail({ to: PREVIEW_TO, subject: 'Shliah Bot — notification WhatsApp à consulter', html: `<p>${escape(body).replace(/\n/g,'<br>')}</p><p>${escape(e.message)}</p>`, idempotencyKey: 'nl-wa-fallback-' + createHash('sha256').update(body).digest('hex') });
      console.error('Newsletter : notification WhatsApp non confirmée');
      return null;
    }
  }
  async function photosFor(doc) {
    const ids = [...new Set(doc.posts.flatMap(p => p.photoIds))];
    const rows = ids.length ? (await pool.query('SELECT id,data,mime_type FROM medias WHERE id=ANY($1::int[])', [ids])).rows : [];
    const sharp = require('sharp');
    const photos = {};
    for (const row of rows) { const size = await sharp(row.data).metadata(); photos[String(row.id)] = { data: row.data, mime: row.mime_type, width: size.width, height: size.height }; }
    if (ids.some(id => !photos[id])) throw new Error('Photo manquante');
    return photos;
  }

  async function prepare(week = upcomingWeek()) {
    let row = await edition(week);
    if (['approved','programming','dispatching','scheduled','uncertain'].includes(row.status)) throw new Error('Cette version est déjà validée ou en programmation ; aucune modification automatique.');
    const { posts, photos } = await collect(pool);
    const infos = (await pool.query('SELECT titre,contenu,categorie,created_at FROM infos ORDER BY created_at DESC LIMIT 80')).rows;
    let shabbat;
    try { shabbat = await fetchShabbat(week, pool); }
    catch (_) { shabbat = null; }
    const copy = await compose({ posts, photos, infos, shabbat, week, notes: row.notes, anthropicKey });
    let target;
    try { target = await kehila.inspect(process.env.KEHILA_API_KEY, process.env.KEHILA_NEWSLETTER_SOURCE_CAMPAIGN_ID || SOURCE_CAMPAIGN); }
    catch (_) { copy.missing.push('Connexion Kehila ou audience habituelle à configurer avant programmation.'); }
    if (!posts.length && !copy.notices.length) copy.missing.push('Aucun post récent ni annonce vérifiée : compléter le contenu.');
    const document = { week, posts, shabbat, copy };
    row = await update(row.id, { revision: row.revision + 1, status: 'draft', document, preview_sent_at: null, preview_message_id: null, editing_phone: null,
      audience_hash: target?.hash || null, audience_label: target?.label || null, source_campaign: process.env.KEHILA_NEWSLETTER_SOURCE_CAMPAIGN_ID || SOURCE_CAMPAIGN, last_error: null });
    return sendPreview(row, photos);
  }
  async function sendPreview(row, photos) {
    if (!photos) photos = await photosFor(row.document);
    const banner = `<p style="font-family:Arial;background:#fff2d8;padding:14px"><b>APERÇU PRIVÉ — ${escape(row.week)} — version ${row.revision}</b><br>Envoi proposé : jeudi à 21h30 (Paris).<br>Audience : ${escape(row.audience_label || 'À configurer')}<br>Valide uniquement cette version depuis ton Shliah Bot. Aucune newsletter n’a été envoyée aux abonnés.</p>`;
    const html = render(row.document, photos, publicBaseUrl, { preview: true }).replace('<body ', '<body ').replace(/(<body[^>]*>)/, '$1' + banner);
    const sent = await envoyerEmail({ to: PREVIEW_TO, subject: `[APERÇU v${row.revision}] ${row.document.copy.subject}`, html, idempotencyKey: `newsletter-${row.id}-v${row.revision}` });
    if (!sent.ok || !sent.id) throw new Error('Email d’aperçu non accepté par le service d’envoi');
    row = await update(row.id, { status: 'preview', preview_sent_at: new Date(), preview_message_id: sent.id });
    const missing = row.document.copy.missing;
    const buttons = [...(!missing.length && row.audience_hash ? [{ id: buttonId('approve', row), title: '✅ Valider' }] : []), { id: buttonId('edit', row), title: '✏️ Modifier' }];
    await notify(`📧 L’aperçu de ta newsletter du ${row.week}, version ${row.revision}, a été confié au service d’envoi pour ${PREVIEW_TO}.\nVérifie l’email avant de valider.\n${missing.length ? 'À compléter : ' + missing.join(' ; ').slice(0, 400) : 'Après validation : Kehila, jeudi à 21h30.'}`, buttons);
    return row;
  }

  async function program(row) {
    if (row.approved_revision !== row.revision || !row.approved_at || row.status !== 'approved') throw new Error('Version non approuvée');
    if (!process.env.KEHILA_API_KEY) throw new Error('Connexion Kehila manquante');
    row = await update(row.id, { status: 'programming' });
    try {
      const result = await kehila.schedule({ edition: row, photos: await photosFor(row.document), baseUrl: publicBaseUrl, key: process.env.KEHILA_API_KEY, save: async fields => { row = await update(row.id, fields); } });
      await notify(`✅ Newsletter v${row.revision} programmée dans Kehila pour jeudi ${row.week} à 21h30 (Paris).\n${result.targetCount} destinataires prévus.\nhttps://app.unisoft.world/app/messages/detail?id=${result.campaignId}`);
      return result;
    } catch (e) {
      // A non-idempotent operation may already have happened. Never auto-retry it.
      const uncertain = e.uncertain || ['creating_template','creating_campaign','dispatching'].includes(row.external_step);
      await update(row.id, { status: uncertain ? 'uncertain' : 'approved', last_error: e.message });
      await notify(`⚠️ Newsletter v${row.revision} : ${uncertain ? 'résultat de programmation incertain ; ne pas relancer avant vérification dans Kehila.' : 'non programmée : ' + e.message}\nAucun nouvel essai automatique.`);
      throw e;
    }
  }
  async function approve(row, revision, from) {
    if (!canApprove(row, revision)) { await notify('Ce bouton ne permet pas de valider : version ancienne, informations manquantes, déjà validée ou heure dépassée. Écris « newsletter » pour voir le statut.'); return; }
    row = await update(row.id, { status: 'approved', approved_revision: revision, approved_at: new Date(), approved_by: from });
    await program(row);
  }
  async function handleButton(from, id) {
    const action = parseButton(id);
    if (!action) return false;
    if (!isAdmin(from) || String(from).replace(/\D/g,'') !== String(adminPhone).replace(/\D/g,'')) return true;
    whatsapp.markInteraction();
    try { await locked(async () => {
      const row = (await pool.query('SELECT * FROM newsletter_editions WHERE id=$1', [action.id])).rows[0];
      if (!row || row.revision !== action.revision || row.week < START) { await notify('Cet aperçu est ancien. Écris « newsletter » pour voir le statut.'); return; }
      if (action.action === 'approve') await approve(row, action.revision, from);
      else if (['draft','preview'].includes(row.status)) { await update(row.id, { editing_phone: from }); await notify('Écris tes corrections dans ton prochain message. Je préparerai une nouvelle version à valider.'); }
      else await notify('La newsletter est déjà validée ou en programmation. Aucune modification automatique.');
    }); } catch (e) { console.error('Newsletter bouton :', e.message); }
    return true;
  }
  async function handleText(from, text) {
    if (!isAdmin(from) || String(from).replace(/\D/g,'') !== String(adminPhone).replace(/\D/g,'')) return false;
    whatsapp.markInteraction();
    await ready;
    const pending = (await pool.query("SELECT * FROM newsletter_editions WHERE editing_phone=$1 AND status IN ('draft','preview') AND updated_at > NOW() - INTERVAL '30 minutes' ORDER BY week DESC LIMIT 1", [from])).rows[0];
    if (!pending && !/^newsletter(?:\s|$)/i.test(text.trim())) return false;
    try { await locked(async () => {
      const command = text.trim().replace(/^newsletter\s*/i, '').trim();
      if (/^test$/i.test(command)) { await testDelivery(); return; }
      let row = pending ? (await pool.query('SELECT * FROM newsletter_editions WHERE id=$1', [pending.id])).rows[0] : await edition();
      if (pending && !['draft','preview'].includes(row.status)) throw new Error('Cette édition a déjà été validée.');
      if (pending && !/^annuler$/i.test(command)) {
        await update(row.id, { notes: row.notes + '\n' + text, editing_phone: null });
        await notify('Je prépare le nouvel aperçu avec tes corrections.'); await prepare(row.week); return;
      }
      if (pending && /^annuler$/i.test(command)) { await update(row.id, { editing_phone: null }); await notify('Modification annulée.'); return; }
      if (/^(aper[cç]u|preparer|préparer)$/i.test(command)) { await notify('Je prépare ton aperçu.'); await prepare(row.week); return; }
      if (/^modifier$/i.test(command)) { if (!['draft','preview'].includes(row.status)) throw new Error('Newsletter déjà validée : modification bloquée'); await update(row.id, { editing_phone: from }); await notify('Écris tes corrections dans ton prochain message.'); return; }
      if (/^ajouter\s+/i.test(command)) { if (!['draft','preview'].includes(row.status)) throw new Error('Newsletter déjà validée : modification bloquée'); await update(row.id, { notes: row.notes + '\n' + command.replace(/^ajouter\s+/i, ''), status: 'draft', preview_sent_at: null }); await notify('Information ajoutée. Le prochain aperçu devra être validé.'); return; }
      if (/^valider$/i.test(command)) { await notify('Pour valider une version précise, utilise le bouton de son dernier email. Écris « newsletter renvoyer » pour retrouver ses boutons.'); return; }
      if ((!command || /^renvoyer$/i.test(command)) && row.status === 'preview') { const missing = row.document.copy.missing; await notify(`Newsletter ${row.week} v${row.revision} — aperçu envoyé à ${PREVIEW_TO}.\nAudience : ${row.audience_label || 'à configurer'}.\n${missing.length ? 'À compléter : ' + missing.join('; ').slice(0,400) : 'Valider programme cette version pour jeudi à 21h30.'}`, [...(!missing.length && row.audience_hash ? [{ id: buttonId('approve',row), title: '✅ Valider' }] : []), { id: buttonId('edit',row), title: '✏️ Modifier' }]); return; }
      if (/^programmer$/i.test(command) && row.status === 'approved') { await program(row); return; }
      await notify(`📰 Newsletter du ${row.week} — ${row.status}, version ${row.revision}.\n« newsletter ajouter … » : ajouter une annonce\n« newsletter aperçu » : préparer l’email\n« newsletter modifier » : corriger\n« newsletter renvoyer » : retrouver les boutons\n« newsletter test » : tester email + WhatsApp.`);
    }); } catch (e) { await notify('⚠️ Newsletter : ' + e.message); }
    return true;
  }
  async function testDelivery() {
    const sent = await envoyerEmail({ to: PREVIEW_TO, subject: 'TEST TECHNIQUE — aperçu newsletter Shliah Bot', html: '<p>Test technique de la connexion email du Shliah Bot.</p><p>Aucune newsletter existante n’a été modifiée. Aucun envoi aux abonnés.</p>', idempotencyKey: 'newsletter-technical-' + paris().date });
    if (!sent.ok || !sent.id) throw new Error('Email de test non accepté');
    const messageId = await wa('✅ Test technique : le service d’envoi a accepté l’email de test pour bhsmaurice@gmail.com. Vérifie ta boîte de réception. Aucune newsletter n’a été modifiée.');
    return { emailAccepted: true, whatsappAccepted: Boolean(messageId) };
  }

  async function tick(now = new Date()) {
    const local = paris(now);
    if (local.weekday !== 'Thu' || local.date < START || local.hour < 10 || local.hour >= 21) return;
    await locked(async () => {
      const slot = local.hour < 12 ? '10h' : '12h';
      const claim = await pool.query('INSERT INTO newsletter_jobs (week,slot) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING week', [local.date, slot]);
      if (!claim.rows.length) return;
      try {
        if (slot === '10h') {
          await edition(local.date);
          const { posts } = await collect(pool, now);
          await notify(`📰 Préparation de la newsletter : ${posts.length} post(s) récent(s), ${posts.reduce((n,p) => n + p.photoIds.length,0)} photo(s).\nAjoute tes annonces et horaires avec « newsletter ajouter … ». L’aperçu sera envoyé à midi à ${PREVIEW_TO}.`);
        } else await prepare(local.date);
        await pool.query("UPDATE newsletter_jobs SET status='done' WHERE week=$1 AND slot=$2", [local.date, slot]);
      } catch (e) {
        await pool.query("UPDATE newsletter_jobs SET status='failed',last_error=$3 WHERE week=$1 AND slot=$2", [local.date, slot, e.message]);
        await notify('⚠️ Préparation newsletter interrompue : ' + e.message + '. Écris « newsletter aperçu » pour réessayer.');
      }
    });
  }
  let busy = false;
  const timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { console.error('Newsletter tâche :', e.message); } finally { busy = false; } }, 60000);
  timer.unref();

  function adminAuth(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const actual = req.headers['x-admin-password'];
    const hash = v => createHash('sha256').update(v).digest();
    if (!adminPassword || typeof actual !== 'string' || !timingSafeEqual(hash(actual), hash(adminPassword))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  app.get('/admin/newsletter/status', adminAuth, async (_req,res) => {
    try { await ready; const rows = (await pool.query('SELECT week,revision,status,preview_sent_at,scheduled_at,campaign_id,last_error FROM newsletter_editions ORDER BY week DESC LIMIT 5')).rows;
      res.json({ start: START, previewTo: PREVIEW_TO, timezone: 'Europe/Paris', preparation: '10:00', preview: '12:00', sendAfterApproval: '21:30', kehilaConfigured: Boolean(process.env.KEHILA_API_KEY), editions: rows });
    } catch (_) { res.status(500).json({ error: 'Newsletter unavailable' }); }
  });
  app.get('/admin/newsletter/kehila-check', adminAuth, async (_req,res) => {
    try {
      const checked = await kehila.inspect(process.env.KEHILA_API_KEY, process.env.KEHILA_NEWSLETTER_SOURCE_CAMPAIGN_ID || SOURCE_CAMPAIGN);
      res.json({ connected: true, audienceVerified: true, audience: checked.label });
    } catch (_) { res.status(502).json({ connected: false, error: 'Connexion ou audience Kehila non vérifiée' }); }
  });
  app.get('/admin/newsletter/whatsapp-check', adminAuth, async (_req,res) => {
    try { res.json(await whatsapp.check()); }
    catch (_) { res.status(502).json({ error: 'Vérification WhatsApp indisponible' }); }
  });
  app.post('/admin/newsletter/whatsapp-test', adminAuth, async (_req,res) => {
    try {
      const checked = await whatsapp.check();
      if (!checked.approved || !checked.sameAccount) return res.status(409).json({ error: 'Modèle ou compte WhatsApp non validé', ...checked });
      const id = await wa('Test technique du suivi de newsletter. La connexion WhatsApp est active. Aucune newsletter modifiée et aucun envoi aux abonnés.', null, { forceTemplate: true });
      res.json({ whatsappAccepted: Boolean(id), deliveryConfirmed: false });
    } catch (_) { res.status(502).json({ error: 'Test WhatsApp non accepté' }); }
  });
  app.post('/admin/newsletter/test', adminAuth, async (_req,res) => { try { res.json(await locked(testDelivery)); } catch (e) { res.status(500).json({ error: e.message }); } });
  return { handleButton, handleText, ready, tick };
}
module.exports = { init, upcomingWeek, buttonId, parseButton, canApprove };
