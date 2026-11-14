'use strict';
const { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const helpers = require('./stories.helpers');

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
    ALTER TABLE story_drafts ADD COLUMN IF NOT EXISTS targets JSONB NOT NULL DEFAULT '["instagram","facebook"]';
    ALTER TABLE story_settings ADD COLUMN IF NOT EXISTS targets JSONB NOT NULL DEFAULT '["instagram","facebook"]';
    CREATE TABLE IF NOT EXISTS story_handoffs (hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS story_reminders (id UUID PRIMARY KEY, days JSONB NOT NULL, time TEXT NOT NULL, message TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE IF NOT EXISTS story_reminder_jobs (reminder_id UUID NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'claimed', PRIMARY KEY(reminder_id,date));
    INSERT INTO story_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS story_admin_activity (phone TEXT PRIMARY KEY, last_inbound TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS story_plans (id UUID PRIMARY KEY, owner TEXT NOT NULL, media_id UUID NOT NULL, days JSONB NOT NULL, time TEXT NOT NULL, mode TEXT NOT NULL, targets JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, revision INT NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS story_plan_sessions (phone TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS story_plan_jobs (plan_id UUID NOT NULL, date TEXT NOT NULL, revision INT NOT NULL, status TEXT NOT NULL DEFAULT 'claimed', PRIMARY KEY(plan_id,date,revision));
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
  function destination(row){return (row.targets||['instagram','facebook']).map(n=>n==='instagram'?'Instagram':'Facebook').join(' et ');}
  async function preview(row) {
    await wa(row.owner, { type: 'video', video: { link: url(row.media_id), caption: row.slot?.startsWith('plan:')?'Voici ton visuel programmé. Rien ne sera publié sans validation.':'Aperçu du statut avec son nigoun. À partager manuellement pour le statut WhatsApp.' } });
    if(!destination(row))return text(row.owner,'Prêt pour ton statut WhatsApp : partage le média manuellement depuis ton téléphone.');
    await wa(row.owner, { type: 'interactive', interactive: { type: 'button', body: { text: 'Publier cette version en story '+destination(row)+' ?' }, action: { buttons: ['approve', ...(row.clip_id ? ['change'] : []), 'cancel'].map(action => ({ type: 'reply', reply: { id: `st_${action}_${row.id}_${row.revision}`, title: { approve: '✅ Valider', change: '🎵 Autre nigoun', cancel: '❌ Annuler' }[action] } })) } } });
  }
  async function createDraft(owner, media, clip = null, slot = null, kind = 'story', targets = ['instagram','facebook']) {
    const r = await pool.query('INSERT INTO story_drafts(id,slot,clip_id,media_id,owner,kind,status,targets) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(slot) DO NOTHING RETURNING *', [randomUUID(), slot, clip, media, owner, kind, kind === 'reminder' ? 'reminder' : 'preview', JSON.stringify(targets)]);
    return r.rows[0];
  }
  async function handleText(from, value) {
    if (!isAdmin(from)) return false;
    if (await planner.handleText(from,value)) return true;
    if (!/^(statu|statut|statuts|stories)( annuler| nouveau)?$/i.test(value.trim())) return false;
    await ensureDB();
    if (/annuler$/i.test(value)) {
      await pool.query('DELETE FROM story_sessions WHERE phone=$1', [from]);
      await text(from, 'Préparation du statut annulée.');
    } else {
      const reminder = !/nouveau$/i.test(value) && (await pool.query("SELECT * FROM story_drafts WHERE owner=$1 AND kind='reminder' AND created_at>NOW()-INTERVAL '12 hours' ORDER BY created_at DESC LIMIT 1",[from])).rows[0];
      if (reminder && !(await pool.query("SELECT id FROM story_drafts WHERE owner=$1 AND status='preview' AND created_at>NOW()-INTERVAL '12 hours' LIMIT 1",[from])).rows.length) {
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
    if (await planner.handleMedia(from,message)) return true;
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
    if(!destination(row))return text(row.owner,'Prêt pour ton statut WhatsApp : partage le média manuellement depuis ton téléphone.');
    await wa(row.owner, { type: 'interactive', interactive: { type: 'button', body: { text: 'Publier cette image en story '+destination(row)+' ?' }, action: { buttons: ['approve', 'cancel'].map(action => ({ type: 'reply', reply: { id: `st_${action}_${row.id}_${row.revision}`, title: action === 'approve' ? '✅ Valider' : '❌ Annuler' } })) } } });
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
      if(row.slot?.startsWith('plan:') && b.action!=='cancel'){const parts=row.slot.split(':');const active=(await pool.query('SELECT id FROM story_plans WHERE id=$1 AND owner=$2 AND enabled AND revision=$3',[parts[1],from,Number(parts[3])])).rows;if(!active.length)throw new Error('Cette programmation a été arrêtée ou modifiée.');}
      if (row.kind === 'reminder') throw new Error('Ce rappel ne permet aucune publication.');
      if (row.slot && (row.slot.startsWith('plan:') ? row.slot.split(':')[2] : row.slot) !== paris().date && b.action !== 'cancel') throw new Error('Cet aperçu du samedi a expiré. Prépare un nouveau statut.');
      if (b.action === 'cancel') { await pool.query("UPDATE story_drafts SET status='cancelled' WHERE id=$1", [row.id]); return text(from, 'Publication annulée.'); }
      if (b.action === 'change') {
        const clips = (await pool.query('SELECT * FROM story_clips WHERE enabled ORDER BY id')).rows;
        const clip = choose(clips, row.clip_id);
        if (!clip) throw new Error('Il faut un autre nigoun autorisé dans la sélection.');
        const updated = await pool.query("UPDATE story_drafts SET status='preview',clip_id=$2,media_id=$3,revision=revision+1 WHERE id=$1 RETURNING *", [row.id, clip.id, clip.media_id]);
        return await preview(updated.rows[0]);
      }
      const cfg = getMeta ? await getMeta() : { pageToken: env.STORIES_META_TOKEN || env.META_PAGE_TOKEN, igId: env.STORIES_INSTAGRAM_ID, pageId: env.STORIES_FACEBOOK_PAGE_ID };
      if (!cfg.pageToken || ((row.targets||['instagram','facebook']).includes('instagram') && !cfg.igId) || !cfg.pageId) throw new Error('Les accès stories Instagram/Facebook restent à configurer.');
      const meta = (path, body) => api(path, body, cfg.pageToken);
      const mime = (await pool.query('SELECT mime FROM story_media WHERE id=$1', [row.media_id])).rows[0].mime;
      const video = mime === 'video/mp4';
      const results = row.results;
      const selectedTargets = helpers.targets(row.targets || ['instagram','facebook']);
      if (!selectedTargets.length) throw new Error('Ce contenu est uniquement destiné au partage manuel sur WhatsApp.');
      for (const network of selectedTargets) {
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
      await text(from, selectedTargets.map(n => `${n} : ${results[n].status === 'accepted' ? 'accepté par Meta' : 'à vérifier, aucun nouvel essai automatique'}`).join('\n') + '\nPour WhatsApp, partage l’aperçu manuellement dans ton statut.').catch(()=>{});
    } catch (e) {
      await pool.query("UPDATE story_drafts SET status=$2 WHERE id=$1", [row.id, b.action === 'approve' && Object.keys(row.results).length ? 'check_required' : 'preview']);
      await text(from, e.message).catch(()=>{});
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
      await planner.tick(now).catch(()=>console.error('Stories : programmations indisponibles'));
      await reminderTick(now).catch(()=>console.error('Stories : rappel personnel non confirmé'));
      const p = paris(now);
      const settings = (await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
      if (!settings?.enabled) return;
      if (new Date(p.date + 'T12:00:00Z').getUTCDay() !== 6 || p.minute < 1230 || p.minute > 1260) return;
      if (!isHolyTime || await isHolyTime(now)) return;
      const mode = effectiveMode(settings);
      const selected = await selectMedia(mode, settings);
      const row = await createDraft(adminPhone, selected.media, selected.clip, p.date, mode === 'reminder' ? 'reminder' : 'story',settings.targets||['instagram','facebook']);
      if (!row) return;
      if (settings.next_mode) await pool.query('UPDATE story_settings SET next_mode=NULL WHERE id=1 AND next_mode=$1',[settings.next_mode]);
      await notify(mode);
      // User replies “statu” to receive the video and approval buttons inside the messaging window.
    } finally { running = false; }
  }
  async function reminderTick(now) {
    const p=paris(now),day=new Date(p.date+'T12:00:00Z').getUTCDay();
    const reminders=(await pool.query('SELECT * FROM story_reminders WHERE enabled')).rows;
    for(const item of reminders){
      const [h,m]=item.time.split(':').map(Number),elapsed=p.minute-h*60-m;
      if(!item.days.includes(day)||elapsed<0||elapsed>15)continue;
      if(!isHolyTime||await isHolyTime(now))continue;
      const claim=await pool.query('INSERT INTO story_reminder_jobs(reminder_id,date) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING date',[item.id,p.date]);
      if(!claim.rows.length)continue;
      let accepted=false;
      try{await wa(adminPhone,{type:'template',template:{name:env.STORIES_PERSONAL_REMINDER_TEMPLATE||'shliah_rappel_personnel',language:{code:'fr'},components:[{type:'body',parameters:[{type:'text',text:item.message.replace(/\s+/g,' ')}]}]}});accepted=true;}catch(_){}
      if(!accepted&&envoyerEmail){const sent=await envoyerEmail({to:'bhsmaurice@gmail.com',subject:'Votre rappel — Shliah Bot',html:'<p>'+helpers.escape(item.message)+'</p><p>Rappel personnel uniquement. Aucun contenu publié.</p>',idempotencyKey:'story-reminder-'+item.id+'-'+p.date});accepted=Boolean(sent?.ok);}
      await pool.query('UPDATE story_reminder_jobs SET status=$3 WHERE reminder_id=$1 AND date=$2',[item.id,p.date,accepted?'accepted':'failed']);
    }
  }
  const wrap = f => (req, res) => Promise.resolve(f(req, res)).catch(() => res.status(500).json({ ok: false, error: 'Opération stories impossible' }));
  const safeEqual=(a,b)=>{const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&timingSafeEqual(aa,bb);};
  const sign=value=>createHmac('sha256',adminPassword).update(value).digest('hex');
  function sessionValid(value){const parts=String(value||'').split('.');return parts.length===3&&Number(parts[1])>Date.now()&&safeEqual(parts[2],sign(parts[0]+'.'+parts[1]));}
  const auth=(req,res,next)=>{
    if(adminPassword&&safeEqual(req.get('X-Admin-Password'),adminPassword))return next();
    const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('shliah_stories_session='));
    const value=cookie?.slice('shliah_stories_session='.length);
    if(sessionValid(value)){
      if(req.method!=='GET'&&req.get('Origin')!==new URL(publicBaseUrl).origin)return res.sendStatus(403);
      return next();
    }
    return res.sendStatus(401);
  };
  app.post('/admin/stories/session',auth,wrap(async(_req,res)=>{
    await ensureDB();const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
    await pool.query('DELETE FROM story_handoffs WHERE expires_at<NOW()');
    await pool.query("INSERT INTO story_handoffs(hash,expires_at) VALUES($1,NOW()+INTERVAL '60 seconds')",[hash]);
    res.set('Cache-Control','no-store').json({token});
  }));
  app.post('/admin/stories/session/redeem',wrap(async(req,res)=>{
    await ensureDB();const token=req.body.token;
    if(typeof token!=='string'||!(/^[a-f0-9]{64}$/).test(token))return res.sendStatus(401);
    const hash=createHash('sha256').update(token).digest('hex');
    const claim=await pool.query('DELETE FROM story_handoffs WHERE hash=$1 AND expires_at>NOW() RETURNING hash',[hash]);
    if(!claim.rows.length)return res.sendStatus(401);
    const payload=randomBytes(16).toString('hex')+'.'+(Date.now()+8*3600000),value=payload+'.'+sign(payload);
    res.set('Set-Cookie','shliah_stories_session='+value+'; HttpOnly; Secure; SameSite=Lax; Path=/admin/stories; Max-Age=28800').set('Cache-Control','no-store').json({ok:true});
  }));
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
    const {enabled=current.enabled,mode=current.mode||'music',next_mode=current.next_mode||null,targets=current.targets||['instagram','facebook']} = req.body;
    let selectedTargets;try{selectedTargets=helpers.targets(targets);}catch(e){return res.status(400).json({error:e.message});}
    if (typeof enabled !== 'boolean' || !MODES.includes(mode) || (next_mode !== null && !MODES.includes(next_mode))) return res.status(400).json({error:'Choix invalide'});
    if (enabled) {
      const settings={...current,mode,next_mode};
      const modes=new Set([mode,next_mode].filter(Boolean));
      if ([...modes].some(m=>m!=='reminder') && !settings.cover) return res.status(409).json({error:'Il manque le visuel du samedi.'});
      if (modes.has('music')) {
        const count=(await pool.query('SELECT COUNT(*)::int AS n FROM story_clips WHERE enabled')).rows[0].n;
        if(count<2)return res.status(409).json({error:'Il manque deux clips de nigounim.'});
      }
      if ([...modes].some(m=>m!=='reminder') && selectedTargets.length) {
        const cfg=await getMeta();
        if(!cfg.pageToken||(selectedTargets.includes('instagram')&&!cfg.igId))return res.status(409).json({error:'Connexion Instagram/Facebook incomplète'});
      }
    }
    await pool.query('UPDATE story_settings SET enabled=$1,mode=$2,next_mode=$3,targets=$4 WHERE id=1',[enabled,mode,next_mode,JSON.stringify(selectedTargets)]);
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
  async function addMusic(data,music_id){let mime='image/jpeg';
      const track=licensedTracks.find(t=>t.id===music_id);
      const clip=(await pool.query('SELECT m.data FROM story_clips c JOIN story_media m ON m.id=c.media_id WHERE c.id=$1 AND c.enabled',[music_id])).rows[0];
      if(!track||!clip)throw new Error('Nigoun indisponible');
      const fs=require('node:fs/promises'),path=require('node:path'),folder=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'shliah-manual-'));
      try{
        const sharp=require('sharp'),image=path.join(folder,'image.png'),audio=path.join(folder,'audio.mp4'),out=path.join(folder,'out.mp4');
        const footer=Buffer.from('<svg width="1080" height="120"><rect width="1080" height="120" fill="white"/><g font-family="sans-serif" font-size="22" text-anchor="middle" fill="#52617a"><text x="540" y="30">'+helpers.escape(track.title+' — '+track.author)+'</text><text x="540" y="60">Extrait et fondus · Adaptation '+track.short+'</text><text x="540" y="92">'+track.license+'</text></g></svg>');
        const base=await sharp(data).resize(1080,1800,{fit:'contain',background:'white'}).extend({bottom:120,top:0,left:0,right:0,background:'white'}).toBuffer();
        await fs.writeFile(image,await sharp(base).composite([{input:footer,left:0,top:1800}]).png().toBuffer());await fs.writeFile(audio,clip.data);
        await require('./render-clip').renderClip(image,audio,out);data=await fs.readFile(out);mime='video/mp4';
      }finally{await fs.rm(folder,{recursive:true,force:true});}
    return {data,mime};
  }
  app.post('/admin/stories/manual',auth,wrap(async(req,res)=>{
    await ensureDB();
    let selected;try{selected=helpers.targets(req.body.targets);}catch(e){return res.status(400).json({error:e.message});}
    const {type,content,music_id,silent}=req.body;let data,mime;
    if(type==='model'){const settings=(await pool.query('SELECT cover FROM story_settings WHERE id=1')).rows[0];if(!settings?.cover)return res.status(409).json({error:'Aucun modèle enregistré'});data=(await pool.query('SELECT data FROM story_media WHERE id=$1',[settings.cover])).rows[0].data;mime='image/jpeg';}
    else if(type==='text'){
      if(typeof content!=='string'||!content.trim()||content.length>700)return res.status(400).json({error:'Écris un texte de 700 caractères maximum.'});
      data=await require('sharp')(Buffer.from(helpers.textSvg(content))).jpeg().toBuffer();mime='image/jpeg';
    }else if(type==='image'||type==='video'){
      if(typeof content!=='string'||content.length>9500000)return res.status(400).json({error:'Fichier de 7 Mo maximum.'});
      data=Buffer.from(content,'base64');
      if(type==='image'){data=await require('sharp')(data).rotate().resize(1080,1920,{fit:'contain',background:'white'}).jpeg().toBuffer();mime='image/jpeg';}
      else{if(data.subarray(4,8).toString()!=='ftyp')return res.status(400).json({error:'Utilise une vidéo MP4.'});mime='video/mp4';}
    }else return res.status(400).json({error:'Choisis image, vidéo ou texte.'});
    if(music_id&&type!=='video'){
      ({data,mime}=await addMusic(data,music_id));
    }else if(type==='video'&&silent){
      const fs=require('node:fs/promises'),path=require('node:path'),folder=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'shliah-silent-'));
      try{const input=path.join(folder,'input.mp4'),out=path.join(folder,'out.mp4');await fs.writeFile(input,data);await require('node:util').promisify(require('node:child_process').execFile)(env.FFMPEG_PATH||require('ffmpeg-static'),['-nostdin','-y','-i',input,'-c:v','copy','-an','-movflags','+faststart',out],{timeout:60000,maxBuffer:1048576});data=await fs.readFile(out);}finally{await fs.rm(folder,{recursive:true,force:true});}
    }
    const media=randomUUID();await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[media,data,mime]);
    const row=await createDraft(adminPhone,media,null,null,'story',selected);
    res.json({ok:true,id:row.id,revision:row.revision,url:url(media),mime,targets:selected,message:'Aperçu prêt. Rien n’est encore publié.'});
  }));
  app.post('/admin/stories/drafts/:id/:action',auth,wrap(async(req,res)=>{
    await ensureDB();const {action,id}=req.params;
    if(!['approve','cancel'].includes(action)||!Number.isInteger(req.body.revision))return res.status(400).json({error:'Action invalide'});
    await handleButton(adminPhone,`st_${action}_${id}_${req.body.revision}`);
    const row=(await pool.query('SELECT status,results FROM story_drafts WHERE id=$1 AND owner=$2',[id,adminPhone])).rows[0];
    res.json({ok:true,...row});
  }));
  app.get('/admin/stories/reminders',auth,wrap(async(_req,res)=>{await ensureDB();res.json({reminders:(await pool.query('SELECT * FROM story_reminders ORDER BY time,id')).rows});}));
  app.post('/admin/stories/reminders',auth,wrap(async(req,res)=>{
    await ensureDB();let checked;try{checked=helpers.reminder(req.body);}catch(e){return res.status(400).json({error:e.message});}
    const id=randomUUID();await pool.query('INSERT INTO story_reminders(id,days,time,message) VALUES($1,$2,$3,$4)',[id,JSON.stringify(checked.days),checked.time,checked.message]);res.json({ok:true,id,message:'Rappel hebdomadaire enregistré.'});
  }));
  app.post('/admin/stories/reminders/:id/toggle',auth,wrap(async(req,res)=>{
    await ensureDB();if(typeof req.body.enabled!=='boolean')return res.status(400).json({error:'Choix invalide'});
    await pool.query('UPDATE story_reminders SET enabled=$2 WHERE id=$1',[req.params.id,req.body.enabled]);res.json({ok:true});
  }));
  app.get('/admin/stories/status', auth, wrap(async (req, res) => {
    res.set('Cache-Control','no-store');
    await ensureDB();
    const settings = (await pool.query('SELECT * FROM story_settings WHERE id=1')).rows[0];
    let meta; try { const c = await getMeta(); meta = { connected: Boolean(c.pageToken), facebook: c.pageName, instagram: Boolean(c.igId) }; } catch (_) { meta = { connected: false }; }
    res.json({ enabled: settings?.enabled, mode:settings?.mode||'music',next_mode:settings?.next_mode||null, targets:settings?.targets||['instagram','facebook'], cover: Boolean(settings?.cover), coverUrl: settings?.cover ? url(settings.cover) : null, meta, clips: (await pool.query('SELECT id,title,media_id FROM story_clips WHERE enabled ORDER BY id')).rows.map(c=>({id:c.id,title:c.title,url:url(c.media_id)})) });
  }));
  const planner = require('./stories.planner').init({pool,ensureDB,isAdmin,adminPhone,text,wa,paris,isHolyTime,downloadMedia,createDraft,preview:async row=>{const m=(await pool.query('SELECT mime FROM story_media WHERE id=$1',[row.media_id])).rows[0];return m.mime==='video/mp4'?preview(row):imagePreview(row);},addMusic,notifyPlan:async row=>{const active=(await pool.query("SELECT phone FROM story_admin_activity WHERE phone=$1 AND last_inbound>NOW()-INTERVAL '23 hours'",[row.owner])).rows.length;if(active){const media=(await pool.query('SELECT mime FROM story_media WHERE id=$1',[row.media_id])).rows[0];await text(row.owner,'🔔 Voici ton visuel programmé. Vérifie-le avant de valider.');return media.mime==='video/mp4'?preview(row):imagePreview(row);}try{await wa(adminPhone,{type:'template',template:{name:env.STORIES_PERSONAL_REMINDER_TEMPLATE||'shliah_rappel_personnel',language:{code:'fr'},components:[{type:'body',parameters:[{type:'text',text:'Un visuel programmé est prêt. Répondez « statu » pour voir l’aperçu et choisir de publier ou annuler'}]}]}});}catch(e){if(envoyerEmail)await envoyerEmail({to:'bhsmaurice@gmail.com',subject:'Visuel programmé à valider',html:'<p>Écrivez « statu » au bot WhatsApp pour voir le visuel et valider. Rien ne sera publié sans votre accord.</p>'});else throw e;}}});
  function start() { const timer = setInterval(() => tick().catch(() => console.error('Stories : préparation interrompue, consulter la configuration')), 60000); timer.unref(); tick().catch(() => {}); return timer; }
  return { ensureDB, start, tick, handleText, handleMedia, handleButton, reminderTick };
}
module.exports = { init, paris, due, choose, parseButton, effectiveMode };
