'use strict';
// ═══════════════════════════════════════════════════════════════
// SMS par WhatsApp (réservé à l'admin)
//
//  « sms Ce soir 20h30 soirée Hassidout ! »
//      → le bot demande à qui (3 boutons) → aperçu + prix → ✅ Envoyer / ❌ Annuler
//  « sms 06 12 34 56 78 Chalom, ton colis est arrivé »
//      → à une seule personne (information, sans STOP) → aperçu → ✅ / ❌
//  « sms crédits » → solde SMSFactor
//  « sms » tout seul → aide
// ═══════════════════════════════════════════════════════════════
const { normaliserTel, telLisible } = require('./sms.core');

const SESSION_TTL = 30 * 60 * 1000;
let ctx = null, sms = null;
const sessions = {};

const NOMS = { abonnes_chabbat: 'abonnés Chabbat', abonnes_evenements: 'abonnés événements', tous: 'tous les contacts' };
const euros = n => n.toFixed(2).replace('.', ',') + ' €';

function session(from) {
  const s = sessions[from];
  if (s && Date.now() - s.t > SESSION_TTL) { delete sessions[from]; return null; }
  return s || null;
}

async function montrerApercu(from, s) {
  const d = s.cible === 'liste' ? await sms.destinataires('liste', s.numeros) : await sms.destinataires(s.cible);
  const p = sms.preparer(s.texte, s.pushtype);
  s.nb = d.numeros.length;
  if (!s.nb) { delete sessions[from]; await ctx.sendWhatsApp(from, '❌ Aucun destinataire' + (d.exclusStop ? ' (ils ont tous demandé STOP).' : '.')); return; }
  const total = p.sms * s.nb;
  const qui = s.cible === 'liste' ? telLisible(d.numeros[0]) : `${s.nb} ${NOMS[s.cible]}`;
  await ctx.sendWhatsAppButtons(from,
    `📱 APERÇU SMS\n\nÀ : ${qui}\n\n${p.texte}${s.pushtype === 'marketing' ? '\n+ mention STOP' : ''}\n\n`
    + `${p.sms} SMS par personne · ${total} crédit(s) ≈ ${euros(total * sms.cfg().prix)}`
    + (d.exclusStop ? `\n${d.exclusStop} exclu(s) (STOP)` : '')
    + (s.pushtype === 'marketing' ? '\n\nℹ️ Annonce : pas d\'envoi la nuit ni le dimanche, SMSFactor décale si besoin.' : ''),
    [{ id: 'sms_ok', title: '✅ Envoyer' }, { id: 'sms_annuler', title: '❌ Annuler' }]);
}

async function handleText(from, text) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const t = String(text || '').trim();
  const m = t.match(/^sms(?=$|[\s:\-])\s*[:\-]?\s*([\s\S]*)$/i);
  if (!m) return false;
  const reste = m[1].trim();

  if (!reste) {
    await ctx.sendWhatsApp(from, "📱 SMS\n\nsms + ton message → envoi groupé (je te demande à qui)\n\nsms 06 12 34 56 78 + message → une seule personne\n\nsms crédits → ton solde\n\nPage complète : " + (ctx.publicBaseUrl || '') + '/admin/sms');
    return true;
  }
  if (/^cr[ée]dits?\s*[?.!]*$/i.test(reste) || /^solde\s*[?.!]*$/i.test(reste)) {
    try { const c = await sms.credits(); await ctx.sendWhatsApp(from, c.illimite ? '📱 Crédits SMS : illimité' : `📱 Il te reste ${c.credits} crédits SMS.`); }
    catch (e) { await ctx.sendWhatsApp(from, '❌ ' + e.message); }
    return true;
  }
  if (!sms.cfg().token) { await ctx.sendWhatsApp(from, "❌ SMSFactor n'est pas encore branché : ajoute SMSFACTOR_TOKEN dans Railway → Variables."); return true; }

  // Un numéro au début → une seule personne
  const num = reste.match(/^(\+?[\d][\d .]{7,16}\d)\s+([\s\S]+)$/);
  if (num && normaliserTel(num[1])) {
    sessions[from] = { t: Date.now(), cible: 'liste', numeros: [num[1]], texte: num[2].trim(), pushtype: 'alert' };
    await montrerApercu(from, sessions[from]);
    return true;
  }

  sessions[from] = { t: Date.now(), texte: reste, pushtype: 'marketing' };
  const info = await sms.destinataires('abonnes_evenements');
  const chab = await sms.destinataires('abonnes_chabbat');
  const tous = await sms.destinataires('tous');
  await ctx.sendWhatsAppButtons(from, '📱 À qui j\'envoie ce SMS ?',
    [{ id: 'sms_c_evenements', title: `Événements (${info.numeros.length})`.slice(0, 20) },
     { id: 'sms_c_chabbat', title: `Chabbat (${chab.numeros.length})`.slice(0, 20) },
     { id: 'sms_c_tous', title: `Tous (${tous.numeros.length})`.slice(0, 20) }]);
  return true;
}

async function handleBouton(from, id) {
  if (!ctx || !ctx.isAdmin(from)) return;
  const s = session(from);
  if (!s) { await ctx.sendWhatsApp(from, '⏱️ Ce SMS a expiré. Réécris « sms » + ton message.'); return; }
  s.t = Date.now();
  const cibles = { sms_c_evenements: 'abonnes_evenements', sms_c_chabbat: 'abonnes_chabbat', sms_c_tous: 'tous' };
  if (cibles[id]) { s.cible = cibles[id]; await montrerApercu(from, s); return; }
  if (id === 'sms_annuler') { delete sessions[from]; await ctx.sendWhatsApp(from, '❌ SMS annulé.'); return; }
  if (id === 'sms_ok') {
    if (!s.cible || s.envoi) return;
    s.envoi = true;
    const d = s.cible === 'liste' ? await sms.destinataires('liste', s.numeros) : await sms.destinataires(s.cible);
    await ctx.sendWhatsApp(from, `⏳ Envoi à ${d.numeros.length} personne(s)…`);
    const r = await sms.envoyer({ numeros: d.numeros, texte: s.texte, pushtype: s.pushtype, origine: 'whatsapp', cible: s.cible });
    delete sessions[from];
    await ctx.sendWhatsApp(from, r.ok
      ? `✅ ${r.envoyes} SMS envoyé(s).` + (r.credits != null ? `\n\nIl te reste ${r.credits} crédits.` : '') + (r.erreur ? `\n\n⚠️ ${r.erreur}` : '')
      : '❌ ' + (r.erreur || 'Envoi impossible.'));
  }
}

function init(options) {
  ctx = options;
  sms = options.sms;
  return { handleText, handleBouton };
}

module.exports = { init };
