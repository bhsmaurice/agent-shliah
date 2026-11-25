'use strict';

const { timingSafeEqual } = require('node:crypto');
const { join } = require('node:path');
const schema = require('./mariages.schema.json');

const base = '/admin/mariages';
const fields = schema.flatMap(([, section]) => section);
const questionKeys = new Set(fields.filter(([key, , type]) =>
  key !== 'status' && !['checkbox', 'name-extra', 'legacy', 'legacy-textarea', 'archived', 'archived-textarea'].includes(type)
).map(([key]) => key));
const documentStatuses = ['À demander', 'Demandé', 'Reçu', 'Vérifié', 'Sans objet'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const answers = {};
  for (const [key, , type] of fields) {
    const value = input[key] ?? '';
    const limit = ['textarea', 'legacy-textarea', 'archived-textarea'].includes(type) ? 4000 : 240;
    if (typeof value !== 'string' || value.length > limit || value.includes('\0')) return null;
    if (value && type === 'date') {
      const parsed = new Date(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) return null;
    }
    if (value && type === 'time' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    if (Array.isArray(type) && !type.includes(value)) return null;
    if (type === 'document' && value && !documentStatuses.includes(value)) return null;
    answers[key] = value.trim();
  }
  const skipped = input.skippedQuestions ?? [];
  if (!Array.isArray(skipped) || skipped.length > questionKeys.size || skipped.some(key => !questionKeys.has(key))) return null;
  answers.skippedQuestions = [...new Set(skipped)].filter(key => !answers[key]).sort();
  const hasName = ['groom', 'bride'].some(person =>
    answers[person + 'GivenNames'] || answers[person + 'FamilyName'] || answers[person + 'Name']);
  return hasName || answers.status === 'Brouillon' ? answers : null;
}

function init({ app, pool, adminPassword }) {
  const secret = Buffer.from(adminPassword || '');
  let ready;

  function ensureDB() {
    return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS marriage_dossiers (
      id UUID PRIMARY KEY,
      answers JSONB NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(error => {
      ready = null;
      throw error;
    });
  }

  app.get(base, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, 'mariages.admin.html'));
  });
  app.get(base + '/schema', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ schema, documentStatuses });
  });

  function privateRoute(handler) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const password = Buffer.from(req.get('X-Admin-Password') || '');
      if (!secret.length) return res.status(503).json({ error: 'L’accès administrateur doit être configuré.' });
      if (password.length !== secret.length || !timingSafeEqual(password, secret)) {
        return res.status(401).json({ error: 'Mot de passe administrateur incorrect.' });
      }
      try {
        await ensureDB();
        await handler(req, res);
      } catch (error) {
        console.error('Mariages : erreur de base de données', error.code || error.name);
        res.status(500).json({ error: 'Impossible de charger ou d’enregistrer le dossier.' });
      }
    };
  }

  app.get(base + '/dossiers', privateRoute(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, answers, revision FROM marriage_dossiers
      ORDER BY NULLIF(answers->>'weddingDate', '') ASC NULLS LAST, updated_at DESC`);
    res.json({ dossiers: rows });
  }));

  app.put(base + '/dossiers/:id', privateRoute(async (req, res) => {
    const { id } = req.params;
    const { revision, answers: input } = req.body || {};
    const answers = validate(input);
    if (!uuid.test(id) || !Number.isInteger(revision) || revision < 0 || revision > 2147483646 || !answers) {
      return res.status(400).json({ error: 'Vérifie les champs et renseigne au moins un des deux noms.' });
    }
    const { rows } = revision === 0
      ? await pool.query(`INSERT INTO marriage_dossiers (id, answers) VALUES ($1, $2)
          ON CONFLICT (id) DO UPDATE SET answers = EXCLUDED.answers
          WHERE marriage_dossiers.revision = 1 AND marriage_dossiers.answers = EXCLUDED.answers
          RETURNING id, answers, revision`, [id, JSON.stringify(answers)])
      : await pool.query(`UPDATE marriage_dossiers SET answers = $2, revision = $3 + 1, updated_at = NOW()
          WHERE id = $1 AND (revision = $3 OR (revision = $3 + 1 AND answers = $2))
          RETURNING id, answers, revision`, [id, JSON.stringify(answers), revision]);
    if (!rows.length) return res.status(409).json({ error: 'Le dossier a changé dans une autre session. Recharge la liste avant de le modifier à nouveau.' });
    res.json({ dossier: rows[0] });
  }));
}

module.exports = { init };
