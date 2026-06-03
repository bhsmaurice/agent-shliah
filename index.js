const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "shliah_beth_habad";
const WHATSAPP_TOKEN = "EAA7xa4ZCBA7ABRsvAJuW71eSJRDAPfqYJ9leoKABQ5H2YmZAVIfYFQYhb6ggpZAxU59zMHIQMFIZAha6t59FieAo89TVXlXfnTmDqKedhDRXkTOAwYvNHA3eIN1bmdI3BAydkLsgKDYmm3AicF0NBQu4qeJaWj5DiGvUu72GuAVZCX7vUXkzVaY3JIefpvjwGgXQGxa8TpGjZCqwGeffxY2x80TaZBoCiNSJFtKrE5IztTILatWSJJjtAQbb4vEKZBDaAEEWZCukSNZCjVupKAde29EOYjKHJTkm6QaFcZD";
const ANTHROPIC_API_KEY = "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";
const PHONE_NUMBER_ID = "1130585603476547";

const SYSTEM_PROMPT = `Tu es l'assistant virtuel du Beth Habad Saint-Maurice, représentant le Rav Levi Basanger, Shliah du Rabbi, et la Rebbetzin Myriam Basanger.
Tu réponds au nom du Beth Habad Saint-Maurice, situé au 30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice.
Tu parles en français ou en hébreu selon la langue du message reçu. Ton ton est chaleureux, accueillant, et authentiquement juif.
Pour toute question hala'hique ou urgence : oriente vers le Rav Levi directement.
Termine chaque message par une note positive : Chabbat Chalom, Bonne semaine, A bientôt au Beth Habad !`;

// Vérification webhook Meta
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

// Réception des messages WhatsApp
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await response.json();
    return data.content[0].text;
  } catch (e) {
    return "Désolé, une erreur s'est produite. Contactez le Rav Levi directement.";
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
