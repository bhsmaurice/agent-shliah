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
  const app = { get: (p, h) => { routesGet[p] = h; }, delete: () => {} };
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
