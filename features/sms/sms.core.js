'use strict';
// ═══════════════════════════════════════════════════════════════
// SMS — outils de base (sans base de données, testables seuls)
//  • normaliserTel   : 06 12 34 56 78 → 33612345678
//  • nettoyerPourSMS : enlève les emojis et remplace ê â î ô ç…
//                      pour rester en SMS « normal » (160 caractères)
//                      au lieu du mode « unicode » (70 caractères = 2× plus cher)
//  • compterSMS      : combien de SMS (donc de crédits) pour un texte
// ═══════════════════════════════════════════════════════════════

// Alphabet GSM 03.38 : tout ce qui est ici tient dans un SMS « normal »
const GSM_BASE = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡'
  + 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€'; // comptent pour 2 caractères
const GSM = new Set([...GSM_BASE, ...GSM_EXT]);

// Mention STOP ajoutée automatiquement par SMSFactor aux SMS « marketing »
const LONGUEUR_STOP = 16;

const REMPLACEMENTS = [
  [/[êëÊË]/g, c => (c === c.toLowerCase() ? 'e' : 'E')],
  [/[âÂ]/g, c => (c === 'â' ? 'a' : 'A')],
  [/[îïÎÏ]/g, c => (c === c.toLowerCase() ? 'i' : 'I')],
  [/[ôÔ]/g, c => (c === 'ô' ? 'o' : 'O')],
  [/[ûÛ]/g, c => (c === 'û' ? 'u' : 'U')],
  [/[ÈÊ]/g, 'E'], [/[ÀÂ]/g, 'A'], [/[ÙÛ]/g, 'U'],
  [/ç/g, 'c'], [/œ/g, 'oe'], [/Œ/g, 'OE'],
  [/[’‘‛`´]/g, "'"], [/«[\s  ]*/g, '"'], [/[\s  ]*»/g, '"'], [/[“”„]/g, '"'], [/…/g, '...'], [/[–—−]/g, '-'],
  [/[    ]/g, ' '], [/[•·]/g, '-'], [/\t/g, ' '],
];

function normaliserTel(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = '33' + d.slice(1);
  if (d.length === 9 && /^[67]/.test(d)) d = '33' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}

// Affichage français : 33612345678 → 06 12 34 56 78
function telLisible(d) {
  d = String(d || '');
  return d.startsWith('33') && d.length === 11 ? ('0' + d.slice(2)).replace(/(\d{2})(?=\d)/g, '$1 ') : '+' + d;
}

function nettoyerPourSMS(texte) {
  let t = String(texte == null ? '' : texte).replace(/\r\n/g, '\n');
  for (const [re, rep] of REMPLACEMENTS) t = t.replace(re, rep);
  const restants = [...t].filter(c => !GSM.has(c));
  // Lettres d'un autre alphabet (hébreu…) : on garde le texte tel quel (mode unicode)
  if (restants.some(c => /\p{L}/u.test(c))) return t.trim();
  // Sinon ce sont des emojis / symboles : on les enlève
  t = [...t].filter(c => GSM.has(c)).join('');
  return t.split('\n').map(l => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function compterSMS(texte, { stop = false } = {}) {
  const t = String(texte || '');
  const unicode = [...t].some(c => !GSM.has(c));
  let n = unicode ? t.length : [...t].reduce((s, c) => s + (GSM_EXT.includes(c) ? 2 : 1), 0);
  if (stop) n += LONGUEUR_STOP;
  const [un, plusieurs] = unicode ? [70, 67] : [160, 153];
  const sms = n === 0 ? 0 : n <= un ? 1 : Math.ceil(n / plusieurs);
  return { unicode, caracteres: n, sms };
}

module.exports = { normaliserTel, telLisible, nettoyerPourSMS, compterSMS, LONGUEUR_STOP };
