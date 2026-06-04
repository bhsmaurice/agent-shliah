const express = require('express');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS infos (
      id SERIAL PRIMARY KEY,
      categorie TEXT,
      titre TEXT,
      contenu TEXT,
      instruction TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      phone TEXT,
      question TEXT,
      reponse TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Base de données prête');
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "shliah_beth_habad";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "habad2024";

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
  let prompt = SYSTEM_PROMPT_BASE;
  try {
    const result = await pool.query('SELECT * FROM infos ORDER BY created_at ASC');
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

function parleDeMikve(msg) {
  return ['mikve', 'mikvé', 'bain rituel'].some(m => msg.toLowerCase().includes(m));
}

function parleDevenements(msg) {
  return ['événement', 'evenement', 'agenda', 'programme', 'activité', 'activite', 'cette semaine', 'ce mois', 'soirée', 'soiree'].some(m => msg.toLowerCase().includes(m));
}

// ─── WEBHOOK META ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      let extra = null;
      if (parleDeMikve(text)) extra = await getMikvaotFemmes();
      else if (parleDevenements(text)) extra = await getEvenements();
      const reply = await askClaude(text, extra);
      await sendWhatsApp(from, reply);
      // Sauvegarder la conversation
      try {
        await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [from, text, reply]);
      } catch (e) { console.error('Conv save error:', e.message); }
    }
    res.sendStatus(200);
  } else res.sendStatus(404);
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
  const result = await pool.query('SELECT * FROM infos ORDER BY created_at ASC');
  const labels = { priere: 'PRIÈRE', horaire: 'HORAIRE', cours: 'COURS DE TORAH', service: 'SERVICE', evenement: 'ÉVÉNEMENT', autre: 'INFORMATION' };
  const infos = result.rows.map(row => {
    let bloc = `--- ${labels[row.categorie] || 'INFO'} : ${row.titre.toUpperCase()} ---\n${row.contenu}`;
    if (row.instruction) bloc += `\nInstruction : ${row.instruction}`;
    return bloc;
  });
  res.json({ ok: true, infos, ids: result.rows.map(r => r.id), total: result.rows.length });
});

app.delete('/admin/delete/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM infos WHERE id = $1', [req.params.id]);
  res.json({ ok: true, message: "Supprimé" });
});

// Voir les conversations
app.get('/admin/conversations', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50');
  res.json({ ok: true, conversations: result.rows });
});

// ─── CLAUDE ──────────────────────────────────────────────────
async function askClaude(userMessage, extra = null) {
  try {
    const systemPrompt = await getFullPrompt(extra);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] })
    });
    const data = await response.json();
    if (data.content && data.content[0]) return data.content[0].text;
    return "Erreur: " + JSON.stringify(data);
  } catch (e) { return "Erreur: " + e.message; }
}

async function sendWhatsApp(to, message) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
  });
}

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`Shliah Bot actif sur port ${PORT}`)));
