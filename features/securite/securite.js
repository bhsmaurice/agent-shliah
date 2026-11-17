// ═══════════════════════════════════════════════════════════════
// SÉCURITÉ — protections générales du serveur Shliah Bot
//
// 1. Signature WhatsApp : le bot n'accepte que les messages vraiment
//    envoyés par Meta (réglage Railway : WHATSAPP_APP_SECRET).
// 2. Anti-devinette du mot de passe admin : 8 mauvais essais en
//    15 min → appareil bloqué 30 min + alerte WhatsApp à Levi.
// 3. En-têtes de sécurité (pas d'affichage dans un autre site,
//    le mot de passe ne fuit pas vers les liens cliqués, pas de cache).
// ═══════════════════════════════════════════════════════════════
const crypto = require('node:crypto');

const MAX_ECHECS = 8;
const FENETRE_MS = 15 * 60 * 1000;
const BLOCAGE_MS = 30 * 60 * 1000;

// Les adresses où le mot de passe admin est utilisé
const ZONE_ADMIN = /^\/(admin|api\/admin|tsedaka(\/|$)|api\/havrouta|lettres-sefer-torah\/admin|backup)/;

function memeTexte(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function init({ app, adminPassword, alerter }) {
  app.set('trust proxy', 1);          // vraie adresse IP derrière Railway
  app.disable('x-powered-by');

  // ─── 3. En-têtes de sécurité ───
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Strict-Transport-Security', 'max-age=31536000');
    if (ZONE_ADMIN.test(req.path)) res.set('Cache-Control', 'no-store');
    next();
  });

  // ─── 1. Signature des messages WhatsApp (Meta) ───
  const secret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '';
  if (!secret) console.warn('⚠️ [SÉCURITÉ] WHATSAPP_APP_SECRET absent dans Railway : la signature WhatsApp n’est pas vérifiée.');
  app.use('/webhook', (req, res, next) => {
    if (req.method !== 'POST' || !secret) return next();
    const recu = String(req.get('x-hub-signature-256') || '');
    const attendu = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    if (memeTexte(recu, attendu)) return next();
    console.warn('🚫 [SÉCURITÉ] Faux message WhatsApp refusé (signature invalide) depuis', req.ip);
    return res.sendStatus(401);
  });

  // ─── 2. Anti-devinette du mot de passe admin ───
  const echecs = new Map();   // ip -> { liste: [dates], bloqueJusqua }
  let derniereAlerte = 0;
  app.use((req, res, next) => {
    if (!ZONE_ADMIN.test(req.path)) return next();
    const donne = (req.query && req.query.password) ?? (req.body && req.body.password) ?? req.get('x-admin-password');
    if (donne === undefined || donne === null || donne === '') return next();

    const ip = req.ip || '?', now = Date.now();
    const e = echecs.get(ip) || { liste: [], bloqueJusqua: 0 };
    if (now < e.bloqueJusqua) {
      return res.status(429).json({ ok: false, message: 'Trop d’essais. Réessayez dans ' + Math.ceil((e.bloqueJusqua - now) / 60000) + ' min.' });
    }
    if (memeTexte(donne, adminPassword)) { echecs.delete(ip); return next(); }

    e.liste = e.liste.filter(t => now - t < FENETRE_MS);
    e.liste.push(now);
    if (e.liste.length >= MAX_ECHECS) {
      e.bloqueJusqua = now + BLOCAGE_MS; e.liste = [];
      console.warn('🚫 [SÉCURITÉ] Appareil bloqué 30 min (mots de passe faux) :', ip);
      if (alerter && now - derniereAlerte > 3600 * 1000) {
        derniereAlerte = now;
        alerter('⚠️ Shliah Bot : quelqu’un a tapé plusieurs mauvais mots de passe admin. Appareil bloqué 30 min. Si ce n’est pas toi, change le mot de passe dans Railway.').catch(() => {});
      }
    }
    echecs.set(ip, e);
    // nettoyage pour ne pas garder trop d'adresses en mémoire
    if (echecs.size > 5000) for (const [k, v] of echecs) if (now > v.bloqueJusqua && !v.liste.length) echecs.delete(k);
    next(); // la route répond elle-même « mot de passe incorrect »
  });

  console.log('🛡️ Sécurité active' + (secret ? ' (signature WhatsApp vérifiée)' : ''));
}

// Mot de passe admin : jamais de valeur par défaut connue
function motDePasseAdmin() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  console.error('❌ [SÉCURITÉ] ADMIN_PASSWORD absent dans Railway : admin verrouillé (mot de passe aléatoire).');
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { init, motDePasseAdmin, memeTexte };
