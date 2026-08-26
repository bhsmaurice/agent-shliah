const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS infos (id SERIAL PRIMARY KEY, categorie TEXT, titre TEXT, contenu TEXT, instruction TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, phone TEXT, question TEXT, reponse TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS demandes (id SERIAL PRIMARY KEY, type TEXT, phone TEXT, data JSONB, statut TEXT DEFAULT 'nouveau', created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions_demande (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, type TEXT, etape INTEGER DEFAULT 0, reponses JSONB DEFAULT '{}', terminee BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages_traites (msg_id TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS histoires (id SERIAL PRIMARY KEY, titre TEXT NOT NULL, texte TEXT NOT NULL, image_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, abonne_chabbat BOOLEAN DEFAULT FALSE, abonne_evenements BOOLEAN DEFAULT FALSE, question_chabbat_posee BOOLEAN DEFAULT FALSE, question_evenements_posee BOOLEAN DEFAULT FALSE, nb_messages INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
  // Ajouter colonnes si elles n'existent pas
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nom TEXT`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prenom TEXT`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS genre TEXT`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS adresse TEXT`);
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS musiques (id SERIAL PRIMARY KEY, titre TEXT NOT NULL, lien TEXT NOT NULL, ambiance TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS playlistes (id SERIAL PRIMARY KEY, nom TEXT NOT NULL, ambiance TEXT NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS playliste_musiques (id SERIAL PRIMARY KEY, playliste_id INTEGER REFERENCES playlistes(id) ON DELETE CASCADE, musique_id INTEGER REFERENCES musiques(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cerfa_counters (year INT PRIMARY KEY, last_number INT NOT NULL DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cerfa_receipts (id SERIAL PRIMARY KEY, numero TEXT UNIQUE NOT NULL, nom TEXT, prenom TEXT, adresse TEXT, montant NUMERIC(10,2) NOT NULL, mode_paiement TEXT, date_don DATE NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS paiements (id SERIAL PRIMARY KEY, phone TEXT NOT NULL, montant NUMERIC(10,2) NOT NULL, description TEXT, lien_paiement TEXT, statut TEXT DEFAULT 'en_attente', nb_relances INTEGER DEFAULT 0, derniere_relance TIMESTAMP, delai_relance_jours INTEGER DEFAULT 3, max_relances INTEGER DEFAULT 3, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS infos_privees (id SERIAL PRIMARY KEY, titre TEXT NOT NULL, contenu TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  // AJOUT — stockage des images uploadées depuis WhatsApp (servies via /media/:id)
  await pool.query(`CREATE TABLE IF NOT EXISTS medias (id SERIAL PRIMARY KEY, data BYTEA NOT NULL, mime_type TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  // THEMES TABLE - Pour V2 PRO
  await pool.query(`CREATE TABLE IF NOT EXISTS themes (id SERIAL PRIMARY KEY, name TEXT NOT NULL, colors_json JSONB NOT NULL, is_active BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
  
  // Insérer le theme V2 violet par défaut s'il n'existe pas
  const themeV2 = {
    "gold": "#7c3aed",
    "gold_light": "#a78bfa",
    "gold_dark": "#5B3FD1",
    "navy": "#1A2540",
    "navy2": "#2C3E66",
    "bg": "#F4F2ED",
    "white": "#fff",
    "text": "#1A2540",
    "muted": "#7A8AAA",
    "border": "#E0D8C8"
  };
  await pool.query(
    `INSERT INTO themes (name, colors_json, is_active) VALUES ($1, $2, $3) 
     ON CONFLICT DO NOTHING`,
    ['V2-Violet', JSON.stringify(themeV2), true]
  ).catch(() => {});

  await pool.query('ALTER TABLE sessions_demande ADD COLUMN IF NOT EXISTS terminee BOOLEAN DEFAULT FALSE').catch(()=>{});
  await pool.query('ALTER TABLE cerfa_receipts ADD COLUMN IF NOT EXISTS email TEXT').catch(()=>{});
  await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nom TEXT').catch(()=>{});
  await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS prenom TEXT').catch(()=>{});
  await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS genre TEXT').catch(()=>{});
  // AJOUT — colonne image pour les Infos
  await pool.query('ALTER TABLE infos ADD COLUMN IF NOT EXISTS image_url TEXT').catch(()=>{});
  await pool.query('DELETE FROM sessions_demande').catch(()=>{});
  console.log('Base de données prête');
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "shliah_beth_habad";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "habad2024";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "33770241746"; // Format: 33XXXXXXXXX
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // plus utilisé pour l'envoi (conservé pour compat)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL || 'bhsmaurice@gmail.com';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Shliah Bot <onboarding@resend.dev>';
// AJOUT — URL publique du serveur Railway, nécessaire pour générer les liens d'images (/media/:id)
// Va dans Railway > Variables et ajoute PUBLIC_BASE_URL = https://TON-APP.up.railway.app
// (Railway fournit aussi automatiquement RAILWAY_PUBLIC_DOMAIN, utilisé en secours ci-dessous)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
async function envoyerEmail({ to, subject, html, attachments }) {
  if (!RESEND_API_KEY) {
    console.error('Email non envoyé : RESEND_API_KEY manquant');
    return { ok: false, error: "La variable RESEND_API_KEY n'est pas configurée sur Railway." };
  }
  try {
    const body = {
      from: RESEND_FROM_EMAIL,
      to: [to || RESEND_TO_EMAIL],
      subject,
      html,
    };
    if (attachments && attachments.length) {
      body.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content)).toString('base64'),
      }));
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Resend error:', data);
      return { ok: false, error: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    const causeMsg = e.cause && e.cause.message ? ` (${e.cause.message})` : '';
    console.error('Resend fetch error:', e.name, e.message, causeMsg);
    return { ok: false, error: `[resend-v2] ${e.name}: ${e.message}${causeMsg}` };
  }
}

const ADMIN_WHATSAPP_NUMBERS = (process.env.ADMIN_WHATSAPP_NUMBERS || '33770241746')
  .split(',').map(n => n.trim()).filter(Boolean);

const ASSOCIATION = {
  nom: 'Beth habad S. Maurice Plateau',
  rna: 'W941017037',
  adresse: '54 Avenue maréchal de Lattre de Tassigny, 94410 Saint Maurice',
  objet: "Action d'intérêt général de bienfaisance",
  qualite: "Œuvre ou organisme d'intérêt général",
  articleCGI: '200 du CGI',
};

let bethHabadLogoBytesCache = null;
async function getBethHabadLogoBytes() {
  if (bethHabadLogoBytesCache) return bethHabadLogoBytesCache;
  const url = process.env.BETH_HABAD_LOGO_URL;
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bethHabadLogoBytesCache = Buffer.from(await res.arrayBuffer());
    return bethHabadLogoBytesCache;
  } catch (e) {
    console.error('Logo Beth Habad : échec du téléchargement -', e.message);
    return null;
  }
}

function isAdminCerfaTrigger(text) {
  return /^admin\s+cerfa/i.test(text.trim());
}
function isPriveTrigger(text) {
  return /^prive770/i.test(text.trim());
}
async function handlePriveCommand(from, text) {
  if (!isPriveTrigger(text)) return false;
  if (!isAuthorizedAdminCerfa(from)) return true; // ignoré silencieusement
  try {
    const query = text.replace(/^prive770/i, '').trim();
    if (!query) {
      const result = await pool.query('SELECT titre FROM infos_privees ORDER BY titre ASC');
      if (result.rows.length === 0) {
        await sendWhatsApp(from, "🔒 Aucune info privée enregistrée pour le moment.\n\nAjoute-en depuis le panneau admin, onglet 🔒 Privé.");
      } else {
        const liste = result.rows.map(r => `• ${r.titre}`).join('\n');
        await sendWhatsApp(from, `🔒 Infos privées disponibles :\n\n${liste}\n\nEnvoie "Prive770 [mot-clé]" pour recevoir le contenu.`);
      }
    } else {
      const result = await pool.query('SELECT * FROM infos_privees WHERE titre ILIKE $1 ORDER BY created_at DESC LIMIT 1', [`%${query}%`]);
      if (result.rows.length === 0) {
        await sendWhatsApp(from, `🔒 Aucune info privée trouvée pour "${query}".`);
      } else {
        await sendWhatsApp(from, `🔒 ${result.rows[0].titre}\n\n${result.rows[0].contenu}`);
      }
    }
  } catch (e) {
    await sendWhatsApp(from, `Erreur : ${e.message}`);
  }
  return true;
}

function isAuthorizedAdminCerfa(fromNumber) {
  const clean = String(fromNumber).replace(/\D/g, '');
  return ADMIN_WHATSAPP_NUMBERS.some((n) => clean.endsWith(n) || n.endsWith(clean));
}

function numberToFrenchWords(n) {
  const units = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
  function below100(num) {
    if (num < 20) return units[num];
    const t = Math.floor(num / 10), u = num % 10;
    if (t === 7 || t === 9) return tens[t] + '-' + units[10 + u];
    let word = tens[t];
    if (u === 0) return t === 8 ? word + 's' : word;
    if (u === 1 && t !== 8) return word + ' et un';
    return word + '-' + units[u];
  }
  function below1000(num) {
    const h = Math.floor(num / 100), rest = num % 100;
    let word = '';
    if (h > 0) {
      word += h === 1 ? 'cent' : units[h] + ' cent';
      if (h > 1 && rest === 0) word += 's';
      if (rest > 0) word += ' ';
    }
    if (rest > 0) word += below100(rest);
    return word;
  }
  function convert(num) {
    if (num === 0) return 'zéro';
    let word = '';
    const millions = Math.floor(num / 1000000), thousands = Math.floor((num % 1000000) / 1000), rest = num % 1000;
    if (millions > 0) word += (millions === 1 ? 'un million' : below1000(millions) + ' millions') + ' ';
    if (thousands > 0) word += (thousands === 1 ? 'mille' : below1000(thousands) + ' mille') + ' ';
    if (rest > 0) word += below1000(rest);
    return word.trim();
  }
  const intPart = Math.floor(n);
  return convert(intPart) + (intPart > 1 ? ' euros' : ' euro');
}

function parseAdminCerfaMessage(rawText) {
  const withoutTrigger = rawText.replace(/^admin\s+cerfa/i, '').trim();
  const lines = withoutTrigger.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) {
    throw new Error("Format: Admin CERFA puis 4 lignes -> montant / Nom Prénom / adresse / especes|cb|cheque (+ email et/ou date JJ/MM/AAAA facultatifs, dans n'importe quel ordre)");
  }
  const [montantLine, nomPrenomLine, adresseLine, modeLine, ...extraLines] = lines;
  const montantMatch = montantLine.replace(',', '.').match(/(\d+(\.\d+)?)/);
  if (!montantMatch) throw new Error(`Montant introuvable dans : "${montantLine}"`);
  const montant = parseFloat(montantMatch[1]);
  const nomParts = nomPrenomLine.replace(/^(mr|mme|m\.|mlle)\s+/i, '').trim().split(/\s+/);
  const nom = nomParts[0];
  const prenom = nomParts.slice(1).join(' ') || '-';
  const adresse = adresseLine;
  const modeLower = modeLine.toLowerCase();
  let mode = "Remise d'espèces";
  if (/cb|carte/.test(modeLower)) mode = 'Carte bancaire';
  else if (/virement/.test(modeLower)) mode = 'Virement';
  else if (/pr[eé]l[eè]vement/.test(modeLower)) mode = 'Prélèvement';
  else if (/ch[eè]que/.test(modeLower)) mode = 'Chèque';
  else if (/autre/.test(modeLower)) mode = 'Autre';
  else if (/esp[eè]ce|cash/.test(modeLower)) mode = "Remise d'espèces";

  let email = null;
  let dateDon = null;
  for (const line of extraLines) {
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) {
      email = line;
      continue;
    }
    const dateMatch = line.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!dateDon && dateMatch) {
      const [, jour, moisNum, annee] = dateMatch;
      const j = jour.padStart(2, '0'), m = moisNum.padStart(2, '0');
      dateDon = `${annee}-${m}-${j}`;
      continue;
    }
  }

  return { montant, nom, prenom, adresse, mode, email, dateDon };
}

async function getNextCerfaNumero() {
  const year = new Date().getFullYear();
  const res = await pool.query(
    `INSERT INTO cerfa_counters (year, last_number) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_number = cerfa_counters.last_number + 1
     RETURNING last_number`,
    [year]
  );
  return `BH${year}-${String(res.rows[0].last_number).padStart(3, '0')}`;
}

async function generateCerfaPDF({ numero, nom, prenom, adresse, montant, mode, dateVersement: dateVersementOverride }) {
  const pdfDoc = await PDFDocument.create();
  const PW = 595.28, PH = 841.89;
  const page = pdfDoc.addPage([PW, PH]);
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const marginX = 45;
  const contentW = PW - 2 * marginX;
  const black = rgb(0, 0, 0);
  const gray = rgb(0.8, 0.8, 0.8);
  const lineGray = rgb(0.45, 0.45, 0.45);
  const Y = (topPt) => PH - topPt;

  const drawCentered = (text, topPt, size, f = font, color = black) => {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (PW - w) / 2, y: Y(topPt), size, font: f, color });
  };
  const drawRight = (text, topPt, size, f = font, color = black, rightX = PW - marginX) => {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: rightX - w, y: Y(topPt), size, font: f, color });
  };
  const drawLeft = (text, topPt, size, f = font, color = black, x = marginX) => {
    page.drawText(text, { x, y: Y(topPt), size, font: f, color });
  };
  const drawLabelValue = (label, value, topPt, x = marginX + 10, size = 9.5) => {
    page.drawText(label, { x, y: Y(topPt), size, font: bold, color: black });
    const lw = bold.widthOfTextAtSize(label, size);
    page.drawText(value, { x: x + lw + 4, y: Y(topPt), size, font, color: black });
  };
  const grayBar = (label, topPt, height = 20, size = 11) => {
    page.drawRectangle({ x: marginX, y: Y(topPt + height), width: contentW, height, color: gray });
    const w = bold.widthOfTextAtSize(label, size);
    page.drawText(label, { x: (PW - w) / 2, y: Y(topPt + height - 6), size, font: bold, color: black });
  };
  const box = (topPt, height) => {
    page.drawRectangle({ x: marginX, y: Y(topPt + height), width: contentW, height, borderColor: lineGray, borderWidth: 1 });
  };
  const hLine = (topPt, x1 = marginX, x2 = PW - marginX) => {
    page.drawLine({ start: { x: x1, y: Y(topPt) }, end: { x: x2, y: Y(topPt) }, thickness: 0.6, color: lineGray });
  };
  const drawCheckbox = (label, checked, x, topPt, size = 9) => {
    const boxSize = 8.5;
    const boxY = Y(topPt) - boxSize + 2.5;
    page.drawRectangle({ x, y: boxY, width: boxSize, height: boxSize, borderColor: black, borderWidth: 0.8 });
    if (checked) {
      page.drawLine({ start: { x: x + 1, y: boxY + 4 }, end: { x: x + 3.2, y: boxY + 1.5 }, thickness: 1.1, color: black });
      page.drawLine({ start: { x: x + 3.2, y: boxY + 1.5 }, end: { x: x + 7.3, y: boxY + 7.5 }, thickness: 1.1, color: black });
    }
    page.drawText(label, { x: x + boxSize + 4, y: Y(topPt), size, font: checked ? bold : font, color: black });
  };
  const drawCheckboxRow = (items, topPt, size = 9, gap = 24) => {
    const boxSize = 8.5;
    let x = marginX + 10;
    items.forEach(({ label, checked }) => {
      drawCheckbox(label, checked, x, topPt, size);
      const labelW = (checked ? bold : font).widthOfTextAtSize(label, size);
      x += boxSize + 4 + labelW + gap;
    });
  };
  const drawUnderlinedLabel = (label, topPt, size = 9.5) => {
    page.drawText(label, { x: marginX + 10, y: Y(topPt), size, font: bold, color: black });
    const w = bold.widthOfTextAtSize(label, size);
    page.drawLine({ start: { x: marginX + 10, y: Y(topPt) - 2 }, end: { x: marginX + 10 + w, y: Y(topPt) - 2 }, thickness: 0.6, color: black });
  };

  const dateVersement = dateVersementOverride || new Date().toLocaleDateString('fr-FR');
  const nomDonateurComplet = `${prenom} ${nom}`.toUpperCase();
  const montantNum = Number(montant);
  const formatMontantFr = (n) => {
    const isInt = Number.isInteger(n);
    const parts = isInt ? [String(n)] : n.toFixed(2).split('.');
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return isInt ? intPart : `${intPart},${parts[1]}`;
  };
  const montantDisplay = formatMontantFr(montantNum);

  drawLeft('2041-RD', 24, 8, font, black, marginX + 8);
  const cerfaOvalW = 58, cerfaOvalH = 25;
  const cerfaOvalCx = marginX + cerfaOvalW / 2 + 8;
  const cerfaOvalCy = Y(52);
  page.drawEllipse({
    x: cerfaOvalCx,
    y: cerfaOvalCy,
    xScale: cerfaOvalW / 2,
    yScale: cerfaOvalH / 2,
    color: rgb(0.09, 0.16, 0.38),
  });
  const cerfaLabel = 'cerfa';
  const cerfaLabelSize = 14;
  const cerfaLabelW = italicFont.widthOfTextAtSize(cerfaLabel, cerfaLabelSize);
  page.drawText(cerfaLabel, {
    x: cerfaOvalCx - cerfaLabelW / 2,
    y: cerfaOvalCy - cerfaLabelSize / 2 + 2,
    size: cerfaLabelSize,
    font: italicFont,
    color: rgb(1, 1, 1),
  });
  drawLeft('N° 11580*05', 90, 9, font, black, marginX);

  drawCentered('Reçu des dons et versements', 30, 13, bold);
  drawCentered('effectués par les particuliers au titre', 46, 10, font);
  drawCentered('des articles 200 et 978 du code', 59, 10, font);
  drawCentered('général des impôts', 72, 10, font);

  drawRight("N° d'ordre du reçu", 30, 10, font);
  drawRight(numero, 50, 14, bold);

  hLine(100);

  const logoBytes = await getBethHabadLogoBytes();
  let logoBottomY = 110;
  if (logoBytes) {
    try {
      let embeddedLogo;
      try {
        embeddedLogo = await pdfDoc.embedPng(logoBytes);
      } catch (e) {
        embeddedLogo = await pdfDoc.embedJpg(logoBytes);
      }
      const targetH = 42;
      const scale = targetH / embeddedLogo.height;
      const targetW = embeddedLogo.width * scale;
      const logoX = marginX + (contentW / 2 - 30 - targetW) / 2;
      page.drawImage(embeddedLogo, { x: logoX, y: Y(152), width: targetW, height: targetH });
      logoBottomY = 152;
    } catch (e) {
      console.error('Logo Beth Habad : échec insertion dans le PDF -', e.message);
    }
  }
  const leftColCenterX = marginX + (contentW / 2 - 30) / 2;
  const nomAssoW = bold.widthOfTextAtSize(ASSOCIATION.nom, 10);
  page.drawText(ASSOCIATION.nom, { x: leftColCenterX - nomAssoW / 2, y: Y(logoBottomY + 20), size: 10, font: bold, color: black });

  const donateurColX = 330;
  drawLeft(nomDonateurComplet, 117, 11.5, bold, black, donateurColX);
  const adresseParts = adresse.split(',').map((s) => s.trim()).filter(Boolean);
  let addrTop = 134;
  adresseParts.forEach((part) => { drawLeft(part, addrTop, 10.5, font, black, donateurColX); addrTop += 15; });

  hLine(182);

  let top = 192;
  grayBar('BÉNÉFICIAIRE DU DON', top);
  top += 20;
  const beneficiaireBoxStart = top;
  let rowTop = top + 17;
  [
    ['NOM OU DENOMINATION : ', ASSOCIATION.nom],
    ['Numéro SIREN ou RNA : ', ASSOCIATION.rna],
    ['ADRESSE ASSOCIATION : ', ASSOCIATION.adresse],
    ['OBJET : ', ASSOCIATION.objet],
    ['QUALITE DE L’ORGANISME : ', ASSOCIATION.qualite],
  ].forEach(([label, value]) => { drawLabelValue(label, value, rowTop); rowTop += 18; });
  rowTop += 8;
  hLine(rowTop, marginX + 8, PW - marginX - 8);
  rowTop += 20;
  drawLeft("Le bénéficiaire reconnaît avoir reçu au titre des dons et versements ouvrant droit à", rowTop, 9.5, font, black, marginX + 10);
  rowTop += 13;
  drawLeft("réduction d'impôt, la somme de :", rowTop, 9.5, font, black, marginX + 10);
  rowTop += 20;
  const montantLabel = `***${montantDisplay} Euros***  ${numberToFrenchWords(montantNum)}`;
  const mW = bold.widthOfTextAtSize(montantLabel, 12);
  const montantBoxX = (PW - (mW + 20)) / 2;
  page.drawRectangle({ x: montantBoxX, y: Y(rowTop + 20), width: mW + 20, height: 22, borderColor: lineGray, borderWidth: 1 });
  page.drawText(montantLabel, { x: montantBoxX + 10, y: Y(rowTop + 13), size: 12, font: bold, color: black });
  rowTop += 30;
  box(beneficiaireBoxStart, rowTop - beneficiaireBoxStart);
  top = rowTop;

  top += 18;
  grayBar('DONATEUR', top);
  top += 20;
  const donateurBoxStart = top;
  drawLabelValue('NOM OU DENOMINATION : ', nomDonateurComplet, top + 17);
  drawLabelValue('ADRESSE DONATEUR : ', adresse, top + 35);
  top += 50;
  box(donateurBoxStart, top - donateurBoxStart);

  top += 24;
  drawCentered("Le bénéficiaire certifie sur l'honneur que les dons et versements qu'il reçoit", top, 9.5, font);
  top += 14;
  drawCentered("ouvrent droit à la réduction d'impôt prévue à l'article", top, 9.5, font);
  top += 24;
  drawCheckboxRow([
    { label: '200 du CGI', checked: ASSOCIATION.articleCGI === '200 du CGI' },
    { label: '238 bis du CGI', checked: ASSOCIATION.articleCGI === '238 bis du CGI' },
    { label: '978 du CGI', checked: ASSOCIATION.articleCGI === '978 du CGI' },
  ], top);
  top += 22;
  drawUnderlinedLabel('Forme du don', top);
  top += 20;
  drawCheckboxRow([
    { label: 'Acte authentique', checked: false },
    { label: 'Acte sous seing privé', checked: false },
    { label: 'Déclaration de don manuel', checked: true },
    { label: 'Autres', checked: false },
  ], top);
  top += 22;
  drawUnderlinedLabel('Nature du don', top);
  top += 20;
  drawCheckboxRow([
    { label: 'Numéraire', checked: true },
    { label: 'Titres de sociétés cotées', checked: false },
    { label: 'Autres', checked: false },
  ], top);
  top += 26;
  hLine(top);

  top += 22;
  page.drawText('Mode de versement : ', { x: marginX + 10, y: Y(top), size: 10, font, color: black });
  page.drawText(mode, { x: marginX + 10 + font.widthOfTextAtSize('Mode de versement : ', 10), y: Y(top), size: 10, font: bold, color: black });
  drawRight('Date et signature', top - 10, 10.5, bold);
  drawRight(dateVersement, top + 8, 10, font);

  drawCentered('Reçu cerfa généré par Shliah Bot', 760, 9, font);

  return Buffer.from(await pdfDoc.save());
}

async function sendWhatsAppDocument(to, pdfBuffer, filename) {
  const form = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  form.append('file', blob, filename);
  form.append('messaging_product', 'whatsapp');
  const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
    body: form,
  });
  const uploadData = await uploadRes.json();
  const mediaId = uploadData.id;
  if (!mediaId) throw new Error('Upload média WhatsApp échoué: ' + JSON.stringify(uploadData));
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, filename, caption: `Reçu Cerfa ${filename}` } }),
  });
}

async function handleAdminCerfaCommand(from, text) {
  if (!isAdminCerfaTrigger(text)) return false;
  if (!isAuthorizedAdminCerfa(from)) return true;
  try {
    const data = parseAdminCerfaMessage(text);
    const numero = await getNextCerfaNumero();
    const dateDon = data.dateDon || new Date().toISOString().slice(0, 10);
    const dateVersement = new Date(dateDon + 'T00:00:00').toLocaleDateString('fr-FR');
    const pdfBuffer = await generateCerfaPDF({ numero, ...data, dateVersement });
    const filename = `Cerfa_${numero}.pdf`;
    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [numero, data.nom, data.prenom, data.adresse, data.montant, data.mode, dateDon, data.email]
    );
    envoyerBackupCerfa({ numero, ...data, dateVersement }, pdfBuffer).catch(e => console.error('Backup Cerfa error:', e));
    envoyerCerfaDonateur({ numero, ...data }, pdfBuffer).catch(e => console.error('Email donateur error:', e));
    await sendWhatsAppDocument(from, pdfBuffer, filename);
  } catch (e) {
    await sendWhatsApp(from, `Erreur génération Cerfa : ${e.message}`);
  }
  return true;
}

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
REGLE IMPORTANTE - MARQUEUR D'INFO UTILISEE :
Chaque bloc d'information ci-dessous porte un identifiant entre crochets, par exemple [id:12]. Si ta réponse utilise le contenu d'un ou plusieurs de ces blocs, termine TOUJOURS ta réponse par une ligne supplémentaire, après ta signature, au format exact [[INFO:12]] (un par bloc utilisé). Cette ligne est un marqueur technique invisible pour l'utilisateur : ne l'explique jamais, ne dis jamais que tu l'ajoutes. Si tu n'utilises aucun bloc d'information, n'ajoute rien.
REGLE IMPORTANTE - HORAIRES DE CHABBAT :
Quand quelquun demande les "horaires de Chabbat" ou "heure de Chabbat" sans preciser, tu DOIS toujours poser cette question avant de repondre :
"Tu veux les horaires dallumage des bougies (entree/sortie de Chabbat) ou les horaires des offices au Beth Habad ?"
Ne jamais repondre directement sans avoir pose cette question.
Exception : si la personne mentionne "allumage", "bougies", "havdalah" ou "paracha" donne directement les horaires dallumage.
Exception : si la personne mentionne "Chaharit", "Minha", "office", "priere" donne directement les horaires des offices.
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
        let bloc = `--- ${labels[row.categorie] || 'INFO'} : ${row.titre.toUpperCase()} [id:${row.id}] ---\n${row.contenu}`;
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
async function getHorairesChabbat() {
  try {
    // Fallback simple: horaires connus pour Paris (vendredi prochain)
    console.log('📅 Calcul horaires vendredi prochain...');
    
    const now = new Date();
    const jour = now.getDay();
    const daysUntilFriday = (5 - jour + 7) % 7;
    const fridayDate = new Date(now);
    fridayDate.setDate(fridayDate.getDate() + daysUntilFriday);
    
    const moisNoms = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
    const dateLabel = `vendredi ${fridayDate.getDate()} ${moisNoms[fridayDate.getMonth()]} ${fridayDate.getFullYear()}`;
    
    // Horaires de Paris pour les 4 prochaines semaines (calj.net) avec Paracha
    const horairesAout = {
      '7': { entree: '21h02', sortie: '22h13', paracha: 'Réeh' },  // 7-8 août
      '14': { entree: '20h50', sortie: '21h59', paracha: 'Choftim' }, // 14-15 août
      '21': { entree: '20h37', sortie: '21h46', paracha: 'Ki Tavo' }, // 21-22 août  
      '28': { entree: '20h24', sortie: '21h32', paracha: 'Nitsavim' }  // 28-29 août
    };
    
    const horaires = horairesAout[fridayDate.getDate().toString()];
    if (horaires) {
      console.log('✅ Horaires trouvés:', dateLabel, horaires.entree, horaires.sortie, 'Paracha:', horaires.paracha);
      return {
        texte: `HORAIRES CHABBAT - PARIS :\n📅 ${dateLabel}\n📖 Paracha ${horaires.paracha}\n🕯️ Entrée de Chabbat : ${horaires.entree}\n✨ Sortie de Chabbat (Havdalah) : ${horaires.sortie}`,
        paracha: horaires.paracha,
        date: dateLabel,
        entree: horaires.entree,
        sortie: horaires.sortie
      };
    }
    
    // Sinon retourner une date approchée
    console.log('⚠️ Horaires non trouvés pour cette date, utilisant horaires par défaut');
    return {
      texte: `HORAIRES CHABBAT - PARIS :\n📅 ${dateLabel}\n🕯️ Horaires Chabbat`,
      paracha: 'N/A',
      date: dateLabel,
      entree: '21h00',
      sortie: '22h00'
    };
  } catch (e) { 
    console.error('❌ Erreur:', e.message);
    return null;
  }
}
let chabbatCache = { data: null, lastFetch: 0 };
async function getHorairesChabbatCached() {
  const now = Date.now();
  if (chabbatCache.data && (now - chabbatCache.lastFetch) < 3600000) return chabbatCache.data;
  const data = await getHorairesChabbat();
  if (data) { chabbatCache.data = data; chabbatCache.lastFetch = now; }
  return data;
}
async function getOuCreerContact(phone) {
  try {
    const res = await pool.query('SELECT * FROM contacts WHERE phone=$1', [phone]);
    if (res.rows.length > 0) return res.rows[0];
    await pool.query('INSERT INTO contacts (phone) VALUES ($1) ON CONFLICT DO NOTHING', [phone]);
    const res2 = await pool.query('SELECT * FROM contacts WHERE phone=$1', [phone]);
    return res2.rows[0];
  } catch (e) { console.error('Contact error:', e.message); return null; }
}
async function incrementerMessages(phone) {
  try { await pool.query('UPDATE contacts SET nb_messages = nb_messages + 1 WHERE phone=$1', [phone]); } catch (e) {}
}
async function marquerQuestionPosee(phone, type) {
  try {
    if (type === 'chabbat') await pool.query('UPDATE contacts SET question_chabbat_posee=TRUE WHERE phone=$1', [phone]);
    if (type === 'evenements') await pool.query('UPDATE contacts SET question_evenements_posee=TRUE WHERE phone=$1', [phone]);
  } catch (e) {}
}
async function mettreAJourAbonnement(phone, type, valeur) {
  try {
    if (type === 'chabbat') await pool.query('UPDATE contacts SET abonne_chabbat=$1 WHERE phone=$2', [valeur, phone]);
    if (type === 'evenements') await pool.query('UPDATE contacts SET abonne_evenements=$1 WHERE phone=$2', [valeur, phone]);
  } catch (e) {}
}
let sessionsAbonnement = {};
function estReponseOui(text) {
  const lower = text.toLowerCase().trim();
  return ['oui', 'yes', 'כן', 'ok', 'ouais', 'bien sûr', 'avec plaisir', 'volontiers', 'pourquoi pas'].some(m => lower.includes(m));
}
function estReponseNon(text) {
  const lower = text.toLowerCase().trim();
  return lower === 'non' || lower === 'no' || lower === 'לא' || lower === 'pas' || lower === 'nope' || lower === 'merci non' || lower === 'non merci';
}
async function getQuestionAbonnement(phone, contact) {
  if (!contact) return null;
  const nb = contact.nb_messages || 0;
  if (nb === 2 && !contact.question_chabbat_posee) {
    await marquerQuestionPosee(phone, 'chabbat');
    sessionsAbonnement[phone] = 'chabbat';
    return `\n\nAu fait, veux-tu recevoir les horaires d'allumage des bougies automatiquement chaque vendredi matin ? 🕯️ (Oui/Non)`;
  }
  if (nb === 4 && !contact.question_evenements_posee) {
    await marquerQuestionPosee(phone, 'evenements');
    sessionsAbonnement[phone] = 'evenements';
    return `\n\nOn organise régulièrement des événements et activités au Beth Habad. Veux-tu être tenu informé ? 😊 (Oui/Non)`;
  }
  return null;
}
function demarrerCronChabbat() {
  setInterval(async () => {
    const now = new Date();
    const heuresParis = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jour = heuresParis.getDay(), heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (jour === 5 && heure === 9 && minute < 5) {
      const dateAujourdhui = heuresParis.toISOString().slice(0, 10);
      const cacheKey = `chabbat_en_attente_${dateAujourdhui}`;
      if (global[cacheKey]) return;
      global[cacheKey] = true;
      console.log('🕯️ Préparation message Chabbat pour validation...');
      await preparerValidationChabbat();
    }
  }, 5 * 60 * 1000);
  console.log('⏰ Cron Chabbat démarré');
}
async function preparerValidationChabbat() {
  try {
    const chabbat = await getHorairesChabbat();
    if (!chabbat) { console.error('Cron: impossible de récupérer les horaires'); return; }
    const message = `🕯️ Chabbat Chalom !\n\n📖 Paracha ${chabbat.paracha}\n📅 ${chabbat.date}\n\n🕯️ Allumage des bougies : ${chabbat.entree}\n✨ Havdalah (sortie) : ${chabbat.sortie}\n\nChabbat Chalom à toute la famille !\n\nBeth Habad S. Maurice`;
    
    // Envoyer à l'admin pour validation
    await sendWhatsAppButtons(
      ADMIN_PHONE, 
      `📢 VALIDATION MESSAGE CHABBAT\n\n${message}\n\nValider l'envoi ?`,
      [
        { id: 'valider_chabbat', title: '✓ Envoyer' },
        { id: 'editer_chabbat', title: '✎ Éditer' },
        { id: 'annuler_chabbat', title: '✗ Annuler' }
      ]
    );
    
    // Stocker le message en attente
    global.chabbatEnAttente = { message, dateAujourdhui: new Date().toISOString().slice(0, 10) };
    console.log('🕯️ Message envoyé à admin pour validation');
  } catch (e) { console.error('Cron error:', e.message); }
}
async function envoyerHorairesChabbatValides() {
  try {
    if (!global.chabbatEnAttente) {
      console.log('Aucun message Chabbat en attente');
      return;
    }
    const { message } = global.chabbatEnAttente;
    const abonnes = await pool.query('SELECT phone FROM contacts WHERE abonne_chabbat=TRUE');
    if (abonnes.rows.length === 0) { console.log('Cron: aucun abonné'); return; }
    let envoyes = 0;
    for (const row of abonnes.rows) {
      try { await sendWhatsApp(row.phone, message); envoyes++; await new Promise(r => setTimeout(r, 300)); }
      catch (e) { console.error(`Cron erreur ${row.phone}:`, e.message); }
    }
    console.log(`🕯️ Cron: ${envoyes}/${abonnes.rows.length} envoyés`);
    global.chabbatEnAttente = null;
  } catch (e) { console.error('Cron error:', e.message); }
}
function parlDeMusique(msg) {
  const lower = msg.toLowerCase();
  return ['musique', 'music', 'nigoun', 'nigoune', 'nigouns', 'nigounim', 'chant', 'chanson', 'melodie', 'mélodie', 'chantons', 'chanter'].some(m => lower.includes(m));
}
function parlDePlaylist(msg) {
  const lower = msg.toLowerCase();
  return ['playlist', 'playliste', 'liste de music', 'liste musique', 'toutes les musiques'].some(m => lower.includes(m));
}
const AMBIANCES = {
  '1': { label: '🎶 Douce et relaxante', key: 'douce' },
  '2': { label: '🔥 Qui bouge', key: 'bouge' },
  '3': { label: '🕯️ Nigounim / Chabbat', key: 'chabbat' }
};

// ─── AJOUT RAPIDE DE MUSIQUE PAR L'ADMIN (via WhatsApp) ─────────
// L'admin envoie un lien (YouTube ou autre) au bot -> le bot propose
// des boutons pour choisir l'ambiance -> demande le titre -> enregistre.
function extraireUrlMusique(text) {
  const match = text.match(/(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}
const AMBIANCES_AJOUT = {
  musique_douce: { key: 'douce', label: '🎶 Douce et relaxante' },
  musique_bouge: { key: 'bouge', label: '🔥 Qui bouge' },
  musique_chabbat: { key: 'chabbat', label: '🕯️ Nigounim / Chabbat' }
};
let sessionsAjoutMusique = {};
async function sendWhatsAppButtons(to, bodyText, buttons) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
      }
    })
  });
}
async function demarrerAjoutMusique(from, lien) {
  sessionsAjoutMusique[from] = { etape: 'categorie', lien };
  await sendWhatsAppButtons(from, "🎵 Lien détecté !\n\nC'est quel style ?", [
    { id: 'musique_douce', title: 'Douce' },
    { id: 'musique_bouge', title: 'Qui bouge' },
    { id: 'musique_chabbat', title: 'Chabbat' }
  ]);
}
async function gererChoixAmbianceAjout(from, buttonId) {
  const session = sessionsAjoutMusique[from];
  if (!session || session.etape !== 'categorie') return false;
  const ambiance = AMBIANCES_AJOUT[buttonId];
  if (!ambiance) return false;
  session.etape = 'titre';
  session.ambiance = ambiance.key;
  session.ambianceLabel = ambiance.label;
  await sendWhatsApp(from, `C'est noté : ${ambiance.label}\n\nQuel est le titre de cette musique ?`);
  return true;
}
async function gererTitreAjoutMusique(from, text) {
  const session = sessionsAjoutMusique[from];
  if (!session || session.etape !== 'titre') return null;
  delete sessionsAjoutMusique[from];
  try {
    const titre = text.trim();
    await pool.query('INSERT INTO musiques (titre, lien, ambiance) VALUES ($1, $2, $3)', [titre, session.lien, session.ambiance]);
    return `✅ Ajouté à ${session.ambianceLabel} !\n\n🎵 ${titre}`;
  } catch (e) {
    return `Erreur lors de l'ajout : ${e.message}`;
  }
}

// ─── AJOUT RAPIDE D'UNE INFO AVEC IMAGE PAR L'ADMIN (via WhatsApp) ──
// L'admin envoie une IMAGE au bot -> le bot la télécharge et l'héberge
// lui-même (table `medias`, servie via /media/:id) -> demande le titre
// -> enregistre directement dans la table `infos` avec image_url rempli.
// Catégorie par défaut : "autre" (modifiable ensuite depuis l'admin panel).
async function telechargerMediaWhatsApp(mediaId) {
  const infoRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
  });
  const info = await infoRes.json();
  if (!info.url) throw new Error('Média WhatsApp introuvable : ' + JSON.stringify(info));
  const fileRes = await fetch(info.url, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: info.mime_type || 'image/jpeg' };
}
async function enregistrerMedia(buffer, mimeType) {
  try {
    // Utiliser sharp pour corriger l'orientation EXIF automatiquement ET optimiser l'image
    const processedBuffer = await sharp(buffer)
      .rotate() // Sharp corrige automatiquement l'orientation EXIF pour CHAQUE photo
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
    const result = await pool.query('INSERT INTO medias (data, mime_type) VALUES ($1, $2) RETURNING id', [processedBuffer, 'image/jpeg']);
    return result.rows[0].id;
  } catch (e) {
    // Fallback: enregistrer l'image sans traitement si sharp échoue
    console.error('Erreur traitement image:', e.message);
    const result = await pool.query('INSERT INTO medias (data, mime_type) VALUES ($1, $2) RETURNING id', [buffer, mimeType]);
    return result.rows[0].id;
  }
}
let sessionsAjoutInfo = {};
async function demarrerAjoutInfo(from, mediaId) {
  try {
    const { buffer, mimeType } = await telechargerMediaWhatsApp(mediaId);
    const idMedia = await enregistrerMedia(buffer, mimeType);
    if (!PUBLIC_BASE_URL) {
      await sendWhatsApp(from, "⚠️ Impossible de générer le lien de l'image : la variable PUBLIC_BASE_URL n'est pas configurée sur Railway (mets l'URL de ton app, ex: https://ton-app.up.railway.app).");
      return;
    }
    const imageUrl = `${PUBLIC_BASE_URL}/media/${idMedia}`;
    sessionsAjoutInfo[from] = { etape: 'titre', imageUrl };
    await sendWhatsApp(from, "🖼️ Image reçue !\n\nQuel est le titre de cette information ?");
  } catch (e) {
    await sendWhatsApp(from, `Erreur lors de la réception de l'image : ${e.message}`);
  }
}
async function gererTitreAjoutInfo(from, text) {
  const session = sessionsAjoutInfo[from];
  if (!session || session.etape !== 'titre') return null;
  session.titre = text.trim();
  session.etape = 'contenu';
  return `C'est noté !\n\nMaintenant envoie le texte complet de cette information (ce que le bot doit savoir/répondre). Si tu veux laisser vide, écris "non".`;
}
async function gererContenuAjoutInfo(from, text) {
  const session = sessionsAjoutInfo[from];
  if (!session || session.etape !== 'contenu') return null;
  delete sessionsAjoutInfo[from];
  try {
    const texte = text.trim();
    const estVide = /^(non|aucun|rien|-)$/i.test(texte);
    const contenu = estVide ? session.titre : texte;
    await pool.query(
      'INSERT INTO infos (categorie, titre, contenu, image_url) VALUES ($1, $2, $3, $4)',
      ['autre', session.titre, contenu, session.imageUrl]
    );
    return `✅ Ajouté dans les Infos !\n\n🖼️ ${session.titre}`;
  } catch (e) {
    return `Erreur lors de l'ajout : ${e.message}`;
  }
}

let sessionsMusiqueType = {};
async function gererMusique(from, text, type) {
  const session = sessionsMusiqueType[from];
  if (session && session.etape === 'ambiance') {
    const choix = text.trim();
    const ambiance = AMBIANCES[choix];
    if (!ambiance) {
      return `Réponds avec 1, 2 ou 3 :\n\n1. 🎶 Douce et relaxante\n2. 🔥 Qui bouge\n3. 🕯️ Nigounim / Chabbat`;
    }
    const modeType = session.mode;
    delete sessionsMusiqueType[from];
    if (modeType === 'musique') {
      const result = await pool.query('SELECT * FROM musiques WHERE ambiance=$1 ORDER BY created_at DESC', [ambiance.key]);
      if (result.rows.length === 0) return `Pas encore de musiques dans cette catégorie. Reviens bientôt ! 🎵\n\nKol Touv !`;
      const liste = result.rows.map((m, i) => `${i + 1}. ${m.titre}\n${m.lien}`).join('\n\n');
      return `🎵 ${ambiance.label}\n\nVoici les musiques recommandées par le Rav Levi :\n\n${liste}\n\nBonne écoute ! 🎶\n\nKol Touv !`;
    } else {
      const result = await pool.query('SELECT p.*, array_agg(m.titre || chr(10) || m.lien ORDER BY m.titre) as musiques FROM playlistes p LEFT JOIN playliste_musiques pm ON pm.playliste_id = p.id LEFT JOIN musiques m ON m.id = pm.musique_id WHERE p.ambiance=$1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT 1', [ambiance.key]);
      if (result.rows.length === 0 || !result.rows[0].musiques[0]) {
        const musResult = await pool.query('SELECT * FROM musiques WHERE ambiance=$1 ORDER BY created_at DESC', [ambiance.key]);
        if (musResult.rows.length === 0) return `Pas encore de playlist dans cette catégorie. Reviens bientôt ! 🎵\n\nKol Touv !`;
        const liste = musResult.rows.map(m => `🎵 ${m.titre}\n${m.lien}`).join('\n\n');
        return `🎶 Playlist ${ambiance.label}\n\n${liste}\n\nBonne écoute !\n\nKol Touv !`;
      }
      const playlist = result.rows[0];
      const liste = playlist.musiques.filter(Boolean).join('\n\n');
      return `🎶 ${playlist.nom}\n\n${playlist.description ? playlist.description + '\n\n' : ''}${liste}\n\nBonne écoute ! 🎵\n\nKol Touv !`;
    }
  }
  sessionsMusiqueType[from] = { etape: 'ambiance', mode: type };
  return `Quelle ambiance tu cherches ? 🎵\n\n1. 🎶 Douce et relaxante\n2. 🔥 Qui bouge\n3. 🕯️ Nigounim / Chabbat\n\nRéponds avec 1, 2 ou 3.`;
}
function parleDeMikve(msg) { return ['mikve', 'mikvé', 'bain rituel'].some(m => msg.toLowerCase().includes(m)); }
function parleDevenements(msg) { return ['événement', 'evenement', 'agenda', 'programme', 'activité', 'activite', 'cette semaine', 'ce mois', 'soirée', 'soiree'].some(m => msg.toLowerCase().includes(m)); }
function parleDeChabbat(msg) {
  const lower = msg.toLowerCase();
  return ['chabbat', 'shabbat', 'allumage', 'bougie', 'havdalah', 'fin chabbat', 'rentre chabbat', 'entre chabbat', 'sortie chabbat', 'heure chabbat', 'quand chabbat', 'paracha', 'parasha'].some(m => lower.includes(m));
}
function parleDeHistoire(msg) {
  const lower = msg.toLowerCase();
  return ['histoire', 'histoires', 'rabbi', 'rebbie', 'rebbe', 'conte', 'récit', 'recit'].some(m => lower.includes(m));
}
let sessionsHistoires = {};
async function gererHistoire(from, text) {
  const session = sessionsHistoires[from];
  if (session && session.etape === 'choix') {
    const num = parseInt(text.trim());
    if (!isNaN(num) && num >= 1 && num <= session.histoires.length) {
      const histoire = session.histoires[num - 1];
      delete sessionsHistoires[from];
      if (histoire.image_url) {
        await sendWhatsAppImage(from, histoire.image_url, `📖 ${histoire.titre}`);
        await new Promise(r => setTimeout(r, 800));
        return `${histoire.texte}\n\nKol Touv !`;
      }
      return `📖 ${histoire.titre}\n\n${histoire.texte}\n\nKol Touv !`;
    } else {
      return `Réponds avec un numéro entre 1 et ${session.histoires.length}.`;
    }
  }
  const result = await pool.query('SELECT id, titre, texte, image_url FROM histoires ORDER BY created_at DESC');
  if (result.rows.length === 0) return "Aucune histoire disponible pour le moment. Reviens bientôt !";
  sessionsHistoires[from] = { etape: 'choix', histoires: result.rows };
  const liste = result.rows.map((h, i) => `${i + 1}. ${h.titre}`).join('\n');
  return `📖 Histoires du Rabbi\n\nChoisis une histoire :\n\n${liste}\n\nRéponds avec le numéro de ton choix.`;
}
// ─── ENVOI AUTOMATIQUE DE L'IMAGE D'UNE INFO QUAND LE BOT L'UTILISE ──────
// Claude ajoute un marqueur invisible [[INFO:id]] à la fin de sa réponse
// quand il utilise le contenu d'une info. On extrait ces ids, on nettoie
// le texte visible, et on envoie l'image de chaque info concernée (si elle en a une).
function extraireIdsInfoUtilisees(texte) {
  if (!texte) return [];
  const ids = new Set();
  const regex = /\[\[INFO:(\d+)\]\]/g;
  let m;
  while ((m = regex.exec(texte)) !== null) ids.add(parseInt(m[1]));
  return Array.from(ids);
}
function nettoyerReponseInfoTags(texte) {
  if (!texte) return texte;
  return texte.replace(/\s*\[\[INFO:\d+\]\]\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function envoyerImagesInfos(to, ids) {
  if (!ids || !ids.length) return;
  try {
    const result = await pool.query('SELECT image_url FROM infos WHERE id = ANY($1) AND image_url IS NOT NULL', [ids]);
    for (const row of result.rows) {
      if (row.image_url) {
        await sendWhatsAppImage(to, row.image_url);
        await new Promise(r => setTimeout(r, 400));
      }
    }
  } catch (e) { console.error('Erreur envoi images infos:', e.message); }
}
function normaliserMot(mot) {
  return (mot || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/(.)\1+/g, '$1'); // colle les lettres doublées (ex: houppa -> houpa) pour tolérer les variantes d'écriture
}
const MOTS_VIDES_INFO = new Set(['sous', 'la', 'le', 'les', 'de', 'des', 'du', 'et', 'a', 'au', 'aux', 'un', 'une', 'sur', 'pour', 'dans', 'avec', 'ce', 'cette', 'ces']);
function motsSignificatifs(texte) {
  return (texte || '').split(/[^a-zA-Zà-ÿÀ-Ÿ']+/).map(normaliserMot).filter(m => m.length >= 3 && !MOTS_VIDES_INFO.has(m));
}
// Cherche une info qui n'a pas de vrai contenu (contenu vide ou identique au titre) mais
// qui a une image, en comparant les mots du titre à ceux du message (tolérant aux fautes/variantes).
async function trouverInfoImageSansContenu(text) {
  try {
    const result = await pool.query(
      `SELECT id, titre, image_url FROM infos WHERE image_url IS NOT NULL AND (contenu IS NULL OR contenu = '' OR lower(trim(contenu)) = lower(trim(titre)))`
    );
    if (!result.rows.length) return null;
    const motsMessage = new Set(motsSignificatifs(text));
    if (!motsMessage.size) return null;
    for (const row of result.rows) {
      const motsTitre = motsSignificatifs(row.titre);
      if (!motsTitre.length) continue;
      const trouves = motsTitre.filter(m => motsMessage.has(m));
      if (trouves.length >= Math.max(1, Math.ceil(motsTitre.length / 2))) return row;
    }
    return null;
  } catch (e) { console.error('Erreur recherche info image:', e.message); return null; }
}
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } })
  });
}
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
  const config = TYPES_DEMANDES[type]; const label = config ? config.label : type;
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const r = await envoyerEmail({
    subject: `📋 Nouvelle demande : ${label}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">📋 ${label}</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Date</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${dateStr}</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">WhatsApp</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>+${phone}</strong></td></tr><tr><td style="padding:8px;color:#666;vertical-align:top;">Message</td><td style="padding:8px;white-space:pre-wrap;"><strong>${texteLibre}</strong></td></tr></table></div>`,
  });
  if (!r.ok) console.error('Email error:', r.error);
}
async function envoyerBackupCerfa({ numero, nom, prenom, adresse, montant, mode, dateVersement, email }, pdfBuffer) {
  const r = await envoyerEmail({
    subject: `🧾 Sauvegarde Cerfa ${numero}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">🧾 Sauvegarde automatique — Cerfa ${numero}</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Donateur</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${prenom || ''} ${nom || ''}</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Adresse</td><td style="padding:8px;border-bottom:1px solid #eee;">${adresse || ''}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Montant</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${montant} €</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Mode</td><td style="padding:8px;border-bottom:1px solid #eee;">${mode || ''}</td></tr><tr><td style="padding:8px;color:#666;">Date du don</td><td style="padding:8px;">${dateVersement || ''}</td></tr></table><p style="color:#999;font-size:12px;margin-top:16px;">Ce mail est généré automatiquement à chaque Cerfa créé, pour garder une copie de secours indépendante.</p></div>`,
    attachments: [{ filename: `Cerfa_${numero}.pdf`, content: pdfBuffer }],
  });
  if (!r.ok) console.error('Backup Cerfa email error:', r.error);
}
function modeAffichageDonateur(mode) {
  if (!mode) return 'votre don';
  const m = mode.toLowerCase();
  if (m.includes('espèce')) return 'espèces';
  if (m.includes('chèque')) return 'chèque';
  if (m.includes('carte') || m.includes('virement') || m.includes('prélèvement')) return 'carte bancaire';
  return mode;
}
async function envoyerCerfaDonateur({ numero, nom, prenom, montant, mode, email }, pdfBuffer) {
  if (!email) return;
  const montantAffiche = Number(montant).toLocaleString('fr-FR');
  const r = await envoyerEmail({
    to: email,
    subject: `Votre reçu fiscal — ${ASSOCIATION.nom}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;line-height:1.5;">
      <p>Bonjour ${prenom || ''} ${nom || ''},</p>
      <p>Votre don de ${montantAffiche} € par ${modeAffichageDonateur(mode)} en faveur de l'association ${ASSOCIATION.nom} est confirmé.</p>
      <p>Nous vous remercions chaleureusement pour votre soutien et vous souhaitons le meilleur dans tous les domaines !</p>
      <p>Vous trouverez ci-joint votre reçu fiscal.</p>
      <p>Si vous rencontrez des difficultés pour consulter votre reçu, n'hésitez pas à nous contacter directement.</p>
    </div>`,
    attachments: [{ filename: `Cerfa_${numero}.pdf`, content: pdfBuffer }],
  });
  if (!r.ok) console.error('Email donateur error:', r.error);
}
function getSignature() { const now = new Date(); return now.getDay() === 5 ? "Chabbat Chalom !" : "Kol Touv !"; }
async function envoyerRelancePaiement(p) {
  let prenom = null;
  try {
    const c = await pool.query('SELECT prenom FROM contacts WHERE phone=$1', [p.phone]);
    if (c.rows.length > 0) prenom = c.rows[0].prenom;
  } catch (e) {}
  const salutation = prenom ? `Chalom ${prenom} !` : `Chalom !`;
  const montantAffiche = parseFloat(p.montant).toLocaleString('fr-FR');
  let message = `${salutation} 🙏\n\nPetit rappel amical : il reste ${montantAffiche}€ à régler`;
  if (p.description) message += ` pour ${p.description}`;
  message += `.`;
  if (p.lien_paiement) message += `\n\nVoici le lien pour régler en ligne :\n${p.lien_paiement}`;
  message += `\n\nMerci beaucoup !\n\n${getSignature()}`;
  await sendWhatsApp(p.phone, message);
  await pool.query(
    `UPDATE paiements SET nb_relances = nb_relances + 1, derniere_relance = NOW(), statut = CASE WHEN statut = 'en_attente' THEN 'relance' ELSE statut END WHERE id = $1`,
    [p.id]
  );
}
function demarrerCronRelancesPaiements() {
  setInterval(async () => {
    const now = new Date();
    const heuresParis = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (heure === 10 && minute < 5) {
      const dateAujourdhui = heuresParis.toISOString().slice(0, 10);
      const cacheKey = `relances_envoyees_${dateAujourdhui}`;
      if (global[cacheKey]) return;
      global[cacheKey] = true;
      console.log('🔔 Vérification des relances de paiement automatiques...');
      try {
        const result = await pool.query(`
          SELECT * FROM paiements
          WHERE statut IN ('en_attente', 'relance')
            AND nb_relances < max_relances
            AND (
              (derniere_relance IS NULL AND created_at <= NOW() - (delai_relance_jours || ' days')::interval)
              OR (derniere_relance IS NOT NULL AND derniere_relance <= NOW() - (delai_relance_jours || ' days')::interval)
            )
        `);
        for (const p of result.rows) {
          try { await envoyerRelancePaiement(p); await new Promise(r => setTimeout(r, 300)); }
          catch (e) { console.error('Relance paiement erreur:', p.id, e.message); }
        }
        console.log(`🔔 ${result.rows.length} relance(s) automatique(s) envoyée(s)`);
      } catch (e) { console.error('Cron relances error:', e.message); }
    }
  }, 5 * 60 * 1000);
  console.log('⏰ Cron relances paiements démarré');
}
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});
// ─── AJOUT — route publique servant les images uploadées via WhatsApp ──
app.get('/media/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT data, mime_type FROM medias WHERE id=$1', [req.params.id]);
    if (result.rows.length === 0) return res.sendStatus(404);
    res.set('Content-Type', result.rows[0].mime_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.rows[0].data);
  } catch (e) {
    res.sendStatus(500);
  }
});
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
       if (message && message.type === 'button') { await handleBoutonTemplate(message); return; }
    if (message && message.type === 'interactive') {
      const from = message.from, msgId = message.id;
      try {
        const already = await pool.query('SELECT 1 FROM messages_traites WHERE msg_id=$1', [msgId]);
        if (already.rows.length > 0) return;
        await pool.query('INSERT INTO messages_traites (msg_id) VALUES ($1) ON CONFLICT DO NOTHING', [msgId]);
      } catch (e) { console.error('Dedup error:', e.message); }
      const buttonId = message.interactive?.button_reply?.id;
            if (buttonId && buttonId.indexOf('tsedaka_') === 0) { await gererBoutonTsedaka(from, buttonId); return; }
      if (buttonId && buttonId.indexOf('inscription_') === 0) { await gererBoutonInscription(from, buttonId); return; }
            if (buttonId && buttonId.indexOf('sefer_') === 0) { await gererBoutonSefer(from, buttonId); return; }
      if (buttonId && isAuthorizedAdminCerfa(from)) {
        if (buttonId === 'valider_chabbat') {
          await sendWhatsApp(from, '✓ Envoi du message Chabbat en cours...');
          await envoyerHorairesChabbatValides();
          await sendWhatsApp(from, '✅ Message Chabbat envoyé à tous les abonnés!');
        } else if (buttonId === 'editer_chabbat') {
          global.chabbatEnEdition = true;
          await sendWhatsApp(from, '✎ Envoie-moi le message modifié (ou réponds avec le texte complet que tu veux envoyer)');
        } else if (buttonId === 'annuler_chabbat') {
          global.chabbatEnAttente = null;
          global.chabbatEnEdition = false;
          await sendWhatsApp(from, '❌ Envoi annulé.');
        } else {
          await gererChoixAmbianceAjout(from, buttonId);
        }
      }
      return;
    }

    // AJOUT — l'admin envoie une image -> on démarre le flux d'ajout dans les Infos
    if (message && message.type === 'image') {
      const from = message.from, msgId = message.id;
      try {
        const already = await pool.query('SELECT 1 FROM messages_traites WHERE msg_id=$1', [msgId]);
        if (already.rows.length > 0) return;
        await pool.query('INSERT INTO messages_traites (msg_id) VALUES ($1) ON CONFLICT DO NOTHING', [msgId]);
      } catch (e) { console.error('Dedup error:', e.message); }
      if (isAuthorizedAdminCerfa(from)) {
        const mediaId = message.image?.id;
        if (mediaId) await demarrerAjoutInfo(from, mediaId);
      }
      return;
    }

    if (message && message.type === 'text') {
      const from = message.from, text = message.text.body, msgId = message.id;
      try {
        const already = await pool.query('SELECT 1 FROM messages_traites WHERE msg_id=$1', [msgId]);
        if (already.rows.length > 0) return;
        await pool.query('INSERT INTO messages_traites (msg_id) VALUES ($1) ON CONFLICT DO NOTHING', [msgId]);
      } catch(e) { console.error('Dedup error:', e.message); }

      if (await handleAdminCerfaCommand(from, text)) return;
      if (await handlePriveCommand(from, text)) return;
            if (await handleSeferTorah(from, text)) return;
            if (await handleCerfaTsedakaCommand(from, text)) return;
            if (await handleInscriptionTsedaka(from, text)) return;
      if (isAuthorizedAdminCerfa(from)) {
        // ÉDITION — l'admin modifie le message Chabbat
        if (global.chabbatEnEdition) {
          global.chabbatEnEdition = false;
          global.chabbatEnAttente.message = text;
          await sendWhatsAppButtons(
            from, 
            `📢 VALIDATION MESSAGE MODIFIÉ\n\n${text}\n\nValider l'envoi ?`,
            [
              { id: 'valider_chabbat', title: '✓ Envoyer' },
              { id: 'editer_chabbat', title: '✎ Éditer à nouveau' },
              { id: 'annuler_chabbat', title: '✗ Annuler' }
            ]
          );
          return;
        }
        
        // AJOUT — étapes "titre" puis "contenu" du flux Infos avec image (prioritaire sur le flux musique)
        const sessionInfo = sessionsAjoutInfo[from];
        if (sessionInfo && sessionInfo.etape === 'titre') {
          const reponse = await gererTitreAjoutInfo(from, text);
          await sendWhatsApp(from, reponse);
          return;
        }
        if (sessionInfo && sessionInfo.etape === 'contenu') {
          const reponse = await gererContenuAjoutInfo(from, text);
          await sendWhatsApp(from, reponse);
          return;
        }
        const sessionAjout = sessionsAjoutMusique[from];
        if (sessionAjout && sessionAjout.etape === 'titre') {
          const reponse = await gererTitreAjoutMusique(from, text);
          await sendWhatsApp(from, reponse);
          return;
        }
        const lienDetecte = extraireUrlMusique(text);
        if (lienDetecte && !sessionAjout) {
          await demarrerAjoutMusique(from, lienDetecte);
          return;
        }
      }

      if (sessionsAbonnement[from]) {
        const typeAbonnement = sessionsAbonnement[from];
        delete sessionsAbonnement[from];
        if (estReponseOui(text)) {
          await mettreAJourAbonnement(from, typeAbonnement, true);
          const msg = typeAbonnement === 'chabbat'
            ? `Super ! Tu recevras les horaires d'allumage des bougies chaque vendredi matin. 🕯️\n\nKol Touv !`
            : `Parfait ! Tu recevras les infos et événements du Beth Habad. 😊\n\nKol Touv !`;
          await sendWhatsApp(from, msg);
        } else if (estReponseNon(text)) {
          await mettreAJourAbonnement(from, typeAbonnement, false);
          await sendWhatsApp(from, `Pas de souci ! Tu peux toujours me demander à tout moment.\n\nKol Touv !`);
        } else {
          sessionsAbonnement[from] = typeAbonnement;
          const question = typeAbonnement === 'chabbat'
            ? `Réponds simplement Oui ou Non 😊\n\nVeux-tu recevoir les horaires d'allumage des bougies chaque vendredi matin ?`
            : `Réponds simplement Oui ou Non 😊\n\nVeux-tu recevoir les infos et événements du Beth Habad ?`;
          await sendWhatsApp(from, question);
        }
        return;
      }
      let reply, estUneDemande = false, idsInfosAEnvoyer = [];
      const contact = await getOuCreerContact(from);
      await incrementerMessages(from);
      const contactMaj = await pool.query('SELECT * FROM contacts WHERE phone=$1', [from]).then(r => r.rows[0]).catch(() => null);
      let session = null;
      try { const sr = await pool.query('SELECT * FROM sessions_demande WHERE phone=$1', [from]); if (sr.rows.length > 0) session = sr.rows[0]; } catch(e) {}
      if (session && session.terminee) { await pool.query('DELETE FROM sessions_demande WHERE phone=$1', [from]).catch(()=>{}); session = null; }
      const infoImageMatch = !session ? await trouverInfoImageSansContenu(text) : null;
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
      } else if (sessionsMusiqueType[from]) {
        reply = await gererMusique(from, text, sessionsMusiqueType[from]?.mode || 'musique');
      } else if (parlDePlaylist(text)) {
        reply = await gererMusique(from, text, 'playlist');
      } else if (parlDeMusique(text)) {
        reply = await gererMusique(from, text, 'musique');
      } else if (sessionsHistoires[from] || parleDeHistoire(text)) {
        reply = await gererHistoire(from, text);
      } else if (infoImageMatch) {
        reply = `📋 ${infoImageMatch.titre}`;
        idsInfosAEnvoyer = [infoImageMatch.id];
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
          else if (parleDeChabbat(text)) extra = await getHorairesChabbatCached().then(d => d?.texte || null);
          else if (parleDevenements(text)) extra = await getEvenements();
          let historique = [];
          try { const hist = await pool.query('SELECT question, reponse FROM conversations WHERE phone=$1 ORDER BY created_at DESC LIMIT 5', [from]); historique = hist.rows.reverse(); } catch (e) {}
          reply = await askClaude(text, extra, historique);
          idsInfosAEnvoyer = extraireIdsInfoUtilisees(reply);
          reply = nettoyerReponseInfoTags(reply);
        }
      }
      const replyContientQuestion = reply && reply.trim().endsWith("?");
      if (!replyContientQuestion) {
        const questionAbonnement = await getQuestionAbonnement(from, contactMaj);
        if (questionAbonnement) reply = reply + questionAbonnement;
      }
      await sendWhatsApp(from, reply);
      if (idsInfosAEnvoyer.length) await envoyerImagesInfos(from, idsInfosAEnvoyer);
      if (!estUneDemande) {
        try { await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [from, text, reply]); } catch (e) {}
      }
    }
  }
});
// ─── UPLOAD D'IMAGE DEPUIS L'ADMIN PANEL (drag-and-drop / choix de fichier) ──
// Reçoit l'image encodée en base64, la stocke dans la table `medias` (la même
// que pour le flux WhatsApp) et renvoie l'URL publique /media/:id à utiliser
// comme image_url pour une info, une histoire, etc.
app.post('/admin/upload-image', async (req, res) => {
  const { password, image_base64, mime_type } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!image_base64) return res.status(400).json({ ok: false, message: "Aucune image reçue" });
  if (!PUBLIC_BASE_URL) return res.status(400).json({ ok: false, message: "La variable PUBLIC_BASE_URL n'est pas configurée sur Railway." });
  try {
    const buffer = Buffer.from(image_base64, 'base64');
    const idMedia = await enregistrerMedia(buffer, mime_type || 'image/jpeg');
    res.json({ ok: true, url: `${PUBLIC_BASE_URL}/media/${idMedia}` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.post('/admin/add', async (req, res) => {
  const { password, categorie, titre, contenu, instruction, image_url } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!titre || !contenu) return res.status(400).json({ ok: false, message: "Titre et contenu requis" });
  await pool.query('INSERT INTO infos (categorie, titre, contenu, instruction, image_url) VALUES ($1, $2, $3, $4, $5)', [categorie, titre, contenu, instruction || null, image_url || null]);
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
  const { password, categorie, titre, contenu, instruction, image_url } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('UPDATE infos SET categorie=$1, titre=$2, contenu=$3, instruction=$4, image_url=$5 WHERE id=$6', [categorie, titre, contenu, instruction || null, image_url || null, req.params.id]);
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
  const result = await pool.query(`
    SELECT conv.*, ct.nom, ct.prenom, ct.genre
    FROM conversations conv
    LEFT JOIN contacts ct ON ct.phone = conv.phone
    ORDER BY conv.created_at DESC LIMIT 50
  `);
  res.json({ ok: true, conversations: result.rows });
});
app.get('/admin/conversations/liste', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query(`
    SELECT conv.phone,
           COUNT(*)::int AS nb_messages,
           MAX(conv.created_at) AS derniere_date,
           (ARRAY_AGG(conv.question ORDER BY conv.created_at DESC))[1] AS derniere_question,
           ct.nom, ct.prenom, ct.genre
    FROM conversations conv
    LEFT JOIN contacts ct ON ct.phone = conv.phone
    GROUP BY conv.phone, ct.nom, ct.prenom, ct.genre
    ORDER BY derniere_date DESC
  `);
  res.json({ ok: true, contacts: result.rows });
});
app.get('/admin/conversations/thread', async (req, res) => {
  const { password, phone } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!phone) return res.status(400).json({ ok: false, message: "Numéro requis" });
  const result = await pool.query(`
    SELECT conv.*, ct.nom, ct.prenom, ct.genre
    FROM conversations conv
    LEFT JOIN contacts ct ON ct.phone = conv.phone
    WHERE conv.phone = $1
    ORDER BY conv.created_at ASC
  `, [phone]);
  res.json({ ok: true, messages: result.rows });
});
app.delete('/admin/conversations/delete', async (req, res) => {
  const { password, phone } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!phone) return res.status(400).json({ ok: false, message: "Numéro requis" });
  const result = await pool.query('DELETE FROM conversations WHERE phone = $1', [phone]);
  res.json({ ok: true, message: `${result.rowCount} messages supprimés`, deleted: result.rowCount });
});
app.get('/admin/home/recent-conversations', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query(`
      SELECT phone, question, reponse, created_at,
             (SELECT nom FROM contacts WHERE phone = conversations.phone LIMIT 1) as nom,
             (SELECT prenom FROM contacts WHERE phone = conversations.phone LIMIT 1) as prenom
      FROM conversations
      ORDER BY created_at DESC LIMIT 8
    `);
    res.json({ ok: true, conversations: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/admin/demandes', async (req, res) => {
  const { password, type } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  let query = 'SELECT d.*, ct.nom, ct.prenom, ct.genre FROM demandes d LEFT JOIN contacts ct ON ct.phone = d.phone'; const params = [];
  if (type) { query += ' WHERE d.type = $1'; params.push(type); }
  query += ' ORDER BY d.created_at DESC';
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
app.get('/admin/cerfa', async (req, res) => {
  const { password, search } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  let query = 'SELECT * FROM cerfa_receipts'; const params = [];
  if (search) { query += ' WHERE nom ILIKE $1 OR prenom ILIKE $1 OR numero ILIKE $1'; params.push(`%${search}%`); }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json({ ok: true, receipts: result.rows, total: result.rows.length });
});
app.get('/admin/email-check', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!RESEND_API_KEY) {
    return res.json({ ok: false, configured: false, message: "La variable RESEND_API_KEY n'est pas configurée sur Railway." });
  }
  const r = await envoyerEmail({
    subject: '✅ Test email de sauvegarde Shliah Bot',
    html: '<p>Ceci est un email de test. Si tu le reçois, le système de sauvegarde par email fonctionne.</p>',
  });
  if (r.ok) {
    res.json({ ok: true, configured: true, message: `Email de test envoyé avec succès à ${RESEND_TO_EMAIL}. Vérifie ta boîte de réception (et les spams).` });
  } else {
    res.json({ ok: false, configured: true, message: "La variable est configurée mais l'envoi a échoué.", error: r.error });
  }
});
app.get('/admin/cerfa/export', async (req, res) => {
  const { password, email } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT * FROM cerfa_receipts ORDER BY created_at ASC');
    const rows = result.rows;
    const cols = ['numero', 'nom', 'prenom', 'adresse', 'montant', 'mode_paiement', 'date_don', 'email', 'created_at'];
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvLines = [cols.join(';')];
    rows.forEach((r) => { csvLines.push(cols.map((c) => csvEscape(r[c])).join(';')); });
    const csv = '﻿' + csvLines.join('\n');
    if (email !== 'false') {
      envoyerEmail({
        subject: `📦 Sauvegarde complète Cerfa (${rows.length} reçus)`,
        html: `<p>Export complet de tous les reçus Cerfa, ${rows.length} au total, en pièce jointe (fichier CSV, s'ouvre avec Excel/Numbers).</p>`,
        attachments: [{ filename: `Cerfa_export_${new Date().toISOString().slice(0, 10)}.csv`, content: csv }],
      }).then((r) => { if (!r.ok) console.error('Export email error:', r.error); });
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="Cerfa_export_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
const TABLES_BACKUP = ['infos', 'demandes', 'contacts', 'histoires', 'musiques', 'playlistes', 'playliste_musiques', 'cerfa_counters', 'cerfa_receipts'];
async function exporterBaseComplete() {
  const dump = { genere_le: new Date().toISOString(), tables: {} };
  for (const table of TABLES_BACKUP) {
    try {
      const result = await pool.query(`SELECT * FROM ${table}`);
      dump.tables[table] = result.rows;
    } catch (e) {
      dump.tables[table] = { erreur: e.message };
    }
  }
  try {
    const conv = await pool.query('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 2000');
    dump.tables['conversations (2000 plus récentes)'] = conv.rows;
  } catch (e) {
    dump.tables['conversations (2000 plus récentes)'] = { erreur: e.message };
  }
  return dump;
}
async function sauvegarderBaseComplete() {
  const dump = await exporterBaseComplete();
  const json = JSON.stringify(dump, null, 2);
  const counts = Object.entries(dump.tables).map(([t, rows]) => `${t} : ${Array.isArray(rows) ? rows.length : 'erreur'}`).join('<br>');
  const r = await envoyerEmail({
    subject: `🗄️ Sauvegarde complète Shliah Bot — ${new Date().toLocaleDateString('fr-FR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">🗄️ Sauvegarde complète</h2><p>Toutes les données du bot, en pièce jointe (fichier JSON).</p><p style="color:#666;font-size:13px;">${counts}</p></div>`,
    attachments: [{ filename: `shliah-backup-${new Date().toISOString().slice(0, 10)}.json`, content: json }],
  });
  if (!r.ok) console.error('Backup complète email error:', r.error);
  return { json, ok: r.ok, error: r.error };
}
function demarrerCronBackup() {
  setInterval(async () => {
    const now = new Date();
    const heuresParis = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jour = heuresParis.getDay(), heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (heure === 3 && minute < 5) {
      const dateAujourdhui = heuresParis.toISOString().slice(0, 10);
      const cacheKey = `backup_envoye_${dateAujourdhui}`;
      if (global[cacheKey]) return;
      global[cacheKey] = true;
      console.log('🗄️ Sauvegarde complète automatique...');
      await sauvegarderBaseComplete();
    }
  }, 5 * 60 * 1000);
  console.log('⏰ Cron sauvegarde démarré');
}
app.get('/admin/backup-complete', async (req, res) => {
  const { password, email } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const dump = await exporterBaseComplete();
    const json = JSON.stringify(dump, null, 2);
    if (email !== 'false') {
      const counts = Object.entries(dump.tables).map(([t, rows]) => `${t} : ${Array.isArray(rows) ? rows.length : 'erreur'}`).join('<br>');
      envoyerEmail({
        subject: `🗄️ Sauvegarde complète Shliah Bot — ${new Date().toLocaleDateString('fr-FR')}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">🗄️ Sauvegarde complète (manuelle)</h2><p>Toutes les données du bot, en pièce jointe (fichier JSON).</p><p style="color:#666;font-size:13px;">${counts}</p></div>`,
        attachments: [{ filename: `shliah-backup-${new Date().toISOString().slice(0, 10)}.json`, content: json }],
      }).then((r) => { if (!r.ok) console.error('Backup complète email error:', r.error); });
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="shliah-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(json);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/admin/logo-check', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const url = process.env.BETH_HABAD_LOGO_URL || null;
  if (!url) return res.json({ ok: true, configured: false, message: "La variable BETH_HABAD_LOGO_URL n'est pas configurée sur Railway." });
  const realBytes = await getBethHabadLogoBytes();
  try {
    const r = await fetch(url);
    const contentType = r.headers.get('content-type') || null;
    const buf = Buffer.from(await r.arrayBuffer());
    const lookslikeImage = !!(contentType && contentType.startsWith('image/'));
    const magicHex = buf.slice(0, 12).toString('hex');
    let realFormat = 'inconnu';
    if (magicHex.startsWith('89504e47')) realFormat = 'PNG (signature valide)';
    else if (magicHex.startsWith('ffd8ff')) realFormat = 'JPEG (signature valide)';
    else if (magicHex.startsWith('47494638')) realFormat = 'GIF';
    else if (magicHex.startsWith('52494646') && buf.slice(8, 12).toString('ascii') === 'WEBP') realFormat = 'WEBP';
    else if (magicHex.startsWith('3c737667') || magicHex.startsWith('3c3f786d')) realFormat = 'SVG (texte, pas une image bitmap)';
    let embedOk = false, embedError = null, embedFormat = null, width = null, height = null;
    if (lookslikeImage) {
      const testDoc = await PDFDocument.create();
      try {
        const img = await testDoc.embedPng(buf);
        embedOk = true; embedFormat = 'png'; width = img.width; height = img.height;
      } catch (e1) {
        try {
          const img = await testDoc.embedJpg(buf);
          embedOk = true; embedFormat = 'jpg'; width = img.width; height = img.height;
        } catch (e2) {
          embedError = `PNG: ${e1 && (e1.message || e1)} | JPG: ${e2 && (e2.message || e2)}`;
        }
      }
    }
    res.json({
      ok: true,
      configured: true,
      url,
      httpStatus: r.status,
      contentType,
      byteLength: buf.length,
      lookslikeImage,
      magicHex,
      realFormat,
      embedOk,
      embedFormat,
      width,
      height,
      embedError,
      realFunctionWorks: !!realBytes,
      realFunctionByteLength: realBytes ? realBytes.length : 0,
      message: !lookslikeImage
        ? "Le lien ne renvoie PAS une image (probablement une page HTML) - utilise le lien 'Raw' ou 'Copier l'adresse de l'image', pas le lien de la page GitHub."
        : !embedOk
          ? `Le fichier fait ${buf.length} octets et son vrai format détecté est : ${realFormat}. pdf-lib n'arrive pas à l'insérer (${embedError}). Il faut ré-enregistrer l'image en PNG classique (par exemple en l'ouvrant et en la ré-exportant avec Aperçu sur Mac, ou Paint sur Windows) puis la re-uploader.`
          : !realBytes
            ? "Le test direct marche, MAIS la fonction réellement utilisée pour générer les Cerfa (getBethHabadLogoBytes) renvoie rien — il y a sûrement une ancienne version de cette fonction encore présente dans index.js (peut-être collée deux fois). Il faut retélécharger le fichier index.js le plus récent et bien tout remplacer."
            : "Tout fonctionne : le logo devrait apparaître sur les Cerfa générés.",
    });
  } catch (e) {
    res.json({ ok: true, configured: true, url, error: e.message, message: "Le téléchargement du logo a échoué." });
  }
});
app.delete('/admin/cerfa/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM cerfa_receipts WHERE id = $1', [req.params.id]);
  res.json({ ok: true, message: "Supprimé" });
});
app.put('/admin/cerfa/:id', async (req, res) => {
  const { password, nom, prenom, adresse, montant, mode, date, email } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!nom || !adresse || !montant || !date) return res.status(400).json({ ok: false, message: "Nom, adresse, montant et date requis" });
  try {
    const montantNum = parseFloat(String(montant).replace(',', '.'));
    if (isNaN(montantNum)) return res.status(400).json({ ok: false, message: "Montant invalide" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, message: "Date invalide" });
    const modeLower = (mode || '').toLowerCase();
    let modeFinal = "Remise d'espèces";
    if (/cb|carte|virement|pr[eé]l[eè]vement/.test(modeLower)) modeFinal = 'Virement, prélèvement, carte bancaire';
    else if (/ch[eè]que/.test(modeLower)) modeFinal = 'Chèque';
    const prenomFinal = prenom && prenom.trim() ? prenom.trim() : '-';
    const emailFinal = email && email.trim() ? email.trim() : null;
    const result = await pool.query(
      `UPDATE cerfa_receipts SET nom=$1, prenom=$2, adresse=$3, montant=$4, mode_paiement=$5, date_don=$6, email=$7 WHERE id=$8 RETURNING *`,
      [nom.trim(), prenomFinal, adresse.trim(), montantNum, modeFinal, date, emailFinal, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: "Reçu introuvable" });
    res.json({ ok: true, message: "Reçu mis à jour", receipt: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.post('/admin/cerfa/:id/renvoyer', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT * FROM cerfa_receipts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: "Reçu introuvable" });
    const r = result.rows[0];
    if (!r.email) return res.status(400).json({ ok: false, message: "Aucun email renseigné pour ce reçu" });
    const dateVersement = new Date(r.date_don).toLocaleDateString('fr-FR');
    const pdfBuffer = await generateCerfaPDF({
      numero: r.numero, nom: r.nom, prenom: r.prenom, adresse: r.adresse,
      montant: parseFloat(r.montant), mode: r.mode_paiement, dateVersement,
    });
    await envoyerCerfaDonateur({ numero: r.numero, nom: r.nom, prenom: r.prenom, montant: parseFloat(r.montant), mode: r.mode_paiement, email: r.email }, pdfBuffer);
    res.json({ ok: true, message: `Reçu renvoyé à ${r.email}` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.post('/admin/cerfa/generer', async (req, res) => {
  const { password, nom, prenom, adresse, montant, mode, email, date } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!nom || !adresse || !montant) return res.status(400).json({ ok: false, message: "Nom, adresse et montant requis" });
  try {
    const montantNum = parseFloat(String(montant).replace(',', '.'));
    if (isNaN(montantNum)) return res.status(400).json({ ok: false, message: "Montant invalide" });
    const modeLower = (mode || '').toLowerCase();
    let modeFinal = "Remise d'espèces";
    if (/cb|carte/.test(modeLower)) modeFinal = 'Carte bancaire';
    else if (/virement/.test(modeLower)) modeFinal = 'Virement';
    else if (/pr[eé]l[eè]vement/.test(modeLower)) modeFinal = 'Prélèvement';
    else if (/ch[eè]que/.test(modeLower)) modeFinal = 'Chèque';
    else if (/autre/.test(modeLower)) modeFinal = 'Autre';
    const numero = await getNextCerfaNumero();
    const prenomFinal = prenom && prenom.trim() ? prenom.trim() : '-';
    const emailFinal = email && email.trim() ? email.trim() : null;
    const dateDon = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const dateVersement = new Date(dateDon + 'T00:00:00').toLocaleDateString('fr-FR');
    const pdfBuffer = await generateCerfaPDF({ numero, nom: nom.trim(), prenom: prenomFinal, adresse: adresse.trim(), montant: montantNum, mode: modeFinal, dateVersement });
    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [numero, nom.trim(), prenomFinal, adresse.trim(), montantNum, modeFinal, dateDon, emailFinal]
    );
    envoyerBackupCerfa({ numero, nom: nom.trim(), prenom: prenomFinal, adresse: adresse.trim(), montant: montantNum, mode: modeFinal, dateVersement, email: emailFinal }, pdfBuffer).catch(e => console.error('Backup Cerfa error:', e));
    envoyerCerfaDonateur({ numero, nom: nom.trim(), prenom: prenomFinal, montant: montantNum, mode: modeFinal, email: emailFinal }, pdfBuffer).catch(e => console.error('Email donateur error:', e));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="Cerfa_${numero}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/admin/cerfa/:id/pdf', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT * FROM cerfa_receipts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: "Reçu introuvable" });
    const r = result.rows[0];
    const dateVersement = new Date(r.date_don).toLocaleDateString('fr-FR');
    const pdfBuffer = await generateCerfaPDF({
      numero: r.numero, nom: r.nom, prenom: r.prenom, adresse: r.adresse,
      montant: parseFloat(r.montant), mode: r.mode_paiement, dateVersement,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="Cerfa_${r.numero}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/admin/broadcast/contacts', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT DISTINCT phone FROM conversations ORDER BY phone');
    res.json({ ok: true, count: result.rows.length, phones: result.rows.map(r => r.phone) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/admin/broadcast/send', async (req, res) => {
  const { password, mode, paracha, date, entree, sortie, texte_libre, image_url, phone_unique, cible } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    let phones = [];
    if (phone_unique) { phones = [phone_unique.replace(/[\s\+\-\.]/g, '')]; }
    else if (cible === 'abonnes_evenements') { const r = await pool.query('SELECT phone FROM contacts WHERE abonne_evenements=TRUE'); phones = r.rows.map(r => r.phone); }
    else if (cible === 'abonnes_chabbat') { const r = await pool.query('SELECT phone FROM contacts WHERE abonne_chabbat=TRUE'); phones = r.rows.map(r => r.phone); }
    else { const r = await pool.query('SELECT DISTINCT phone FROM conversations ORDER BY phone'); phones = r.rows.map(r => r.phone); }
    if (phones.length === 0) return res.json({ ok: false, message: "Aucun contact trouvé" });
    let envoyes = 0, erreurs = 0;
    for (const phone of phones) {
      try {
        let body;
        let messageTexte = '';
        if (mode === 'chabbat') {
          body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'broadcast_chabbat', language: { code: 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text: paracha || '' }, { type: 'text', text: date || '' }, { type: 'text', text: entree || '' }, { type: 'text', text: sortie || '' }] }] } });
          messageTexte = `🕯️ Chabbat Chalom !\n\nParacha de la semaine : ${paracha || ''}\nDate : ${date || ''}\n\nEntrée de Chabbat : ${entree || ''}\nSortie de Chabbat : ${sortie || ''}\n\nChabbat Chalom à toute la communauté ! 🌟\n✡️ Beth Habad Saint-Maurice`;
        } else {
          const texteAEnvoyer = (texte_libre || '').trim();
          if (texteAEnvoyer && texteAEnvoyer !== ' ') {
            body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: texteAEnvoyer } });
            messageTexte = texteAEnvoyer;
          } else if (image_url) {
            await sendWhatsAppImage(phone, image_url);
            envoyes++;
            await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [phone, '[Admin - Image]', image_url]);
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
        }
        const response = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body });
        const data = await response.json();
        if (data.messages) {
          envoyes++;
          if (messageTexte) {
            await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [phone, '[Admin]', messageTexte]);
          }
          if (mode !== 'chabbat' && image_url && (texte_libre || '').trim() && (texte_libre || '').trim() !== ' ') {
            await new Promise(r => setTimeout(r, 400));
            await sendWhatsAppImage(phone, image_url);
          }
        } else { erreurs++; console.error(`Broadcast erreur ${phone}:`, JSON.stringify(data)); }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) { erreurs++; }
    }
    res.json({ ok: true, total: phones.length, envoyes, erreurs, message: `${envoyes} messages envoyés, ${erreurs} erreurs` });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/admin/chabbat', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const data = await getHorairesChabbat();
  res.json({ ok: true, data: data?.texte || null });
});
app.get('/admin/abonnes', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const result = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
  res.json({ ok: true, contacts: result.rows, total: result.rows.length, abonnesChabbat: result.rows.filter(r => r.abonne_chabbat).length, abonnesEvenements: result.rows.filter(r => r.abonne_evenements).length });
});
app.post('/admin/abonnes/envoyer', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await envoyerHorairesChabbatAbonnes();
  res.json({ ok: true, message: 'Horaires envoyés aux abonnés !' });
});
app.get('/admin/contacts/detail', async (req, res) => {
  const { password, phone } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!phone) return res.status(400).json({ ok: false, message: "Numéro requis" });
  const result = await pool.query('SELECT * FROM contacts WHERE phone = $1', [phone]);
  if (result.rows.length === 0) return res.json({ ok: false, message: "Contact non trouvé" });
  res.json({ ok: true, contact: result.rows[0] });
});
app.put('/admin/contacts/update', async (req, res) => {
  const { password, phone, prenom, nom, email, adresse, genre } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!phone) return res.status(400).json({ ok: false, message: "Numéro requis" });
  try {
    await pool.query(
      'UPDATE contacts SET prenom = $1, nom = $2, email = $3, adresse = $4, genre = $5 WHERE phone = $6',
      [prenom, nom, email, adresse, genre, phone]
    );
    res.json({ ok: true, message: "Contact mis à jour" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
// ─── IMPORT NOMS/PRÉNOMS DES CONTACTS (par téléphone) ─────────
// Reçoit une liste { telephone, nom, prenom } (téléphone au format
// international sans + ni espace, ex: "33612345678") et met à jour ou crée
// les contacts correspondants avec leur nom/prénom. N'écrase jamais les
// abonnements existants : seuls nom/prenom sont modifiés.
app.post('/admin/contacts/import-noms', async (req, res) => {
  const { password, contacts } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ ok: false, message: "Liste de contacts vide" });
  let importes = 0, erreurs = 0;
  for (const c of contacts) {
    const phone = (c.telephone || '').replace(/[^\d]/g, '');
    const nom = (c.nom || '').trim() || null;
    const prenom = (c.prenom || '').trim() || null;
    const genreRaw = (c.genre || '').trim().toLowerCase();
    const genre = ['homme', 'femme', 'enfant'].includes(genreRaw) ? genreRaw : null;
    if (!phone) { erreurs++; continue; }
    try {
      await pool.query(
        `INSERT INTO contacts (phone, nom, prenom, genre) VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO UPDATE SET nom = EXCLUDED.nom, prenom = EXCLUDED.prenom, genre = EXCLUDED.genre`,
        [phone, nom, prenom, genre]
      );
      importes++;
    } catch (e) { erreurs++; console.error('Import contact error:', phone, e.message); }
  }
  res.json({ ok: true, importes, erreurs, total: contacts.length, message: `${importes} contact(s) importé(s)/mis à jour${erreurs ? `, ${erreurs} erreur(s)` : ''}` });
});
app.get('/admin/histoires', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const result = await pool.query('SELECT * FROM histoires ORDER BY created_at DESC');
  res.json({ ok: true, histoires: result.rows });
});
// ─── API ADMIN INFOS PRIVÉES ───────────────────────────────────
app.get('/admin/infos-privees', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query('SELECT * FROM infos_privees ORDER BY titre ASC');
  res.json({ ok: true, infos: result.rows });
});
app.post('/admin/infos-privees', async (req, res) => {
  const { password, titre, contenu } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!titre || !contenu) return res.status(400).json({ ok: false, message: "Titre et contenu requis" });
  await pool.query('INSERT INTO infos_privees (titre, contenu) VALUES ($1, $2)', [titre, contenu]);
  res.json({ ok: true, message: "Info privée ajoutée !" });
});
app.put('/admin/infos-privees/:id', async (req, res) => {
  const { password, titre, contenu } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('UPDATE infos_privees SET titre=$1, contenu=$2 WHERE id=$3', [titre, contenu, req.params.id]);
  res.json({ ok: true, message: "Info privée mise à jour !" });
});
app.delete('/admin/infos-privees/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM infos_privees WHERE id=$1', [req.params.id]);
  res.json({ ok: true, message: "Supprimée !" });
});
// ─── API ADMIN PAIEMENTS (suivi et relance) ───────────────────
app.get('/admin/paiements', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const result = await pool.query(`
    SELECT p.*, ct.nom, ct.prenom, ct.genre
    FROM paiements p
    LEFT JOIN contacts ct ON ct.phone = p.phone
    ORDER BY p.created_at DESC
  `);
  res.json({ ok: true, paiements: result.rows });
});
app.post('/admin/paiements', async (req, res) => {
  const { password, phone, montant, description, lien_paiement, delai_relance_jours, max_relances } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const phoneClean = (phone || '').replace(/[^\d]/g, '');
  const montantNum = parseFloat(String(montant).replace(',', '.'));
  if (!phoneClean || isNaN(montantNum)) return res.status(400).json({ ok: false, message: "Numéro et montant requis" });
  const result = await pool.query(
    `INSERT INTO paiements (phone, montant, description, lien_paiement, delai_relance_jours, max_relances) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [phoneClean, montantNum, description || null, lien_paiement || null, delai_relance_jours || 3, max_relances || 3]
  );
  res.json({ ok: true, message: "Paiement ajouté !", paiement: result.rows[0] });
});
app.put('/admin/paiements/:id/statut', async (req, res) => {
  const { password, statut } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('UPDATE paiements SET statut=$1 WHERE id=$2', [statut, req.params.id]);
  res.json({ ok: true, message: "Statut mis à jour" });
});
app.post('/admin/paiements/:id/relancer', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const result = await pool.query('SELECT * FROM paiements WHERE id=$1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: "Paiement introuvable" });
    await envoyerRelancePaiement(result.rows[0]);
    res.json({ ok: true, message: "Relance envoyée !" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.delete('/admin/paiements/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  await pool.query('DELETE FROM paiements WHERE id=$1', [req.params.id]);
  res.json({ ok: true, message: "Supprimé" });
});
app.post('/admin/histoires', async (req, res) => {
  const { password, titre, texte, image_url } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  if (!titre || !texte) return res.status(400).json({ ok: false, message: 'Titre et texte requis' });
  await pool.query('INSERT INTO histoires (titre, texte, image_url) VALUES ($1, $2, $3)', [titre, texte, image_url || null]);
  res.json({ ok: true, message: 'Histoire ajoutée !' });
});
app.put('/admin/histoires/:id', async (req, res) => {
  const { password, titre, texte, image_url } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('UPDATE histoires SET titre=$1, texte=$2, image_url=$3 WHERE id=$4', [titre, texte, image_url || null, req.params.id]);
  res.json({ ok: true, message: 'Histoire mise à jour !' });
});
app.delete('/admin/histoires/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('DELETE FROM histoires WHERE id=$1', [req.params.id]);
  res.json({ ok: true, message: 'Supprimée !' });
});
app.get('/admin/musiques', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const result = await pool.query('SELECT * FROM musiques ORDER BY ambiance, created_at DESC');
  res.json({ ok: true, musiques: result.rows });
});
app.post('/admin/musiques', async (req, res) => {
  const { password, titre, lien, ambiance } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  if (!titre || !lien || !ambiance) return res.status(400).json({ ok: false, message: 'Titre, lien et ambiance requis' });
  await pool.query('INSERT INTO musiques (titre, lien, ambiance) VALUES ($1, $2, $3)', [titre, lien, ambiance]);
  res.json({ ok: true, message: 'Musique ajoutée !' });
});
app.put('/admin/musiques/:id', async (req, res) => {
  const { password, titre, lien, ambiance } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('UPDATE musiques SET titre=$1, lien=$2, ambiance=$3 WHERE id=$4', [titre, lien, ambiance, req.params.id]);
  res.json({ ok: true, message: 'Musique mise à jour !' });
});
app.delete('/admin/musiques/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('DELETE FROM musiques WHERE id=$1', [req.params.id]);
  res.json({ ok: true, message: 'Supprimée !' });
});
app.get('/admin/playlistes', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const result = await pool.query('SELECT * FROM playlistes ORDER BY ambiance, created_at DESC');
  const playlistes = [];
  for (const p of result.rows) {
    const musiques = await pool.query('SELECT m.* FROM musiques m JOIN playliste_musiques pm ON pm.musique_id = m.id WHERE pm.playliste_id=$1', [p.id]);
    playlistes.push({ ...p, musiques: musiques.rows });
  }
  res.json({ ok: true, playlistes });
});
app.post('/admin/playlistes', async (req, res) => {
  const { password, nom, ambiance, description, musique_ids } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  if (!nom || !ambiance) return res.status(400).json({ ok: false, message: 'Nom et ambiance requis' });
  const result = await pool.query('INSERT INTO playlistes (nom, ambiance, description) VALUES ($1, $2, $3) RETURNING id', [nom, ambiance, description || null]);
  const id = result.rows[0].id;
  if (musique_ids && musique_ids.length > 0) {
    for (const mid of musique_ids) {
      await pool.query('INSERT INTO playliste_musiques (playliste_id, musique_id) VALUES ($1, $2)', [id, mid]);
    }
  }
  res.json({ ok: true, message: 'Playlist créée !' });
});
app.put('/admin/playlistes/:id', async (req, res) => {
  const { password, nom, ambiance, description, musique_ids } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('UPDATE playlistes SET nom=$1, ambiance=$2, description=$3 WHERE id=$4', [nom, ambiance, description || null, req.params.id]);
  if (musique_ids !== undefined) {
    await pool.query('DELETE FROM playliste_musiques WHERE playliste_id=$1', [req.params.id]);
    for (const mid of musique_ids) {
      await pool.query('INSERT INTO playliste_musiques (playliste_id, musique_id) VALUES ($1, $2)', [req.params.id, mid]);
    }
  }
  res.json({ ok: true, message: 'Playlist mise à jour !' });
});
app.delete('/admin/playlistes/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  await pool.query('DELETE FROM playlistes WHERE id=$1', [req.params.id]);
  res.json({ ok: true, message: 'Supprimée !' });
});
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

// TSEDAKA ENDPOINT — recevoir les données du formulaire Cerfa et générer/envoyer le Cerfa PDF
app.post('/tsedaka/cerfa', async (req, res) => {
  res.sendStatus(200); // Répondre immédiatement
  
  try {
    const { prenom, nom, adresse, tel, montant, phone, email } = req.body;    
    // Validation
    if (!prenom || !nom || !adresse || !tel || !montant || !phone) {
      console.error('Tsedaka Cerfa: données manquantes', { prenom, nom, adresse, tel, montant, phone });
      return;
    }
    
    // Normaliser le numéro de téléphone (enlever le +, garder 33XXXXXXXXX)
    let phoneFormatted = phone.replace(/\D/g, ''); // Enlever tout ce qui n'est pas un chiffre
    if (phoneFormatted.startsWith('33')) {
      // OK, garder tel quel
    } else if (phoneFormatted.startsWith('0')) {
      phoneFormatted = '33' + phoneFormatted.slice(1); // 0XX -> 33XX
    }
    
    // Générer le numéro Cerfa
    const numero = await getNextCerfaNumero();
    const dateDon = new Date().toISOString().slice(0, 10);
    const dateVersement = new Date(dateDon + 'T00:00:00').toLocaleDateString('fr-FR');
    
    // Générer le PDF Cerfa
    const pdfBuffer = await generateCerfaPDF({
      numero,
      nom: nom,
      prenom,
      adresse,
      montant: parseFloat(montant),
      mode: 'Paiement en ligne',
      dateVersement
    });
    
    const filename = `Cerfa_${numero}.pdf`;
    
    // Enregistrer en DB
    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [numero, nom, prenom, adresse, parseFloat(montant), 'Paiement en ligne', dateDon, tel]
    );
    await pool.query('UPDATE cerfa_receipts SET phone=$1 WHERE numero=$2', [phoneFormatted, numero]).catch(() => {});
    // Envoyer le Cerfa par email au donateur
    if (email && email.indexOf('@') > 0) {
      await pool.query('UPDATE cerfa_receipts SET email=$1 WHERE numero=$2', [email, numero]).catch(() => {});
      envoyerCerfaDonateur({
        numero: numero,
        nom: nom,
        prenom: prenom,
        montant: parseFloat(montant),
        mode: 'Paiement en ligne',
        email: email
      }, pdfBuffer).catch(e => console.error('Email Cerfa donateur:', e.message));
    }
    // Envoyer message de remerciement
    const gratitudeMsg = `Merci pour ta Tsedaka de ${montant}€ aujourd'hui ! 🙏\n\nTon reçu fiscal est en pièce jointe.`;
    await sendWhatsApp(phoneFormatted, gratitudeMsg);
    
    // Envoyer le PDF du Cerfa
    await sendWhatsAppDocument(phoneFormatted, pdfBuffer, filename);
    
    console.log(`✅ Cerfa Tsedaka généré: ${numero} pour ${prenom}`);
  } catch (e) {
    console.error('❌ Tsedaka Cerfa error:', e.message);
  }
});

// TEST ENDPOINT — déclencher le cron Chabbat manuellement
app.post('/test/chabbat', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    console.log('🕯️ Test cron Chabbat déclenché');
    await preparerValidationChabbat();
    res.json({ ok: true, message: "Message de validation Chabbat envoyé à l'admin!" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/test/chabbat/:password', async (req, res) => {
  const { password } = req.params;
  if (password !== 'test123' && password !== ADMIN_PASSWORD) return res.send('❌ Mot de passe incorrect');
  try {
    console.log('🕯️ Test cron Chabbat déclenché');
    await preparerValidationChabbat();
    res.send('✅ Message de validation Chabbat envoyé! Regarde ton WhatsApp 👍');
  } catch (e) {
    res.send('❌ Erreur: ' + e.message);
  }
});


// ═══════════════════════════════════════════════
// THEMES API - V2 PRO
// ═══════════════════════════════════════════════

// GET /api/admin/theme - Retourne le theme actif
app.get('/api/admin/theme', async (req, res) => {
  try {
    const result = await pool.query('SELECT colors_json FROM themes WHERE is_active = true LIMIT 1');
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active theme found' });
    }
    res.json(result.rows[0].colors_json);
  } catch (e) {
    console.error('Theme fetch error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/theme/update - Changer les couleurs
app.post('/api/admin/theme/update', async (req, res) => {
  try {
    const { colors } = req.body;
    if (!colors || typeof colors !== 'object') {
      return res.status(400).json({ error: 'Invalid colors object' });
    }
    
    // Mettre à jour le theme actif
    await pool.query(
      'UPDATE themes SET colors_json = $1 WHERE is_active = true',
      [JSON.stringify(colors)]
    );
    
    res.json({ success: true, message: 'Theme updated' });
  } catch (e) {
    console.error('Theme update error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// TSEDAKA QUOTIDIENNE — enregistrement des abonnés
// ═══════════════════════════════════════════════
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

async function initTsedakaDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tsedaka_abonnes (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      prenom TEXT,
      nom TEXT,
      adresse TEXT,
      stripe_customer_id TEXT,
      stripe_payment_method_id TEXT,
      carte_gardee BOOLEAN DEFAULT FALSE,
      rappel_quotidien BOOLEAN DEFAULT FALSE,
      dernier_don_le DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('Table tsedaka_abonnes prete');
  } catch (e) {
    console.error('Table tsedaka_abonnes error:', e.message);
  }
}
initTsedakaDB();

// Recupere la carte utilisee lors d'un paiement Stripe
async function stripeGetPaymentMethod(paymentIntentId) {
  if (!STRIPE_SECRET_KEY || !paymentIntentId) return null;
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents/' + paymentIntentId, {
      headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY }
    });
    const data = await res.json();
    if (data.error) { console.error('Stripe error:', data.error.message); return null; }
    return { paymentMethodId: data.payment_method || null, customerId: data.customer || null };
  } catch (e) {
    console.error('Stripe fetch error:', e.message);
    return null;
  }
}

// Appele par la page Tsedaka quand la personne coche une case
app.post('/tsedaka/abonner', async (req, res) => {
  res.sendStatus(200);
  try {
    const { phone, prenom, nom, adresse, garder_carte, rappel_quotidien, payment_intent_id, customer_id } = req.body;
    if (!phone) return;
    if (!garder_carte && !rappel_quotidien) return;

    let phoneFormatted = String(phone).replace(/\D/g, '');
    if (phoneFormatted.startsWith('0')) phoneFormatted = '33' + phoneFormatted.slice(1);

    let pmId = null;
    let custId = customer_id || null;
    if (garder_carte) {
      const info = await stripeGetPaymentMethod(payment_intent_id);
      if (info) {
        pmId = info.paymentMethodId;
        custId = info.customerId || custId;
      }
    }

    await pool.query(`
      INSERT INTO tsedaka_abonnes (phone, prenom, nom, adresse, stripe_customer_id, stripe_payment_method_id, carte_gardee, rappel_quotidien)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (phone) DO UPDATE SET
        prenom = COALESCE(EXCLUDED.prenom, tsedaka_abonnes.prenom),
        nom = COALESCE(EXCLUDED.nom, tsedaka_abonnes.nom),
        adresse = COALESCE(EXCLUDED.adresse, tsedaka_abonnes.adresse),
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, tsedaka_abonnes.stripe_customer_id),
        stripe_payment_method_id = COALESCE(EXCLUDED.stripe_payment_method_id, tsedaka_abonnes.stripe_payment_method_id),
        carte_gardee = (EXCLUDED.carte_gardee OR tsedaka_abonnes.carte_gardee),
        rappel_quotidien = EXCLUDED.rappel_quotidien
    `, [phoneFormatted, prenom || null, nom || null, adresse || null, custId, pmId, !!garder_carte, !!rappel_quotidien]);

    console.log('Tsedaka abonne enregistre:', phoneFormatted, '| carte:', !!pmId, '| rappel:', !!rappel_quotidien);
  } catch (e) {
    console.error('Tsedaka abonner error:', e.message);
  }
});

// Voir la liste des abonnes Tsedaka
app.get('/admin/tsedaka/abonnes', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const r = await pool.query('SELECT * FROM tsedaka_abonnes ORDER BY created_at DESC');    res.json({ ok: true, abonnes: r.rows, total: r.rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
// ═══════════════════════════════════════════════
// TSEDAKA QUOTIDIENNE — rappel 10h + paiement en 1 clic
// ═══════════════════════════════════════════════

const TSEDAKA_MONTANTS = {
  tsedaka_050: 0.50,
  tsedaka_100: 1,
  tsedaka_500: 5
};

async function initTsedakaDons() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tsedaka_dons (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      montant NUMERIC(10,2) NOT NULL,
      stripe_payment_intent_id TEXT,
      date_don DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('Table tsedaka_dons prete');
  } catch (e) {
    console.error('Table tsedaka_dons error:', e.message);
  }
}
initTsedakaDons();

// Debite la carte deja enregistree (la personne n'a rien a retaper)
async function stripeDebiterCarteGardee(customerId, paymentMethodId, montant) {
  if (!STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY manquante sur Railway' };
  if (!customerId || !paymentMethodId) return { ok: false, error: 'Carte non enregistree' };
  try {
    const params = new URLSearchParams();
    params.append('amount', String(Math.round(montant * 100)));
    params.append('currency', 'eur');
    params.append('customer', customerId);
    params.append('payment_method', paymentMethodId);
    params.append('off_session', 'true');
    params.append('confirm', 'true');
    params.append('description', 'Tsedaka quotidienne Beth Habad S. Maurice');
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message };
    if (data.status !== 'succeeded') return { ok: false, error: 'Paiement non abouti (' + data.status + ')' };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Quand la personne clique sur un montant dans WhatsApp
async function gererBoutonTsedaka(from, buttonId) {
  const montant = TSEDAKA_MONTANTS[buttonId];
  if (!montant) return;
  try {
    const r = await pool.query('SELECT * FROM tsedaka_abonnes WHERE phone=$1', [from]);
    if (r.rows.length === 0 || !r.rows[0].carte_gardee || !r.rows[0].stripe_payment_method_id) {
      await sendWhatsApp(from, "Je ne retrouve pas ta carte enregistree.\n\nTu peux faire ta Tsedaka ici :\nhttps://habadsmaurice.com/tsedaka/");
      return;
    }
    const ab = r.rows[0];
    const paiement = await stripeDebiterCarteGardee(ab.stripe_customer_id, ab.stripe_payment_method_id, montant);
    if (!paiement.ok) {
      console.error('Tsedaka paiement echoue', from, paiement.error);
      await sendWhatsApp(from, "Le paiement n'a pas pu passer.\n\nTu peux essayer ici :\nhttps://habadsmaurice.com/tsedaka/\n\n" + getSignature());
      return;
    }
    await pool.query('INSERT INTO tsedaka_dons (phone, montant, stripe_payment_intent_id) VALUES ($1,$2,$3)', [from, montant, paiement.id]);
    await pool.query('UPDATE tsedaka_abonnes SET dernier_don_le = CURRENT_DATE WHERE phone=$1', [from]);
    const montantAffiche = montant === 0.5 ? '0,50' : String(montant);
    await sendWhatsApp(from, "Tizkou Lemitsvot !\n\nTu as accompli la mitsva de Tsedaka aujourd'hui : " + montantAffiche + " euros\n\n" + getSignature());
    console.log('Tsedaka quotidienne OK:', from, montant);
  } catch (e) {
    console.error('gererBoutonTsedaka error:', e.message);
  }
}

// Envoie le rappel a tous les abonnes
async function envoyerRappelsTsedaka() {
  try {
    const r = await pool.query('SELECT phone, prenom FROM tsedaka_abonnes WHERE rappel_quotidien = TRUE');
    if (r.rows.length === 0) { console.log('Tsedaka: aucun abonne au rappel'); return; }
    let envoyes = 0;
    for (const ab of r.rows) {
      try {
        const salut = ab.prenom ? 'Chalom ' + ab.prenom + ' !' : 'Chalom !';
        await sendWhatsAppButtons(
          ab.phone,
          salut + "\n\nC'est le moment de ta Tsedaka du jour.\n\nChoisis ton montant :",
          [
            { id: 'tsedaka_050', title: '0,50 euros' },
            { id: 'tsedaka_100', title: '1 euro' },
            { id: 'tsedaka_500', title: '5 euros' }
          ]
        );
        envoyes++;
        await new Promise(res => setTimeout(res, 300));
      } catch (e) {
        console.error('Rappel Tsedaka erreur', ab.phone, e.message);
      }
    }
    console.log('Tsedaka: ' + envoyes + '/' + r.rows.length + ' rappels envoyes');
  } catch (e) {
    console.error('envoyerRappelsTsedaka error:', e.message);
  }
}

// Cron : chaque jour a 10h, JAMAIS le samedi (Chabbat)
function demarrerCronTsedaka() {
  setInterval(async () => {
    const heuresParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jour = heuresParis.getDay();
    const heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (jour === 6) return; // samedi = Chabbat, on n'envoie rien
    if (heure === 10 && minute < 5) {
      const dateAujourdhui = heuresParis.toISOString().slice(0, 10);
      const cacheKey = 'tsedaka_rappel_' + dateAujourdhui;
      if (global[cacheKey]) return;
      global[cacheKey] = true;
      console.log('Tsedaka: envoi des rappels du jour...');
      await envoyerRappelsTsedaka();
    }
  }, 5 * 60 * 1000);
  console.log('Cron Tsedaka quotidienne demarre (pas le samedi)');
}
demarrerCronTsedaka();

// Voir les dons Tsedaka quotidiens
app.get('/admin/tsedaka/dons', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const r = await pool.query(`
      SELECT d.*, a.prenom, a.nom
      FROM tsedaka_dons d
      LEFT JOIN tsedaka_abonnes a ON a.phone = d.phone
      ORDER BY d.created_at DESC LIMIT 200
    `);
    const total = r.rows.reduce((s, x) => s + parseFloat(x.montant || 0), 0);
    res.json({ ok: true, dons: r.rows, nombre: r.rows.length, total_collecte: total });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// TEST : ouvrir ce lien pour recevoir le rappel tout de suite
app.get('/test/tsedaka/:password', async (req, res) => {
  if (req.params.password !== ADMIN_PASSWORD) return res.send('Mot de passe incorrect');
  try {
    await envoyerRappelsTsedaka();
    res.send('Rappels Tsedaka envoyes ! Regarde ton WhatsApp.');
  } catch (e) {
    res.send('Erreur: ' + e.message);
  }
});
// ═══════════════════════════════════════════════
// CERFA TSEDAKA — recapitulatif mensuel + a la demande
// ═══════════════════════════════════════════════

pool.query('ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS cerfa_numero TEXT').catch(() => {});

// Genere UN seul Cerfa qui regroupe tous les dons pas encore factures
async function genererCerfaTsedaka(phone, avantDate) {
  try {
    let sql = 'SELECT id, montant, date_don FROM tsedaka_dons WHERE phone=$1 AND cerfa_numero IS NULL';
    const params = [phone];
    if (avantDate) { sql += ' AND date_don < $2'; params.push(avantDate); }
    sql += ' ORDER BY date_don ASC';
    const dons = await pool.query(sql, params);
    if (dons.rows.length === 0) return { ok: false, raison: 'aucun don a facturer' };

    const total = dons.rows.reduce((s, d) => s + parseFloat(d.montant), 0);
    const ids = dons.rows.map(d => d.id);

    const a = await pool.query('SELECT * FROM tsedaka_abonnes WHERE phone=$1', [phone]);
    const ab = a.rows[0] || {};
    const nom = ab.nom || 'Donateur';
    const prenom = ab.prenom || '-';
    const adresse = ab.adresse || '';

    const premier = new Date(dons.rows[0].date_don);
    const dernier = new Date(dons.rows[dons.rows.length - 1].date_don);
    const periode = premier.toLocaleDateString('fr-FR') + ' au ' + dernier.toLocaleDateString('fr-FR');

    const numero = await getNextCerfaNumero();
    const dateDon = dernier.toISOString().slice(0, 10);
    const dateVersement = dernier.toLocaleDateString('fr-FR');

    const pdfBuffer = await generateCerfaPDF({
      numero,
      nom: nom,
      prenom: prenom,
      adresse: adresse,
      montant: total,
      mode: 'Carte bancaire',
      dateVersement: dateVersement
    });

    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [numero, nom, prenom, adresse, total, 'Carte bancaire', dateDon, null]
    );
    await pool.query('UPDATE tsedaka_dons SET cerfa_numero=$1 WHERE id = ANY($2)', [numero, ids]);

    const totalAffiche = total.toFixed(2).replace('.', ',');
    await sendWhatsApp(phone,
      "Voici ton recu fiscal pour tes Tsedakot.\n\n" +
      "Periode : " + periode + "\n" +
      "Nombre de dons : " + dons.rows.length + "\n" +
      "Total : " + totalAffiche + " euros\n\n" +
      "Merci beaucoup pour ton soutien !\n\n" + getSignature()
    );
    await sendWhatsAppDocument(phone, pdfBuffer, 'Cerfa_' + numero + '.pdf');
    envoyerBackupCerfa({ numero, nom, prenom, adresse, montant: total, mode: 'Carte bancaire', dateVersement, email: null }, pdfBuffer)
      .catch(e => console.error('Backup Cerfa Tsedaka:', e.message));

    console.log('Cerfa Tsedaka envoye:', numero, phone, total);
    return { ok: true, numero: numero, total: total, nb: dons.rows.length };
  } catch (e) {
    console.error('genererCerfaTsedaka error:', e.message);
    return { ok: false, raison: e.message };
  }
}

// A LA DEMANDE : la personne ecrit "cerfa" au bot
async function handleCerfaTsedakaCommand(from, text) {
  try {
    const t = (text || '').toLowerCase();
    const demande = ['cerfa', 'recu fiscal', 'reçu fiscal', 'mon recu', 'mon reçu'].some(m => t.includes(m));
    if (!demande) return false;
    const d = await pool.query('SELECT 1 FROM tsedaka_dons WHERE phone=$1 AND cerfa_numero IS NULL LIMIT 1', [from]);
    if (d.rows.length === 0) return false;
    await sendWhatsApp(from, "Je prepare ton recu fiscal, un instant...");
    await genererCerfaTsedaka(from, null);
    return true;
  } catch (e) {
    console.error('handleCerfaTsedakaCommand error:', e.message);
    return false;
  }
}

// AUTOMATIQUE : le 1er de chaque mois a 9h, Cerfa du mois precedent
function demarrerCronCerfaTsedaka() {
  setInterval(async () => {
    const heuresParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (heuresParis.getDate() !== 1) return;
    if (heuresParis.getHours() !== 9 || heuresParis.getMinutes() >= 5) return;
    const cacheKey = 'cerfa_tsedaka_' + heuresParis.toISOString().slice(0, 7);
    if (global[cacheKey]) return;
    global[cacheKey] = true;
    const premierDuMois = heuresParis.toISOString().slice(0, 8) + '01';
    console.log('Cerfa Tsedaka mensuel : generation en cours...');
    try {
      const r = await pool.query('SELECT DISTINCT phone FROM tsedaka_dons WHERE cerfa_numero IS NULL AND date_don < $1', [premierDuMois]);
      for (const row of r.rows) {
        await genererCerfaTsedaka(row.phone, premierDuMois);
        await new Promise(res => setTimeout(res, 500));
      }
      console.log('Cerfa Tsedaka mensuel : ' + r.rows.length + ' envoyes');
    } catch (e) {
      console.error('Cron Cerfa Tsedaka error:', e.message);
    }
  }, 5 * 60 * 1000);
  console.log('Cron Cerfa Tsedaka mensuel demarre');
}
demarrerCronCerfaTsedaka();

// TEST : generer tout de suite le Cerfa d'un numero
app.get('/test/cerfa-tsedaka/:password/:phone', async (req, res) => {
  if (req.params.password !== ADMIN_PASSWORD) return res.send('Mot de passe incorrect');
  const r = await genererCerfaTsedaka(req.params.phone, null);
  res.send(r.ok
    ? ('Cerfa ' + r.numero + ' envoye : ' + r.total + ' euros (' + r.nb + ' dons)')
    : ('Rien a envoyer : ' + r.raison));
});
// ═══════════════════════════════════════════════
// TSEDAKA — envoi manuel du rappel depuis l'admin
// ═══════════════════════════════════════════════

async function envoyerBoutonsTsedakaA(phone, prenom) {
  const salut = prenom ? 'Chalom ' + prenom + ' !' : 'Chalom !';
  try {
    const r = await fetch('https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: salut + "\n\nC'est le moment de ta Tsedaka du jour.\n\nChoisis ton montant :" },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'tsedaka_050', title: '0,50 euros' } },
              { type: 'reply', reply: { id: 'tsedaka_100', title: '1 euro' } },
              { type: 'reply', reply: { id: 'tsedaka_500', title: '5 euros' } }
            ]
          }
        }
      })
    });
    const data = await r.json();
    return !!(data && data.messages);
  } catch (e) {
    return false;
  }
}

app.post('/admin/tsedaka/envoyer-rappel', async (req, res) => {
  const { password, cible } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    let destinataires = [];

    if (cible === 'tous') {
      const c = await pool.query('SELECT DISTINCT phone FROM contacts');
      const noms = await pool.query('SELECT phone, prenom FROM tsedaka_abonnes');
      const map = {};
      noms.rows.forEach(n => { map[n.phone] = n.prenom; });
      destinataires = c.rows.map(x => ({ phone: x.phone, prenom: map[x.phone] || null }));
    } else {
      const r = await pool.query('SELECT phone, prenom FROM tsedaka_abonnes WHERE rappel_quotidien = TRUE');
      destinataires = r.rows;
    }

    if (destinataires.length === 0) {
      return res.json({ ok: true, envoyes: 0, echecs: 0, total: 0 });
    }

    let envoyes = 0, echecs = 0;
    for (const d of destinataires) {
      const ok = await envoyerBoutonsTsedakaA(d.phone, d.prenom);
      if (ok) envoyes++; else echecs++;
      await new Promise(r2 => setTimeout(r2, 300));
    }

    console.log('Rappel Tsedaka manuel (' + cible + ') : ' + envoyes + '/' + destinataires.length);
    res.json({ ok: true, envoyes: envoyes, echecs: echecs, total: destinataires.length });
  } catch (e) {
    console.error('envoyer-rappel error:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});
// ═══════════════════════════════════════════════
// TSEDAKA — inscription depuis WhatsApp (mot-cle "tsedaka")
// ═══════════════════════════════════════════════

const LIEN_TSEDAKA = 'https://habadsmaurice.com/tsedaka/';
function veutParlerTsedaka(text) {
  const t = (text || '').toLowerCase().trim();
  if (t.indexOf('cerfa') >= 0) return false;
  return ['tsedaka', 'tsedaca', 'tzedaka', 'sedaka', 'tsedakka', 'don quotidien', 'don du jour']
    .some(m => t.indexOf(m) >= 0);
}

async function handleInscriptionTsedaka(from, text) {
  try {
    if (!veutParlerTsedaka(text)) return false;

    const r = await pool.query('SELECT * FROM tsedaka_abonnes WHERE phone=$1', [from]);
    const ab = r.rows[0];

    // Deja inscrit au rappel
    if (ab && ab.rappel_quotidien) {
      await sendWhatsAppButtons(
        from,
        "Tu es deja inscrit a la Tsedaka quotidienne.\n\nTu recois le rappel chaque matin a 10h.\n\nTu veux faire ta Tsedaka maintenant ?",
        [
          { id: 'tsedaka_050', title: '0,50 euros' },
          { id: 'tsedaka_100', title: '1 euro' },
          { id: 'tsedaka_500', title: '5 euros' }
        ]
      );
      return true;
    }

    // Carte deja enregistree, il manque juste le rappel
    if (ab && ab.carte_gardee && ab.stripe_payment_method_id) {
      await sendWhatsAppButtons(
        from,
        "La Tsedaka quotidienne\n\nTa carte est deja enregistree.\n\nJe peux t'envoyer un rappel chaque matin a 10h avec 3 montants au choix. Un clic et ta Tsedaka est faite.",
        [
          { id: 'inscription_oui', title: "Je m'inscris" },
          { id: 'inscription_non', title: 'Plus tard' }
        ]
      );
      return true;
    }

    // Pas encore de carte
    await sendWhatsAppButtons(
      from,
      "La Tsedaka quotidienne\n\nChaque matin a 10h, je t'envoie un rappel avec 3 montants au choix. Tu cliques, et ta Tsedaka est faite en une seconde.\n\nPour commencer, il faut faire un premier don et cocher les deux cases en bas du formulaire.",
      [
        { id: 'inscription_lien', title: 'Je veux le lien' },
        { id: 'inscription_non', title: 'Plus tard' }
      ]
    );
    return true;
  } catch (e) {
    console.error('handleInscriptionTsedaka error:', e.message);
    return false;
  }
}

async function gererBoutonInscription(from, buttonId) {
  try {
    if (buttonId === 'inscription_lien') {
      await sendWhatsApp(from,
        "Voici le lien :\n" + LIEN_TSEDAKA +
        "\n\nApres ton don, un petit formulaire s'ouvre. Coche les deux cases tout en bas :\n" +
        "- Enregistrer ma carte\n" +
        "- Me rappeler chaque jour\n\n" +
        "Et c'est tout ! Je m'occupe du reste.\n\n" + getSignature()
      );
      return;
    }

    if (buttonId === 'inscription_oui') {
      await pool.query('UPDATE tsedaka_abonnes SET rappel_quotidien = TRUE WHERE phone=$1', [from]);
      await sendWhatsApp(from,
        "C'est fait !\n\nTu recevras ton rappel Tsedaka chaque matin a 10h (sauf le Chabbat).\n\n" +
        "Tizkou Lemitsvot !\n\n" + getSignature()
      );
      return;
    }

    if (buttonId === 'inscription_non') {
      await sendWhatsApp(from,
        "Pas de souci !\n\nQuand tu voudras, ecris-moi simplement \"tsedaka\" et je te reproposerai.\n\n" + getSignature()
      );
      return;
    }
  } catch (e) {
    console.error('gererBoutonInscription error:', e.message);
  }
}
// ═══════════════════════════════════════════════
// TSEDAKA — vue complete des dons (site + WhatsApp)
// ═══════════════════════════════════════════════

(async () => {
  try {
    await pool.query('ALTER TABLE cerfa_receipts ADD COLUMN IF NOT EXISTS phone TEXT');
    // Rattraper les anciens Cerfa ou le numero avait ete mis dans la case email
    await pool.query(`
      UPDATE cerfa_receipts
      SET phone = CASE WHEN email LIKE '0%' THEN '33' || substring(email from 2) ELSE email END
      WHERE phone IS NULL AND email ~ '^[0-9]{9,15}$'
    `);
    console.log('Colonne phone sur cerfa_receipts prete');
  } catch (e) {
    console.error('Colonne phone cerfa_receipts:', e.message);
  }
})();

app.get('/admin/tsedaka/dons-tous', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  try {
    const r = await pool.query(`
      SELECT d.phone, d.montant, d.created_at, d.cerfa_numero, 'whatsapp' AS source,
             a.prenom, a.nom
      FROM tsedaka_dons d
      LEFT JOIN tsedaka_abonnes a ON a.phone = d.phone
      UNION ALL
      SELECT c.phone, c.montant, c.created_at, c.numero AS cerfa_numero, 'site' AS source,
             c.prenom, c.nom
      FROM cerfa_receipts c
      WHERE c.phone IS NOT NULL
        AND c.numero NOT IN (SELECT cerfa_numero FROM tsedaka_dons WHERE cerfa_numero IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT 300
    `);
    const total = r.rows.reduce((s, x) => s + parseFloat(x.montant || 0), 0);
    res.json({ ok: true, dons: r.rows, nombre: r.rows.length, total_collecte: total });
  } catch (e) {
    console.error('dons-tous error:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});
// ═══════════════════════════════════════════════
// TSEDAKA — envoi avec repli automatique sur le template Meta
// Message normal d'abord (gratuit). Si la fenetre 24h est
// fermee, on bascule sur le template payant.
// ═══════════════════════════════════════════════

const TEMPLATE_TSEDAKA = 'tsedaka_quotidienne';

// Envoi du template Meta (payant, mais passe meme apres 24h)
async function envoyerTemplateTsedaka(phone) {
  try {
    const r = await fetch('https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: TEMPLATE_TSEDAKA,
          language: { code: 'fr' },
          components: [
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'tsedaka_050' }] },
            { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'tsedaka_100' }] },
            { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: 'tsedaka_500' }] }
          ]
        }
      })
    });
    const data = await r.json();
    if (data && data.messages) return { ok: true, mode: 'template' };
    console.error('Template Tsedaka refuse pour', phone, JSON.stringify(data && data.error ? data.error : data));
    return { ok: false, mode: 'template' };
  } catch (e) {
    console.error('Template Tsedaka erreur', phone, e.message);
    return { ok: false, mode: 'template' };
  }
}

// Remplace la version precedente : essaie gratuit, puis template
async function envoyerBoutonsTsedakaA(phone, prenom) {
  const salut = prenom ? 'Chalom ' + prenom + ' !' : 'Chalom !';
  try {
    const r = await fetch('https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: salut + "\n\nC'est le moment de ta Tsedaka du jour.\n\nChoisis ton montant :" },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'tsedaka_050', title: '0,50 euros' } },
              { type: 'reply', reply: { id: 'tsedaka_100', title: '1 euro' } },
              { type: 'reply', reply: { id: 'tsedaka_500', title: '5 euros' } }
            ]
          }
        }
      })
    });
    const data = await r.json();
    if (data && data.messages) return { ok: true, mode: 'gratuit' };
  } catch (e) {
    console.error('Message gratuit erreur', phone, e.message);
  }
  // La fenetre 24h est fermee : on passe par le template
  return await envoyerTemplateTsedaka(phone);
}

// Remplace la version precedente : le rappel de 10h utilise aussi le repli
async function envoyerRappelsTsedaka() {
  try {
    const r = await pool.query('SELECT phone, prenom FROM tsedaka_abonnes WHERE rappel_quotidien = TRUE');
    if (r.rows.length === 0) { console.log('Tsedaka: aucun abonne au rappel'); return; }
    let gratuits = 0, templates = 0, echecs = 0;
    for (const ab of r.rows) {
      const res = await envoyerBoutonsTsedakaA(ab.phone, ab.prenom);
      if (!res.ok) echecs++;
      else if (res.mode === 'template') templates++;
      else gratuits++;
      await new Promise(x => setTimeout(x, 300));
    }
    console.log('Tsedaka rappels : ' + gratuits + ' gratuits, ' + templates + ' templates payants, ' + echecs + ' echecs');
  } catch (e) {
    console.error('envoyerRappelsTsedaka error:', e.message);
  }
}

// Les boutons d'un TEMPLATE arrivent en type "button" (pas "interactive")
async function handleBoutonTemplate(message) {
  const from = message.from, msgId = message.id;
  try {
    const already = await pool.query('SELECT 1 FROM messages_traites WHERE msg_id=$1', [msgId]);
    if (already.rows.length > 0) return;
    await pool.query('INSERT INTO messages_traites (msg_id) VALUES ($1) ON CONFLICT DO NOTHING', [msgId]);
  } catch (e) { console.error('Dedup bouton template:', e.message); }

  const payload = (message.button && (message.button.payload || message.button.text)) || '';
  if (payload.indexOf('tsedaka_') === 0) { await gererBoutonTsedaka(from, payload); return; }
  if (payload.indexOf('inscription_') === 0) { await gererBoutonInscription(from, payload); return; }

  // Repli : on reconnait le montant par le texte du bouton
  const t = payload.toLowerCase();
  if (t.indexOf('0,50') >= 0 || t.indexOf('0.50') >= 0) { await gererBoutonTsedaka(from, 'tsedaka_050'); return; }
  if (t.indexOf('1 euro') >= 0) { await gererBoutonTsedaka(from, 'tsedaka_100'); return; }
  if (t.indexOf('5 euro') >= 0) { await gererBoutonTsedaka(from, 'tsedaka_500'); return; }
  console.log('Bouton template non reconnu :', payload);
}
// ═══════════════════════════════════════════════
// CALENDRIER JUIF AUTOMATIQUE — Chabbat ET fetes (Hebcal)
// Paris · allumage 18 min avant le coucher
// sortie a la tombee de la nuit (8,5 degres)
// Remplace l'ancienne liste ecrite a la main.
// ═══════════════════════════════════════════════

const HEBCAL_BASE = 'https://www.hebcal.com/hebcal?v=1&cfg=json'
  + '&maj=on&min=on&mf=on&ss=on&s=on&c=on&M=on&b=18'
  + '&geo=geoname&geonameid=2988507&lg=fr&i=off&mod=off&nx=off';

const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR_CAL = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function isoJour(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function heureHebcal(item) {
  const m = String(item.title || '').match(/(\d{1,2}):(\d{2})/);
  if (m) return m[1].padStart(2, '0') + 'h' + m[2];
  const m2 = String(item.date || '').match(/T(\d{2}):(\d{2})/);
  if (m2) return m2[1] + 'h' + m2[2];
  return null;
}

function nomPropre(titre) {
  return String(titre || '').replace(/^Paras?ha?t?\s+/i, '').trim();
}

// Recupere le calendrier des prochains jours
async function getCalendrierHebcal(jours) {
  const debut = new Date();
  const fin = new Date(Date.now() + (jours || 30) * 86400000);
  const url = HEBCAL_BASE + '&start=' + isoJour(debut) + '&end=' + isoJour(fin);
  for (let essai = 1; essai <= 2; essai++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ShliahBot/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.items || [];
    } catch (e) {
      console.error('Hebcal essai ' + essai + ' :', e.message);
      if (essai === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// Prochain allumage de bougies : Chabbat OU fete
async function getProchainAllumage() {
  const items = await getCalendrierHebcal(30);
  if (!items) return null;

  const maintenant = Date.now();
  const bougies = items.find(i => i.category === 'candles' && new Date(i.date).getTime() > maintenant);
  if (!bougies) return null;

  const debutMs = new Date(bougies.date).getTime();
  const havdalah = items.find(i => i.category === 'havdalah' && new Date(i.date).getTime() > debutMs);
  const finMs = havdalah ? new Date(havdalah.date).getTime() : debutMs + 36 * 3600000;

  const dansLaPeriode = items.filter(i => {
    const t = new Date(i.date).getTime();
    return t >= debutMs - 3600000 && t <= finMs;
  });

  const parashat = dansLaPeriode.find(i => i.category === 'parashat');
  const fete = dansLaPeriode.find(i => i.category === 'holiday' && i.yomtov);
  const feteMineure = dansLaPeriode.find(i => i.category === 'holiday' && !i.yomtov);

  const d = new Date(bougies.date);
  const dateLabel = JOURS_FR[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS_FR_CAL[d.getMonth()] + ' ' + d.getFullYear();

  const entree = heureHebcal(bougies);
  const sortie = havdalah ? heureHebcal(havdalah) : '-';
  const nomFete = fete ? fete.title : (feteMineure ? feteMineure.title : null);
  const paracha = parashat ? nomPropre(parashat.title) : (nomFete || 'N/A');
  const estFete = !!fete;

  let texte = 'HORAIRES - PARIS :\n📅 ' + dateLabel + '\n';
  if (nomFete) texte += '✡️ ' + nomFete + '\n';
  if (parashat) texte += '📖 Paracha ' + nomPropre(parashat.title) + '\n';
  texte += '🕯️ Allumage des bougies : ' + entree + '\n✨ Sortie : ' + sortie;

  console.log('Hebcal OK :', dateLabel, '|', nomFete || ('Paracha ' + paracha), '|', entree, '->', sortie);
  return { texte, paracha, fete: nomFete, estFete, date: dateLabel, entree, sortie, jourSemaine: d.getDay() };
}

// Remplace l'ancienne fonction : le reste du bot l'utilise deja
async function getHorairesChabbat() {
  const h = await getProchainAllumage();
  if (!h) { console.error('Hebcal indisponible - aucun horaire renvoye'); return null; }
  return h;
}

// Remplace l'ancienne : le message s'adapte aux fetes
async function prepararerMessageCalendrier() {
  const h = await getProchainAllumage();
  if (!h) return null;
  let msg;
  if (h.estFete) {
    msg = '✡️ ' + h.fete + '\n\n';
    msg += '📅 ' + h.date + '\n';
    if (h.paracha && h.paracha !== h.fete && h.paracha !== 'N/A') msg += '📖 Paracha ' + h.paracha + '\n';
    msg += '🕯️ Allumage des bougies : ' + h.entree + '\n';
    msg += '✨ Sortie : ' + h.sortie + '\n\n';
    msg += 'Hag Saméah à toute la communauté !\n\n🏛️ Beth Habad S. Maurice';
  } else {
    msg = '🕯️ Chabbat Chalom !\n\n';
    msg += '📖 Paracha ' + h.paracha + '\n';
    msg += '📅 ' + h.date + '\n';
    msg += '🕯️ Allumage des bougies : ' + h.entree + '\n';
    msg += '✨ Havdalah (sortie) : ' + h.sortie + '\n\n';
    msg += 'Chabbat Chalom à toute la famille !\n\n🏛️ Beth Habad S. Maurice';
  }
  return msg;
}

async function prepararerValidationCalendrier() {
  try {
    const message = await prepararerMessageCalendrier();
    if (!message) { console.error('Cron: impossible de recuperer les horaires'); return; }
    await sendWhatsAppButtons(
      ADMIN_PHONE,
      '📢 VALIDATION MESSAGE\n\n' + message + "\n\nValider l'envoi ?",
      [
        { id: 'valider_chabbat', title: '✓ Envoyer' },
        { id: 'editer_chabbat', title: '✎ Éditer' },
        { id: 'annuler_chabbat', title: '✗ Annuler' }
      ]
    );
    global.chabbatEnAttente = { message, dateAujourdhui: new Date().toISOString().slice(0, 10) };
    console.log('Message envoye a admin pour validation');
  } catch (e) {
    console.error('Validation calendrier error:', e.message);
  }
}

// Remplace l'ancienne fonction utilisee par le cron du vendredi
async function preparerValidationChabbat() {
  return await prepararerValidationCalendrier();
}

// Cron fetes : chaque jour a 9h, si allumage aujourd'hui hors vendredi
function demarrerCronFetes() {
  setInterval(async () => {
    const heuresParis = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jour = heuresParis.getDay(), heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (jour === 5) return; // vendredi : deja gere par le cron Chabbat
    if (heure !== 9 || minute >= 5) return;
    const dateAujourdhui = isoJour(heuresParis);
    const cacheKey = 'fete_en_attente_' + dateAujourdhui;
    if (global[cacheKey]) return;
    try {
      const h = await getProchainAllumage();
      if (!h || !h.estFete) return;
      const dateAllumage = h.date;
      // On ne previent que si l'allumage est aujourd'hui
      if (dateAllumage.indexOf(String(heuresParis.getDate()) + ' ' + MOIS_FR_CAL[heuresParis.getMonth()]) === -1) return;
      global[cacheKey] = true;
      console.log('Preparation message fete pour validation...');
      await prepararerValidationCalendrier();
    } catch (e) {
      console.error('Cron fetes error:', e.message);
    }
  }, 5 * 60 * 1000);
  console.log('Cron fetes demarre');
}
demarrerCronFetes();

// Voir les horaires a tout moment
app.get('/test/horaires/:password', async (req, res) => {
  if (req.params.password !== ADMIN_PASSWORD) return res.send('Mot de passe incorrect');
  chabbatCache.data = null;
  const h = await getProchainAllumage();
  if (!h) return res.send('Impossible de recuperer les horaires pour le moment.');
  res.json(h);
});

// Voir les prochaines fetes
app.get('/test/fetes/:password', async (req, res) => {
  if (req.params.password !== ADMIN_PASSWORD) return res.send('Mot de passe incorrect');
  const items = await getCalendrierHebcal(120);
  if (!items) return res.send('Hebcal indisponible.');
  const fetes = items
    .filter(i => i.category === 'holiday')
    .map(i => ({ date: String(i.date).slice(0, 10), nom: i.title, yomtov: !!i.yomtov }));
  res.json({ ok: true, nombre: fetes.length, fetes: fetes });
});
// ═══════════════════════════════════════════════
// LETTRE DANS LE SEFER TORAH — formulaire guide en 4 etapes
// ═══════════════════════════════════════════════

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS sessions_sefer (
      phone TEXT PRIMARY KEY,
      etape INTEGER DEFAULT 1,
      data JSONB DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('Table sessions_sefer prete');
  } catch (e) {
    console.error('Table sessions_sefer:', e.message);
  }
})();

function parleDeSeferTorah(text) {
  const t = (text || '').toLowerCase();
  return ['sefer torah', 'séfer torah', 'sefer thora', 'lettre torah', 'lettre dans le sefer',
    'lettre sefer', 'sefer', 'séfer'].some(m => t.indexOf(m) >= 0);
}

function veutAnnuler(text) {
  const t = (text || '').toLowerCase().trim();
  return t === 'annuler' || t === 'stop' || t === 'arreter' || t === 'arrêter' || t === 'annule';
}

async function getSessionSefer(phone) {
  try {
    const r = await pool.query('SELECT * FROM sessions_sefer WHERE phone=$1', [phone]);
    if (r.rows.length === 0) return null;
    // Une session abandonnee depuis plus de 2h est oubliee
    const age = Date.now() - new Date(r.rows[0].updated_at).getTime();
    if (age > 2 * 3600 * 1000) {
      await pool.query('DELETE FROM sessions_sefer WHERE phone=$1', [phone]);
      return null;
    }
    return r.rows[0];
  } catch (e) { return null; }
}

async function majSessionSefer(phone, etape, data) {
  await pool.query(
    `INSERT INTO sessions_sefer (phone, etape, data, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (phone) DO UPDATE SET etape=$2, data=$3, updated_at=NOW()`,
    [phone, etape, JSON.stringify(data || {})]
  );
}

async function finSessionSefer(phone) {
  await pool.query('DELETE FROM sessions_sefer WHERE phone=$1', [phone]).catch(() => {});
}

async function demarrerSeferTorah(from) {
  await majSessionSefer(from, 1, {});
  await sendWhatsAppButtons(
    from,
    "📖 Lettre dans le Sefer Torah\nÉtape 1/4\n\nC'est pour un garçon ou une fille ?",
    [
      { id: 'sefer_garcon', title: 'Garçon' },
      { id: 'sefer_fille', title: 'Fille' },
      { id: 'sefer_annuler', title: 'Annuler' }
    ]
  );
}

function recapSefer(d) {
  let r = "📖 Vérifie avant d'envoyer :\n\n";
  r += (d.genre || '-') + "\n";
  r += (d.nom_complet || '-') + (d.age ? ', ' + d.age : '') + "\n";
  if (d.mere) r += (d.genre === 'Fille' ? 'Fille de ' : 'Fils de ') + d.mere + "\n";
  if (d.contact) r += "\n" + d.contact;
  return r;
}

async function handleSeferTorah(from, text) {
  try {
    let session = await getSessionSefer(from);

    // Demarrage
    if (!session) {
      if (!parleDeSeferTorah(text)) return false;
      await demarrerSeferTorah(from);
      return true;
    }

    if (veutAnnuler(text)) {
      await finSessionSefer(from);
      await sendWhatsApp(from, "C'est annulé.\n\nÉcris-moi \"sefer torah\" quand tu veux recommencer.\n\n" + getSignature());
      return true;
    }

    const d = session.data || {};
    const etape = session.etape;

    if (etape === 1) {
      // On attend un bouton, mais on accepte aussi le texte
      const t = text.toLowerCase();
      if (t.indexOf('gar') >= 0 || t === 'g') { await seferEtape2(from, d, 'Garçon'); return true; }
      if (t.indexOf('fil') >= 0 || t === 'f') { await seferEtape2(from, d, 'Fille'); return true; }
      await sendWhatsAppButtons(from, "📖 Étape 1/4\n\nC'est pour un garçon ou une fille ?", [
        { id: 'sefer_garcon', title: 'Garçon' },
        { id: 'sefer_fille', title: 'Fille' },
        { id: 'sefer_annuler', title: 'Annuler' }
      ]);
      return true;
    }

    if (etape === 2) {
      d.nom_complet = text.trim();
      await majSessionSefer(from, 3, d);
      await sendWhatsApp(from, "📖 Étape 3/4\n\nQuel âge a-t-il/elle, et quel est le prénom de la maman ?\n\n(exemple : 8 ans, Sarah)");
      return true;
    }

    if (etape === 3) {
      const brut = text.trim();
      const m = brut.match(/^([^,;\n]+)[,;\n]+(.+)$/);
      if (m) { d.age = m[1].trim(); d.mere = m[2].trim(); }
      else { d.age = brut; d.mere = ''; }
      await majSessionSefer(from, 4, d);
      await sendWhatsApp(from, "📖 Étape 4/4\n\nL'adresse complète et un numéro de téléphone ?");
      return true;
    }

    if (etape === 4) {
      d.contact = text.trim();
      await majSessionSefer(from, 5, d);
      await sendWhatsAppButtons(from, recapSefer(d) + "\n\nC'est bon ?", [
        { id: 'sefer_valider', title: "✓ C'est bon" },
        { id: 'sefer_recommencer', title: '↺ Recommencer' },
        { id: 'sefer_annuler', title: '✗ Annuler' }
      ]);
      return true;
    }

    if (etape === 5) {
      await sendWhatsAppButtons(from, recapSefer(d) + "\n\nC'est bon ?", [
        { id: 'sefer_valider', title: "✓ C'est bon" },
        { id: 'sefer_recommencer', title: '↺ Recommencer' },
        { id: 'sefer_annuler', title: '✗ Annuler' }
      ]);
      return true;
    }

    return false;
  } catch (e) {
    console.error('handleSeferTorah error:', e.message);
    return false;
  }
}

async function seferEtape2(from, d, genre) {
  d.genre = genre;
  await majSessionSefer(from, 2, d);
  await sendWhatsApp(from, "📖 Étape 2/4\n\nQuel est le prénom et le nom de l'enfant ?\n\n(écris \"annuler\" pour arrêter)");
}

async function gererBoutonSefer(from, buttonId) {
  try {
    if (buttonId === 'sefer_annuler') {
      await finSessionSefer(from);
      await sendWhatsApp(from, "C'est annulé.\n\nÉcris-moi \"sefer torah\" quand tu veux recommencer.\n\n" + getSignature());
      return;
    }
    if (buttonId === 'sefer_recommencer') {
      await demarrerSeferTorah(from);
      return;
    }
    const session = await getSessionSefer(from);
    const d = (session && session.data) || {};

    if (buttonId === 'sefer_garcon') { await seferEtape2(from, d, 'Garçon'); return; }
    if (buttonId === 'sefer_fille') { await seferEtape2(from, d, 'Fille'); return; }

    if (buttonId === 'sefer_valider') {
      if (!session) { await sendWhatsApp(from, "La demande a expiré. Écris \"sefer torah\" pour recommencer."); return; }
      const recap =
        'Genre : ' + (d.genre || '-') + '\n' +
        'Enfant : ' + (d.nom_complet || '-') + '\n' +
        'Age : ' + (d.age || '-') + '\n' +
        'Prenom de la mere : ' + (d.mere || '-') + '\n' +
        'Adresse et telephone : ' + (d.contact || '-');
      await sauvegarderDemande('sefer_torah', from, recap);
      envoyerEmailDemande('sefer_torah', from, recap).catch(e => console.error('Email sefer:', e.message));
      await finSessionSefer(from);
      await sendWhatsApp(from,
        "✅ C'est enregistré !\n\n" +
        (d.nom_complet || '') + (d.age ? ', ' + d.age : '') + "\n" +
        (d.mere ? ((d.genre === 'Fille' ? 'Fille de ' : 'Fils de ') + d.mere + "\n") : '') +
        "\nNous te contactons très vite.\n\n" + getSignature()
      );
      console.log('Demande Sefer Torah enregistree :', from);
      return;
    }
  } catch (e) {
    console.error('gererBoutonSefer error:', e.message);
  }
}
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Shliah Bot actif sur port ${PORT}`));
  demarrerCronChabbat();
  demarrerCronBackup();
  demarrerCronRelancesPaiements();
});
