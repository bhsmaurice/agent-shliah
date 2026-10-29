'use strict';
// ═══════════════════════════════════════════════════════════════
// SMS — envoi par SMSFactor, page admin, réponses et STOP
//
// Ce que ça fait :
//  1. Envoi groupé (abonnés Chabbat, abonnés événements, tous les
//     contacts, ou une liste collée) depuis /admin/sms ou par WhatsApp
//     (commande « sms », voir sms.bot.js)
//  2. Secours : whatsappOuSMS() essaie WhatsApp, et si ça ne passe pas
//     (fenêtre de 24 h fermée…), envoie un SMS
//  3. Réponses : si un numéro dédié est loué chez SMSFactor, les SMS
//     reçus arrivent sur le webhook et le bot répond par SMS
//  4. STOP : les désinscrits ne reçoivent plus rien
//  5. Jamais d'envoi pendant Chabbat et Yom Tov (calendrier Hebcal, Paris)
//
// Variables Railway :
//   SMSFACTOR_TOKEN     (obligatoire) — token API SMSFactor
//   SMS_EXPEDITEUR      (facultatif)  — nom affiché, 11 caractères max
//                                       (défaut BHSMAURICE ; mettre "aucun"
//                                       pour le numéro court partagé)
//   SMS_NUMERO          (facultatif)  — numéro dédié loué chez SMSFactor,
//                                       utilisé pour répondre aux SMS reçus
//   SMS_PRIX            (facultatif)  — prix d'un SMS en euros pour l'estimation (défaut 0.066)
//   SMS_SECOURS         (facultatif)  — "off" pour couper le secours WhatsApp → SMS
//   SMS_REPONSE_AUTO    (facultatif)  — "off" pour que le bot ne réponde pas aux SMS reçus
//   SMS_WEBHOOK_SECRET  (facultatif)  — sinon dérivé du mot de passe admin
// ═══════════════════════════════════════════════════════════════
const crypto = require('node:crypto');
const { normaliserTel, telLisible, nettoyerPourSMS, compterSMS } = require('./sms.core');

const API = 'https://api.smsfactor.com';
const TAILLE_LOT = 500;
const MAX_REPONSES_PAR_JOUR = 20;

let ctx = null;

const cfg = () => ({
  token: process.env.SMSFACTOR_TOKEN || '',
  expediteur: (() => {
    const v = (process.env.SMS_EXPEDITEUR || 'BHSMAURICE').trim();
    return /^aucun$/i.test(v) ? '' : v.replace(/[^A-Za-z0-9 .-]/g, '').slice(0, 11);
  })(),
  numero: normaliserTel(process.env.SMS_NUMERO || ''),
  prix: parseFloat(String(process.env.SMS_PRIX || '0.066').replace(',', '.')) || 0.066,
  secours: !/^(off|non|0|false)$/i.test(process.env.SMS_SECOURS || ''),
  reponseAuto: !/^(off|non|0|false)$/i.test(process.env.SMS_REPONSE_AUTO || ''),
});

function secretWebhook() {
  return process.env.SMS_WEBHOOK_SECRET
    || crypto.createHash('sha256').update('sms-webhook:' + (ctx && ctx.adminPassword || '')).digest('hex').slice(0, 20);
}
function urlsWebhook() {
  const base = (ctx && ctx.publicBaseUrl) || 'https://TON-APP.up.railway.app';
  const s = secretWebhook();
  return { reponses: `${base}/sms/webhook/${s}/mo`, stop: `${base}/sms/webhook/${s}/stop` };
}

// ─── Chabbat / Yom Tov (Hebcal, Paris, allumage 18 min avant) ────
let cacheCal = { t: 0, periodes: null };
async function periodesInterdites() {
  if (cacheCal.periodes && Date.now() - cacheCal.t < 6 * 3600 * 1000) return cacheCal.periodes;
  const iso = d => d.toISOString().slice(0, 10);
  const debut = new Date(Date.now() - 3 * 86400000), fin = new Date(Date.now() + 30 * 86400000);
  const url = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&ss=on&c=on&M=on&b=18&i=off&geo=geoname&geonameid=2988507'
    + `&start=${iso(debut)}&end=${iso(fin)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'ShliahBot/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Hebcal HTTP ' + r.status);
  const items = (await r.json()).items || [];
  const periodes = [];
  for (const it of items.filter(i => i.category === 'candles')) {
    const a = new Date(it.date).getTime();
    const sortie = items.find(i => i.category === 'havdalah' && new Date(i.date).getTime() > a);
    if (sortie) periodes.push({ debut: a, fin: new Date(sortie.date).getTime() });
  }
  cacheCal = { t: Date.now(), periodes };
  return periodes;
}
// Renvoie la date de fin (sortie) si on est pendant Chabbat/Yom Tov, sinon null
async function enChabbat(date = new Date()) {
  const t = date.getTime();
  try {
    const p = (await periodesInterdites()).find(x => t >= x.debut && t <= x.fin);
    return p ? new Date(p.fin) : null;
  } catch (e) {
    // Calendrier indisponible : prudence, vendredi 15h → samedi 22h (Paris)
    console.error('SMS — calendrier :', e.message);
    const d = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const min = d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();
    return (min >= 5 * 1440 + 15 * 60 && min <= 6 * 1440 + 22 * 60) ? new Date(t + 3600000) : null;
  }
}

// ─── Base de données ──────────────────────────────────────────
async function ensureDB() {
  const q = s => ctx.pool.query(s);
  await q(`CREATE TABLE IF NOT EXISTS sms_envois (
    id SERIAL PRIMARY KEY, origine TEXT, cible TEXT, pushtype TEXT, texte TEXT,
    nb_destinataires INTEGER DEFAULT 0, nb_envoyes INTEGER DEFAULT 0, cout NUMERIC(10,2) DEFAULT 0,
    phone TEXT, tickets TEXT, statut TEXT, erreur TEXT, details JSONB, created_at TIMESTAMP DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS sms_stop (phone TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS sms_recus (
    id SERIAL PRIMARY KEY, phone TEXT, message TEXT, reponse TEXT, cle TEXT UNIQUE, created_at TIMESTAMP DEFAULT NOW())`);
}

// ─── API SMSFactor ────────────────────────────────────────────
async function appelAPI(methode, chemin, corps) {
  const { token } = cfg();
  if (!token) throw new Error("SMSFACTOR_TOKEN n'est pas configuré sur Railway");
  const r = await fetch(API + chemin, {
    method: methode,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || ('SMSFactor HTTP ' + r.status));
  return data;
}

async function credits() {
  const d = await appelAPI('GET', '/credits');
  if (String(d.status) !== '1') throw new Error(d.message || 'Réponse SMSFactor inattendue');
  return { credits: Number(d.credits) || 0, postpaid: !!d.postpaid_limit || Number(d.postpaid) > 0, illimite: !!d.unlimited };
}

async function numerosStop() {
  const r = await ctx.pool.query('SELECT phone FROM sms_stop');
  return new Set(r.rows.map(x => x.phone));
}

// Liste des numéros pour une cible
async function destinataires(cible, liste) {
  let brut = [];
  if (cible === 'abonnes_chabbat') brut = (await ctx.pool.query('SELECT phone FROM contacts WHERE abonne_chabbat=TRUE')).rows.map(r => r.phone);
  else if (cible === 'abonnes_evenements') brut = (await ctx.pool.query('SELECT phone FROM contacts WHERE abonne_evenements=TRUE')).rows.map(r => r.phone);
  else if (cible === 'tous') brut = (await ctx.pool.query('SELECT phone FROM contacts')).rows.map(r => r.phone);
  else brut = String(Array.isArray(liste) ? liste.join('\n') : (liste || '')).split(/[\n,;]+/);
  const stop = await numerosStop();
  const vus = new Set(), ok = [], invalides = [];
  let exclus = 0;
  for (const b of brut) {
    if (!String(b || '').trim()) continue;
    const n = normaliserTel(b);
    if (!n) { invalides.push(String(b).trim()); continue; }
    if (vus.has(n)) continue;
    vus.add(n);
    if (stop.has(n)) { exclus++; continue; }
    ok.push(n);
  }
  return { numeros: ok, invalides, exclusStop: exclus };
}

function preparer(texte, pushtype) {
  const propre = nettoyerPourSMS(texte);
  const c = compterSMS(propre, { stop: pushtype === 'marketing' && !!cfg().expediteur });
  return { texte: propre, ...c };
}

/**
 * Envoie un SMS à une liste de numéros.
 * pushtype : 'alert' (information, sans STOP, à toute heure)
 *            'marketing' (annonce / appel aux dons : STOP ajouté, pas la nuit ni le dimanche)
 */
async function envoyer({ numeros, texte, pushtype = 'alert', origine = 'admin', cible = null, expediteur, ignorerChabbat = false }) {
  const config = cfg();
  const prep = preparer(texte, pushtype);
  const liste = [...new Set((numeros || []).map(normaliserTel).filter(Boolean))];
  const ligne = { origine, cible, pushtype, texte: prep.texte, nb: liste.length, phone: liste.length === 1 ? liste[0] : null };
  const journal = async (statut, extra) => {
    try {
      await ctx.pool.query(
        `INSERT INTO sms_envois (origine, cible, pushtype, texte, nb_destinataires, nb_envoyes, cout, phone, tickets, statut, erreur, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [origine, cible, pushtype, prep.texte, ligne.nb, extra.envoyes || 0, extra.cout || 0, ligne.phone,
          (extra.tickets || []).join(',') || null, statut, extra.erreur || null, extra.details ? JSON.stringify(extra.details) : null]);
    } catch (e) { console.error('SMS journal :', e.message); }
  };

  if (!prep.texte) return { ok: false, erreur: 'Message vide' };
  if (!liste.length) return { ok: false, erreur: 'Aucun destinataire' };
  if (!config.token) { await journal('erreur', { erreur: 'SMSFACTOR_TOKEN manquant' }); return { ok: false, erreur: "La clé SMSFactor (SMSFACTOR_TOKEN) n'est pas encore sur Railway." }; }
  if (!ignorerChabbat) {
    const fin = await enChabbat();
    if (fin) {
      await journal('bloque_chabbat', {});
      return { ok: false, chabbat: true, erreur: `Pas d'envoi pendant Chabbat / Yom Tov (jusqu'à ${fin.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', hour: '2-digit', minute: '2-digit' })}).` };
    }
  }
  const stop = await numerosStop();
  const final = liste.filter(n => !stop.has(n));
  if (!final.length) { await journal('stop', {}); return { ok: false, erreur: 'Ce(s) numéro(s) ont demandé STOP.' }; }

  const exp = expediteur !== undefined ? expediteur : config.expediteur;
  let envoyes = 0, cout = 0, creditsRestants = null;
  const tickets = [], details = { blacklisted: 0, invalid: 0, npai: 0, flood: 0 }, erreurs = [];
  for (let i = 0; i < final.length; i += TAILLE_LOT) {
    const lot = final.slice(i, i + TAILLE_LOT);
    const message = { text: prep.texte, pushtype };
    if (exp) message.sender = exp;
    try {
      const d = await appelAPI('POST', '/send', { sms: { message, recipients: { gsm: lot.map((value, k) => ({ gsmsmsid: String(i + k + 1), value })) } } });
      if (String(d.status) === '1' || String(d.status) === '-8') {
        envoyes += Number(d.sent != null ? d.sent : lot.length) || 0;
        cout += Number(d.cost) || 0;
        if (d.ticket) tickets.push(String(d.ticket));
        if (d.credits != null) creditsRestants = Number(d.credits);
        for (const k of Object.keys(details)) details[k] += Number(d[k]) || 0;
      } else erreurs.push(d.message || ('statut ' + d.status));
    } catch (e) { erreurs.push(e.message); }
  }
  const ok = envoyes > 0;
  await journal(ok ? (erreurs.length ? 'partiel' : 'envoye') : 'erreur', { envoyes, cout, tickets, erreur: erreurs.join(' | ') || null, details });
  return { ok, envoyes, total: final.length, credits_utilises: cout, credits: creditsRestants, sms_par_message: prep.sms, erreur: erreurs.join(' | ') || null, details, texte: prep.texte };
}

// ─── Secours : WhatsApp d'abord, SMS si WhatsApp échoue ───────
async function whatsappOuSMS(to, message, origine = 'secours') {
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/${ctx.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (data && data.messages) return { ok: true, canal: 'whatsapp' };
    console.log('WhatsApp refusé pour', to, '→ secours SMS ?', JSON.stringify(data && data.error ? data.error.message : data).slice(0, 200));
  } catch (e) { console.error('WhatsApp erreur', to, e.message); }
  if (!cfg().secours || !cfg().token) return { ok: false, canal: 'aucun' };
  const res = await envoyer({ numeros: [to], texte: message, pushtype: 'alert', origine });
  return { ok: res.ok, canal: res.ok ? 'sms' : 'aucun', erreur: res.erreur };
}

// ─── SMS reçus (numéro dédié) ─────────────────────────────────
async function traiterSMSRecu(corps) {
  const from = normaliserTel(corps.from || corps.gsm || corps.sender);
  const message = String(corps.message || corps.text || '').trim();
  if (!from || !message) return;
  const cle = crypto.createHash('sha256').update([from, corps.date || '', message].join('|')).digest('hex');
  const ins = await ctx.pool.query('INSERT INTO sms_recus (phone, message, cle) VALUES ($1,$2,$3) ON CONFLICT (cle) DO NOTHING RETURNING id', [from, message, cle]);
  if (!ins.rows.length) return; // déjà traité
  const id = ins.rows[0].id;
  if (/^\s*stop\b/i.test(message)) { await ajouterStop(from); return; }
  if (!cfg().reponseAuto || !ctx.repondre) return;
  const n = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM sms_recus WHERE phone=$1 AND reponse IS NOT NULL AND created_at > NOW() - INTERVAL '1 day'", [from]);
  if (n.rows[0].n >= MAX_REPONSES_PAR_JOUR) { console.log('SMS : limite de réponses atteinte pour', from); return; }
  const reponse = await ctx.repondre(from, message);
  if (!reponse) return;
  const exp = cfg().numero || undefined; // répondre depuis le numéro dédié pour que la personne puisse continuer
  const res = await envoyer({ numeros: [from], texte: reponse, pushtype: 'alert', origine: 'reponse_sms', expediteur: exp, ignorerChabbat: true });
  await ctx.pool.query('UPDATE sms_recus SET reponse=$1 WHERE id=$2', [res.ok ? res.texte : ('[non envoyé] ' + (res.erreur || '')), id]);
  try { await ctx.pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1,$2,$3)', [from, '[SMS] ' + message, res.texte || reponse]); } catch (e) {}
}

async function ajouterStop(phone) {
  const p = normaliserTel(phone);
  if (!p) return;
  await ctx.pool.query('INSERT INTO sms_stop (phone) VALUES ($1) ON CONFLICT DO NOTHING', [p]);
  console.log('SMS STOP :', p);
}

// ─── Initialisation + routes ──────────────────────────────────
function init(options) {
  ctx = options;
  const { app, adminPassword } = ctx;
  ensureDB().then(() => console.log('📱 Tables SMS prêtes')).catch(e => console.error('Tables SMS :', e.message));

  const ok = pw => pw === adminPassword;
  const refus = res => res.status(401).json({ ok: false, message: 'Mot de passe incorrect' });

  // Webhooks SMSFactor (réponses et STOP) — l'adresse contient un secret
  app.post('/sms/webhook/:secret/:type', async (req, res) => {
    if (req.params.secret !== secretWebhook()) return res.sendStatus(404);
    res.sendStatus(200);
    try {
      if (req.params.type === 'stop') await ajouterStop(req.body && req.body.from);
      else if (req.params.type === 'mo') await traiterSMSRecu(req.body || {});
    } catch (e) { console.error('SMS webhook :', e.message); }
  });

  app.get('/admin/sms/info', async (req, res) => {
    if (!ok(req.query.password)) return refus(res);
    const c = cfg();
    let solde = null, erreurSolde = null;
    if (c.token) { try { solde = await credits(); } catch (e) { erreurSolde = e.message; } }
    const compte = async sql => (await ctx.pool.query(sql)).rows[0].n;
    const fin = await enChabbat();
    res.json({
      ok: true,
      configure: !!c.token, expediteur: c.expediteur || '(numéro court partagé)', numero: c.numero ? telLisible(c.numero) : null,
      secours: c.secours, reponseAuto: c.reponseAuto, prix: c.prix, solde, erreurSolde,
      chabbat: fin ? fin.toISOString() : null,
      webhooks: urlsWebhook(),
      cibles: {
        abonnes_chabbat: await compte('SELECT COUNT(*)::int AS n FROM contacts WHERE abonne_chabbat=TRUE'),
        abonnes_evenements: await compte('SELECT COUNT(*)::int AS n FROM contacts WHERE abonne_evenements=TRUE'),
        tous: await compte('SELECT COUNT(*)::int AS n FROM contacts'),
      },
      stops: await compte('SELECT COUNT(*)::int AS n FROM sms_stop'),
    });
  });

  app.post('/admin/sms/apercu', async (req, res) => {
    const { password, cible, liste, texte, pushtype } = req.body || {};
    if (!ok(password)) return refus(res);
    const d = await destinataires(cible, liste);
    const p = preparer(texte, pushtype === 'marketing' ? 'marketing' : 'alert');
    res.json({ ok: true, nb: d.numeros.length, invalides: d.invalides, exclusStop: d.exclusStop, texte: p.texte, unicode: p.unicode,
      caracteres: p.caracteres, sms_par_message: p.sms, total_sms: p.sms * d.numeros.length, cout_estime: +(p.sms * d.numeros.length * cfg().prix).toFixed(2) });
  });

  app.post('/admin/sms/envoyer', async (req, res) => {
    const { password, cible, liste, texte, pushtype } = req.body || {};
    if (!ok(password)) return refus(res);
    const d = await destinataires(cible, liste);
    const r = await envoyer({ numeros: d.numeros, texte, pushtype: pushtype === 'marketing' ? 'marketing' : 'alert', origine: 'admin', cible });
    res.json(Object.assign({ message: r.ok ? `${r.envoyes} SMS envoyé(s)` : r.erreur }, r));
  });

  app.get('/admin/sms/historique', async (req, res) => {
    if (!ok(req.query.password)) return refus(res);
    const e = await ctx.pool.query('SELECT * FROM sms_envois ORDER BY created_at DESC LIMIT 100');
    const r = await ctx.pool.query(`SELECT s.*, c.prenom, c.nom FROM sms_recus s LEFT JOIN contacts c ON c.phone = s.phone ORDER BY s.created_at DESC LIMIT 100`);
    const s = await ctx.pool.query('SELECT * FROM sms_stop ORDER BY created_at DESC LIMIT 200');
    res.json({ ok: true, envois: e.rows, recus: r.rows, stops: s.rows });
  });

  app.post('/admin/sms/stop', async (req, res) => {
    const { password, phone, retirer } = req.body || {};
    if (!ok(password)) return refus(res);
    const p = normaliserTel(phone);
    if (!p) return res.status(400).json({ ok: false, message: 'Numéro invalide' });
    if (retirer) await ctx.pool.query('DELETE FROM sms_stop WHERE phone=$1', [p]);
    else await ajouterStop(p);
    res.json({ ok: true, message: retirer ? 'Retiré de la liste STOP' : 'Ajouté à la liste STOP' });
  });

  app.get('/admin/sms', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(require('./sms.admin').PAGE_HTML);
  });

  console.log('📱 Module SMS prêt' + (cfg().token ? '' : ' (en attente de SMSFACTOR_TOKEN)'));
  return { envoyer, whatsappOuSMS, destinataires, preparer, credits, enChabbat, cfg, urlsWebhook };
}

module.exports = { init };
