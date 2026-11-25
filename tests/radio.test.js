'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { init, _test: R } = require('../features/radio/radio.bot');

test('Liens YouTube reconnus', () => {
  assert.equal(R.youtubeId('écoute https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), 'dQw4w9WgXcQ');
  assert.equal(R.youtubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(R.youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(R.youtubeId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
  assert.equal(R.youtubeId('https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(R.youtubeId('https://habadsmaurice.com'), null);
  assert.equal(R.youtubeId('bonjour'), null);
});

test('Vocal ≠ fichier audio', () => {
  assert.equal(R.estFichierAudio({ type: 'audio', audio: { id: '1', voice: true } }), false);
  assert.equal(R.estFichierAudio({ type: 'audio', audio: { id: '1', voice: false } }), true);
  assert.equal(R.estFichierAudio({ type: 'document', document: { id: '1', filename: 'Nigoun.mp3' } }), true);
  assert.equal(R.estFichierAudio({ type: 'document', document: { id: '1', mime_type: 'audio/mpeg' } }), true);
  assert.equal(R.estFichierAudio({ type: 'document', document: { id: '1', filename: 'recu.pdf', mime_type: 'application/pdf' } }), false);
});

test('Choix tapés et noms de fichiers', () => {
  assert.equal(R.choixDepuisTexte(' 1 '), 'radio_hayous');
  assert.equal(R.choixDepuisTexte('Calme'), 'radio_calme');
  assert.equal(R.choixDepuisTexte('clip'), 'radio_clip');
  assert.equal(R.choixDepuisTexte('merci'), null);
  assert.equal(R.nomFichierPropre('AC/DC: "Live"?', 'mp3'), 'AC DC Live.mp3');
  assert.equal(R.nomFichierPropre('Nigoun.m4a'), 'Nigoun.m4a');
});

test('Envoi AzuraCast : morceaux de 4 Mo puis ajout à la bonne liste', async () => {
  process.env.AZURACAST_API_KEY = 'cle-test';
  process.env.AZURACAST_URL = 'https://radio.test/';
  const appels = [];
  const ancien = global.fetch;
  global.fetch = async (url, opts) => {
    const corps = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].filter(([k]) => k !== 'file_data')) : opts.body;
    appels.push({ url, methode: opts.method, cle: opts.headers['X-API-Key'], corps });
    if (url.endsWith('/playlists')) return new Response(JSON.stringify([
      { id: 7, name: 'Jingles', type: 'default', source: 'songs', is_jingle: true, num_songs: 50 },
      { id: 4, name: 'default', type: 'default', source: 'songs', is_enabled: true, num_songs: 12 },
      { id: 5, name: 'Vide', type: 'default', source: 'songs', is_enabled: true, num_songs: 0 },
      { id: 6, name: 'Une fois par heure', type: 'once_per_x_minutes', is_enabled: true, num_songs: 99 }
    ]));
    return new Response(JSON.stringify({ success: true }));
  };
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'radiotest-'));
    const f = path.join(dir, 'Mon Nigoun.mp3');
    await fs.writeFile(f, Buffer.alloc(9 * 1024 * 1024, 1));
    const chemin = await R.envoyerSurAzuracast(2, f);
    assert.equal(chemin, 'Mon Nigoun.mp3');
    const uploads = appels.filter((a) => a.url.endsWith('/files/upload'));
    assert.equal(uploads.length, 3);
    assert.equal(uploads[0].url, 'https://radio.test/api/station/2/files/upload');
    assert.equal(uploads[2].corps.flowChunkNumber, '3');
    assert.equal(uploads[2].corps.flowTotalChunks, '3');
    assert.equal(uploads[2].corps.flowCurrentChunkSize, String(1024 * 1024));
    assert.ok(uploads.every((u) => u.cle === 'cle-test' && u.corps.flowIdentifier === uploads[0].corps.flowIdentifier));
    const liste = await R.ajouterALaPlaylist(2, chemin);
    assert.equal(liste, 'default');
    const batch = appels.find((a) => a.url.endsWith('/files/batch'));
    assert.deepEqual(JSON.parse(batch.corps), { do: 'playlist', playlists: ['4'], files: ['Mon Nigoun.mp3'], dirs: [] });
    await fs.rm(dir, { recursive: true, force: true });
  } finally { global.fetch = ancien; }
});

test('Clé refusée : message clair', async () => {
  const ancien = global.fetch;
  global.fetch = async () => new Response('{"message":"no"}', { status: 403 });
  try { await assert.rejects(R.choisirPlaylist(1), /clé API AzuraCast est refusée/); }
  finally { global.fetch = ancien; }
});

test('Seul l\'admin déclenche ; lien → liste de radios ; « Clip seulement » range le clip', async () => {
  const envoyes = [], requetes = [], routesGet = {};
  const pool = { async query(sql, args) { requetes.push({ sql, args }); return { rows: [] }; } };
  const app = { get: (p, h) => { routesGet[p] = h; }, post: () => {}, delete: () => {} };
  const ancien = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/messages')) { envoyes.push(JSON.parse(opts.body)); return new Response('{}'); }
    if (String(url).includes('oembed')) return new Response(JSON.stringify({ title: 'Nigoun Simha', author_name: 'Chanteur' }));
    return new Response('{}');
  };
  try {
    const radio = init({ app, pool, sendWhatsApp: async (to, t) => envoyes.push({ to, texte: t }), isAdmin: (f) => f === '33770241746', adminPassword: 'x', whatsappToken: 't', phoneNumberId: 'p' });
    assert.equal(await radio.handleText('33600000000', 'https://youtu.be/dQw4w9WgXcQ'), false);
    assert.equal(await radio.handleText('33770241746', 'https://youtu.be/dQw4w9WgXcQ'), true);
    const liste = envoyes.find((m) => m.type === 'interactive');
    const ids = liste.interactive.action.sections[0].rows.map((r) => r.id);
    assert.deepEqual(ids, ['radio_hayous', 'radio_nigounim', 'radio_calme', 'radio_clip', 'radio_annuler']);
    assert.ok(liste.interactive.action.sections[0].rows.every((r) => r.title.length <= 24));
    assert.equal(await radio.handleText('33770241746', '4'), true);
    const insert = requetes.find((q) => /INSERT INTO radio_clips/.test(q.sql));
    assert.deepEqual(insert.args.slice(0, 3), ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Nigoun Simha']);
    assert.match(envoyes.at(-1).texte, /Clip ajouté/);
    assert.equal(R.sessions['33770241746'], undefined);
    // Un vocal n'est pas pris par la radio (il reste pour « Mon carnet »)
    assert.equal(await radio.handleMedia('33770241746', { type: 'audio', audio: { id: 'v', voice: true } }), false);
    assert.ok(routesGet['/radio/clips']);
  } finally { global.fetch = ancien; }
});

test('Page admin « Radio » : mot de passe, état, coller un lien « clip »', async () => {
  const routes = {}, requetes = [];
  const app = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; }, delete: (p, h) => { routes['DELETE ' + p] = h; } };
  const pool = { async query(sql, args) {
    requetes.push({ sql, args });
    if (/FROM radio_envois/.test(sql)) return { rows: [{ id: 1, statut: 'ok', titre: 'Nigoun', radio: 'hayous' }] };
    if (/FROM radio_clips/.test(sql)) return { rows: [{ id: 3, youtube_id: 'dQw4w9WgXcQ', titre: 'Clip' }] };
    return { rows: [] };
  } };
  const ancien = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('oembed')) return new Response(JSON.stringify({ title: 'Simha' }));
    if (String(url).includes('/playlists')) return new Response('[]');
    return new Response('{}');
  };
  const rep = () => { const r = { code: 200, corps: null, status(c) { r.code = c; return r; }, json(j) { r.corps = j; return r; }, set() { return r; } }; return r; };
  try {
    process.env.AZURACAST_API_KEY = 'cle';
    init({ app, pool, sendWhatsApp: async () => {}, isAdmin: () => true, adminPassword: 'pw', whatsappToken: 't', phoneNumberId: 'p' });
    let r = rep(); await routes['GET /admin/radio']({ query: { password: 'faux' } }, r); assert.equal(r.code, 401);
    r = rep(); await routes['GET /admin/radio']({ query: { password: 'pw' } }, r);
    assert.equal(r.corps.ok, true); assert.equal(r.corps.branche.ok, true);
    assert.equal(r.corps.envois.length, 1); assert.match(r.corps.clips[0].miniature, /dQw4w9WgXcQ/);
    r = rep(); await routes['POST /admin/radio/lien']({ body: { password: 'pw', lien: 'pas un lien', radio: 'hayous' } }, r); assert.equal(r.corps.ok, false);
    r = rep(); await routes['POST /admin/radio/lien']({ body: { password: 'pw', lien: 'https://youtu.be/dQw4w9WgXcQ', radio: 'clip' } }, r);
    assert.equal(r.corps.ok, true); assert.match(r.corps.message, /Simha/);
    assert.ok(requetes.some((q) => /INSERT INTO radio_clips/.test(q.sql)));
    r = rep(); await routes['POST /admin/radio/clips/:id/supprimer']({ params: { id: '3' }, body: { password: 'pw' } }, r);
    assert.equal(r.corps.ok, true);
  } finally { global.fetch = ancien; }
});

test('Nouveautés : les plus récentes d\'abord, sans jingles ni fichiers hors liste', async () => {
  process.env.AZURACAST_API_KEY = 'cle';
  R.viderCache();
  const ancien = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/playlists')) return new Response(JSON.stringify([{ id: 1, name: 'default' }, { id: 9, name: 'Jingles', is_jingle: true }]));
    if (u.includes('/station/2/files')) return new Response(JSON.stringify([
      { title: 'Ancienne', artist: 'A', path: 'a.mp3', uploaded_at: 100, playlists: [{ id: 1 }], art: 'http://radio.test/art.jpg' },
      { title: 'Nouvelle', artist: 'B', path: 'b.mp3', uploaded_at: 300, playlists: [{ id: 1 }] },
      { title: 'Jingle', path: 'jingles/j.mp3', uploaded_at: 999, playlists: [{ id: 9 }] },
      { title: 'Hors liste', path: 'c.mp3', uploaded_at: 500, playlists: [] }
    ]));
    if (u.includes('/files')) return new Response('[]');
    return new Response('[]');
  };
  try {
    const l = await R.nouveautes();
    assert.deepEqual(l.map((m) => m.titre), ['Nouvelle', 'Ancienne']);
    assert.equal(l[0].radio, 'hayous');
    assert.equal(l[1].pochette, 'https://radio.test/art.jpg');
  } finally { global.fetch = ancien; }
});

test('Abonnement radio : phrases reconnues', () => {
  assert.equal(R.demandeAbonnement('Je veux recevoir les nouveautés de la radio 🎵'), 'oui');
  assert.equal(R.demandeAbonnement('Radio'), 'oui');
  assert.equal(R.demandeAbonnement('stop radio'), 'stop');
  assert.equal(R.demandeAbonnement('Désinscrire de la radio'), 'stop');
  assert.equal(R.demandeAbonnement('la radio est super'), null);
  assert.equal(R.demandeAbonnement('stop'), null);
});

test('Abonnement : inscription, puis « Prévenir les abonnés » envoie le modèle à chacun', async () => {
  const envoyes = [], requetes = [];
  const pool = { async query(sql, args) {
    requetes.push({ sql, args });
    if (/FROM contacts WHERE abonne_radio = TRUE/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: '2' }] };
    if (/SELECT phone FROM contacts WHERE abonne_radio/.test(sql)) return { rows: [{ phone: '33611111111' }, { phone: '33622222222' }] };
    if (/SELECT \* FROM radio_envois WHERE id/.test(sql)) return { rows: [{ id: 7, statut: 'ok', titre: 'Nigoun', auteur: 'Fried', radio: 'hayous', prevenus: null }] };
    return { rows: [] };
  } };
  const ancien = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/messages')) envoyes.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ messages: [{ id: 'x' }] })); };
  try {
    const radio = init({ app: { get() {}, post() {}, delete() {} }, pool, sendWhatsApp: async (to, t) => envoyes.push({ to, texte: t }), isAdmin: (f) => f === '33770241746', adminPassword: 'pw', whatsappToken: 't', phoneNumberId: 'p' });
    assert.equal(await radio.handleAbonnement('33611111111', 'Je veux recevoir les nouveautés de la radio'), true);
    const ins = requetes.find((q) => /INSERT INTO contacts/.test(q.sql));
    assert.deepEqual(ins.args, ['33611111111', true]);
    assert.match(envoyes.at(-1).texte, /inscrit/);
    assert.equal(await radio.handleAbonnement('33611111111', 'bonjour'), false);
    envoyes.length = 0;
    await radio.handleBouton('33770241746', 'radio_prevenir_7');
    const modeles = envoyes.filter((m) => m.type === 'template');
    assert.deepEqual(modeles.map((m) => m.to), ['33611111111', '33622222222']);
    assert.equal(modeles[0].template.name, 'radio_nouveaute');
    assert.equal(modeles[0].template.components[0].parameters[0].text, 'Nigoun (Fried) sur Radio Hayous');
    assert.match(envoyes.at(-1).texte, /2 abonnés prévenus/);
    assert.ok(requetes.some((q) => /UPDATE radio_envois SET prevenus/.test(q.sql) && q.args[1] === 2));
  } finally { global.fetch = ancien; }
});
