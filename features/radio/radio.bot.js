'use strict';
// ═══════════════════════════════════════════════════════════════
// RADIO — envoyer une musique sur la web radio depuis WhatsApp (réservé à l'admin)
//
// WhatsApp :
//   lien YouTube             → « Quelle radio ? » (Hayous / Nigounim / Calme / Clip seulement)
//                              → le son part sur la radio choisie
//                              → le clip est rangé dans l'onglet « Clips »
//   fichier audio (mp3…)     → « Quelle radio ? » → le fichier part sur la radio
//   (les messages VOCAUX restent pour « Mon carnet »)
//
// À n'utiliser que pour les musiques dont on a l'accord de l'artiste.
//
// Page publique : GET /radio/clips  → liste des clips (pour l'onglet « Clips » de la radio)
//
// Variables Railway :
//   AZURACAST_API_KEY  (obligatoire) — clé API AzuraCast (Mon compte > Clés API)
//   AZURACAST_URL      (facultatif)  — https://radio.habadsmaurice.com par défaut
//   RADIO_STATIONS     (facultatif)  — JSON {"hayous":2,"nigounim":1,"calme":3}
//   YTDLP_COOKIES      (facultatif)  — cookies YouTube (format Netscape) si YouTube bloque le serveur
//   YTDLP_PATH         (facultatif)  — chemin d'un yt-dlp déjà installé
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const GRAPH = 'https://graph.facebook.com/v25.0';
const CHUNK = 4 * 1024 * 1024; // 4 Mo par morceau (comme dans la page de gestion)
const EXT_AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)$/i;

let ctx = null;
const sessions = {}; // from -> { source, lien?, youtubeId?, mediaId?, filename?, mime? , cree }

function radios() {
  let ids = { hayous: 2, nigounim: 1, calme: 3 };
  try { if (process.env.RADIO_STATIONS) ids = { ...ids, ...JSON.parse(process.env.RADIO_STATIONS) }; } catch (e) { /* garde les valeurs par défaut */ }
  return {
    hayous: { id: Number(ids.hayous), nom: 'Radio Hayous' },
    nigounim: { id: Number(ids.nigounim), nom: 'Radio Nigounim' },
    calme: { id: Number(ids.calme), nom: 'Radio Calme' }
  };
}
const azuraUrl = () => (process.env.AZURACAST_URL || 'https://radio.habadsmaurice.com').replace(/\/+$/, '');

// ─── Reconnaître un lien YouTube ──────────────────────────────
function youtubeId(text) {
  const m = String(text || '').match(/https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  return m ? m[1] : null;
}
function nomFichierPropre(nom, extDefaut) {
  const base = String(nom || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Musique';
  return EXT_AUDIO.test(base) ? base : `${base}.${extDefaut || 'mp3'}`;
}
function extDepuisMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'mp3';
}

// ─── Base de données (clips) ──────────────────────────────────
async function creerTables() {
  await ctx.pool.query(`CREATE TABLE IF NOT EXISTS radio_clips (
    id SERIAL PRIMARY KEY, youtube_id TEXT UNIQUE NOT NULL, titre TEXT, auteur TEXT,
    lien TEXT NOT NULL, radio TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await ctx.pool.query(`CREATE TABLE IF NOT EXISTS radio_envois (
    id SERIAL PRIMARY KEY, source TEXT, origine TEXT, lien TEXT, titre TEXT, auteur TEXT, radio TEXT,
    statut TEXT DEFAULT 'en_cours', message TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), fini_le TIMESTAMPTZ)`);
}
async function noterEnvoi(champs) {
  try {
    const r = await ctx.pool.query('INSERT INTO radio_envois (source, origine, lien, titre, radio) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [champs.source, champs.origine, champs.lien || null, champs.titre || null, champs.radio || null]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (e) { return null; }
}
async function finirEnvoi(id, champs) {
  if (!id) return;
  await ctx.pool.query('UPDATE radio_envois SET statut=$2, message=$3, titre=COALESCE($4, titre), auteur=COALESCE($5, auteur), fini_le=NOW() WHERE id=$1',
    [id, champs.statut, champs.message || null, champs.titre || null, champs.auteur || null]).catch(() => {});
}
async function enregistrerClip({ youtubeId: yid, lien, titre, auteur, radio }) {
  await ctx.pool.query(
    `INSERT INTO radio_clips (youtube_id, lien, titre, auteur, radio) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (youtube_id) DO UPDATE SET titre = COALESCE(EXCLUDED.titre, radio_clips.titre),
       auteur = COALESCE(EXCLUDED.auteur, radio_clips.auteur), radio = COALESCE(EXCLUDED.radio, radio_clips.radio)`,
    [yid, lien, titre || null, auteur || null, radio || null]);
}

// ─── WhatsApp : liste de choix ────────────────────────────────
async function demanderRadio(from, intro) {
  const r = radios();
  const body = {
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: `${intro}\n\nSur quelle radio je la mets ?` },
      action: {
        button: 'Choisir la radio',
        sections: [{ title: 'Radios', rows: [
          { id: 'radio_hayous', title: `🎉 ${r.hayous.nom}` },
          { id: 'radio_nigounim', title: `🕯️ ${r.nigounim.nom}` },
          { id: 'radio_calme', title: `🌙 ${r.calme.nom}` },
          ...(sessions[from] && sessions[from].youtubeId ? [{ id: 'radio_clip', title: '🎬 Clip seulement', description: 'Pas sur la radio, juste dans « Clips »' }] : []),
          { id: 'radio_annuler', title: '✖️ Annuler' }
        ] }]
      }
    }
  };
  const res = await fetch(`${GRAPH}/${ctx.phoneNumberId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${ctx.whatsappToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) {
    // Repli si la liste ne passe pas : réponse tapée
    await ctx.sendWhatsApp(from, `${intro}\n\nSur quelle radio ? Réponds :\n1 = ${r.hayous.nom}\n2 = ${r.nigounim.nom}\n3 = ${r.calme.nom}${sessions[from] && sessions[from].youtubeId ? '\n4 = Clip seulement' : ''}\n0 = Annuler`);
  }
}
function choixDepuisTexte(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(1|hayous|hayout)$/.test(t)) return 'radio_hayous';
  if (/^(2|nigoun|nigounim)$/.test(t)) return 'radio_nigounim';
  if (/^(3|calme)$/.test(t)) return 'radio_calme';
  if (/^(4|clip)$/.test(t)) return 'radio_clip';
  if (/^(0|annuler|stop)$/.test(t)) return 'radio_annuler';
  return null;
}

// ─── Entrées WhatsApp ─────────────────────────────────────────
async function handleText(from, text) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const s = sessions[from];
  if (s) {
    const choix = choixDepuisTexte(text);
    if (choix) { await handleBouton(from, choix); return true; }
  }
  const yid = youtubeId(text);
  if (!yid) return false;
  sessions[from] = { source: 'youtube', youtubeId: yid, lien: `https://www.youtube.com/watch?v=${yid}`, cree: Date.now() };
  await demanderRadio(from, '🎵 Lien YouTube reçu !');
  return true;
}

function estFichierAudio(message) {
  if (message.type === 'audio') return !!(message.audio && message.audio.id) && !message.audio.voice;
  if (message.type === 'document') {
    const d = message.document || {};
    return !!d.id && (/^audio\//i.test(d.mime_type || '') || EXT_AUDIO.test(d.filename || ''));
  }
  return false;
}
async function handleMedia(from, message) {
  if (!ctx || !ctx.isAdmin(from) || !estFichierAudio(message)) return false;
  const m = message.type === 'audio' ? message.audio : message.document;
  sessions[from] = { source: 'fichier', mediaId: m.id, filename: m.filename || null, mime: m.mime_type || '', cree: Date.now() };
  await demanderRadio(from, `🎵 Musique reçue${m.filename ? ` : ${m.filename}` : ''} !`);
  return true;
}

async function handleBouton(from, id) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  if (!String(id).startsWith('radio_')) return false;
  const s = sessions[from];
  if (!s) { await ctx.sendWhatsApp(from, "Je n'ai plus la musique en mémoire. Renvoie-moi le lien ou le fichier 🙂"); return true; }
  delete sessions[from];
  if (id === 'radio_annuler') { await ctx.sendWhatsApp(from, '❌ Annulé.'); return true; }
  if (id === 'radio_clip') {
    if (!s.youtubeId) return true;
    const info = await infosYoutube(s.youtubeId).catch(() => ({}));
    await enregistrerClip({ youtubeId: s.youtubeId, lien: s.lien, titre: info.titre, auteur: info.auteur });
    await ctx.sendWhatsApp(from, `🎬 Clip ajouté dans l'onglet « Clips »${info.titre ? ` :\n${info.titre}` : '.'}`);
    return true;
  }
  const cle = id.replace('radio_', '');
  const radio = radios()[cle];
  if (!radio) return true;
  if (!process.env.AZURACAST_API_KEY) {
    await ctx.sendWhatsApp(from, '⚠️ La radio n\'est pas encore branchée : il faut ajouter la variable AZURACAST_API_KEY sur Railway.');
    return true;
  }
  await ctx.sendWhatsApp(from, `⏳ C'est parti pour ${radio.nom}… Je te préviens quand c'est en ligne (ça peut prendre 1 à 2 minutes).`);
  // Le travail continue en arrière-plan : WhatsApp n'attend pas.
  lancerEnvoi(s, cle, 'whatsapp', (msg) => ctx.sendWhatsApp(from, msg));
  return true;
}

// Démarre un envoi en arrière-plan et le note dans l'historique (page admin « Radio »)
async function lancerEnvoi(s, cle, origine, dire) {
  const radio = radios()[cle];
  const id = await noterEnvoi({ source: s.source, origine, lien: s.lien, titre: s.filename, radio: cle });
  traiter(s, cle, radio)
    .then(async (r) => {
      await finirEnvoi(id, { statut: 'ok', titre: r.titre, auteur: r.auteur, message: r.playlist ? `Liste : ${r.playlist}` : null });
      if (dire) await dire(`✅ En ligne sur ${radio.nom} !\n\n🎵 ${r.titre}${r.auteur ? `\n👤 ${r.auteur}` : ''}${r.playlist ? `\n📋 Liste : ${r.playlist}` : ''}${s.source === 'youtube' ? '\n🎬 Clip ajouté dans « Clips »' : ''}`);
    })
    .catch(async (e) => {
      console.error('Radio —', e.message);
      await finirEnvoi(id, { statut: 'erreur', message: e.message });
      if (dire) await dire(`❌ Ça n'a pas marché : ${e.message}`).catch(() => {});
    });
  return id;
}

// ─── Travail en arrière-plan ──────────────────────────────────
async function traiter(s, cle, radio) {
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), 'radio-'));
  try {
    let fichier, titre = null, auteur = null;
    if (s.source === 'youtube') {
      let dl;
      try {
        dl = await telechargerYoutube(s.lien, dossier);
      } catch (e) {
        // Le clip est quand même rangé, même si le son n'a pas pu être récupéré
        const info = await infosYoutube(s.youtubeId).catch(() => ({}));
        await enregistrerClip({ youtubeId: s.youtubeId, lien: s.lien, titre: info.titre, auteur: info.auteur, radio: cle }).catch(() => {});
        throw new Error(`${expliquerErreurYoutube(e.message)}\n\n🎬 Le clip est quand même dans l'onglet « Clips ». Pour la radio, envoie-moi le fichier audio.`);
      }
      fichier = dl.fichier; titre = dl.titre; auteur = dl.auteur;
      await enregistrerClip({ youtubeId: s.youtubeId, lien: s.lien, titre, auteur, radio: cle });
    } else {
      const ext = s.filename && EXT_AUDIO.test(s.filename) ? s.filename.split('.').pop().toLowerCase() : extDepuisMime(s.mime);
      const nom = nomFichierPropre(s.filename || `Musique WhatsApp ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h')}`, ext);
      fichier = path.join(dossier, nom);
      await fs.writeFile(fichier, await telechargerMediaWhatsApp(s.mediaId));
      titre = nom.replace(EXT_AUDIO, '');
    }
    const chemin = await envoyerSurAzuracast(radio.id, fichier);
    const playlist = await ajouterALaPlaylist(radio.id, chemin);
    return { titre: titre || path.basename(chemin).replace(EXT_AUDIO, ''), auteur, playlist };
  } finally {
    await fs.rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}

function expliquerErreurYoutube(msg) {
  const m = String(msg || '');
  if (/sign in to confirm|not a bot|429|too many requests/i.test(m)) return 'YouTube a bloqué le téléchargement depuis le serveur (il croit que c\'est un robot).';
  if (/private|unavailable|removed|copyright/i.test(m)) return 'Cette vidéo n\'est pas disponible (privée ou supprimée).';
  if (/duration|max-filesize|too (long|large)/i.test(m)) return 'Cette vidéo est trop longue ou trop lourde pour la radio.';
  return `Je n'ai pas pu récupérer le son de YouTube (${m.split('\n').filter(Boolean).pop() || 'erreur inconnue'}).`;
}

// ─── WhatsApp : récupérer le fichier envoyé ───────────────────
async function telechargerMediaWhatsApp(mediaId) {
  const info = await (await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } })).json();
  if (!info.url) throw new Error('fichier introuvable sur WhatsApp');
  const r = await fetch(info.url, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } });
  if (!r.ok) throw new Error(`téléchargement WhatsApp impossible (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// ─── YouTube (yt-dlp) ─────────────────────────────────────────
function lancer(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message = `${String(stderr || '').trim() || err.message}`; return reject(err); }
      resolve(String(stdout));
    });
  });
}
let ytdlpPret = null;
function ytdlp() {
  if (process.env.YTDLP_PATH) return Promise.resolve(process.env.YTDLP_PATH);
  if (!ytdlpPret) {
    ytdlpPret = (async () => {
      const dest = path.join(os.tmpdir(), 'yt-dlp');
      try { await fs.access(dest); return dest; } catch (e) { /* à télécharger */ }
      const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', { redirect: 'follow' });
      if (!r.ok) throw new Error(`installation de yt-dlp impossible (HTTP ${r.status})`);
      await fs.writeFile(dest + '.tmp', Buffer.from(await r.arrayBuffer()));
      await fs.chmod(dest + '.tmp', 0o755);
      await fs.rename(dest + '.tmp', dest);
      return dest;
    })().catch((e) => { ytdlpPret = null; throw e; });
  }
  return ytdlpPret;
}
function cheminFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch (e) { return null; }
}
async function argsCommuns(dossier) {
  const args = ['--no-playlist', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github'];
  if (process.env.YTDLP_COOKIES) {
    const c = path.join(dossier, 'cookies.txt');
    await fs.writeFile(c, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'));
    args.push('--cookies', c);
  }
  return args;
}
async function telechargerYoutube(lien, dossier) {
  const bin = await ytdlp();
  const ffmpeg = cheminFfmpeg();
  const args = [
    ...(await argsCommuns(dossier)),
    '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
    '--embed-metadata', '--match-filter', 'duration < 10800', '--max-filesize', '400M',
    ...(ffmpeg ? ['--ffmpeg-location', ffmpeg] : []),
    '-o', path.join(dossier, '%(title).100B.%(ext)s'),
    '--no-simulate',
    '--print', 'before_dl:INFO\t%(title)s\t%(uploader)s',
    '--print', 'after_move:FILE\t%(filepath)s',
    lien
  ];
  let out;
  try {
    out = await lancer(bin, args, 15 * 60 * 1000);
  } catch (e) {
    // Ancienne version de yt-dlp sans ces options : on réessaie sans elles
    if (/no such option|unrecognized arguments/i.test(e.message)) {
      const sans = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--js-runtimes' || args[i] === '--remote-components') { i++; continue; }
        sans.push(args[i]);
      }
      out = await lancer(bin, sans, 15 * 60 * 1000);
    } else throw e;
  }
  let titre = null, auteur = null, fichier = null;
  for (const ligne of out.split('\n')) {
    const [type, a, b] = ligne.split('\t');
    if (type === 'INFO') { titre = a && a !== 'NA' ? a : null; auteur = b && b !== 'NA' ? b : null; }
    if (type === 'FILE' && a) fichier = a.trim();
  }
  if (!fichier) {
    const mp3 = (await fs.readdir(dossier)).find((f) => /\.mp3$/i.test(f));
    if (!mp3) throw new Error('aucun fichier audio produit (vidéo trop longue ?)');
    fichier = path.join(dossier, mp3);
  }
  return { fichier, titre, auteur };
}
// Titre et chaîne d'un clip, sans rien télécharger (page oEmbed de YouTube)
async function infosYoutube(yid) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yid}`)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return {};
  const d = await r.json();
  return { titre: d.title || null, auteur: d.author_name || null };
}

// ─── AzuraCast ────────────────────────────────────────────────
async function azura(methode, chemin, corps, enTetes) {
  const r = await fetch(`${azuraUrl()}/api${chemin}`, {
    method: methode,
    headers: { 'X-API-Key': process.env.AZURACAST_API_KEY, Accept: 'application/json', ...(enTetes || {}) },
    body: corps
  });
  const texte = await r.text();
  let json = null; try { json = JSON.parse(texte); } catch (e) { /* pas du JSON */ }
  if (!r.ok || (json && json.success === false)) {
    const msg = (json && (json.formatted_message || json.message)) || `HTTP ${r.status}`;
    throw new Error(r.status === 401 || r.status === 403 ? 'la clé API AzuraCast est refusée (vérifie AZURACAST_API_KEY)' : `AzuraCast : ${msg}`);
  }
  return json;
}
async function envoyerSurAzuracast(stationId, fichier) {
  const data = await fs.readFile(fichier);
  const nom = path.basename(fichier);
  const total = Math.max(1, Math.ceil(data.length / CHUNK));
  const identifiant = `${data.length}-${nom.replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}`;
  for (let i = 0; i < total; i++) {
    const morceau = data.subarray(i * CHUNK, Math.min(data.length, (i + 1) * CHUNK));
    const form = new FormData();
    form.append('flowChunkNumber', String(i + 1));
    form.append('flowChunkSize', String(CHUNK));
    form.append('flowCurrentChunkSize', String(morceau.length));
    form.append('flowTotalSize', String(data.length));
    form.append('flowIdentifier', identifiant);
    form.append('flowFilename', nom);
    form.append('flowRelativePath', nom);
    form.append('flowTotalChunks', String(total));
    form.append('currentDirectory', '');
    form.append('file_data', new Blob([morceau], { type: 'application/octet-stream' }), nom);
    await azura('POST', `/station/${stationId}/files/upload`, form);
  }
  return nom;
}
async function choisirPlaylist(stationId) {
  const listes = (await azura('GET', `/station/${stationId}/playlists`)) || [];
  const candidates = listes.filter((p) => p.is_enabled !== false && (!p.type || p.type === 'default') && (!p.source || p.source === 'songs') && !p.is_jingle);
  candidates.sort((a, b) => (b.num_songs || 0) - (a.num_songs || 0));
  return candidates[0] || null;
}
async function ajouterALaPlaylist(stationId, chemin) {
  const p = await choisirPlaylist(stationId);
  if (!p) return null; // la musique est dans la bibliothèque, mais aucune liste trouvée
  await azura('PUT', `/station/${stationId}/files/batch`, JSON.stringify({ do: 'playlist', playlists: [String(p.id)], files: [chemin], dirs: [] }), { 'Content-Type': 'application/json' });
  return p.name;
}

// ─── Routes ───────────────────────────────────────────────────
function routes() {
  const app = ctx.app;
  // Public : liste des clips pour l'onglet « Clips » de la radio
  app.get('/radio/clips', async (req, res) => {
    try {
      const r = await ctx.pool.query('SELECT id, youtube_id, titre, auteur, lien, radio, created_at FROM radio_clips ORDER BY created_at DESC LIMIT 200');
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ok: true, clips: r.rows.map((c) => ({ ...c, miniature: `https://i.ytimg.com/vi/${c.youtube_id}/hqdefault.jpg` })) });
    } catch (e) { res.status(500).json({ ok: false }); }
  });
  const okPw = (req) => ((req.query && req.query.password) || (req.body && req.body.password)) === ctx.adminPassword;
  async function supprimerClip(req, res) {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    await ctx.pool.query('DELETE FROM radio_clips WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }
  app.delete('/admin/radio/clips/:id', supprimerClip);
  app.post('/admin/radio/clips/:id/supprimer', supprimerClip);

  // Page admin « Radio » : état du branchement, historique, clips
  app.get('/admin/radio', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    const r = radios();
    let branche = { ok: false, message: 'La variable AZURACAST_API_KEY n\'est pas encore ajoutée sur Railway.' };
    if (process.env.AZURACAST_API_KEY) {
      try { await azura('GET', `/station/${r.hayous.id}/playlists`); branche = { ok: true, message: `Branchée sur ${azuraUrl().replace(/^https?:\/\//, '')}` }; }
      catch (e) { branche = { ok: false, message: e.message }; }
    }
    try {
      const envois = await ctx.pool.query('SELECT * FROM radio_envois ORDER BY created_at DESC LIMIT 60');
      const clips = await ctx.pool.query('SELECT * FROM radio_clips ORDER BY created_at DESC LIMIT 200');
      res.json({ ok: true, branche, radios: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.nom])),
        envois: envois.rows, clips: clips.rows.map((c) => ({ ...c, miniature: `https://i.ytimg.com/vi/${c.youtube_id}/mqdefault.jpg` })) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  // Coller un lien YouTube depuis l'ordinateur
  app.post('/admin/radio/lien', async (req, res) => {
    if (!okPw(req)) return res.status(401).json({ ok: false });
    const yid = youtubeId(req.body && req.body.lien);
    const cle = String((req.body && req.body.radio) || '');
    if (!yid) return res.json({ ok: false, message: 'Ce n\'est pas un lien YouTube.' });
    const s = { source: 'youtube', youtubeId: yid, lien: `https://www.youtube.com/watch?v=${yid}` };
    if (cle === 'clip') {
      const info = await infosYoutube(yid).catch(() => ({}));
      await enregistrerClip({ youtubeId: yid, lien: s.lien, titre: info.titre, auteur: info.auteur });
      return res.json({ ok: true, message: `Clip ajouté${info.titre ? ' : ' + info.titre : ''}` });
    }
    if (!radios()[cle]) return res.json({ ok: false, message: 'Choisis une radio.' });
    if (!process.env.AZURACAST_API_KEY) return res.json({ ok: false, message: 'La radio n\'est pas encore branchée (AZURACAST_API_KEY).' });
    const id = await lancerEnvoi(s, cle, 'admin', null);
    res.json({ ok: true, id, message: `C'est parti pour ${radios()[cle].nom} (1 à 2 minutes).` });
  });
}

function init(options) {
  ctx = options;
  creerTables().catch((e) => console.error('Radio — tables :', e.message));
  routes();
  // On prépare yt-dlp à l'avance pour que le premier lien aille vite
  if (process.env.AZURACAST_API_KEY) setTimeout(() => ytdlp().catch((e) => console.error('Radio — yt-dlp :', e.message)), 20000).unref();
  console.log('Radio (WhatsApp → AzuraCast) prête');
  return { handleText, handleMedia, handleBouton };
}

module.exports = { init, _test: { youtubeId, nomFichierPropre, estFichierAudio, choixDepuisTexte, envoyerSurAzuracast, ajouterALaPlaylist, choisirPlaylist, sessions, setCtx: (c) => { ctx = c; } } };
