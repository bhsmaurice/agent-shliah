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
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS infos (id SERIAL PRIMARY KEY, categorie TEXT, titre TEXT, contenu TEXT, instruction TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, phone TEXT, question TEXT, reponse TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS demandes (id SERIAL PRIMARY KEY, type TEXT, phone TEXT, data JSONB, statut TEXT DEFAULT 'nouveau', created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions_demande (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, type TEXT, etape INTEGER DEFAULT 0, reponses JSONB DEFAULT '{}', terminee BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages_traites (msg_id TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS histoires (id SERIAL PRIMARY KEY, titre TEXT NOT NULL, texte TEXT NOT NULL, image_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, abonne_chabbat BOOLEAN DEFAULT FALSE, abonne_evenements BOOLEAN DEFAULT FALSE, question_chabbat_posee BOOLEAN DEFAULT FALSE, question_evenements_posee BOOLEAN DEFAULT FALSE, nb_messages INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS musiques (id SERIAL PRIMARY KEY, titre TEXT NOT NULL, lien TEXT NOT NULL, ambiance TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS playlistes (id SERIAL PRIMARY KEY, nom TEXT NOT NULL, ambiance TEXT NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS playliste_musiques (id SERIAL PRIMARY KEY, playliste_id INTEGER REFERENCES playlistes(id) ON DELETE CASCADE, musique_id INTEGER REFERENCES musiques(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cerfa_counters (year INT PRIMARY KEY, last_number INT NOT NULL DEFAULT 0)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cerfa_receipts (id SERIAL PRIMARY KEY, numero TEXT UNIQUE NOT NULL, nom TEXT, prenom TEXT, adresse TEXT, montant NUMERIC(10,2) NOT NULL, mode_paiement TEXT, date_don DATE NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query('ALTER TABLE sessions_demande ADD COLUMN IF NOT EXISTS terminee BOOLEAN DEFAULT FALSE').catch(()=>{});
  await pool.query('ALTER TABLE cerfa_receipts ADD COLUMN IF NOT EXISTS email TEXT').catch(()=>{});
  await pool.query('DELETE FROM sessions_demande').catch(()=>{});
  console.log('Base de données prête');
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "shliah_beth_habad";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "habad2024";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ─── ADMIN CERFA (génération automatique de reçus fiscaux) ────
// Numéros WhatsApp autorisés à déclencher "Admin CERFA" (sans +, sans espace)
// Ajoute-en d'autres en les séparant par une virgule, ou via la variable
// d'environnement Railway ADMIN_WHATSAPP_NUMBERS (ex: "33770241746,33600000000")
const ADMIN_WHATSAPP_NUMBERS = (process.env.ADMIN_WHATSAPP_NUMBERS || '33770241746')
  .split(',').map(n => n.trim()).filter(Boolean);

// Infos fixes de l'association (reprises du modèle Cerfa officiel utilisé actuellement)
const ASSOCIATION = {
  nom: 'Beth habad S. Maurice Plateau',
  rna: 'W941017037',
  adresse: '54 Avenue maréchal de Lattre de Tassigny, 94410 Saint Maurice',
  objet: "Action d'intérêt général de bienfaisance",
  qualite: "Œuvre ou organisme d'intérêt général",
  articleCGI: '200 du CGI',
};

// Logo Beth Habad : récupéré une seule fois depuis une URL (variable d'env
// BETH_HABAD_LOGO_URL) puis gardé en mémoire. Si l'URL n'est pas configurée
// ou si le téléchargement échoue, le reçu est simplement généré sans logo.
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

function isAuthorizedAdminCerfa(fromNumber) {
  const clean = String(fromNumber).replace(/\D/g, '');
  return ADMIN_WHATSAPP_NUMBERS.some((n) => clean.endsWith(n) || n.endsWith(clean));
}

// Conversion nombre -> lettres (français)
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

/**
 * Format attendu après "Admin CERFA" (une info par ligne) :
 * montant / Nom Prénom / adresse / especes|cb|cheque
 */
function parseAdminCerfaMessage(rawText) {
  const withoutTrigger = rawText.replace(/^admin\s+cerfa/i, '').trim();
  const lines = withoutTrigger.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) {
    throw new Error("Format: Admin CERFA puis 4 lignes -> montant / Nom Prénom / adresse / especes|cb|cheque");
  }
  const [montantLine, nomPrenomLine, adresseLine, modeLine] = lines;
  const montantMatch = montantLine.replace(',', '.').match(/(\d+(\.\d+)?)/);
  if (!montantMatch) throw new Error(`Montant introuvable dans : "${montantLine}"`);
  const montant = parseFloat(montantMatch[1]);
  const nomParts = nomPrenomLine.replace(/^(mr|mme|m\.|mlle)\s+/i, '').trim().split(/\s+/);
  const nom = nomParts[0];
  const prenom = nomParts.slice(1).join(' ') || '-';
  const adresse = adresseLine;
  const modeLower = modeLine.toLowerCase();
  let mode = "Remise d'espèces";
  if (/cb|carte|virement|pr[eé]l[eè]vement/.test(modeLower)) mode = 'Virement, prélèvement, carte bancaire';
  else if (/ch[eè]que/.test(modeLower)) mode = 'Chèque';
  else if (/esp[eè]ce|cash/.test(modeLower)) mode = "Remise d'espèces";
  return { montant, nom, prenom, adresse, mode };
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

  // ── En-tête ──
  // Logo "cerfa" (ovale bleu marine, dessiné directement, pas une image)
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

  // ── Colonne gauche : logo + nom association / Colonne droite : donateur ──
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

  // ── Bénéficiaire du don ──
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

  // ── Donateur ──
  top += 18;
  grayBar('DONATEUR', top);
  top += 20;
  const donateurBoxStart = top;
  drawLabelValue('NOM OU DENOMINATION : ', nomDonateurComplet, top + 17);
  drawLabelValue('ADRESSE DONATEUR : ', adresse, top + 35);
  top += 50;
  box(donateurBoxStart, top - donateurBoxStart);

  // ── Certification + cases à cocher ──
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

  // ── Mode de versement / date et signature ──
  top += 22;
  page.drawText('Mode de versement : ', { x: marginX + 10, y: Y(top), size: 10, font, color: black });
  page.drawText(mode, { x: marginX + 10 + font.widthOfTextAtSize('Mode de versement : ', 10), y: Y(top), size: 10, font: bold, color: black });
  drawRight('Date et signature', top - 10, 10.5, bold);
  drawRight(dateVersement, top + 8, 10, font);

  // ── Pied de page ──
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

/**
 * @returns {boolean} true si le message était une commande Admin CERFA (traité ou ignoré)
 */
async function handleAdminCerfaCommand(from, text) {
  if (!isAdminCerfaTrigger(text)) return false;
  if (!isAuthorizedAdminCerfa(from)) return true; // ignoré silencieusement
  try {
    const data = parseAdminCerfaMessage(text);
    const numero = await getNextCerfaNumero();
    const pdfBuffer = await generateCerfaPDF({ numero, ...data });
    const filename = `Cerfa_${numero}.pdf`;
    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)`,
      [numero, data.nom, data.prenom, data.adresse, data.montant, data.mode]
    );
    envoyerBackupCerfa({ numero, ...data, dateVersement: new Date().toLocaleDateString('fr-FR') }, pdfBuffer).catch(e => console.error('Backup Cerfa error:', e));
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
// ─── SCRAPING CHABBAT ─────────────────────────────────────────
async function getHorairesChabbat() {
  try {
    const res = await fetch('https://www.torah-box.com/calendrier/chabbat/paris-france_1.html', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' }
    });
    const html = await res.text();
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const now = new Date();
    const moisFr = {'Janvier':0,'Février':1,'Mars':2,'Avril':3,'Mai':4,'Juin':5,'Juillet':6,'Août':7,'Septembre':8,'Octobre':9,'Novembre':10,'Décembre':11};
    for (const row of rows) {
      const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const m = text.match(/Vendredi\s+(\d{1,2})\w*\s+(\w+)\s+(\d{4})\s+(.*?)\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/i);
      if (m) {
        const jour = parseInt(m[1]), moisIdx = moisFr[m[2]], annee = parseInt(m[3]);
        const paracha = m[4].trim(), entree = m[5], sortie = m[6];
        if (moisIdx === undefined) continue;
        const dateChabbat = new Date(annee, moisIdx, jour);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (dateChabbat >= today) {
          const moisNoms = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
          const dateStr = `vendredi ${jour} ${moisNoms[moisIdx]} ${annee}`;
          const entreeH = entree.replace(':', 'h'), sortieH = sortie.replace(':', 'h');
          return { texte: `HORAIRES CHABBAT - PARIS :\n📅 ${dateStr}\n📖 Paracha ${paracha}\n🕯️ Entrée de Chabbat : ${entreeH}\n✨ Sortie de Chabbat (Havdalah) : ${sortieH}`, paracha, date: dateStr, entree: entreeH, sortie: sortieH };
        }
      }
    }
    throw new Error('Aucun Chabbat trouvé');
  } catch (e) { console.error('Torah-Box error:', e.message); }
  try {
    const res = await fetch('https://www.hebcal.com/shabbat?cfg=json&geonameid=2988507&b=18&M=on&lg=fr&td=8.5', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const items = data.items || [];
    let candle = null, havdalah = null, parasha = null;
    for (const item of items) {
      if (item.category === 'candles') candle = item;
      if (item.category === 'havdalah') havdalah = item;
      if (item.category === 'parashat') parasha = item;
    }
    if (candle) {
      const dateCandle = new Date(candle.date);
      const moisNoms = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
      const dateStr = `vendredi ${dateCandle.getDate()} ${moisNoms[dateCandle.getMonth()]} ${dateCandle.getFullYear()}`;
      const entreeH = candle.date.substring(11,16).replace(':','h');
      let sortieH = 'voir torah-box.com';
      if (havdalah) {
        const havDate = new Date(havdalah.date);
        havDate.setMinutes(havDate.getMinutes() + 12);
        sortieH = `${String(havDate.getHours()).padStart(2,'0')}h${String(havDate.getMinutes()).padStart(2,'0')}`;
      }
      const parashaName = parasha ? parasha.title.replace('Paracha ','').replace('Parashat ','') : '';
      return { texte: `HORAIRES CHABBAT - PARIS :\n📅 ${dateStr}\n📖 Paracha ${parashaName}\n🕯️ Entrée de Chabbat : ${entreeH}\n✨ Sortie de Chabbat (Havdalah) : ${sortieH}`, paracha: parashaName, date: dateStr, entree: entreeH, sortie: sortieH };
    }
  } catch (e) { console.error('Hebcal error:', e.message); }
  return null;
}
let chabbatCache = { data: null, lastFetch: 0 };
async function getHorairesChabbatCached() {
  const now = Date.now();
  if (chabbatCache.data && (now - chabbatCache.lastFetch) < 3600000) return chabbatCache.data;
  const data = await getHorairesChabbat();
  if (data) { chabbatCache.data = data; chabbatCache.lastFetch = now; }
  return data;
}
// ─── GESTION CONTACTS & ABONNEMENTS ──────────────────────────
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
// ─── CRON CHABBAT ─────────────────────────────────────────────
function demarrerCronChabbat() {
  setInterval(async () => {
    const now = new Date();
    const heuresParis = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jour = heuresParis.getDay(), heure = heuresParis.getHours(), minute = heuresParis.getMinutes();
    if (jour === 5 && heure === 9 && minute < 5) {
      const dateAujourdhui = heuresParis.toISOString().slice(0, 10);
      const cacheKey = `chabbat_envoye_${dateAujourdhui}`;
      if (global[cacheKey]) return;
      global[cacheKey] = true;
      console.log('🕯️ Envoi automatique horaires Chabbat...');
      await envoyerHorairesChabbatAbonnes();
    }
  }, 5 * 60 * 1000);
  console.log('⏰ Cron Chabbat démarré');
}
async function envoyerHorairesChabbatAbonnes() {
  try {
    const chabbat = await getHorairesChabbat();
    if (!chabbat) { console.error('Cron: impossible de récupérer les horaires'); return; }
    const abonnes = await pool.query('SELECT phone FROM contacts WHERE abonne_chabbat=TRUE');
    if (abonnes.rows.length === 0) { console.log('Cron: aucun abonné'); return; }
    const message = `🕯️ Chabbat Chalom !\n\n📖 Paracha ${chabbat.paracha}\n📅 ${chabbat.date}\n\n🕯️ Allumage des bougies : ${chabbat.entree}\n✨ Havdalah (sortie) : ${chabbat.sortie}\n\nChabbat Chalom à toute la famille !\n\nBeth Habad S. Maurice`;
    let envoyes = 0;
    for (const row of abonnes.rows) {
      try { await sendWhatsApp(row.phone, message); envoyes++; await new Promise(r => setTimeout(r, 300)); }
      catch (e) { console.error(`Cron erreur ${row.phone}:`, e.message); }
    }
    console.log(`🕯️ Cron: ${envoyes}/${abonnes.rows.length} envoyés`);
  } catch (e) { console.error('Cron error:', e.message); }
}
// ─── MUSIQUE & PLAYLIST ───────────────────────────────────────
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
// ─── HISTOIRES DU RABBI ───────────────────────────────────────
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
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } })
  });
}
// ─── SYSTÈME DE DEMANDES ──────────────────────────────────────
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
    const config = TYPES_DEMANDES[type]; const label = config ? config.label : type;
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    await transporter.sendMail({
      from: '"Shliah Bot 🤖" <bhsmaurice@gmail.com>', to: 'bhsmaurice@gmail.com',
      subject: `📋 Nouvelle demande : ${label}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">📋 ${label}</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Date</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${dateStr}</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">WhatsApp</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>+${phone}</strong></td></tr><tr><td style="padding:8px;color:#666;vertical-align:top;">Message</td><td style="padding:8px;white-space:pre-wrap;"><strong>${texteLibre}</strong></td></tr></table></div>`
    });
  } catch (e) { console.error('Email error:', e.message); }
}
// Sauvegarde automatique : envoie chaque Cerfa généré par email (avec le PDF en
// pièce jointe) sur bhsmaurice@gmail.com. C'est une copie indépendante de Railway
// et GitHub — en cas de piratage ou de panne, les reçus restent consultables dans
// la boîte mail.
async function envoyerBackupCerfa({ numero, nom, prenom, adresse, montant, mode, dateVersement, email }, pdfBuffer) {
  if (!GMAIL_APP_PASSWORD) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: 'bhsmaurice@gmail.com', pass: GMAIL_APP_PASSWORD } });
    await transporter.sendMail({
      from: '"Shliah Bot 🤖" <bhsmaurice@gmail.com>',
      to: 'bhsmaurice@gmail.com',
      subject: `🧾 Sauvegarde Cerfa ${numero}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;"><h2 style="color:#1a3a6b;">🧾 Sauvegarde automatique — Cerfa ${numero}</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Donateur</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${prenom || ''} ${nom || ''}</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Adresse</td><td style="padding:8px;border-bottom:1px solid #eee;">${adresse || ''}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Montant</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${montant} €</strong></td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Mode</td><td style="padding:8px;border-bottom:1px solid #eee;">${mode || ''}</td></tr><tr><td style="padding:8px;color:#666;">Date du don</td><td style="padding:8px;">${dateVersement || ''}</td></tr></table><p style="color:#999;font-size:12px;margin-top:16px;">Ce mail est généré automatiquement à chaque Cerfa créé, pour garder une copie de secours indépendante.</p></div>`,
      attachments: [{ filename: `Cerfa_${numero}.pdf`, content: pdfBuffer }],
    });
  } catch (e) {
    console.error('Backup Cerfa email error:', e.message);
  }
}
function getSignature() { const now = new Date(); return now.getDay() === 5 ? "Chabbat Chalom !" : "Kol Touv !"; }
// ─── WEBHOOK META ─────────────────────────────────────────────
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

      // ── Commande Admin CERFA (prioritaire, avant tout le reste) ──
      if (await handleAdminCerfaCommand(from, text)) return;

      // ── Réponse abonnement en cours ──
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
      let reply, estUneDemande = false;
      const contact = await getOuCreerContact(from);
      await incrementerMessages(from);
      const contactMaj = await pool.query('SELECT * FROM contacts WHERE phone=$1', [from]).then(r => r.rows[0]).catch(() => null);
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
      } else if (sessionsMusiqueType[from]) {
        reply = await gererMusique(from, text, sessionsMusiqueType[from]?.mode || 'musique');
      } else if (parlDePlaylist(text)) {
        reply = await gererMusique(from, text, 'playlist');
      } else if (parlDeMusique(text)) {
        reply = await gererMusique(from, text, 'musique');
      } else if (sessionsHistoires[from] || parleDeHistoire(text)) {
        reply = await gererHistoire(from, text);
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
        }
      }
      const replyContientQuestion = reply && reply.trim().endsWith("?");
      if (!replyContientQuestion) {
        const questionAbonnement = await getQuestionAbonnement(from, contactMaj);
        if (questionAbonnement) reply = reply + questionAbonnement;
      }
      await sendWhatsApp(from, reply);
      if (!estUneDemande) {
        try { await pool.query('INSERT INTO conversations (phone, question, reponse) VALUES ($1, $2, $3)', [from, text, reply]); } catch (e) {}
      }
    }
  }
});
// ─── API ADMIN ────────────────────────────────────────────────
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
// ─── API ADMIN CERFA ───────────────────────────────────────────
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
  if (!GMAIL_APP_PASSWORD) {
    return res.json({ ok: false, configured: false, message: "La variable GMAIL_APP_PASSWORD n'est pas configurée sur Railway." });
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: 'bhsmaurice@gmail.com', pass: GMAIL_APP_PASSWORD } });
    await transporter.verify();
    await transporter.sendMail({
      from: '"Shliah Bot 🤖" <bhsmaurice@gmail.com>',
      to: 'bhsmaurice@gmail.com',
      subject: '✅ Test email de sauvegarde Shliah Bot',
      html: '<p>Ceci est un email de test. Si tu le reçois, le système de sauvegarde par email fonctionne.</p>',
    });
    res.json({ ok: true, configured: true, message: 'Email de test envoyé avec succès à bhsmaurice@gmail.com. Vérifie ta boîte de réception (et les spams).' });
  } catch (e) {
    res.json({ ok: false, configured: true, message: "La variable est configurée mais l'envoi a échoué.", error: e.message });
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
    const csv = '﻿' + csvLines.join('\n'); // ﻿ = BOM pour Excel
    // Envoie aussi une copie par email pour une sauvegarde indépendante
    if (email !== 'false') {
      (async () => {
        try {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: 'bhsmaurice@gmail.com', pass: GMAIL_APP_PASSWORD } });
          await transporter.sendMail({
            from: '"Shliah Bot 🤖" <bhsmaurice@gmail.com>',
            to: 'bhsmaurice@gmail.com',
            subject: `📦 Sauvegarde complète Cerfa (${rows.length} reçus)`,
            html: `<p>Export complet de tous les reçus Cerfa, ${rows.length} au total, en pièce jointe (fichier CSV, s'ouvre avec Excel/Numbers).</p>`,
            attachments: [{ filename: `Cerfa_export_${new Date().toISOString().slice(0, 10)}.csv`, content: csv }],
          });
        } catch (e) { console.error('Export email error:', e.message); }
      })();
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="Cerfa_export_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});
app.get('/admin/logo-check', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  const url = process.env.BETH_HABAD_LOGO_URL || null;
  if (!url) return res.json({ ok: true, configured: false, message: "La variable BETH_HABAD_LOGO_URL n'est pas configurée sur Railway." });
  // Teste la fonction RÉELLEMENT utilisée par la génération de Cerfa (pas un fetch séparé)
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
app.post('/admin/cerfa/generer', async (req, res) => {
  const { password, nom, prenom, adresse, montant, mode, email, date } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: "Mot de passe incorrect" });
  if (!nom || !adresse || !montant) return res.status(400).json({ ok: false, message: "Nom, adresse et montant requis" });
  try {
    const montantNum = parseFloat(String(montant).replace(',', '.'));
    if (isNaN(montantNum)) return res.status(400).json({ ok: false, message: "Montant invalide" });
    const modeLower = (mode || '').toLowerCase();
    let modeFinal = "Remise d'espèces";
    if (/cb|carte|virement|pr[eé]l[eè]vement/.test(modeLower)) modeFinal = 'Virement, prélèvement, carte bancaire';
    else if (/ch[eè]que/.test(modeLower)) modeFinal = 'Chèque';
    const numero = await getNextCerfaNumero();
    const prenomFinal = prenom && prenom.trim() ? prenom.trim() : '-';
    const emailFinal = email && email.trim() ? email.trim() : null;
    // date fournie au format YYYY-MM-DD (input type="date") ; sinon date du jour
    const dateDon = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const dateVersement = new Date(dateDon + 'T00:00:00').toLocaleDateString('fr-FR');
    const pdfBuffer = await generateCerfaPDF({ numero, nom: nom.trim(), prenom: prenomFinal, adresse: adresse.trim(), montant: montantNum, mode: modeFinal, dateVersement });
    await pool.query(
      `INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [numero, nom.trim(), prenomFinal, adresse.trim(), montantNum, modeFinal, dateDon, emailFinal]
    );
    envoyerBackupCerfa({ numero, nom: nom.trim(), prenom: prenomFinal, adresse: adresse.trim(), montant: montantNum, mode: modeFinal, dateVersement, email: emailFinal }, pdfBuffer).catch(e => console.error('Backup Cerfa error:', e));
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
        if (mode === 'chabbat') {
          body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'broadcast_chabbat', language: { code: 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text: paracha || '' }, { type: 'text', text: date || '' }, { type: 'text', text: entree || '' }, { type: 'text', text: sortie || '' }] }] } });
        } else {
          const texteAEnvoyer = (texte_libre || '').trim();
          if (texteAEnvoyer && texteAEnvoyer !== ' ') {
            body = JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: texteAEnvoyer } });
          } else if (image_url) {
            await sendWhatsAppImage(phone, image_url);
            envoyes++;
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
        }
        const response = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body });
        const data = await response.json();
        if (data.messages) {
          envoyes++;
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
app.get('/admin/histoires', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false });
  const result = await pool.query('SELECT * FROM histoires ORDER BY created_at DESC');
  res.json({ ok: true, histoires: result.rows });
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
// ─── API ADMIN MUSIQUES ───────────────────────────────────────
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
// ─── API ADMIN PLAYLISTES ─────────────────────────────────────
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
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Shliah Bot actif sur port ${PORT}`));
  demarrerCronChabbat();
});
