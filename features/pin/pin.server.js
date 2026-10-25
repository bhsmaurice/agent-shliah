// ============================================================
// CODE PIN DE LA PAGE ADMIN — gardé sur le serveur (Railway)
// ------------------------------------------------------------
// Le code n'est plus écrit dans admin.html : il est stocké
// (chiffré) dans la table `admin_pins` de la base de données.
// Même code sur tous les appareils et tous les navigateurs.
//
// Routes :
//   POST /api/admin/pin/verify   { pin }                       -> { ok, role, name }
//   GET  /api/admin/pin/info                                    -> { ok, user2: nom|null }
//   POST /api/admin/pin/change   { password, role, pin, name } -> { ok }
//   GET  /api/admin/pin/reset?password=MOT_DE_PASSE_RAILWAY     -> remet le PIN admin par défaut
//
// PIN par défaut (première installation ou remise à zéro) :
//   variable Railway ADMIN_PIN, sinon 194561.
// ============================================================
const crypto = require('crypto');

const DEFAULT_ADMIN_PIN = process.env.ADMIN_PIN || '194561';

// Anti-essais en rafale
const MAX_ESSAIS_IP = 5;              // 5 erreurs -> blocage
const BLOCAGE_IP_MS = 30 * 1000;      // 30 secondes
const MAX_ESSAIS_IP_TOTAL = 15;       // 15 erreurs cumulées -> blocage long
const BLOCAGE_IP_LONG_MS = 15 * 60 * 1000;
const MAX_ESSAIS_GLOBAL = 60;         // toutes IP confondues, sur 10 min
const FENETRE_GLOBALE_MS = 10 * 60 * 1000;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function memePin(pin, row) {
  if (!row) return false;
  const a = Buffer.from(hashPin(pin, row.salt), 'hex');
  const b = Buffer.from(row.pin_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
}

function init({ app, pool, adminPassword, sendWhatsApp, adminPhone }) {
  const essais = new Map(); // ip -> { n, total, bloqueJusqua }
  let echecsGlobaux = [];
  let alerteEnvoyee = 0;

  async function setPin(role, pin, name) {
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO admin_pins (role, pin_hash, salt, name, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (role) DO UPDATE SET pin_hash = $2, salt = $3, name = COALESCE($4, admin_pins.name), updated_at = NOW()`,
      [role, hashPin(pin, salt), salt, name || null]
    );
  }

  const pret = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_pins (
      role TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query("SELECT 1 FROM admin_pins WHERE role = 'admin'");
    if (!r.rows.length) {
      await setPin('admin', DEFAULT_ADMIN_PIN, 'Administrateur');
      console.log('🔒 [PIN] PIN admin initialisé (valeur par défaut)');
    }
  })().catch(e => console.error('❌ [PIN] init:', e.message));

  // ---------- Vérifier un PIN ----------
  app.post('/api/admin/pin/verify', async (req, res) => {
    try {
      await pret;
      const ip = ipDe(req);
      const now = Date.now();
      const e = essais.get(ip) || { n: 0, total: 0, bloqueJusqua: 0 };

      if (now < e.bloqueJusqua) {
        return res.status(429).json({ ok: false, bloque: Math.ceil((e.bloqueJusqua - now) / 1000) });
      }
      echecsGlobaux = echecsGlobaux.filter(t => now - t < FENETRE_GLOBALE_MS);
      if (echecsGlobaux.length >= MAX_ESSAIS_GLOBAL) {
        return res.status(429).json({ ok: false, bloque: 300 });
      }

      const pin = String((req.body && req.body.pin) || '');
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, message: 'PIN invalide' });

      const { rows } = await pool.query('SELECT role, pin_hash, salt, name FROM admin_pins');
      const ordre = ['admin', 'user2'];
      const trouve = ordre.map(r => rows.find(x => x.role === r)).find(row => memePin(pin, row));

      if (trouve) {
        essais.delete(ip);
        return res.json({ ok: true, role: trouve.role, name: trouve.name || '' });
      }

      // Échec
      e.n += 1; e.total += 1;
      echecsGlobaux.push(now);
      let bloque = 0;
      if (e.total >= MAX_ESSAIS_IP_TOTAL) { e.bloqueJusqua = now + BLOCAGE_IP_LONG_MS; e.n = 0; e.total = 0; bloque = BLOCAGE_IP_LONG_MS / 1000; }
      else if (e.n >= MAX_ESSAIS_IP) { e.bloqueJusqua = now + BLOCAGE_IP_MS; e.n = 0; bloque = BLOCAGE_IP_MS / 1000; }
      essais.set(ip, e);

      // Alerte WhatsApp si beaucoup d'erreurs (max 1 par heure)
      if (bloque >= 60 && sendWhatsApp && adminPhone && now - alerteEnvoyee > 3600 * 1000) {
        alerteEnvoyee = now;
        sendWhatsApp(adminPhone, `⚠️ Page admin Shliah Bot : beaucoup de codes PIN faux ont été tapés. Accès bloqué 15 min pour cet appareil.`).catch(() => {});
      }

      return res.status(401).json({ ok: false, essai: e.n, max: MAX_ESSAIS_IP, bloque });
    } catch (err) {
      console.error('❌ [PIN] verify:', err.message);
      res.status(500).json({ ok: false, message: 'Erreur serveur' });
    }
  });

  // ---------- Info : y a-t-il un 2ème utilisateur ? ----------
  app.get('/api/admin/pin/info', async (req, res) => {
    try {
      await pret;
      const { rows } = await pool.query("SELECT name FROM admin_pins WHERE role = 'user2'");
      res.json({ ok: true, user2: rows.length ? (rows[0].name || '2ème utilisateur') : null });
    } catch (err) {
      res.status(500).json({ ok: false });
    }
  });

  // ---------- Changer un PIN (depuis Config) ----------
  app.post('/api/admin/pin/change', async (req, res) => {
    try {
      await pret;
      const { password, role, pin, name } = req.body || {};
      if (password !== adminPassword) return res.status(401).json({ ok: false, message: 'Mot de passe Railway incorrect (onglet Config)' });
      if (!['admin', 'user2'].includes(role)) return res.status(400).json({ ok: false, message: 'Rôle invalide' });
      if (!/^\d{6}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, message: 'Le PIN doit contenir exactement 6 chiffres' });

      // Les deux PIN doivent être différents
      const autre = role === 'admin' ? 'user2' : 'admin';
      const { rows } = await pool.query('SELECT pin_hash, salt FROM admin_pins WHERE role = $1', [autre]);
      if (rows.length && memePin(pin, rows[0])) return res.status(400).json({ ok: false, message: "Ce PIN est déjà utilisé par l'autre utilisateur" });

      await setPin(role, String(pin), name ? String(name).slice(0, 60) : null);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ [PIN] change:', err.message);
      res.status(500).json({ ok: false, message: 'Erreur serveur' });
    }
  });

  // ---------- Remise à zéro (si PIN oublié) ----------
  app.get('/api/admin/pin/reset', async (req, res) => {
    try {
      await pret;
      if (req.query.password !== adminPassword) return res.status(401).send('Mot de passe incorrect');
      await setPin('admin', DEFAULT_ADMIN_PIN, 'Administrateur');
      essais.clear();
      echecsGlobaux = [];
      res.send('<meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;font-size:18px;padding:20px">✅ PIN admin remis par défaut. Retournez sur la page admin.</p>');
    } catch (err) {
      res.status(500).send('Erreur serveur');
    }
  });
}

module.exports = { init };
