const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "shliah_beth_habad";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "habad2024";

const SYSTEM_PROMPT_BASE = `Tu es l'assistant virtuel du Beth Habad Saint-Maurice, représentant le Rav Levi Basanger, Shliah du Rabbi, et la Rebbetzin Myriam Basanger.
Tu réponds au nom du Beth Habad Saint-Maurice, situé au 30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice.
Tu parles en français ou en hébreu selon la langue du message reçu. Ton ton est chaleureux, accueillant, et authentiquement juif.
Pour toute question hala'hique ou urgence : oriente vers le Rav Levi directement au 07 70 24 17 46.
Termine chaque message par une note positive : Chabbat Chalom, Bonne semaine, A bientôt au Beth Habad !

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
Vérification Téfilines : 50 euros/paire, délai 3 semaines
Téfilines neuves : 480 euros/paire, sur commande
Mezouza neuve : 55 euros/pièce, immédiat
Vérification Mezouza : 9 euros/pièce, délai 5 jours
Pose à domicile possible sur demande

CONTACT
Beth Habad Saint-Maurice
30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice
Téléphone : 07 70 24 17 46`;

// Stockage en mémoire des infos ajoutées via l'admin
let extraInfos = [];

function getFullPrompt() {
  if (extraInfos.length === 0) return SYSTEM_PROMPT_BASE;
  return SYSTEM_PROMPT_BASE + "\n\n" + extraInfos.join("\n\n");
}

// ─── WEBHOOK META ───────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      const reply = await askClaude(text);
      await sendWhatsApp(from, reply);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ─── API ADMIN ───────────────────────────────────────────────

// Ajouter une info
app.post('/admin/add', (req, res) => {
  const { password, categorie, titre, contenu, instruction } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  }
  if (!titre || !contenu) {
    return res.status(400).json({ ok: false, message: "Titre et contenu requis" });
  }
  const labels = {
    priere: 'PRIÈRE', horaire: 'HORAIRE', cours: 'COURS DE TORAH',
    service: 'SERVICE', evenement: 'ÉVÉNEMENT', autre: 'INFORMATION'
  };
  let bloc = `--- ${labels[categorie] || 'INFO'} : ${titre.toUpperCase()} ---\n${contenu}`;
  if (instruction) bloc += `\nInstruction : ${instruction}`;
  extraInfos.push(bloc);
  res.json({ ok: true, message: "Information ajoutée avec succès !", total: extraInfos.length });
});

// Voir toutes les infos ajoutées
app.get('/admin/list', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  }
  res.json({ ok: true, infos: extraInfos, total: extraInfos.length });
});

// Supprimer une info par index
app.delete('/admin/delete/:index', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  }
  const i = parseInt(req.params.index);
  if (i < 0 || i >= extraInfos.length) {
    return res.status(400).json({ ok: false, message: "Index invalide" });
  }
  extraInfos.splice(i, 1);
  res.json({ ok: true, message: "Supprimé", total: extraInfos.length });
});

// ─── CLAUDE ──────────────────────────────────────────────────
async function askClaude(userMessage) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: getFullPrompt(),
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) return data.content[0].text;
    return "Erreur: " + JSON.stringify(data);
  } catch (e) {
    return "Erreur: " + e.message;
  }
}

async function sendWhatsApp(to, message) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    })
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent Shliah actif sur port ${PORT}`));
