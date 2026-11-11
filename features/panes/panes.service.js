// ═══════════════════════════════════════════════════════════════════════════
// ÉCRIRE AU RABBI — Service PostgreSQL + routes admin
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

function createPanesService({ pool, app, adminPassword, sendWhatsApp }) {
  if (!pool) throw new Error('pool PostgreSQL requis');

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS panes (
      id SERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      prenom_hebreu TEXT NOT NULL,
      mere_hebreu TEXT NOT NULL,
      categorie TEXT,
      demande TEXT NOT NULL,
      lettre TEXT NOT NULL,
      statut TEXT NOT NULL DEFAULT 'a_transmettre',
      transmis_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_panes_statut ON panes(statut)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_panes_phone ON panes(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_panes_created_at ON panes(created_at DESC)');
  }

  function makeReference() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `PAN-${y}${m}${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  function buildLetter({ prenom_hebreu, mere_hebreu, categorie, demande }) {
    return `PAN — Pidyon Nefesh\n\nNom hébraïque : ${String(prenom_hebreu || '').trim()}\nPrénom hébraïque de la mère : ${String(mere_hebreu || '').trim()}\nDemande de bra'ha : ${categorie || 'Autre'}\n\n${String(demande || '').trim()}`;
  }

  async function create({ phone, prenom_hebreu, mere_hebreu, categorie, demande, lettre }) {
    if (!phone || !prenom_hebreu || !mere_hebreu || !demande) throw new Error('Informations PAN incomplètes');
    let reference = makeReference();
    for (let i = 0; i < 3; i++) {
      try {
        const finalLetter = lettre || buildLetter({ prenom_hebreu, mere_hebreu, categorie, demande });
        const r = await pool.query(`INSERT INTO panes
          (reference, phone, prenom_hebreu, mere_hebreu, categorie, demande, lettre, statut)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'a_transmettre') RETURNING *`,
          [reference, phone, prenom_hebreu.trim(), mere_hebreu.trim(), categorie || 'Autre', demande.trim(), finalLetter]);
        return r.rows[0];
      } catch (e) {
        if (e.code === '23505') { reference = makeReference(); continue; }
        throw e;
      }
    }
    throw new Error('Impossible de générer une référence PAN');
  }

  async function list({ statut, search } = {}) {
    const params = [], where = [];
    if (statut) { params.push(statut); where.push(`p.statut = $${params.length}`); }
    if (search) {
      params.push(`%${String(search).slice(0, 120)}%`);
      const p = `$${params.length}`;
      where.push(`(p.reference ILIKE ${p} OR p.phone ILIKE ${p} OR p.prenom_hebreu ILIKE ${p} OR p.mere_hebreu ILIKE ${p} OR p.categorie ILIKE ${p})`);
    }
    return (await pool.query(`SELECT p.* FROM panes p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT 500`, params)).rows;
  }

  async function updateStatus(id, statut) {
    if (!['nouveau', 'a_transmettre', 'transmis'].includes(statut)) throw new Error('Statut invalide');
    const current = await pool.query('SELECT * FROM panes WHERE id=$1', [id]);
    if (!current.rows[0]) throw new Error('PAN introuvable');
    const avant = current.rows[0];
    const r = await pool.query(`UPDATE panes SET statut=$1,
      transmis_at=CASE WHEN $1='transmis' THEN COALESCE(transmis_at,NOW()) ELSE transmis_at END,
      updated_at=NOW() WHERE id=$2 RETURNING *`, [statut, id]);
    return { pan: r.rows[0], becameTransmitted: statut === 'transmis' && avant.statut !== 'transmis' };
  }

  async function markTransmittedAndNotify(id) {
    const result = await updateStatus(id, 'transmis');
    if (result.becameTransmitted && sendWhatsApp && result.pan.phone) {
      await sendWhatsApp(result.pan.phone, `🙏 *Votre PAN a bien été transmis à l'Ohel du Rabbi.*\n\nQue nous recevions de bonnes nouvelles.\n\n*Beth Habad S. Maurice*`);
    }
    return result.pan;
  }

  function isAdmin(req) {
    const password = req.method === 'GET' ? req.query.password : req.body.password;
    return password === adminPassword;
  }

  function registerRoutes() {
    if (!app) return;
    app.get('/admin/panes', async (req, res) => {
      if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'Non autorisé' });
      try {
        const panes = await list({ statut: req.query.statut || null, search: req.query.search || null });
        const statsR = await pool.query('SELECT statut, COUNT(*)::int AS total FROM panes GROUP BY statut');
        const stats = { nouveau: 0, a_transmettre: 0, transmis: 0, total: 0 };
        statsR.rows.forEach(r => { stats[r.statut] = r.total; stats.total += r.total; });
        res.json({ ok: true, panes, stats });
      } catch (e) { res.status(500).json({ ok: false, error: 'Impossible de charger les PANIM' }); }
    });

    app.put('/admin/panes/:id/statut', async (req, res) => {
      if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'Non autorisé' });
      try {
        let pan;
        if (req.body.statut === 'transmis') pan = await markTransmittedAndNotify(req.params.id);
        else pan = (await updateStatus(req.params.id, req.body.statut)).pan;
        res.json({ ok: true, pan });
      } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });
  }

  return { init, create, list, updateStatus, markTransmittedAndNotify, buildLetter, registerRoutes };
}

module.exports = { createPanesService };
