// ═══════════════════════════════════════════════════════════════
// RÉPERTOIRE SÉCURISÉ — personnes + métiers (Shliah Bot)
// ───────────────────────────────────────────────────────────────
// • "numéro de Igal"  -> donne le numéro (ou propose un choix s'il y en a plusieurs)
// • "plombier"        -> donne directement le(s) plombier(s)
// • "répertoire"      -> petit menu d'aide
// Sécurité : numéro connu dans la base + question sur le Beth Habad
// (premier minyan en semaine = 7h30). Une fois validé, c'est pour toujours.
// ═══════════════════════════════════════════════════════════════

const QUESTION_SECURITE =
  "🔒 Le répertoire est réservé à la communauté.\n\n" +
  "Petite question : à quelle heure est le premier minyan (Cha'harit) au Beth Habad en semaine ?";
const MAX_ESSAIS = 3;            // après 3 mauvaises réponses : bloqué
const MAX_RECHERCHES_JOUR = 20;  // anti-aspiration du répertoire
const MAX_CHOIX = 8;             // au-delà on demande de préciser
const DUREE_SESSION_MS = 15 * 60 * 1000;

let pool, sendWhatsApp, isAdmin, adminPhone;
const sessions = {}; // phone -> { etape: 'question' | 'choix', ... }

// ─── Outils texte / téléphone ─────────────────────────────────
function normaliser(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’\-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// tolère les lettres doublées (Moshe / Mosshe, Hanna / Hana)
function simplifier(mot) { return mot.replace(/(.)\1+/g, '$1'); }
function singulier(mot) { return mot.length > 3 && /[sx]$/.test(mot) ? mot.slice(0, -1) : mot; }

function normaliserTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '33' + d.slice(1);
  return d;
}
function afficherTel(d) {
  d = String(d || '');
  if (d.startsWith('33') && d.length === 11) return ('0' + d.slice(2)).replace(/(\d{2})(?=\d)/g, '$1 ');
  return '+' + d;
}
function signature() {
  const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return paris.getDay() === 5 ? 'Chabbat Chalom !' : 'Kol Touv !';
}
function nomComplet(p) { return [p.prenom, p.nom].filter(Boolean).join(' '); }
function metiersDe(p) { return String(p.metier || '').split(',').map(m => m.trim()).filter(Boolean); }
function surnomsDe(p) { return String(p.surnoms || '').split(',').map(m => m.trim()).filter(Boolean); }

function fiche(p) {
  let txt = '👤 ' + nomComplet(p);
  if (p.surnoms) txt += '\n🗣️ Appelé : ' + surnomsDe(p).join(', ');
  if (p.ville) txt += '\n📍 ' + p.ville;
  if (p.metier) txt += '\n🔧 ' + metiersDe(p).join(', ');
  txt += '\n📞 ' + afficherTel(p.telephone);
  if (p.note) txt += '\nℹ️ ' + p.note;
  return txt;
}

// ─── Base de données ──────────────────────────────────────────
async function initTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS repertoire (
    id SERIAL PRIMARY KEY, prenom TEXT NOT NULL, nom TEXT, ville TEXT,
    telephone TEXT NOT NULL, metier TEXT, note TEXT, actif BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query('ALTER TABLE repertoire ADD COLUMN IF NOT EXISTS surnoms TEXT');
  // Villes mal écrites dans l'import du 14/10/2026
  const VILLES_A_CORRIGER = {"Charenton.": "Charenton-le-Pont", "Charenton-le-Pobt": "Charenton-le-Pont", "Charenton-le": "Charenton-le-Pont", "Charenton-la-Pont": "Charenton-le-Pont", "Charenton-Me-Pont": "Charenton-le-Pont", "Charenton-L'ecole": "Charenton-le-Pont", "Nogent-sur-Marbe": "Nogent-sur-Marne", "Nogent": "Nogent-sur-Marne", "Neuilly/seine": "Neuilly-sur-Seine", "Neuilly": "Neuilly-sur-Seine", "Neilly-sur-Seine": "Neuilly-sur-Seine", "Courbevois": "Courbevoie", "Alfortivlle": "Alfortville", "Bonneuilsurmarne": "Bonneuil-sur-Marne", "Limeil-Brevannes": "Limeil-Brévannes", "Perreux-sur-Marne": "Le Perreux-sur-Marne", "75014-Paris": "Paris", "2e-Arrondissement": "Paris", "95200": "Sarcelles", "92300": "Levallois-Perret", "Boulogne": "Boulogne-Billancourt", "St-Laurent-du-Var": "Saint-Laurent-du-Var", "Epinay-sur-Seine": "Épinay-sur-Seine", "Chatillon": "Châtillon", "Chennevieres-sur-Marne": "Chennevières-sur-Marne", "Jerusalem": "Jérusalem"};
  for (const [faux, juste] of Object.entries(VILLES_A_CORRIGER)) {
    await pool.query('UPDATE repertoire SET ville = $2 WHERE ville = $1', [faux, juste]);
  }
  // Doublons (même numéro) : on garde la fiche la plus ancienne, puis on empêche les nouveaux doublons
  const dbl = await pool.query('DELETE FROM repertoire a USING repertoire b WHERE a.telephone = b.telephone AND a.id > b.id');
  if (dbl.rowCount) console.log('📒 Répertoire : ' + dbl.rowCount + ' doublon(s) supprimé(s)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS repertoire_telephone_unique ON repertoire (telephone)');
  await pool.query(`CREATE TABLE IF NOT EXISTS repertoire_acces (
    phone TEXT PRIMARY KEY, statut TEXT DEFAULT 'en_attente', essais INTEGER DEFAULT 0,
    valide_le TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS repertoire_logs (
    id SERIAL PRIMARY KEY, phone TEXT, recherche TEXT, resultat TEXT,
    created_at TIMESTAMP DEFAULT NOW())`);
  console.log('📒 Répertoire prêt');
}

async function log(phone, recherche, resultat) {
  try {
    await pool.query('INSERT INTO repertoire_logs (phone, recherche, resultat) VALUES ($1,$2,$3)', [phone, recherche, resultat]);
  } catch (e) { console.error('Log répertoire:', e.message); }
}

async function quotaDepasse(phone) {
  if (isAdmin(phone)) return false;
  const depuis = new Date(Date.now() - 24 * 3600 * 1000);
  const r = await pool.query('SELECT COUNT(*) AS n FROM repertoire_logs WHERE phone=$1 AND created_at > $2', [phone, depuis]);
  return parseInt(r.rows[0].n, 10) >= MAX_RECHERCHES_JOUR;
}

// ─── Recherche ────────────────────────────────────────────────
const MOTS_VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'a', 'qui', 'habite', 'et', 'mr', 'mme', 'monsieur', 'madame']);

async function chercherPersonnes(recherche) {
  const mots = normaliser(recherche).split(' ').filter(m => m.length >= 2 && !MOTS_VIDES.has(m)).map(simplifier);
  if (!mots.length) return [];
  const cherche = simplifier(normaliser(recherche));
  const r = await pool.query('SELECT * FROM repertoire WHERE actif = TRUE ORDER BY prenom, nom');
  return r.rows.filter(p => {
    if (surnomsDe(p).some(sn => simplifier(normaliser(sn)) === cherche)) return true;
    const champs = normaliser(`${p.prenom || ''} ${p.nom || ''} ${p.ville || ''} ${(p.surnoms || '').replace(/,/g, ' ')}`).split(' ').filter(Boolean).map(simplifier);
    return mots.every(m => champs.some(c => c === m || (m.length >= 3 && c.startsWith(m))));
  });
}

let cacheMetiers = { liste: null, t: 0 };
async function getMetiers() {
  if (cacheMetiers.liste && Date.now() - cacheMetiers.t < 60000) return cacheMetiers.liste;
  const r = await pool.query(`SELECT metier FROM repertoire WHERE actif = TRUE AND COALESCE(TRIM(metier),'') <> ''`);
  const set = new Set();
  r.rows.forEach(row => metiersDe(row).forEach(m => set.add(m.toLowerCase())));
  cacheMetiers = { liste: Array.from(set).sort(), t: Date.now() };
  return cacheMetiers.liste;
}
function viderCacheMetiers() { cacheMetiers = { liste: null, t: 0 }; }

// "plombier", "je cherche un plombier", "un serrurier svp" -> métier trouvé
async function trouverMetier(text) {
  const mots = normaliser(text).split(' ').filter(Boolean);
  if (!mots.length || mots.length > 6) return null; // phrase longue = vraie question, on laisse Claude
  const motsMsg = new Set(mots.map(m => simplifier(singulier(m))));
  const metiers = await getMetiers();
  for (const metier of metiers) {
    const motsMetier = normaliser(metier).split(' ').filter(w => w.length >= 3).map(w => simplifier(singulier(w)));
    if (motsMetier.length && motsMetier.every(w => motsMsg.has(w))) return metier;
  }
  return null;
}

async function chercherParMetier(metier) {
  const cible = simplifier(singulier(normaliser(metier)));
  const r = await pool.query('SELECT * FROM repertoire WHERE actif = TRUE ORDER BY prenom, nom');
  return r.rows.filter(p => metiersDe(p).some(m => simplifier(singulier(normaliser(m))) === cible));
}

// "numéro de Igal", "tu as le tel d'Igal Cohen ?", "téléphone de Moshe stp"
function extraireNomRecherche(text) {
  const t = normaliser(text);
  const m = t.match(/\b(?:numero|num|telephone|tel|portable|coordonnees|contact)\b(?:\s+(?:de|du|d|a|pour))?(?:\s+(?:telephone|tel|portable))?(?:\s+(?:de|du|d|a))?\s+(.+)$/);
  if (!m) return null;
  let nom = m[1];
  // questions sur le Beth Habad lui-même -> on laisse le bot normal répondre
  if (/\b(beth|habad|synagogue|shul|rav levi|rav|rabbin|vous|toi|bot|rebbetzin|myriam)\b/.test(nom)) return null;
  nom = nom
    .replace(/\b(stp|svp|merci|please|s il te plait|s il vous plait|beaucoup|urgent|vite|svp)\b/g, ' ')
    .replace(/\b(le|la|monsieur|madame|mr|mme)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // un numéro, une adresse ou une longue phrase -> ce n'est pas une recherche de personne
  if (/\d/.test(nom) || nom.split(' ').length > 4) return null;
  return nom.length >= 2 ? nom : null;
}

// ─── Sécurité ─────────────────────────────────────────────────
function bonneReponse(text) {
  const t = normaliser(text).replace(/\s/g, '');
  return /(^|[^0-9])7(h|heures?)?30/.test(t)
    || /(^|[^0-9])7(h|heures?)etdemi/.test(t)
    || /sept(h|heures?)(trente|etdemi)/.test(t);
}

async function getAcces(phone) {
  const r = await pool.query('SELECT * FROM repertoire_acces WHERE phone=$1', [phone]);
  return r.rows[0] || null;
}
async function estValide(phone) {
  if (isAdmin(phone)) return true;
  const a = await getAcces(phone);
  return !!(a && a.statut === 'valide');
}
// Le numéro est "connu" s'il a un nom dans tes contacts (import / fiche admin) ou s'il est lui-même dans le répertoire
async function numeroConnu(phone) {
  const c = await pool.query(
    `SELECT 1 FROM contacts WHERE phone=$1 AND (COALESCE(TRIM(nom),'') <> '' OR COALESCE(TRIM(prenom),'') <> '') LIMIT 1`, [phone]);
  if (c.rows.length) return true;
  const r = await pool.query('SELECT 1 FROM repertoire WHERE telephone=$1 LIMIT 1', [phone]);
  return r.rows.length > 0;
}

async function prevenirAdmin(texte) {
  try { if (adminPhone) await sendWhatsApp(adminPhone, texte); } catch (e) { console.error('Alerte admin répertoire:', e.message); }
}

// Renvoie true si la personne peut accéder tout de suite
async function verifierAcces(from, demande) {
  if (isAdmin(from)) return true;
  const a = await getAcces(from);
  if (a && a.statut === 'valide') return true;

  if (a && a.statut === 'bloque') {
    await sendWhatsApp(from, "L'accès au répertoire n'est pas disponible pour ce numéro.\n\nPour toute demande : Rav Levi au 07 70 24 17 46.\n\n" + signature());
    return false;
  }

  if (!(await numeroConnu(from))) {
    await pool.query(
      `INSERT INTO repertoire_acces (phone, statut) VALUES ($1,'inconnu') ON CONFLICT (phone) DO NOTHING`, [from]);
    await sendWhatsApp(from,
      "Le répertoire est réservé aux membres de la communauté du Beth Habad S. Maurice.\n\n" +
      "Ton numéro n'est pas encore enregistré chez nous. Le Rav Levi va regarder ta demande.\n\n" + signature());
    if (!a) await prevenirAdmin(`📒 Demande d'accès au répertoire\n\n+${from} n'est pas dans la base.\n\nPour l'accepter : page Répertoire > onglet Accès.`);
    return false;
  }

  await pool.query(
    `INSERT INTO repertoire_acces (phone, statut) VALUES ($1,'en_attente') ON CONFLICT (phone) DO NOTHING`, [from]);
  sessions[from] = { etape: 'question', demande, expire: Date.now() + DUREE_SESSION_MS };
  await sendWhatsApp(from, QUESTION_SECURITE);
  return false;
}

async function gererReponseQuestion(from, text, s) {
  if (bonneReponse(text)) {
    delete sessions[from];
    await pool.query(
      `INSERT INTO repertoire_acces (phone, statut, valide_le) VALUES ($1,'valide',NOW())
       ON CONFLICT (phone) DO UPDATE SET statut='valide', valide_le=NOW()`, [from]);
    await sendWhatsApp(from, '✅ Merci, accès validé !');
    await executer(from, s.demande);
    return true;
  }
  const r = await pool.query(
    `UPDATE repertoire_acces SET essais = essais + 1 WHERE phone=$1 RETURNING essais`, [from]);
  const essais = r.rows[0] ? r.rows[0].essais : MAX_ESSAIS;
  if (essais >= MAX_ESSAIS) {
    delete sessions[from];
    await pool.query(`UPDATE repertoire_acces SET statut='bloque' WHERE phone=$1`, [from]);
    await sendWhatsApp(from, "Ce n'est pas la bonne réponse.\n\nL'accès au répertoire est bloqué pour ce numéro. Contacte le Rav Levi au 07 70 24 17 46.\n\n" + signature());
    await prevenirAdmin(`📒 Répertoire : +${from} a été bloqué après ${MAX_ESSAIS} mauvaises réponses.`);
    return true;
  }
  const reste = MAX_ESSAIS - essais;
  await sendWhatsApp(from, `Ce n'est pas la bonne réponse. Il te reste ${reste} essai${reste > 1 ? 's' : ''}.\n\nÀ quelle heure est le premier minyan en semaine ?`);
  return true;
}

// ─── Réponses ─────────────────────────────────────────────────
async function executer(from, demande) {
  if (demande.type === 'menu') {
    const metiers = await getMetiers();
    let msg = "📒 Répertoire du Beth Habad S. Maurice\n\n" +
      "Pour une personne, écris par exemple :\nnuméro de Igal\n\n" +
      "Pour un professionnel, écris simplement le métier :\nplombier, serrurier...";
    if (metiers.length) msg += '\n\nMétiers disponibles : ' + metiers.join(', ');
    await sendWhatsApp(from, msg);
    return;
  }

  if (await quotaDepasse(from)) {
    await sendWhatsApp(from, "Tu as fait beaucoup de recherches aujourd'hui. Réessaie demain, ou contacte le Rav Levi au 07 70 24 17 46.\n\n" + signature());
    return;
  }

  if (demande.type === 'metier') {
    const res = await chercherParMetier(demande.valeur);
    await log(from, 'metier: ' + demande.valeur, res.map(p => p.id).join(',') || 'aucun');
    if (!res.length) { await sendWhatsApp(from, `Je n'ai personne pour « ${demande.valeur} » dans le répertoire.\n\n` + signature()); return; }
    const titre = res.length > 1 ? `🔧 ${res.length} contacts pour « ${demande.valeur} » :` : `🔧 ${demande.valeur} :`;
    await sendWhatsApp(from, titre + '\n\n' + res.slice(0, MAX_CHOIX).map(fiche).join('\n\n') + '\n\n' + signature());
    return;
  }

  if (demande.type === 'nom') {
    const res = await chercherPersonnes(demande.valeur);
    if (!res.length) {
      await log(from, 'nom: ' + demande.valeur, 'aucun');
      await sendWhatsApp(from, `Je n'ai pas trouvé « ${demande.valeur} » dans le répertoire.\n\nEssaie avec le prénom et le nom de famille.`);
      return;
    }
    if (res.length === 1) {
      await log(from, 'nom: ' + demande.valeur, String(res[0].id));
      await sendWhatsApp(from, fiche(res[0]) + '\n\n' + signature());
      return;
    }
    if (res.length > MAX_CHOIX) {
      await log(from, 'nom: ' + demande.valeur, 'trop: ' + res.length);
      await sendWhatsApp(from, `J'ai ${res.length} personnes pour « ${demande.valeur} ».\n\nPrécise le nom de famille ou la ville, par exemple :\nnuméro de ${demande.valeur} Cohen`);
      return;
    }
    await proposerChoix(from, res, demande.valeur);
  }
}

async function proposerChoix(from, res, recherche) {
  sessions[from] = { etape: 'choix', resultats: res, recherche, expire: Date.now() + DUREE_SESSION_MS };
  const liste = res.map((p, i) => `${i + 1}. ${nomComplet(p)}${p.surnoms ? ' (' + surnomsDe(p).join(', ') + ')' : ''}${p.ville ? ' — ' + p.ville : ''}`).join('\n');
  await sendWhatsApp(from, `J'en ai ${res.length} :\n\n${liste}\n\nRéponds avec le chiffre (ou la ville).`);
}

// Renvoie true si le message a été traité comme un choix
async function gererChoix(from, text, s) {
  const t = normaliser(text);
  if (/^\d{1,2}$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 1 && n <= s.resultats.length) {
      const p = s.resultats[n - 1];
      delete sessions[from];
      await log(from, 'nom: ' + s.recherche, String(p.id));
      await sendWhatsApp(from, fiche(p) + '\n\n' + signature());
    } else {
      await sendWhatsApp(from, `Réponds avec un chiffre entre 1 et ${s.resultats.length}.`);
    }
    return true;
  }
  if (t.length >= 3) {
    const parVille = s.resultats.filter(p => p.ville && normaliser(p.ville).includes(t));
    if (parVille.length === 1) {
      delete sessions[from];
      await log(from, 'nom: ' + s.recherche + ' / ville: ' + t, String(parVille[0].id));
      await sendWhatsApp(from, fiche(parVille[0]) + '\n\n' + signature());
      return true;
    }
    if (parVille.length > 1) { await proposerChoix(from, parVille, s.recherche); return true; }
  }
  return false; // la personne parle d'autre chose
}

// ─── Point d'entrée appelé par index.js ───────────────────────
// Renvoie true si le message a été traité par le répertoire
async function handle(from, text) {
  try {
    if (sessions[from] && Date.now() > sessions[from].expire) delete sessions[from];
    const s = sessions[from];
    const t = normaliser(text);

    if (s && /^(stop|annuler|annule|quitter|sortir)$/.test(t)) {
      delete sessions[from];
      await sendWhatsApp(from, "C'est annulé.\n\n" + signature());
      return true;
    }
    if (s && s.etape === 'question') return await gererReponseQuestion(from, text, s);
    if (s && s.etape === 'choix') {
      if (await gererChoix(from, text, s)) return true;
      delete sessions[from];
    }

    // La personne est en train de remplir une demande (Cerfa, salle...) : on ne l'interrompt pas
    try {
      const enCours = await pool.query('SELECT 1 FROM sessions_demande WHERE phone=$1 AND terminee = FALSE LIMIT 1', [from]);
      if (enCours.rows.length) return false;
    } catch (e) { /* table absente : on continue */ }

    let demande = null;
    if (/\b(repertoire|annuaire)\b/.test(t)) {
      demande = { type: 'menu' };
    } else {
      const nom = extraireNomRecherche(text);
      if (nom) {
        // personne trouvée, ou personne déjà validée -> on gère ; sinon on laisse le bot normal répondre
        if ((await chercherPersonnes(nom)).length || (await estValide(from))) demande = { type: 'nom', valeur: nom };
      }
      if (!demande) {
        const metier = await trouverMetier(text);
        if (metier) demande = { type: 'metier', valeur: metier };
      }
    }
    if (!demande) return false;

    if (!(await verifierAcces(from, demande))) return true;
    await executer(from, demande);
    return true;
  } catch (e) {
    console.error('Répertoire error:', e.message);
    return false;
  }
}

function init(deps) {
  pool = deps.pool;
  sendWhatsApp = deps.sendWhatsApp;
  isAdmin = deps.isAdmin || (() => false);
  adminPhone = deps.adminPhone || null;
  initTables().catch(e => console.error('Init répertoire:', e.message));
  require('./repertoire.admin').init({
    app: deps.app, pool, adminPassword: deps.adminPassword,
    normaliserTel, viderCacheMetiers,
  });
}

module.exports = { init, handle, _test: { normaliser, extraireNomRecherche, bonneReponse, afficherTel, normaliserTel, trouverMetier, chercherPersonnes } };
