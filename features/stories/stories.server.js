'use strict';
const { randomUUID } = require('node:crypto');

function paris(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: +parts.hour * 60 + +parts.minute };
}
function due(now, sunset) {
  const p = paris(now);
  return new Date(p.date + 'T12:00:00Z').getUTCDay() === 6 && p.minute >= 1230 && p.minute <= 1260 && Number.isFinite(sunset) && p.minute > sunset;
}
const MODES = ['music', 'image', 'reminder'];
function effectiveMode(settings) { return settings.next_mode || settings.mode || 'music'; }
function choose(clips, previous) { return clips.find(c => c.id !== previous) || null; }
function parseButton(value) {
  const m = /^st_(approve|change|cancel)_([a-f0-9-]{36})_(\d+)$/.exec(value || '');
  return m && { action: m[1], id: m[2], revision: +m[3] };
}
function init({ app, pool, isAdmin, adminPhone, adminPassword, whatsappToken, phoneNumberId, publicBaseUrl, downloadMedia, getMeta, isHolyTime, envoyerEmail, env = process.env, fetcher = fetch }) {
  const version = env.STORIES_GRAPH_VERSION || 'v25.0';
  let ready;
  const ensureDB = () => ready ||= pool.query(`CREATE TABLE IF NOT EXISTS story_clips (id UUID PRIMARY KEY, title TEXT NOT NULL, media_id UUID NOT NULL, rights_note TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE IF NOT EXISTS story_media (id UUID PRIMARY KEY, data BYTEA NOT NULL, mime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS story_drafts (id UUID PRIMARY KEY, slot TEXT UNIQUE, clip_id UUID, media_id UUID NOT NULL, owner TEXT NOT NULL, revision INT NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'preview', results JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS story_settings (id INT PRIMARY KEY DEFAULT 1, enabled BOOLEAN NOT NULL DEFAULT FALSE, cover UUID);
    ALTER TABLE story_settings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'music';
    ALTER TABLE story_settings ADD COLUMN IF NOT EXISTS next_mode TEXT;
    ALTER TABLE story_drafts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'story';
    ALTER TABLE story_drafts ALTER COLUMN media_id DROP NOT NULL;
    INSERT INTO story_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS story_sessions (phone TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`).catch(e => { ready = null; throw e; });
  async function api(path, body, token) {
    const r = await fetcher(`https://graph.facebook.com/${version}/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error('Meta refuse la requête (code ' + (d.error?.code || r.status) + ')');
    return d;
  }
  const wa = async (to, body) => {
    const d = await api(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', to, ...body }, whatsappToken);
    if (!d.messages?.[0]?.id) throw new Error('Notification WhatsApp non acceptée');
    return d;
  };
  const text = (to, body) => wa(to, { type: 'text', text: { body } });
  const url = id => `${publicBaseUrl.replace(/\/$/, '')}/stories/media/${id}`;
  async function preview(row) {
    await wa(row.owner, { type: 'video', video: { link: url(row.media_id), caption: 'Aperçu du statut avec son nigoun. À partager manuellement pour le statut WhatsApp.' } });
    await wa(row.owner, { type: 'interactive', interactive: { type: 'button', body: { text: 'Publier cette version en story Instagram et Facebook ?' }, action: { buttons: ['approve', ...(row.clip_id ? ['change'] : []), 'cancel'].map(action => ({ type: 'reply', reply: { id: `st_${action}_${row.id}_${row.revision}`, title: { approve: '✅ Valider', change: '🎵 Autre nigoun', cancel: '❌ Annuler' }[action] } })) } } });
  }
  async function createDraft(owner, media, clip = null, slot = null, kind = 'story') {
    const r = await pool.query('INSERT INTO story_drafts(id,slot,clip_id,media_id,owner,kind,status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(slot) DO NOTHING RETURNING *', [randomUUID(), slot, clip, media, owner, kind, kind === 'reminder' ? 'reminder' : 'preview']);
    return r.rows[0];
  }
  async function handleText(from, value) {
    if (!isAdmin(from)) return false;
    if (!/^(statu|statut|statuts|stories)( annuler| nouveau)?$/i.test(value.trim())) return false;
    await ensureDB();
    if (/annuler$/i.test(value)) {
      await pool.query('DELETE FROM story_sessions WHERE phone=$1', [from]);
      await text(from, 'Préparation du statut annulée.');
    } else {
      const reminder = !/nouveau$/i.test(value) && (await pool.query("SELECT * FROM story_drafts WHERE owner=$1 AND kind='reminder' AND created_at>NOW()-INTERVAL '12 hours' ORDER BY created_at DESC LIMIT 1",[from])).rows[0];
      if (reminder) {
        await text(from, '🔔 Rappel : pense à ton statut Chavoua Tov et au minyan de dimanche à 9h00. Ce rappel ne programme aucune publication. Pour préparer un statut, écris « statu nouveau ».');
        return true;
      }
      const pending = await pool.query("SELECT * FROM story_drafts WHERE owner=$1 AND status='preview' AND created_at>NOW()-INTERVAL '12 hours' ORDER BY created_at DESC LIMIT 1", [from]);
      if (pending.rows[0]) {
        const mime = (await pool.query('SELECT mime FROM story_media WHERE id=$1', [pending.rows[0].media_id])).rows[0]?.mime;
        if (mime === 'image/jpeg') await imagePreview(pending.rows[0]); else await preview(pending.rows[0]);
      }
      else {
        await pool.query('INSERT INTO story_sessions(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET created_at=NOW()', [from]);
        await text(from, 'Envoie une vidéo MP4 avec son nigoun, ou une image pour une story sans musique. Tu recevras un aperçu avant publication.');
      }
    }
    return true;
  }
  async function handleMedia(from, message) {
    if (!isAdmin(from)) return false;
    await ensureDB();
    const session = await pool.query("DELETE FROM story_sessions WHERE phone=$1 AND created_at>NOW()-INTERVAL '1 hour' RETURNING phone", [from]);
    if (!session.rows.length) return false;
    try {
      const media = message.video || message.image;
      if (!media) return false;
      const file = await downloadMedia(media.id);
      if (!['video/mp4', 'image/jpeg', 'image/png'].includes(file.mimeType) || file.buffer.length > 20 * 1024 * 1024) throw new Error('Utilise un MP4 ou une image de moins de 20 Mo.');
      let data = file.buffer, mime = file.mimeType;
      if (mime !== 'video/mp4') { data = await require('sharp')(data).rotate().jpeg().toBuffer(); mime = 'image/jpeg'; }
      const id = randomUUID();
      await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)', [id, data, mime]);
      const row = await createDraft(from, id);
      if (mime === 'image/jpeg') await imagePreview(row); else await preview(row);
    } catch (e) { await text(from, e.message); }
    return true;
  }
  async function imagePreview(row) {
    await wa(row.owner, { type: 'image', image: { link: url(row.media_id), caption: 'Story sans musique' } });
    await wa(row.owner, { type: 'interactive', interactive: { type: 'button', body: { text: 'Publier cette image en story Instagram et Facebook ?' }, action: { buttons: ['approve', 'cancel'].map(action => ({ type: 'reply', reply: { id: `st_${action}_${row.id}_${row.revision}`, title: action === 'approve' ? '✅ Valider' : '❌ Annuler' } })) } } });
  }
  async function handleButton(from, value) {
    const b = parseButton(value);
    if (!b || !isAdmin(from)) return;
    if (b.action === 'approve' && isHolyTime && await isHolyTime(new Date())) return text(from, 'Publication reportée : Chabbat ou Yom Tov. Reviens après la sortie.');
    await ensureDB();
    // Atomic claim: duplicate clicks or old previews cannot publish twice.
    const claimed = await pool.query("UPDATE story_drafts SET status='busy' WHERE id=$1 AND owner=$2 AND revision=$3 AND status='preview' AND created_at>NOW()-INTERVAL '12 hours' RETURNING *", [b.id, from, b.revision]);
    const row = claimed.rows[0];
    if (!row) return text(from, 'Cet aperçu a expiré ou a déjà été traité.');
    try {
      if (row.kind === 'reminder') throw new Error('Ce rappel ne permet aucune publication.');
      if (row.slot && row.slot !== paris().date && b.action !== 'cancel') throw new Error('Cet aperçu du samedi a expiré. Prépare un nouveau statut.');
      if (b.action === 'cancel') { await pool.query("UPDATE story_drafts SET status='cancelled' WHERE id=$1", [row.id]); return text(from, 'Publication annulée.'); }
      if (b.action === 'change') {
        const clips = (await pool.query('SELECT * FROM story_clips WHERE enabled ORDER BY id')).rows;
        const clip = choose(clips, row.clip_id);
        if (!clip) throw new Error('Il faut un autre nigoun autorisé dans la sélection.');
        const updated = await pool.query("UPDATE story_drafts SET status='preview',clip_id=$2,media_id=$3,revision=revision+1 WHERE id=$1 RETURNING *", [row.id, clip.id, clip.media_id]);
        return await preview(updated.rows[0]);
      }
      const cfg = getMeta ? await getMeta() : { pageToken: env.STORIES_META_TOKEN || env.META_PAGE_TOKEN, igId: env.STORIES_INSTAGRAM_ID, pageId: env.STORIES_FACEBOOK_PAGE_ID };
      if (!cfg.pageToken || !cfg.igId || !cfg.pageId) throw new Error('Les accès stories Instagram/Facebook restent à configurer.');
      const meta = (path, body) => api(path, body, cfg.pageToken);
      const mime = (await pool.query('SELECT mime FROM story_media WHERE id=$1', [row.media_id])).rows[0].mime;
      const video = mime === 'video/mp4';
      const results = row.results;
      for (const network of ['instagram', 'facebook']) {
        // Persist BEFORE external calls. Ambiguous results require manual reconciliation, never automatic re-publication.
        results[network] = { status: 'in_progress' };
        await pool.query('UPDATE story_drafts SET results=$2 WHERE id=$1', [row.id, JSON.stringify(results)]);
        try {
          if (network === 'instagram') {
            const c = await meta(`${cfg.igId}/media`, { media_type: 'STORIES', [video ? 'video_url' : 'image_url']: url(row.media_id) });
            let finished = false;
            for (let i = 0; i < 24; i++) {
              const s = await meta(`${c.id}?fields=status_code`);
              if (s.status_code === 'FINISHED') { finished = true; break; }
              if (['ERROR', 'EXPIRED'].includes(s.status_code)) throw new Error('Traitement Instagram échoué');
              await new Promise(resolve => setTimeout(resolve, 2500));
            }
            if (!finished) throw new Error('Traitement Instagram toujours en cours');
            const p = await meta(`${cfg.igId}/media_publish`, { creation_id: c.id });
            if (!p.id) throw new Error('Confirmation Instagram absente');
            results[network] = { status: 'accepted', id: p.id };
          } else if (video) {
            const start = await meta(`${cfg.pageId}/video_stories`, { upload_phase: 'start' });
            if (!start.video_id || !start.upload_url || new URL(start.upload_url).hostname !== 'rupload.facebook.com') throw new Error('Session vidéo Facebook invalide');
            const upload = await fetcher(start.upload_url, { method: 'POST', headers: { Authorization: 'OAuth ' + cfg.pageToken, file_url: url(row.media_id) }, signal: AbortSignal.timeout(30000) });
            const u = await upload.json();
            if (!upload.ok || !u.success) throw new Error('Transfert Facebook refusé');
            const p = await meta(`${cfg.pageId}/video_stories`, { upload_phase: 'finish', video_id: start.video_id });
            if (!p.success) throw new Error('Confirmation Facebook absente');
            results[network] = { status: 'accepted', id: start.video_id };
          } else {
            const photo = await meta(`${cfg.pageId}/photos`, { url: url(row.media_id), published: false });
            const p = await meta(`${cfg.pageId}/photo_stories`, { photo_id: photo.id });
            if (!p.success) throw new Error('Confirmation Facebook absente');
            results[network] = { status: 'accepted', id: p.post_id };
          }
        } catch (e) { results[network] = { status: 'check_required', error: e.message }; }
        await pool.query('UPDATE story_drafts SET results=$2 WHERE id=$1', [row.id, JSON.stringify(results)]);
      }
      await pool.query("UPDATE story_drafts SET status='processed' WHERE id=$1", [row.id]);
      await text(from, ['instagram', 'facebook'].map(n => `${n} : ${results[n].status === 'accepted' ? 'accepté par Meta' : 'à vérifier, aucun nouvel essai automatique'}`).join('\n') + '\nPour WhatsApp, partage l’aperçu manuellement dans ton statut.');
    } catch (e) {
      await pool.query("UPDATE story_drafts SET status=$2 WHERE id=$1", [row.id, b.action === 'approve' && Object.keys(row.results).length ? 'check_required' : 'preview']);
      await text(from, e.message);
    }
  }
  async function selectMedia(mode, settings) {
    if (mode === 'reminder') return {media:null,clip:null};
    if (!settings.cover) throw new Error('Visuel du samedi manquant');
    if (mode === 'image') return {media:settings.cover,clip:null};
    const clips = (await pool.query('SELECT * FROM story_clips WHERE enabled ORDER BY id')).rows;
    const previous = (await pool.query("SELECT clip_id FROM story_drafts WHERE slot IS NOT NULL AND clip_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0]?.clip_id;
    const clip = choose(clips, previous);
    if (!clip || clips.length < 2) throw new Error('Deux nigounim sont nécessaires pour la rotation');
    return {media:clip.media_id,clip:clip.id};
  }
  async function notify(mode) {
    const reminder = mode === 'reminder';
    const name = reminder ? (env.STORIES_REMINDER_TEMPLATE || 'shliah_stories_rappel') : (env.STORIES_WHATSAPP_TEMPLATE || 'shliah_stories_admin');
    try {
      await wa(adminPhone,{type:'template',template:{name,language:{code:'fr'}}});
      return true;
    } catch (_) {
      if (envoyerEmail) await envoyerEmail({to:'bhsmaurice@gmail.com',subject:reminder?'Rappel — statut du samedi soir':'Story Chavoua Tov à valider',html:reminder?'<p>Rappel demandé : pensez à votre statut Chavoua Tov et au minyan de dimanche à 9h00. Aucune publication programmée par ce rappel.</p>':'<p>Votre story est prête. Écrivez « statu » au bot pour consulter l’aperçu et valider. La notification WhatsApp n’a pas été acceptée.</p>'});
      return false;
    }
  }
  let running = false;
  async function tick(now = new Date()) {
    if (running) return;
    running = true;
    try {
      await ensureDB();
      const p = paris(now);
      const settings = (await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
      if (!settings?.enabled) return;
      if (new Date(p.date + 'T12:00:00Z').getUTCDay() !== 6 || p.minute < 1230 || p.minute > 1260) return;
      if (!isHolyTime || await isHolyTime(now)) return;
      const mode = effectiveMode(settings);
      const selected = await selectMedia(mode, settings);
      const row = await createDraft(adminPhone, selected.media, selected.clip, p.date, mode === 'reminder' ? 'reminder' : 'story');
      if (!row) return;
      if (settings.next_mode) await pool.query('UPDATE story_settings SET next_mode=NULL WHERE id=1 AND next_mode=$1',[settings.next_mode]);
      await notify(mode);
      // User replies “statu” to receive the video and approval buttons inside the messaging window.
    } finally { running = false; }
  }
  const wrap = f => (req, res) => Promise.resolve(f(req, res)).catch(() => res.status(500).json({ ok: false, error: 'Opération stories impossible' }));
  const auth = (req, res, next) => req.get('X-Admin-Password') === adminPassword ? next() : res.sendStatus(401);
  app.get('/stories/media/:id', wrap(async (req, res) => {
    await ensureDB();
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
    const row = (await pool.query('SELECT * FROM story_media WHERE id=$1', [req.params.id])).rows[0];
    if (!row) return res.sendStatus(404);
    res.set('Cache-Control','public, max-age=3600').set('Accept-Ranges','bytes').type(row.mime);
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    if (range) {
      const start=Number(range[1]), end=range[2]?Math.min(Number(range[2]),row.data.length-1):row.data.length-1;
      if (start>end || start>=row.data.length) return res.status(416).set('Content-Range','bytes */'+row.data.length).end();
      return res.status(206).set('Content-Range',`bytes ${start}-${end}/${row.data.length}`).send(row.data.subarray(start,end+1));
    }
    res.send(row.data);
  }));
  app.post('/admin/stories/clips', auth, wrap(async (req, res) => {
    await ensureDB();
    const { title, mp4_base64, rights_note } = req.body;
    if (!title || !rights_note || typeof mp4_base64 !== 'string' || mp4_base64.length > 12000000) return res.status(400).json({ ok: false });
    const data = Buffer.from(mp4_base64, 'base64');
    if (data.subarray(4, 8).toString() !== 'ftyp') return res.status(400).json({ ok: false, error: 'MP4 requis' });
    const media = randomUUID(), id = randomUUID();
    await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)', [media, data, 'video/mp4']);
    await pool.query('INSERT INTO story_clips(id,title,media_id,rights_note) VALUES($1,$2,$3,$4)', [id, title, media, rights_note]);
    res.json({ ok: true, id });
  }));
  app.get('/admin/stories', (_req,res) => res.sendFile(require('node:path').join(__dirname, 'stories.admin.html')));
  async function importPublic(source, limit = 20*1024*1024) {
    let u; try { u = new URL(source); } catch (_) { throw new Error('Lien HTTPS requis'); }
    const allowed = ['oaiusercontent.com','githubusercontent.com','wikimedia.org','chabad.org'];
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !allowed.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) throw new Error('Hébergeur de média non autorisé');
    const r = await fetcher(u.href, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!r.ok || +r.headers.get('content-length') > limit) throw new Error('Média indisponible ou trop volumineux');
    const chunks = []; let total = 0;
    for await (const chunk of r.body) { total += chunk.length; if (total > limit) { throw new Error('Média trop volumineux'); } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  app.post('/admin/stories/cover', auth, wrap(async (req,res) => {
    await ensureDB();
    const data = await require('sharp')(await importPublic(req.body.source)).rotate().resize(1080,1920,{fit:'contain',background:'white'}).jpeg({quality:92}).toBuffer();
    const id = randomUUID();
    await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[id,data,'image/jpeg']);
    await pool.query('UPDATE story_settings SET cover=$1 WHERE id=1',[id]);
    res.json({ok:true,message:'Visuel du samedi enregistré.'});
  }));
  app.post('/admin/stories/import-clip', auth, wrap(async(req,res)=>{
    await ensureDB();
    if (!req.body.title || !req.body.rights_note) return res.status(400).json({error:'Titre et autorisation nécessaires'});
    const data = await importPublic(req.body.source);
    if (data.subarray(4,8).toString() !== 'ftyp') return res.status(400).json({error:'Clip MP4 requis'});
    const id = randomUUID(), media = randomUUID();
    await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[media,data,'video/mp4']);
    await pool.query('INSERT INTO story_clips(id,title,media_id,rights_note) VALUES($1,$2,$3,$4)',[id,req.body.title,media,req.body.rights_note]);
    res.json({ok:true,message:'Nigoun ajouté à la rotation.'});
  }));
  const licensedTracks = [
    { id: 'a13c774a-cbe9-4f17-b826-cd77ce599001', title:'Nigoun du Baal Chem Tov', author:'Nizzan Zvi Cohen', source:'https://upload.wikimedia.org/wikipedia/commons/7/79/Niggun_Habaal_Shem_Tov.ogg', page:'https://commons.wikimedia.org/wiki/File:Niggun_Habaal_Shem_Tov.ogg', license:'https://creativecommons.org/licenses/by/4.0/', short:'CC BY 4.0', start:5 },
    { id: 'a13c774a-cbe9-4f17-b826-cd77ce599002', title:'Nigoun Hitkachrout', author:'Rabbi Yitzchak Ginsburgh', source:'https://upload.wikimedia.org/wikipedia/commons/f/f3/Niggun_hitkashrut.wav', page:'https://commons.wikimedia.org/wiki/File:Niggun_hitkashrut.wav', license:'https://creativecommons.org/licenses/by-sa/4.0/', short:'CC BY-SA 4.0', start:15 }
  ];
  app.get('/stories/credits',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><title>Crédits des nigounim</title><h1>Crédits des nigounim</h1>'+licensedTracks.map(t=>'<p>'+t.title+' — '+t.author+'. <a href="'+t.page+'">Enregistrement source</a> · <a href="'+t.license+'">'+t.short+'</a>. Extrait de 15 secondes avec fondus, intégré au visuel Chavoua Tov. La vidéo adaptée est distribuée sous '+t.short+'. Aucune approbation de notre communication par les interprètes n’est suggérée.</p>').join('')));
  let preparing = false;
  app.post('/admin/stories/prepare-music', auth, wrap(async(_req,res)=>{
    await ensureDB();
    if (preparing) return res.status(409).json({error:'Préparation déjà en cours'});
    const settings=(await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    if (!settings.cover) return res.status(409).json({error:'Enregistrer le visuel avant les nigounim'});
    preparing=true;
    const fs=require('node:fs/promises'), path=require('node:path');
    const folder=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'shliah-nigoun-'));
    try {
      const cover=(await pool.query('SELECT data FROM story_media WHERE id=$1',[settings.cover])).rows[0].data;
      for (const track of licensedTracks) {
        if ((await pool.query('SELECT id FROM story_clips WHERE id=$1',[track.id])).rows.length) continue;
        const sharp=require('sharp');
        const base=await sharp(cover).resize(1080,1800,{fit:'contain',background:'white'}).extend({bottom:120,top:0,left:0,right:0,background:'white'}).toBuffer();
        const footer=Buffer.from('<svg width="1080" height="120"><rect width="1080" height="120" fill="white"/><g font-family="sans-serif" font-size="22" fill="#52617a" text-anchor="middle"><text x="540" y="30">'+track.title+' — '+track.author+'</text><text x="540" y="60">Extrait avec fondus · Adaptation '+track.short+'</text><text x="540" y="92">'+track.license+'</text></g></svg>');
        const image=path.join(folder,'cover.png'), audio=path.join(folder,'audio'), output=path.join(folder,'clip.mp4');
        await fs.writeFile(image,await sharp(base).composite([{input:footer,left:0,top:1800}]).png().toBuffer());
        await fs.writeFile(audio,await importPublic(track.source,60*1024*1024));
        await require('./render-clip').renderClip(image,audio,output,track.start);
        const data=await fs.readFile(output), media=randomUUID();
        await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[media,data,'video/mp4']);
        await pool.query('INSERT INTO story_clips(id,title,media_id,rights_note) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[track.id,track.title,media,track.page+' | '+track.author+' | '+track.license+' | extrait et fondus ; vidéo adaptée sous '+track.short]);
      }
      res.json({ok:true,message:'Deux nigounim préparés avec crédits, prêts pour votre aperçu.'});
    } finally { preparing=false; await fs.rm(folder,{recursive:true,force:true}); }
  }));
  app.post('/admin/stories/settings', auth, wrap(async(req,res)=>{
    await ensureDB();
    const current = (await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    const {enabled=current.enabled,mode=current.mode||'music',next_mode=current.next_mode||null} = req.body;
    if (typeof enabled !== 'boolean' || !MODES.includes(mode) || (next_mode !== null && !MODES.includes(next_mode))) return res.status(400).json({error:'Choix invalide'});
    if (enabled) {
      const settings={...current,mode,next_mode};
      const modes=new Set([mode,next_mode].filter(Boolean));
      if ([...modes].some(m=>m!=='reminder') && !settings.cover) return res.status(409).json({error:'Il manque le visuel du samedi.'});
      if (modes.has('music')) {
        const count=(await pool.query('SELECT COUNT(*)::int AS n FROM story_clips WHERE enabled')).rows[0].n;
        if(count<2)return res.status(409).json({error:'Il manque deux clips de nigounim.'});
      }
      if ([...modes].some(m=>m!=='reminder')) {
        const cfg=await getMeta();
        if(!cfg.pageToken||!cfg.igId)return res.status(409).json({error:'Connexion Instagram/Facebook incomplète'});
      }
    }
    await pool.query('UPDATE story_settings SET enabled=$1,mode=$2,next_mode=$3 WHERE id=1',[enabled,mode,next_mode]);
    res.json({ok:true,message:enabled?'Préférences enregistrées. Aucune publication sans validation.':'Rendez-vous du samedi en pause.'});
  }));
  app.post('/admin/stories/preview-test', auth, wrap(async(_req,res)=>{
    await ensureDB();
    const settings=(await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    const mode=effectiveMode(settings),selected=await selectMedia(mode,settings);
    const row=await createDraft(adminPhone,selected.media,selected.clip,null,mode==='reminder'?'reminder':'story');
    const notificationAccepted=await notify(mode);
    res.json({ok:true,message:mode==='reminder'?'Rappel de test créé. Aucune publication ni aperçu à valider.':'Aperçu créé. Répondez « statu » au bot. Aucune publication effectuée.',notificationAccepted,id:row.id});
  }));
  app.post('/admin/stories/notify-test', auth, wrap(async(_req,res)=>{
    await ensureDB();
    const settings=(await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    const accepted=await notify(effectiveMode(settings));
    if(!accepted)return res.status(409).json({error:'Modèle WhatsApp non accepté ; email de secours prévu.'});
    res.json({ok:true,message:'Notification acceptée par WhatsApp. Aucune story publiée.'});
  }));
  app.get('/admin/stories/status', auth, wrap(async (req, res) => {
    await ensureDB();
    const settings = (await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    let meta; try { const c = await getMeta(); meta = { connected: Boolean(c.pageToken), facebook: c.pageName, instagram: Boolean(c.igId) }; } catch (_) { meta = { connected: false }; }
    res.json({ enabled: settings?.enabled, mode:settings?.mode||'music',next_mode:settings?.next_mode||null, cover: Boolean(settings?.cover), coverUrl: settings?.cover ? url(settings.cover) : null, meta, clips: (await pool.query('SELECT id,title,media_id FROM story_clips WHERE enabled ORDER BY id')).rows.map(c=>({id:c.id,title:c.title,url:url(c.media_id)})) });
  }));
  function start() { const timer = setInterval(() => tick().catch(() => console.error('Stories : préparation interrompue, consulter la configuration')), 60000); timer.unref(); tick().catch(() => {}); return timer; }
  return { ensureDB, start, tick, handleText, handleMedia, handleButton };
}
module.exports = { init, paris, due, choose, parseButton, effectiveMode };
