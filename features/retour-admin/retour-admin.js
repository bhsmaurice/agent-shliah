// ═══════════════════════════════════════════════════════════════
// Bouton « ← Retour à l'admin » ajouté en haut des pages admin
// servies par Railway (Stories, Tsédaka, Lettres, SMS, etc.).
// Un seul endroit à modifier : la liste PAGES ci-dessous.
// Le bouton est ajouté automatiquement au HTML envoyé, sans toucher
// au code des pages elles-mêmes.
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs');

const ADMIN_URL = 'https://bhsmaurice.github.io/agent-shliah/admin.html?v=2';

// Pages qui reçoivent le bouton (chemin exact, sans ?…)
const PAGES = new Set([
  '/admin/stories',
  '/admin/community',
  '/admin/sms',
  '/admin/repertoire',
  '/tsedaka',
  '/lettres-sefer-torah',
  '/havrouta/admin',
]);

const BARRE = `<div id="retour-admin-bar" style="background:#0B1B3F;padding:8px 14px;font-family:Heebo,system-ui,-apple-system,sans-serif;position:relative;z-index:9999"><a href="${ADMIN_URL}" style="color:#fff;text-decoration:none;font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1px solid #E8D28E;border-radius:999px">← Retour à l'admin</a></div>`;

function injecter(html) {
  if (typeof html !== 'string' || html.includes('retour-admin-bar')) return html;
  const m = html.match(/<body[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + BARRE);
  return BARRE + html;
}

function middleware(req, res, next) {
  if (req.method !== 'GET' || !PAGES.has(req.path.replace(/\/+$/, '') || '/')) return next();

  const send = res.send.bind(res);
  res.send = function (body) {
    const type = String(res.get('Content-Type') || '');
    if (typeof body === 'string' && (type.includes('html') || /<html|<!doctype/i.test(body.slice(0, 300)))) {
      body = injecter(body);
    }
    return send(body);
  };

  const sendFile = res.sendFile.bind(res);
  res.sendFile = function (fichier, ...rest) {
    if (typeof fichier === 'string' && /\.html?$/i.test(fichier)) {
      return fs.readFile(fichier, 'utf8', (err, html) => {
        if (err) return sendFile(fichier, ...rest);
        res.type('html').send(html);
      });
    }
    return sendFile(fichier, ...rest);
  };

  next();
}

module.exports = { middleware, injecter, PAGES, ADMIN_URL };
