'use strict';
// ═══════════════════════════════════════════════════════════════
// MON CARNET — assistant personnel de Levi (réservé à l'admin)
//
// WhatsApp :
//   « tâche commander les plaques dimanche »  → le bot range la tâche
//   message vocal                              → transcrit puis rangé (OPENAI_API_KEY)
//   « mes tâches »                             → liste (en retard / aujourd'hui / à venir)
//   « fait 2 » ou « fait 1 et 3 »              → cocher
//   « supprimer tâche 2 »                      → supprimer
//   « résumé »                                 → le résumé du jour tout de suite
//   « résumé 7h30 »                            → changer l'heure du résumé du matin
// Automatique :
//   résumé du matin (3 priorités + retard + ce qui attend dans l'admin),
//   rappel à l'heure prévue, rien pendant Chabbat et les fêtes.
// Admin : page « Mon carnet » (routes /admin/taches…)
//
// Variables Railway :
//   OPENAI_API_KEY (facultatif) — pour comprendre les messages vocaux
//   TACHES_MODEL   (facultatif) — modèle Claude pour ranger les tâches
// ═══════════════════════════════════════════════════════════════

const DOSSIERS = ['Mezouzot et Téfilines', 'Commandes', 'Communauté', 'Dons', 'Personnel', 'Autre'];
const GRAPH = 'https://graph.facebook.com/v25.0';
const HEURE_DEFAUT = '08:00';
let ctx = null;
let dernierRappel = null; // id de la dernière tâche rappelée (« fait » tout court la coche)

// ─── Dates (heure de Paris) ───────────────────────────────────
function paris(d) { return new Date((d || new Date()).toLocaleString('en-US', { timeZone: 'Europe/Paris' })); }
const pad = n => String(n).padStart(2, '0');
function jourIso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function aujourdhui() { return jourIso(paris()); }
function maintenantTexte() { const p = paris(); return `${jourIso(p)} ${pad(p.getHours())}:${pad(p.getMinutes())}`; }
function plusJours(iso, n) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function dateFr(iso) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return `${JOURS[t.getUTCDay()]} ${d} ${MOIS[m - 1]}`; }
function quandCourt(t) {
  if (!t.echeance) return '';
  const auj = aujourdhui();
  let s = t.echeance === auj ? "aujourd'hui" : t.echeance === plusJours(auj, 1) ? 'demain' : dateFr(t.echeance);
  if (t.heure) s += ' ' + t.heure.replace(':', 'h');
  return s;
}

// ─── Base de données ──────────────────────────────────────────
async function creerTables() {
  await ctx.pool.query(`CREATE TABLE IF NOT EXISTS taches (
    id SERIAL PRIMARY KEY, titre TEXT NOT NULL, dossier TEXT DEFAULT 'Autre',
    echeance DATE, heure TEXT, personne TEXT, notes TEXT,
    statut TEXT DEFAULT 'a_faire', rappel_envoye BOOLEAN DEFAULT false, source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), fait_le TIMESTAMPTZ)`);
  await ctx.pool.query(`CREATE TABLE IF NOT EXISTS taches_config (cle TEXT PRIMARY KEY, valeur TEXT)`);
}
async function lireConfig(cle, defaut) {
  try { const r = await ctx.pool.query('SELECT valeur FROM taches_config WHERE cle=$1', [cle]); return r.rows[0] ? r.rows[0].valeur : defaut; }
  catch (e) { return defaut; }
}
async function ecrireConfig(cle, valeur) {
  await ctx.pool.query('INSERT INTO taches_config (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur', [cle, String(valeur)]);
}
function ligneVersTache(r) {
  return { id: r.id, titre: r.titre, dossier: r.dossier, echeance: r.echeance ? jourIso(new Date(r.echeance)) : null, heure: r.heure, personne: r.personne, notes: r.notes, statut: r.statut, created_at: r.created_at, fait_le: r.fait_le, source: r.source };
}
// DATE renvoyée par pg = minuit heure locale du serveur : on relit en texte pour éviter les décalages
async function tachesOuvertes() {
  const r = await ctx.pool.query(`SELECT *, to_char(echeance, 'YYYY-MM-DD') AS ech FROM taches WHERE statut='a_faire'`);
  return trier(r.rows.map(x => ({ ...ligneVersTache(x), echeance: x.ech || null })));
}
function groupe(t) {
  const auj = aujourdhui();
  if (!t.echeance) return 4;
  if (t.echeance < auj) return 0;
  if (t.echeance === auj) return 1;
  if (t.echeance <= plusJours(auj, 7)) return 2;
  return 3;
}
function trier(liste) {
  return liste.sort((a, b) => groupe(a) - groupe(b)
    || String(a.echeance || '').localeCompare(String(b.echeance || ''))
    || String(a.heure || '99').localeCompare(String(b.heure || '99'))
    || new Date(a.created_at) - new Date(b.created_at));
}

// ─── Comprendre une tâche (Claude) ────────────────────────────
async function comprendre(texte) {
  const p = paris();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.TACHES_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 800,
      system: `Tu es l'assistant personnel du Rav Levi Basanger, directeur du Beth Habad S. Maurice. Nous sommes ${JOURS[p.getDay()]} ${jourIso(p)}, il est ${pad(p.getHours())}:${pad(p.getMinutes())} à Paris.
Transforme son message (texte ou vocal transcrit) en une ou plusieurs tâches.
- titre : court, commence par un verbe (« Commander les plaques », « Relancer Mme Cohen pour ses mezouzot »). Garde les noms tels qu'ils sont dits, n'invente rien.
- dossier : un seul parmi ${DOSSIERS.map(d => '« ' + d + ' »').join(', ')}. Mezouzot, téfilines, vérifications, capsules, étuis, plaques de mezouza → « Mezouzot et Téfilines » sauf s'il s'agit d'une commande à un fournisseur → « Commandes ». Fidèles, cours, offices, fêtes, événements → « Communauté ». Tsédaka, Cerfa, donateurs → « Dons ». Famille, maison → « Personnel ».
- date : « AAAA-MM-JJ » si une date ou un jour est dit (« dimanche » = le prochain dimanche, « demain », « la semaine prochaine » = lundi prochain, « avant Chabbat » = ce vendredi), sinon null. Toujours aujourd'hui ou dans le futur.
- heure : « HH:MM » seulement si une heure est dite (« matin » = 09:00, « midi » = 12:00, « après-midi » = 15:00, « soir » = 20:00), sinon null.
- personne : le nom de la personne concernée s'il y en a une, sinon null.
- notes : détails utiles qui ne tiennent pas dans le titre, sinon null.
Réponds UNIQUEMENT en JSON : {"taches":[{"titre":"...","dossier":"...","date":null,"heure":null,"personne":null,"notes":null}]}`,
      messages: [{ role: 'user', content: String(texte).slice(0, 3000) }]
    }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json();
  if (!res.ok || !data.content) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  const txt = data.content.map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse illisible');
  const j = JSON.parse(m[0]);
  return (j.taches || []).filter(t => t && t.titre).map(t => ({
    titre: String(t.titre).trim().slice(0, 300),
    dossier: DOSSIERS.includes(t.dossier) ? t.dossier : 'Autre',
    echeance: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : null,
    heure: /^\d{1,2}:\d{2}$/.test(t.heure || '') ? t.heure.padStart(5, '0') : null,
    personne: t.personne ? String(t.personne).trim().slice(0, 120) : null,
    notes: t.notes ? String(t.notes).trim().slice(0, 1000) : null
  }));
}
async function inserer(t, source) {
  const r = await ctx.pool.query(
    'INSERT INTO taches (titre, dossier, echeance, heure, personne, notes, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [t.titre, t.dossier || 'Autre', t.echeance || null, t.heure || null, t.personne || null, t.notes || null, source || 'whatsapp']);
  return r.rows[0].id;
}
async function ajouterDepuisTexte(texte, source) {
  let liste;
  try { liste = await comprendre(texte); }
  catch (e) { console.error('Tâches — compréhension :', e.message); liste = [{ titre: String(texte).trim().slice(0, 300), dossier: 'Autre' }]; }
  if (!liste.length) liste = [{ titre: String(texte).trim().slice(0, 300), dossier: 'Autre' }];
  for (const t of liste) t.id = await inserer(t, source);
  return liste;
}

// ─── Messages WhatsApp ────────────────────────────────────────
function confirmation(liste) {
  const lignes = liste.map(t => `✅ *${t.titre}*\n   ${t.dossier}${t.echeance ? ' · ' + quandCourt(t) : ''}${t.personne ? ' · ' + t.personne : ''}`);
  return (liste.length > 1 ? `C'est noté (${liste.length} tâches) :\n\n` : '') + lignes.join('\n\n') + '\n\n_« mes tâches » pour tout voir_';
}
function texteListe(liste) {
  if (!liste.length) return "🎉 Rien à faire pour l'instant !\n\nPour noter : « tâche commander les plaques dimanche »";
  const titres = ['⏰ *En retard*', "📌 *Aujourd'hui*", '📅 *Cette semaine*', '🗓️ *Plus tard*', '📝 *Sans date*'];
  let out = '📋 *Mes tâches*\n', g = -1;
  liste.forEach((t, i) => {
    const gg = groupe(t);
    if (gg !== g) { g = gg; out += `\n${titres[g]}\n`; }
    const q = t.echeance && g !== 1 ? ` — ${quandCourt(t)}` : (t.heure && g === 1 ? ` — ${t.heure.replace(':', 'h')}` : '');
    out += `${i + 1}. ${t.titre}${q}${t.personne ? ' (' + t.personne + ')' : ''}\n`;
  });
  return out + '\n_« fait 2 » pour cocher · « supprimer tâche 2 »_';
}

// Envoi avec vérification ; si WhatsApp refuse (fenêtre de 24 h fermée), e-mail de secours
async function prevenir(phone, texte, sujet) {
  let envoye = false;
  try {
    const r = await fetch(`${GRAPH}/${ctx.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: texte } })
    });
    const d = await r.json();
    envoye = Boolean(d && d.messages);
  } catch (e) { /* e-mail ci-dessous */ }
  // WhatsApp n'accepte un message libre que si Levi a écrit au bot dans les 24 h
  const vu = Number(await lireConfig('dernier_message', '0'));
  if ((!envoye || Date.now() - vu > 23 * 3600 * 1000) && ctx.envoyerEmail) {
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap;">' + texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*/g, '').replace(/_/g, '') + '</div>';
    await ctx.envoyerEmail({ subject: sujet || '📋 Mon carnet — Shliah Bot', html }).catch(() => {});
  }
}

// ─── Chabbat et Yom Tov (Hebcal, Paris) ───────────────────────
let cacheCal = { t: 0, p: null };
async function periodesInterdites() {
  if (cacheCal.p && Date.now() - cacheCal.t < 6 * 3600 * 1000) return cacheCal.p;
  const iso = d => d.toISOString().slice(0, 10);
  const url = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&ss=on&c=on&M=on&b=18&i=off&geo=geoname&geonameid=2988507'
    + `&start=${iso(new Date(Date.now() - 3 * 86400000))}&end=${iso(new Date(Date.now() + 30 * 86400000))}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'ShliahBot/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Hebcal HTTP ' + r.status);
  const items = (await r.json()).items || [];
  const p = [];
  for (const it of items.filter(i => i.category === 'candles')) {
    const a = new Date(it.date).getTime();
    const s = items.find(i => i.category === 'havdalah' && new Date(i.date).getTime() > a);
    if (s) p.push({ debut: a, fin: new Date(s.date).getTime() });
  }
  cacheCal = { t: Date.now(), p };
  return p;
}
async function estChabbatOuFete() {
  const t = Date.now();
  try { return (await periodesInterdites()).some(x => t >= x.debut && t <= x.fin); }
  catch (e) {
    const d = paris(); const min = d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();
    return min >= 5 * 1440 + 15 * 60 && min <= 6 * 1440 + 22 * 60; // prudence : vendredi 15h → samedi 22h
  }
}
async function estJourDeFete(iso) {
  // Le résumé du matin n'est pas envoyé un jour de Chabbat ou de Yom Tov
  try {
    const debutJour = new Date(iso + 'T09:00:00+01:00').getTime();
    return (await periodesInterdites()).some(x => debutJour >= x.debut && debutJour <= x.fin);
  } catch (e) { return paris().getDay() === 6; }
}

// ─── Résumé du matin ──────────────────────────────────────────
async function compteursAdmin() {
  const out = [];
  try { const r = await ctx.pool.query(`SELECT COUNT(*)::int n FROM demandes WHERE statut IN ('nouveau','urgent')`); if (r.rows[0].n) out.push(`${r.rows[0].n} demande${r.rows[0].n > 1 ? 's' : ''} à traiter`); } catch (e) {}
  try { const r = await ctx.pool.query(`SELECT COUNT(*)::int n FROM demandes WHERE statut IN ('nouveau','urgent') AND type='cerfa'`); if (r.rows[0].n) out.push(`${r.rows[0].n} Cerfa à préparer`); } catch (e) {}
  try { const r = await ctx.pool.query(`SELECT COUNT(*)::int n FROM paiements WHERE statut <> 'paye'`); if (r.rows[0].n) out.push(`${r.rows[0].n} paiement${r.rows[0].n > 1 ? 's' : ''} en attente`); } catch (e) {}
  return out;
}
async function texteResume() {
  const liste = await tachesOuvertes();
  const p = paris();
  const retard = liste.filter(t => groupe(t) === 0), jour = liste.filter(t => groupe(t) === 1);
  const prio = [...retard, ...jour].slice(0, 3);
  const prioIds = new Set(prio.map(t => t.id));
  let out = `☀️ *Bonjour Rav Levi*\n${JOURS[p.getDay()].charAt(0).toUpperCase() + JOURS[p.getDay()].slice(1)} ${p.getDate()} ${MOIS[p.getMonth()]}`;
  if (p.getDay() === 5) out += ' — à finir avant Chabbat 🕯️';
  out += '\n';
  if (prio.length) {
    out += '\n🎯 *Tes priorités du jour*\n';
    prio.forEach(t => { out += `• ${t.titre}${groupe(t) === 0 ? ' _(en retard)_' : ''}${t.heure ? ' — ' + t.heure.replace(':', 'h') : ''}\n`; });
  } else out += "\n🎯 Pas de tâche prévue aujourd'hui.\n";
  const resteRetard = retard.filter(t => !prioIds.has(t.id)).length, resteJour = jour.filter(t => !prioIds.has(t.id)).length;
  if (resteRetard || resteJour) out += `\n+ ${resteRetard ? resteRetard + ' autre' + (resteRetard > 1 ? 's' : '') + ' en retard' : ''}${resteRetard && resteJour ? ' · ' : ''}${resteJour ? resteJour + ' autre' + (resteJour > 1 ? 's' : '') + " aujourd'hui" : ''}\n`;
  const semaine = liste.filter(t => groupe(t) === 2).length;
  if (semaine) out += `📅 ${semaine} tâche${semaine > 1 ? 's' : ''} cette semaine\n`;
  const admin = await compteursAdmin();
  if (admin.length) out += `\n📥 *Dans l'admin* : ${admin.join(' · ')}\n`;
  return out + '\n_« mes tâches » pour tout voir · « fait 1 » pour cocher_';
}
let verifEnCours = false;
async function verifierChaqueMinute() {
  if (verifEnCours) return; verifEnCours = true;
  try {
    const auj = aujourdhui(), maintenant = maintenantTexte();
    // 1. Résumé du matin
    const heure = await lireConfig('heure_resume', HEURE_DEFAUT);
    const dejaEnvoye = await lireConfig('resume_envoye', '');
    if (heure !== 'off' && dejaEnvoye !== auj && maintenant.slice(11) >= heure && maintenant.slice(11) < '20:00') {
      await ecrireConfig('resume_envoye', auj); // réservé avant l'envoi : jamais deux fois
      if (!(await estJourDeFete(auj))) await prevenir(ctx.adminPhone, await texteResume(), '☀️ Ton résumé du jour — Shliah Bot');
    }
    // 2. Rappels à l'heure prévue (jamais pendant Chabbat / fête : envoyés à la sortie)
    const r = await ctx.pool.query(`SELECT id, titre, personne, to_char(echeance,'YYYY-MM-DD') ech, heure FROM taches
      WHERE statut='a_faire' AND rappel_envoye=false AND heure IS NOT NULL AND echeance IS NOT NULL
        AND (to_char(echeance,'YYYY-MM-DD') || ' ' || heure) <= $1 ORDER BY echeance, heure LIMIT 5`, [maintenant]);
    if (r.rows.length && !(await estChabbatOuFete())) {
      for (const t of r.rows) {
        await ctx.pool.query('UPDATE taches SET rappel_envoye=true WHERE id=$1', [t.id]);
        await prevenir(ctx.adminPhone, `⏰ *Rappel* : ${t.titre}${t.personne ? ' (' + t.personne + ')' : ''}\n\n_« fait » pour cocher cette tâche_`, '⏰ Rappel — ' + t.titre);
        dernierRappel = t.id;
      }
    }
  } catch (e) { console.error('Tâches — vérification :', e.message); }
  finally { verifEnCours = false; }
}

// ─── Vocal → texte (OpenAI) ───────────────────────────────────
async function transcrire(mediaId) {
  const info = await (await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } })).json();
  if (!info.url) throw new Error('Vocal introuvable');
  const audio = Buffer.from(await (await fetch(info.url, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } })).arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([audio], { type: info.mime_type || 'audio/ogg' }), 'vocal.ogg');
  form.append('model', process.env.TRANSCRIPTION_MODEL || 'whisper-1');
  form.append('language', 'fr');
  form.append('prompt', 'Beth Habad, mezouzot, téfilines, Chabbat, Cerfa, tsédaka, Rav Levi, S. Maurice.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || `HTTP ${r.status}`);
  return String(d.text || '').trim();
}

// ─── Entrées WhatsApp ─────────────────────────────────────────
function vu(from) {
  if (!ctx || !ctx.isAdmin(from)) return;
  ecrireConfig('dernier_message', Date.now()).catch(() => {});
}
async function cocher(from, nums) {
  const liste = await tachesOuvertes();
  const faites = [], inconnus = [];
  for (const n of nums) { const t = liste[n - 1]; if (t) faites.push(t); else inconnus.push(n); }
  for (const t of faites) await ctx.pool.query(`UPDATE taches SET statut='fait', fait_le=NOW() WHERE id=$1`, [t.id]);
  let msg = faites.length ? faites.map(t => `✔️ ~${t.titre}~`).join('\n') : '';
  if (inconnus.length) msg += `${msg ? '\n\n' : ''}Je ne trouve pas le n°${inconnus.join(', ')}. Écris « mes tâches » pour voir les numéros.`;
  const reste = liste.length - faites.length;
  if (faites.length) msg += `\n\n${reste ? `Il reste ${reste} tâche${reste > 1 ? 's' : ''}.` : '🎉 Tout est fait, bravo !'}`;
  await ctx.sendWhatsApp(from, msg);
}
function numeros(s) { return (String(s).match(/\d+/g) || []).map(Number).filter(n => n > 0 && n < 1000); }

async function handleText(from, text) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const t = String(text || '').trim();
  // Créer
  const cr = t.match(/^(?:t[âa]che|tache|todo|à faire|a faire|rappel(?:le[- ]moi)?|note)\s*[:\-–]?\s+([\s\S]+)$/i);
  if (cr && !/^(?:t[âa]ches?)\s+\d/i.test(t)) {
    const liste = await ajouterDepuisTexte(cr[1], 'whatsapp');
    await ctx.sendWhatsApp(from, confirmation(liste));
    return true;
  }
  // Lister
  if (/^(?:mes\s+)?t[âa]ches\s*[?.!]*$/i.test(t) || /^mon carnet\s*[?.!]*$/i.test(t)) {
    await ctx.sendWhatsApp(from, texteListe(await tachesOuvertes()));
    return true;
  }
  // Cocher : « fait 2 », « fait 1 et 3 », « fini 2 » — ou « fait » juste après un rappel
  const f = t.match(/^(?:fait|faite|fini|termin[ée]e?)\s+(?:la\s+)?(?:t[âa]che\s+)?(?:n°\s*)?([\d\s,et]+)$/i);
  if (f && numeros(f[1]).length) { await cocher(from, numeros(f[1])); return true; }
  if (/^fait\s*[.!]*$/i.test(t) && dernierRappel) {
    const r = await ctx.pool.query(`UPDATE taches SET statut='fait', fait_le=NOW() WHERE id=$1 AND statut='a_faire' RETURNING titre`, [dernierRappel]);
    dernierRappel = null;
    if (r.rows.length) { await ctx.sendWhatsApp(from, `✔️ ~${r.rows[0].titre}~`); return true; }
  }
  // Supprimer
  const sp = t.match(/^(?:supprimer|supprime|effacer|efface|annuler|annule)\s+(?:la\s+)?t[âa]che\s*(?:n°\s*)?([\d\s,et]+)$/i);
  if (sp && numeros(sp[1]).length) {
    const liste = await tachesOuvertes();
    const ok = [];
    for (const n of numeros(sp[1])) { const x = liste[n - 1]; if (x) { await ctx.pool.query(`UPDATE taches SET statut='supprime' WHERE id=$1`, [x.id]); ok.push(x.titre); } }
    await ctx.sendWhatsApp(from, ok.length ? `🗑️ Supprimé : ${ok.join(', ')}` : 'Je ne trouve pas cette tâche. Écris « mes tâches » pour voir les numéros.');
    return true;
  }
  // Résumé
  const rh = t.match(/^r[ée]sum[ée](?:\s+du\s+matin)?\s*(?:à|a)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*$/i);
  if (rh) {
    const h = Math.min(23, Number(rh[1])), m = Math.min(59, Number(rh[2] || 0));
    await ecrireConfig('heure_resume', `${pad(h)}:${pad(m)}`);
    await ctx.sendWhatsApp(from, `✅ Ton résumé arrivera chaque matin à ${h}h${rh[2] ? pad(m) : ''} (sauf Chabbat et fêtes).`);
    return true;
  }
  if (/^r[ée]sum[ée](?:\s+du\s+(?:jour|matin))?\s*[?.!]*$/i.test(t)) { await ctx.sendWhatsApp(from, await texteResume()); return true; }
  if (/^(?:pas de|stop|arr[êe]te(?:r)? le)\s+r[ée]sum[ée]/i.test(t)) {
    await ecrireConfig('heure_resume', 'off');
    await ctx.sendWhatsApp(from, '🔕 Plus de résumé le matin. Pour le remettre : « résumé 8h ».');
    return true;
  }
  return false;
}

async function handleAudio(from, message) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const mediaId = message.audio && message.audio.id;
  if (!mediaId) return false;
  if (!process.env.OPENAI_API_KEY) {
    await ctx.sendWhatsApp(from, "🎙️ Les messages vocaux ne sont pas encore activés : il faut ajouter la variable OPENAI_API_KEY sur Railway.\n\nEn attendant, écris : « tâche … »");
    return true;
  }
  try {
    const texte = await transcrire(mediaId);
    if (!texte) { await ctx.sendWhatsApp(from, "🎙️ Je n'ai rien entendu dans ce vocal. Tu peux réessayer ?"); return true; }
    // Un vocal peut aussi être une commande (« mes tâches », « fait 2 »)
    if (await handleText(from, texte)) return true;
    const liste = await ajouterDepuisTexte(texte, 'vocal');
    await ctx.sendWhatsApp(from, `🎙️ _« ${texte.slice(0, 300)}${texte.length > 300 ? '…' : ''} »_\n\n` + confirmation(liste));
  } catch (e) {
    console.error('Tâches — vocal :', e.message);
    await ctx.sendWhatsApp(from, `🎙️ Je n'ai pas réussi à écouter ce vocal (${e.message}). Écris plutôt : « tâche … »`);
  }
  return true;
}

// ─── Routes admin (page « Mon carnet ») ───────────────────────
function routes() {
  const app = ctx.app;
  const okPw = (req) => (req.query && req.query.password === ctx.adminPassword) || (req.body && req.body.password === ctx.adminPassword);
  app.get('/admin/taches', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    try {
      const r = await ctx.pool.query(`SELECT *, to_char(echeance,'YYYY-MM-DD') AS ech FROM taches
        WHERE statut='a_faire' OR (statut='fait' AND fait_le > NOW() - INTERVAL '14 days') ORDER BY created_at DESC LIMIT 500`);
      res.json({ ok: true, aujourdhui: aujourdhui(), dossiers: DOSSIERS, heure_resume: await lireConfig('heure_resume', HEURE_DEFAUT),
        taches: r.rows.map(x => ({ ...ligneVersTache(x), echeance: x.ech || null })) });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });
  // Ajout : soit une phrase libre (rangée par Claude), soit des champs précis
  app.post('/admin/taches', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    try {
      const b = req.body || {};
      if (b.texte) { const liste = await ajouterDepuisTexte(String(b.texte), 'admin'); return res.json({ ok: true, taches: liste }); }
      if (!b.titre) return res.json({ ok: false, message: 'Titre manquant' });
      const id = await inserer({ titre: String(b.titre).slice(0, 300), dossier: DOSSIERS.includes(b.dossier) ? b.dossier : 'Autre', echeance: b.echeance || null, heure: b.heure || null, personne: b.personne || null, notes: b.notes || null }, 'admin');
      res.json({ ok: true, id });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });
  app.post('/admin/taches/config', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    const h = String((req.body || {}).heure_resume || '');
    if (h !== 'off' && !/^\d{2}:\d{2}$/.test(h)) return res.json({ ok: false, message: 'Heure invalide' });
    await ecrireConfig('heure_resume', h);
    res.json({ ok: true, message: h === 'off' ? 'Résumé du matin désactivé' : `Résumé chaque matin à ${h.replace(':', 'h')}` });
  });
  app.post('/admin/taches/:id', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    try {
      const b = req.body || {}, champs = [], vals = [req.params.id];
      const set = (col, v) => { vals.push(v); champs.push(`${col}=$${vals.length}`); };
      if ('titre' in b) set('titre', String(b.titre || '').slice(0, 300) || 'Sans titre');
      if ('dossier' in b) set('dossier', DOSSIERS.includes(b.dossier) ? b.dossier : 'Autre');
      if ('echeance' in b) set('echeance', /^\d{4}-\d{2}-\d{2}$/.test(b.echeance || '') ? b.echeance : null);
      if ('heure' in b) { set('heure', /^\d{2}:\d{2}$/.test(b.heure || '') ? b.heure : null); champs.push('rappel_envoye=false'); }
      if ('personne' in b) set('personne', b.personne || null);
      if ('notes' in b) set('notes', b.notes || null);
      if ('statut' in b && ['a_faire', 'fait', 'supprime'].includes(b.statut)) { set('statut', b.statut); champs.push(b.statut === 'fait' ? 'fait_le=NOW()' : 'fait_le=NULL'); }
      if (!champs.length) return res.json({ ok: false, message: 'Rien à modifier' });
      const r = await ctx.pool.query(`UPDATE taches SET ${champs.join(', ')} WHERE id=$1 RETURNING id`, vals);
      res.json(r.rows.length ? { ok: true } : { ok: false, message: 'Tâche introuvable' });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });
}

function init(options) {
  ctx = options;
  creerTables()
    .then(() => { setTimeout(verifierChaqueMinute, 45000); setInterval(verifierChaqueMinute, 60000); })
    .catch(e => console.error('Tâches — tables :', e.message));
  routes();
  console.log('Mon carnet (tâches) prêt');
  return { handleText, handleAudio, vu };
}

module.exports = { init };
