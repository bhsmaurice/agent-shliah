const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "shliah_beth_habad";
const WHATSAPP_TOKEN = "EAA7xa4ZCBA7ABRu33NwnDHQZCsoC1h2oxiCLnG7F7BZBZC5XmFe0zwI3BUOmclJOyTNvviCjzlDwR2qpXEZCLHqepSZBkweySBSDNI09NvQoL42s7GEJZC0QC2OtrHZAfLIj4nVmLqKpM81f6XaswAXs395vZBnsGmheesgQFIZB4jbZBKjSWvHUWIMKeERyvcEe7qGIAZDZD";
const ANTHROPIC_API_KEY = "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";
const PHONE_NUMBER_ID = "1130585603476547";

const SYSTEM_PROMPT = `Tu es l'assistant virtuel du Beth Habad Saint-Maurice, représentant le Rav Levi Basanger, Shliah du Rabbi, et la Rebbetzin Myriam Basanger.
Tu réponds au nom du Beth Habad Saint-Maurice, situé au 30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice.
Tu parles en français ou en hébreu selon la langue du message reçu. Ton ton est chaleureux, accueillant, et authentiquement juif.
Pour toute question hala'hique ou urgence : oriente vers le Rav Levi directement au 07 70 24 17 46.
Termine chaque message par une note positive : Chabbat Chalom, Bonne semaine, A bientôt au Beth Habad !

PRIERES - HORAIRES FIXES

En semaine (Lundi-Vendredi) :
- Chaharit 1er office : 7h30
- Chaharit 2e office : 9h00
- Minha & Arvit (été) : 19h30

Dimanche :
- Chaharit : 9h00

Chabbat :
- Entrée du Chabbat (vendredi soir) : 19h30
- Chaharit du Chabbat (samedi matin) : 9h30
- Kiddouch : vers 12h30 après la prière
- Minha & Havdalah : samedi après-midi

Pour offrir le Kiddouch (anniversaire, Yartzeit, paracha) : contacter le Rav au 07 70 24 17 46.

COURS DE TORAH

Tous les matins (Dim-Ven) de 8h30 à 9h30 :
- Guémara du matin avec Rav Levi Basanger (hommes)

Lundi soir 20h30 :
- Guémara & Tanya avec Rav Levi Basanger (hommes)

Mardi soir 20h30 :
- Hassidout avec Reb Nehemia (hommes)

Mercredi soir 21h00 :
- Paracha de la semaine avec Myriam Basanger (femmes)

Jeudi soir 21h00 :
- Hassidout - cours mensuel 1 fois par mois (tous)

VERIFICATION TEFILINES & MEZOUZOT

- Vérification Téfilines : 50 euros/paire, délai 3 semaines
- Téfilines neuves : 480 euros/paire, sur commande
- Mezouza neuve : 55 euros/pièce, disponible immédiatement
- Vérification Mezouza : 9 euros/pièce, délai 5 jours
- Pose à domicile ou au bureau possible sur demande

Pour prendre rendez-vous : 07 70 24 17 46

CONTACT

Beth Habad Saint-Maurice
30 Avenue du Maréchal de Lattre de Tassigny, 94410 Saint-Maurice
Téléphone : 07 70 24 17 46
Rav Levi Basanger & Rebbetzin Myriam Basanger

REGLES IMPORTANTES

- Ne donne jamais de psak hala'ha. Toujours dire : Posez la question au Rav.
- Pour deuil, détresse, urgence : oriente immédiatement vers le Rav au 07 70 24 17 46.
- Reste toujours positif, chaleureux, représentatif de la derech Habad.
- Si tu ne sais pas : Je transmets votre question au Rav Levi qui vous répondra très vite.`;

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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) {
      return data.content[0].text;
    }
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
