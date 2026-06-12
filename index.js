const express = require('express');
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS infos (id SERIAL PRIMARY KEY, categorie TEXT, titre TEXT, contenu TEXT, instruction TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, phone TEXT, question TEXT, reponse TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS demandes (id SERIAL PRIMARY KEY, type TEXT, phone TEXT, data JSONB, statut TEXT DEFAULT 'nouveau', created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions_demande (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, type TEXT, etape INTEGER DEFAULT 0, reponses JSONB DEFAULT '{}', terminee BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages_traites (msg_id TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query('ALTER TABLE sessions_demande ADD COLUMN IF NOT EXISTS terminee BOOLEAN DEFAULT FALSE').catch(()=>{});
  await pool.query('DELETE FROM sessions_demande').catch(()=>{});
  console.log('Base de données prête');
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "shliah_beth_habad";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "habad2024";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const SYSTEM_PROMPT_BASE = `Tu t'appelles Shliah Bot, l'assistant virtuel du Beth Habad S. Maurice.
Tu représentes le Rav Levi Basanger, Shliah du Rabbi, et la Rebbetzin Myriam Basanger.
Tu réponds au nom du Beth Habad S. Maurice, situé au 30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice.
Tu parles en français ou en hébreu selon la langue du message reçu. Ton ton est chaleureux, accueillant, et authentiquement juif.
Pour toute question hala'hique ou urgence : oriente vers le Rav Levi directement au 07 70 24 17 46.
Écris toujours "Beth Habad S. Maurice" — jamais "Saint-Maurice" ni "Saint Maurice".
Réponds toujours court et direct, comme un SMS. Maximum 3-4 lignes. Va à l'essentiel.
N'utilise jamais d'astérisques * pour mettre en gras. Écris normalement sans formatage spécial.
Laisse toujours une ligne vide entre chaque information dans le message.
Pour la signature de fin : le vendredi uniquement écris "Chabbat Chalom !", tous les autres jours écris "Kol Touv !". Aucune autre formule.
Si tu ne connais pas la réponse, dis : "Je n'ai pas cette information. Contacte le Rav Levi au 07 70 24 17 46." Ne jamais inventer.

PRIERES - HORAIRES FIXES
En semaine (Lundi-Vendredi) : Chaharit 1er office 7h30, 2e office 9h00, Minha & Arvit 19h30
Dimanche : Chaharit 9h00
Chabbat : Entrée vendredi soir 19h30, Chaharit samedi 9h30, Kiddouch 12h30, Minha & Havdalah samedi après-midi

COURS DE TORAH
Tous les matins 8h30-9h30 : Guémara avec Rav Levi (hommes)
Lundi 20h30 : Guémara & Tanya avec Rav Levi (hommes)
Mardi 20h30 : Hassidout avec Reb Nehemia (hommes)
Mercredi 21h00 : Paracha avec Myriam Basanger (femmes)
Jeudi 21h00 : Hassidout mensuel (tous)

VERIFICATION TEFILINES & MEZOUZOT
Vérification Téfilines : 75 euros/paire, délai 2 semaines. On peut prêter une paire pendant la vérification si disponible.
Téfilines neuves : 480 euros/paire, sur commande
Mezouza neuve : 55 euros/pièce, immédiat
Vérification Mezouza : 9 euros/pièce, délai 5 jours
Pose à domicile possible sur demande

PETIT DEJEUNER DU MATIN
Formules : 50 euros, 150 euros, 250 euros
Demande d'abord pour quelle occasion (anniversaire, Bar Mitsva, Yartzeit, autre).
Lien de paiement : https://habad-s-maurice.kehila.io/don/0f8eb241-2a1e-40fa-8cfc-d81c4bffde63
Demander de mettre la raison dans les commentaires.

CONTACT
Beth Habad S. Maurice
30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice
Téléphone : 07 70 24 17 46`;

async function getFullPrompt(extra = null) {
  const now = new Date();
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const dateStr = `${jours[now.getDay()]} ${now.getDate()} ${mois[now.getMonth()]} ${now.getFullYear()}`;
  let prompt = `[AUJOURD'HUI : ${dateStr}]\n\n` + SYSTEM_PROMPT_BASE;
  try {
    const result = await pool.query('SELECT * FROM infos ORDER BY created_at DESC');
    if (result.rows.length > 0) {
      const labels = { priere: 'PRIÈRE', horaire: 'HORAIRE', cours: 'COURS DE TORAH', service: 'SERVICE', evenement: 'ÉVÉNEMENT', autre: 'INFORMATION' };
      const extras = result.rows.map(row => {
        let bloc = `--- ${labels[row.categorie] || 'INFO'} : ${row.titre.toUpperCase()} ---\n${row.contenu}`;
        if (row.instruction) bloc += `\nInstruction : ${row.instruction}`;
        return bloc;
      });
      prompt += "\n\n" + extras.join("\n\n");
    }
  } catch (e) { console.error('DB error:', e.message); }
  if (extra) prompt += "\n\n" + extra;
  return prompt;
}

async function getMikvaotFemmes() {
  try {
    const res = await fetch('https://www.loubavitch.fr/pratique/liste-des-mikves', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const texte = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return "LISTE DES MIKVAOT FEMMES :\n" + texte.substring(0, 3000);
  } catch (e) { return null; }
}

async function getEvenements() {
  try {
    const res = await fetch('https://habad-s-maurice.kehila.io/evenements', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const texte = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return "ÉVÉNEMENTS ACTUELS :\n" + texte.substring(0, 2000);
  } catch (e) { return null; }
}

// ─── SCRAPING CHABBAT — Torah-Box Paris ──────────────────────
async function getHorairesChabbat() {
  try {
    const res = await fetch('https://www.torah-box.com/calendrier/chabbat/paris-france_1.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' }
    });
    const html = await res.text();

    // Extraire le tableau des Chabbatot à venir
    // Format dans la page : "Vendredi 12 Juin 2026 | Chéla'h Lekha | 21:36 | 23:01"
    const tableMatch = html.match(/Les Chabbaths à venir[\s\S]*?<\/table>/i);
    if (!tableMatch) throw new Error('Tableau non trouvé');

    const lignes = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];

    // Date d'aujourd'hui pour trouver le prochain Chabbat
    const now = new Date();
    const today = now.getDay(); // 0=dim, 5=ven, 6=sam
    
    let prochainChabbat = null;

    for (const ligne of lignes) {
      // Extraire texte brut de la ligne
      const texte = ligne.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Chercher une ligne avec date + horaires (format: "Vendredi DD Mois YYYY Paracha HH:MM HH:MM")
      const match = texte.match(/Vendredi\s+(\d+\w*\s+\w+\s+\d{4})\s+(.*?)\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/i);
      if (match) {
        const dateStr = match[1].trim();
        const paracha = match[2].trim().replace(/[-\s]+/g, ' ');
        const entree = match[3];
        const sortie = match[4];

        // Parser la date
        const mois = { 'Janvier':0,'Février':1,'Mars':2,'Avril':3,'Mai':4,'Juin':5,'Juillet':6,'Août':7,'Septembre':8,'Octobre':9,'Novembre':10,'Décembre':11 };
        const dateParts = dateStr.match(/(\d+)\w*\s+(\w+)\s+(\d{4})/);
        if (dateParts) {
          const jour = parseInt(dateParts[1]);
          const moisIdx = mois[dateParts[2]];
          const annee = parseInt(dateParts[3]);
          if (moisIdx !== undefined) {
            const dateChabbat = new Date(annee, moisIdx, jour);
            // Prendre le premier Chabbat à venir (vendredi prochain ou ce vendredi)
            if (dateChabbat >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - (today === 6 ? 1 : 0))) {
              prochainChabbat = { dateStr: `Vendredi ${dateStr}`, paracha, entree, sortie };
              break;
            }
          }
        }
      }
    }

    if (prochainChabbat) {
      const { dateStr, paracha, entree, sortie } = prochainChabbat;
      const entreeFormatted = entree.replace(':', 'h');
      const sortieFormatted = sortie.replace(':', 'h');
      return `HORAIRES CHABBAT - PARIS (Torah-Box) :\n📅 ${dateStr}\n📖 Paracha ${paracha}\n🕯️ Entrée de Chabbat : ${entreeFormatted}\n✨ Sortie de Chabbat (Havdalah) : ${sortieFormatted}`;
    }

    // Fallback : extraire la première entrée/sortie trouvée
    const firstMatch = html.match(/Entrée à <strong>(\d{1,2}:\d{2})<\/strong>[\s\S]*?Sortie à <strong>(\d{1,2}:\d{2})<\/strong>/i);
    if (firstMatch) {
      return `HORAIRES CHABBAT - PARIS :\n🕯️ Entrée : ${firstMatch[1].replace(':','h')}\n✨ Sortie : ${firstMatch[2].replace(':','h')}`;
    }

    throw new Error('Données non trouvées');
  } catch (e) {
    console.error('Torah-Box scraping error:', e.message);
    // Fallback fr.chabad.org
    try {
      const res2 = await fetch('https://fr.chabad.org/calendar/candlelighting_cdo/locationId/394/locationType/1/jewish/Candle-Lighting.htm', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html2 = await res2.text();
      const texte2 = html2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const allumage = texte2.match(/(\d{1,2}[h:]\d{2})/);
      const parasha = texte2.match(/paracha[ht]?\s+([A-Za-zÀ-ÿ'\-]+)/i);
      if (allumage) return `HORAIRES CHABBAT - PARIS :\n📖 ${parasha ? 'Paracha ' + parasha[1] : ''}\n🕯️ Entrée : ${allumage[1]}\n✨ Sortie : voir fr.chabad.org`;
    } catch (e2) { console.error('Chabad fallback error:', e2.message); }
    return null;
  }
}

// Cache pour éviter de scraper à chaque message
let chabbatCache = { data: null, lastFetch: 0 };
async function getHorairesChabbatCached() {
  const now = Date.now();
  if (chabbatCache.data && (now - chabbatCache.lastFetch) < 3600000) return chabbatCache.data;
  const data = await getHorairesChabbat();
  if (data) { chabbatCache.data = data; chabbatCache.lastFetch = now; }
  return data;
}

function parleDeMikve(msg) { return ['mikve', 'mikvé', 'bain rituel'].some(m => msg.toLowerCase().includes(m)); }
function parleDevenements(msg) { return ['événement', 'evenement', 'agenda', 'programme', 'activité', 'activite', 'cette semaine', 'ce mois', 'soirée', 'soiree'].some(m => msg.toLowerCase().includes(m)); }
function parleDeChabbat(msg) {
  const lower = msg.toLowerCase();
  return ['chabbat', 'shabbat', 'allumage', 'bougie', 'havdalah', 'fin chabbat', 'rentre chabbat', 'entre chabbat', 'sortie chabbat', 'heure chabbat', 'quand chabbat', 'paracha', 'parasha'].some(m => lower.includes(m));
}

// ─── SYSTÈME DE DEMANDES ─────────────────────────────────────
const TYPES_DEMANDES = {
  cerfa: {
    label: 'Reçu Fiscal (Cerfa)',
    detecter: (msg) => { const lower = msg.toLowerCase(); return ['cerfa', 'reçu fiscal', 'recu fiscal', 'attestation don', 'déduction impôt', 'deduction impot'].some(m => lower.includes(m)); },
    questions: [{ cle: 'infos', question: '' }],
    messageDebut: () => `Pour votre reçu fiscal (Cerfa) :\n\nSi vous avez payé via Kehila ou AlloDons, téléchargez-le directement :\n👉 https://kehila.io/export-cerfas\n\n👉 https://www.allodons.fr/landing/pages/cerfa?locale=fr\n\nPour un virement ou autre paiement, envoyez-moi en un seul message :\n\n1. Société ou particulier ?\n2. Nom complet\n3. Adresse complète\n4. Email\n5. Montant du don\n6. Mode de paiement`
  },
  sefer_torah: {
    label: 'Lettre dans le Sefer Torah',
    detecter: (msg) => { const lower = msg.toLowerCase(); return ['sefer torah', 'séfer torah', 'lettre torah', 'lettre dans le sefer', 'sefer', 'lettre sefer'].some(m => lower.includes(m)); },
    questions: [{ cle: 'infos', question: '' }],
    messageDebut: () => `Pour inscrire une lettre dans le Sefer Torah, envoyez-moi en un seul message :\n\n1. Garçon ou fille\n2. Nom de famille\n3. Âge\n4. Prénom de la mère\n5. Adresse complète\n6. Téléphone`
  },
  location_salle: {
    label: 'Location de Salle',
    detecter: (msg) => { const lower = msg.toLowerCase(); return ['louer la salle', 'location salle', 'réserver la salle', 'reserver la salle', 'louer salle', 'réservation salle', 'reservation salle', 'salle disponible', 'disponibilité salle'].some(m => lower.includes(m)); },
    questions: [{ cle: 'infos', question: '' }],
    messageDebut: () => `Pour réserver la salle du Beth Habad S. Maurice, envoyez-moi en un seul message :\n\n1. Nom et prénom\n2. Date souhaitée\n3. Heure\n4. Type d'événement\n5. Téléphone`
  }
};

function detecterTypeDemande(msg) {
  for (const [type, config] of Object.entries(TYPES_DEMANDES)) { if (config.detecter(msg)) return type; }
  return null;
}

async function sauvegarderDemande(type, phone, texteLibre) {
  try {
    const data = { texte_libre: texteLibre, phone_whatsapp: '+' + phone };
    await pool.query('INSERT INTO demandes (type, phone, data) VALUES ($1, $2, $3)', [type, phone, JSON.stringify(data)]);
  } catch (e) { console.error('Demande save error:', e.message); }
}

async function envoyerEmailDemande(type, phone, texteLibre) {
  if (!GMAIL_APP_PASSWORD) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: 'bhsmaurice@gmail.com', pass: GMAIL_APP_PASSWORD } });
    const config = TYPES_DEMANDES[type];
    const label = config ? config.label : type;
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    await transporter.sendMail({
      from: '"Shliah Bot 🤖" <bhsmaurice@gmail.com>', to: 'bhsmaurice@gmail.com',
      subject: `📋 Nouvelle demande : ${label}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">📋 ${label}</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Date</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${dateStr}</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">WhatsApp</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>+${phone}</strong></td></tr><tr><td style="padding:8px;color:#666;vertical-align:top;">Message</td><td style="padding:8px;white-space:pre-wrap;"><strong>${texteLibre}</strong></td></tr></table></div>`
    });
  } catch (e) { console.error('Email error:', e.message); }
}

function getSignature() { const now = new Date(); return now.getDay() === 5 ? "Chabbat Chalom !" : "Kol Touv !"; }

// ─── WEBHOOK META ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from, text = message.text.body, msgId = message.id;
      try {
        const already = await pool.query('SELECT 1 FROM messages_traites WHERE msg_id=$1', [msgId]);
        if (already.rows.length > 0) return;
        await pool.query('INSERT INTO messages_traites (msg_id) VALUES ($1) ON CONFLICT DO NOTHING', [msgId]);
      } catch(e) { console.error('Dedup error:', e.message); }

      let reply, estUneDemande = false;
      let session = null;
      try { const sr = await pool.query('SELECT * FROM sessions_demande WHERE phone=$1', [from]); if (sr.rows.length > 0) session = sr.rows[0]; } catch(e) {}
      if (session && session.terminee) { await pool.query('DELETE FROM sessions_demande WHERE phone=$1', [from]).catch(()=>{}); session = null; }

      if (session) {
        estUneDemande = true;
        const config = TYPES_DEMANDES[session.type];
        let reponses = session.reponses || {};
        if (typeof reponses === 'string') { try { reponses = JSON.parse(reponses); } catch(e) { reponses = {}; } }
        const questions = config.questions, etapeActuelle = parseInt(session.etape) || 0;
        if (etapeActuelle < questions.length) reponses[questions[etapeActuelle].cle] = text;
        const prochaineEtape = etapeActuelle + 1;
        if (prochaineEtape < questions.length) {
          await pool.query('UPDATE sessions_demande SET etape=$1, reponses=$2 WHERE phone=$3', [prochaineEtape, JSON.stringify(reponses), from]);
          reply = questions[prochaineEtape].question;
        } else {
          await pool.query('UPDATE sessions_demande SET terminee=TRUE WHERE phone=$1', [from]);
          const recap = Object.entries(reponses).map(([k,v]) => k + ': ' + v).join('\n');
          await sauvegarderDemande(session.type, from, recap);
          envoyerEmailDemande(session.type, from, recap).catch(e => console.error('Email error:', e));
          reply = `Merci, votre demande a bien été reçue !\n\nNous vous contacterons très rapidement.\n\nSi c'est urgent : 07 70 24 17 46.\n\n${getSignature()}`;
        }
      } else {
        const typeDemande = detecterTypeDemande(text);
        if (typeDemande) {
          estUneDemande = true;
          const config = TYPES_DEMANDES[typeDemande];
          try {
            await pool.query('DELETE FROM sessions_demande WHERE phone=$1', [from]);
            await pool.query('INSERT INTO sessions_demande (phone, type, etape, reponses) VALUES ($1,$2,0,$3)', [from, typeDemande, '{}']);
          } catch(e) { console.error('Session start error:', e.message); }
          reply = config.messageDebut();
        } else {
          let extra = null;
          if (parleDeMikve(text)) extra = await getMikvaotFemmes();
          else if (parleDeChabbat(text)) extra = await getHorairesChabbatCached();
          else if (parleDevenements(text)) extra = await getEvenements();
          let historique = [];
          try { const hist = await pool.query('SELECT question, reponse FROM conversations WHERE phone=$1 ORDER BY created_at DESC LIMIT 5', [from]); historique = hist.rows.reverse(); } catch (e) {}
          reply = await askClaude(text, extra, historique);
        }
      }

      await sendWhatsApp(from, reply);
      if (!estUneDemande) {
        try { await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [from, text, reply]); } catch (e) {}
      }
    }
  }
});

// ─── API ADMIN ───────────────────────────────────────────────
app.post('/admin/add', async (req, res) => {
  const { password, categorie, titre, contenu, instruction } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!titre || !contenu) return res.status(400).json({ ok: false, message: "Titre et contenu requis" });
  await pool.query('INSERT INTO infos (categorie, titre, contenu, instruction) VALUES ($1, $2, $3, $4)', [categorie, titre, contenu, instruction || null]);
  const count = await pool.query('SELECT COUNT(*) FROM infos');
  res.json({ ok: true, message: "Information ajoutée avec succès !", total: parseInt(count.rows[0].count) });
});

app.get('/admin/list', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query('SELECT * FROM infos ORDER BY created_at DESC');
  const labels = { priere: 'PRIÈRE', horaire: 'HORAIRE', cours: 'COURS DE TORAH', service: 'SERVICE', evenement: 'ÉVÉNEMENT', autre: 'INFORMATION' };
  const infos = result.rows.map(row => { let bloc = `--- ${labels[row.categorie] || 'INFO'} : ${row.titre.toUpperCase()} ---\n${row.contenu}`; if (row.instruction) bloc += `\nInstruction : ${row.instruction}`; return bloc; });
  res.json({ ok: true, infos, rawInfos: result.rows, ids: result.rows.map(r => r.id), total: result.rows.length });
});

app.put('/admin/update/:id', async (req, res) => {
  const { password, categorie, titre, contenu, instruction } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('UPDATE infos SET categorie=$1, titre=$2, contenu=$3, instruction=$4 WHERE id=$5', [categorie, titre, contenu, instruction || null, req.params.id]);
  res.json({ ok: true, message: "Information mise à jour !" });
});

app.delete('/admin/delete/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM infos WHERE id = $1', [req.params.id]);
  res.json({ ok: true, message: "Supprimé" });
});

app.get('/admin/conversations', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50');
  res.json({ ok: true, conversations: result.rows });
});

app.get('/admin/demandes', async (req, res) => {
  const { password, type } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  let query = 'SELECT * FROM demandes'; const params = [];
  if (type) { query += ' WHERE type = $1'; params.push(type); }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json({ ok: true, demandes: result.rows, types: Object.keys(TYPES_DEMANDES).map(k => ({ key: k, label: TYPES_DEMANDES[k].label })) });
});

app.put('/admin/demandes/:id/statut', async (req, res) => {
  const { password, statut } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('UPDATE demandes SET statut = $1 WHERE id = $2', [statut, req.params.id]);
  res.json({ ok: true, message: "Statut mis à jour" });
});

app.delete('/admin/demandes/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM demandes WHERE id = $1', [req.params.id]);
  res.json({ ok: true, message: "Supprimé définitivement" });
});

// ─── BROADCAST ───────────────────────────────────────────────
app.get('/admin/broadcast/contacts', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT DISTINCT phone FROM conversations ORDER BY phone');
    res.json({ ok: true, count: result.rows.length, phones: result.rows.map(r => r.phone) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/admin/broadcast/send', async (req, res) => {
  const { password, mode, paracha, date, entree, sortie, texte_libre, phone_unique } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    // Mode envoi unique ou broadcast
    let phones = [];
    if (phone_unique) {
      const clean = phone_unique.replace(/[\s\+\-\.]/g, '');
      phones = [clean];
    } else {
      const result = await pool.query('SELECT DISTINCT phone FROM conversations ORDER BY phone');
      phones = result.rows.map(r => r.phone);
    }
    if (phones.length === 0) return res.json({ ok: false, message: "Aucun contact trouvé" });

    let envoyes = 0, erreurs = 0;
    for (const phone of phones) {
      try {
        let body;
        if (mode === 'chabbat') {
          body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'broadcast_chabbat', language: { code: 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text: paracha || '' }, { type: 'text', text: date || '' }, { type: 'text', text: entree || '' }, { type: 'text', text: sortie || '' }] }] } });
        } else {
          body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: texte_libre || '' } });
        }
        const response = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body });
        const data = await response.json();
        if (data.messages) envoyes++; else { erreurs++; console.error(`Broadcast erreur ${phone}:`, JSON.stringify(data)); }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) { erreurs++; }
    }
    res.json({ ok: true, total: phones.length, envoyes, erreurs, message: `${envoyes} messages envoyés, ${erreurs} erreurs` });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ─── CHABBAT INFO (pour l'admin panel) ───────────────────────
app.get('/admin/chabbat', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const data = await getHorairesChabbat();
  res.json({ ok: true, data });
});

// ─── CLAUDE ──────────────────────────────────────────────────
async function askClaude(userMessage, extra = null, historique = []) {
  try {
    const systemPrompt = await getFullPrompt(extra);
    const messages = [];
    historique.forEach(h => { messages.push({ role: 'user', content: h.question }); messages.push({ role: 'assistant', content: h.reponse }); });
    messages.push({ role: 'user', content: userMessage });
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: systemPrompt, messages }) });
    const data = await response.json();
    if (data.content && data.content[0]) return data.content[0].text;
    return "Erreur: " + JSON.stringify(data);
  } catch (e) { return "Erreur: " + e.message; }
}

async function sendWhatsApp(to, message) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }) });
}

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`Shliah Bot actif sur port ${PORT}`)));
