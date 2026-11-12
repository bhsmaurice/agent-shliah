'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

// Only the two social-post tables are read. No generic media endpoint is exposed.
const POSTS_SQL = `
  SELECT 'publie-' || id AS id, created_at AT TIME ZONE 'UTC' AS date,
         'publié' AS statut, instagram, facebook, photos, resultat
  FROM posts_sociaux
  WHERE created_at >= (NOW() AT TIME ZONE 'UTC') - ($1::int * INTERVAL '1 day')
    AND created_at <= (NOW() AT TIME ZONE 'UTC')
    AND (resultat LIKE '%Facebook : publié ✅%' OR resultat LIKE '%Instagram : publié ✅%')
  UNION ALL
  SELECT 'programme-' || id, date_publication, 'programmé',
         contenu->'brouillon'->>'instagram', contenu->'brouillon'->>'facebook',
         contenu->'photos', NULL
  FROM posts_programmes
  WHERE statut = 'programme'
    AND created_at >= NOW() - ($1::int * INTERVAL '1 day') AND created_at <= NOW()
  ORDER BY date DESC, id DESC`;

const MEDIA_SQL = `
  SELECT m.data, m.mime_type FROM medias m
  WHERE m.id = $1 AND m.mime_type IN ('image/jpeg', 'image/png')
  AND EXISTS (
    SELECT 1 FROM (
      SELECT photos FROM posts_sociaux
      WHERE resultat LIKE '%Facebook : publié ✅%' OR resultat LIKE '%Instagram : publié ✅%'
      UNION ALL
      SELECT contenu->'photos' FROM posts_programmes WHERE statut = 'programme'
    ) p CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.photos) = 'array' THEN p.photos ELSE '[]'::jsonb END
    ) photo
    WHERE COALESCE(photo->>'url', photo #>> '{}') ~ ('/media/' || m.id::text || '([?].*)?$')
  )`;

function mediaId(photo) {
  const url = typeof photo === 'string' ? photo : photo && photo.url;
  const match = typeof url === 'string' && url.match(/\/media\/([1-9][0-9]*)(?:\?.*)?$/);
  return match ? match[1] : null;
}

function link(resultat, platform) {
  const host = platform === 'instagram' ? 'www\\.instagram\\.com' : 'www\\.facebook\\.com';
  return (String(resultat || '').match(new RegExp('https://' + host + '/[^\\s]+')) || [null])[0];
}

function init({ app, pool, publicBaseUrl }) {
  function authenticate(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const expected = process.env.EXPORT_API_KEY;
    const supplied = req.query.key;
    const hash = value => createHash('sha256').update(value).digest();
    if (!expected || typeof supplied !== 'string' || !timingSafeEqual(hash(expected), hash(supplied))) {
      return res.status(401).json({ erreur: 'Clé incorrecte ou absente' });
    }
    next();
  }

  app.get('/api/export/posts', authenticate, async (req, res) => {
    const raw = req.query.days === undefined ? '7' : req.query.days;
    if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return res.status(400).json({ erreur: 'days doit être un entier positif' });
    }
    const days = Math.min(Number(raw), 60);
    try {
      // Never derive secret-bearing links from a caller-controlled Host header.
      const base = new URL(publicBaseUrl);
      if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid public URL');
      const { rows } = await pool.query(POSTS_SQL, [days]);
      const posts = rows.map(p => {
        const published = p.statut === 'publié';
        const plateformes = ['instagram', 'facebook'].filter(platform => published
          ? String(p.resultat || '').includes((platform === 'instagram' ? 'Instagram' : 'Facebook') + ' : publié ✅')
          : Boolean(p[platform]));
        return {
          id: p.id, date: new Date(p.date).toISOString(), statut: p.statut, plateformes,
          texte: (plateformes.includes('instagram') ? p.instagram : p.facebook) || '',
          lienInstagram: published ? link(p.resultat, 'instagram') : null,
          lienFacebook: published ? link(p.resultat, 'facebook') : null,
          photos: (Array.isArray(p.photos) ? p.photos : []).map(photo => {
            const id = mediaId(photo);
            if (!id) throw new Error('Unrecognized post photo');
            const url = new URL('/api/export/media/' + id, base.origin);
            url.searchParams.set('key', process.env.EXPORT_API_KEY);
            return url.href;
          })
        };
      });
      res.json(posts);
    } catch (_) {
      console.error('Export posts: lecture impossible');
      res.status(500).json({ erreur: 'Export indisponible' });
    }
  });

  app.get('/api/export/media/:id', authenticate, async (req, res) => {
    if (!/^[1-9][0-9]*$/.test(req.params.id) || BigInt(req.params.id) > 2147483647n) {
      return res.status(404).json({ erreur: 'Image introuvable' });
    }
    try {
      const { rows } = await pool.query(MEDIA_SQL, [req.params.id]);
      if (!rows.length) return res.status(404).json({ erreur: 'Image introuvable' });
      res.set('Content-Type', rows[0].mime_type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(rows[0].data);
    } catch (_) {
      console.error('Export media: lecture impossible');
      res.status(500).json({ erreur: 'Image indisponible' });
    }
  });
}

module.exports = { init };
