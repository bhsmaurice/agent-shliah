'use strict';
// ═══════════════════════════════════════════════════════════════
// POSTS INSTAGRAM + FACEBOOK depuis WhatsApp (réservé à l'admin)
//
// 1. Levi écrit « post » au bot (ou « post Soirée Sim'hat Torah… »)
// 2. Il transfère les photos (jusqu'à 10) + un petit texte
// 3. Il écrit « fini »
// 4. Le bot (Claude, comme un community manager) rédige le post
//    Instagram ET le post Facebook, et les renvoie avec 3 boutons :
//    ✅ Publier · ✏️ Modifier · ❌ Annuler
// 5. « Publier » → publication automatique sur la page Facebook et sur
//    le compte Instagram relié (API Meta). Sans configuration Meta,
//    le bot renvoie simplement les textes prêts à copier.
//
// Variables Railway :
//   META_PAGE_TOKEN  (obligatoire pour publier) — jeton de la page Facebook
//                    (ou jeton utilisateur système : la page est retrouvée)
//   META_PAGE_ID     (facultatif) — si le jeton donne accès à plusieurs pages
//   META_IG_USER_ID  (facultatif) — retrouvé automatiquement depuis la page
//   POSTS_MODEL      (facultatif) — modèle Claude pour la rédaction
// ═══════════════════════════════════════════════════════════════
const sharp = require('sharp');

const GRAPH = 'https://graph.facebook.com/v25.0';
const MAX_PHOTOS = 10;
const SESSION_TTL = 3 * 60 * 60 * 1000; // 3 heures
const MOTS_FIN = /^(fini|fin|termin[ée]|c'?est bon|go|ok|vas[- ]?y|envoie)\s*[.!]*$/i;
const MOTS_ANNULER = /^(annuler|annule|stop|laisse tomber)\s*[.!]*$/i;

let ctx = null;
const sessions = {};

// ─── Utilitaires ──────────────────────────────────────────────
function maintenantParis() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
}
function dateFr() {
  const d = maintenantParis();
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}
function sessionActive(from) {
  const s = sessions[from];
  if (!s) return null;
  if (Date.now() - s.maj > SESSION_TTL) { delete sessions[from]; return null; }
  return s;
}
function toucher(s) { s.maj = Date.now(); }
function attendre(ms) { return new Promise(r => setTimeout(r, ms)); }

async function boutonsValidation(from, titre) {
  await ctx.sendWhatsAppButtons(from, titre || 'Que veux-tu faire ?', [
    { id: 'post_publier', title: '✅ Publier' },
    { id: 'post_modifier', title: '✏️ Modifier' },
    { id: 'post_annuler', title: '❌ Annuler' }
  ]);
}

// ─── Images : téléchargement, stockage, version Instagram ─────
async function telechargerMedia(mediaId) {
  const infoRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } });
  const info = await infoRes.json();
  if (!info.url) throw new Error('Média WhatsApp introuvable');
  const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${ctx.whatsappToken}` } });
  return Buffer.from(await fileRes.arrayBuffer());
}
async function stocker(buffer) {
  const r = await ctx.pool.query('INSERT INTO medias (data, mime_type) VALUES ($1, $2) RETURNING id', [buffer, 'image/jpeg']);
  return r.rows[0].id;
}
// Instagram refuse les photos trop hautes (< 4:5) ou trop larges (> 1,91:1) :
// on recadre au centre dans les limites autorisées.
async function versionInstagram(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  const ratio = w / h;
  let img = sharp(buffer);
  if (ratio < 0.8) {
    const hh = Math.round(w / 0.8);
    img = img.extract({ left: 0, top: Math.round((h - hh) / 2), width: w, height: hh });
  } else if (ratio > 1.91) {
    const ww = Math.round(h * 1.91);
    img = img.extract({ left: Math.round((w - ww) / 2), top: 0, width: ww, height: h });
  }
  return img.resize(1440, 1440, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}
async function preparerPhoto(mediaId) {
  const brut = await telechargerMedia(mediaId);
  const base = await sharp(brut).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, progressive: true }).toBuffer();
  const insta = await versionInstagram(base);
  const apercu = await sharp(base).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  const idBase = await stocker(base);
  const idInsta = await stocker(insta);
  return {
    url: `${ctx.publicBaseUrl}/media/${idBase}`,
    urlInsta: `${ctx.publicBaseUrl}/media/${idInsta}`,
    apercuB64: apercu.toString('base64')
  };
}

// ─── Rédaction par Claude (community manager) ─────────────────
const CONSIGNES = `Tu es le community manager du Beth Habad S. Maurice (Rav Levi Basanger et Rebbetzin Myriam Basanger), une communauté Habad-Loubavitch chaleureuse du Val-de-Marne.
On te donne les photos d'une activité et le petit message du Rav. Tu rédiges DEUX publications professionnelles, vivantes et chaleureuses :

INSTAGRAM :
- Première ligne accrocheuse (elle s'affiche seule avant « plus »).
- Paragraphes courts, quelques emojis bien choisis (pas trop).
- Termine par « 📍 Beth Habad S. Maurice » puis une ligne de 8 à 12 hashtags pertinents (ex. #BethHabad #Habad #Loubavitch #CommunautéJuive #ValDeMarne + hashtags liés à l'activité ou à la fête).
- 600 à 1200 caractères environ.

FACEBOOK :
- Un peu plus développé et chaleureux, ton communautaire, on remercie les participants et les bénévoles si c'est pertinent.
- Une invitation à rejoindre les prochaines activités, et le site habadsmaurice.com.
- 2 ou 3 hashtags maximum, emojis avec modération.

RÈGLES STRICTES :
- Écris toujours « Beth Habad S. Maurice » ou « S. Maurice », jamais « Saint-Maurice » ni « Saint Maurice » (même dans les hashtags).
- N'invente AUCUN fait : pas de nombre de participants, de nom de personne, de date ou d'horaire qui ne figurent pas dans le message du Rav. Décris ce qu'on voit sur les photos de façon générale (ambiance, sourires, table, enfants…).
- Ne nomme jamais une personne visible sur les photos si son nom n'est pas donné.
- Vocabulaire juif juste et respectueux (Chabbat, Torah, mitsva, Hassidout, fêtes…), orthographe française.
- Pas d'astérisques ni de mise en forme Markdown.

Réponds UNIQUEMENT avec un objet JSON : {"instagram": "...", "facebook": "..."}`;

async function appelClaude(modele, contenu) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modele, max_tokens: 2500, system: CONSIGNES, messages: [{ role: 'user', content: contenu }] }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await res.json();
  if (!res.ok || !data.content) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  const texte = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const m = texte.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse illisible');
  const json = JSON.parse(m[0]);
  if (!json.instagram || !json.facebook) throw new Error('Textes incomplets');
  return { instagram: String(json.instagram).trim(), facebook: String(json.facebook).trim() };
}

async function rediger(s, demandeModif) {
  const contenu = [];
  // Claude regarde au maximum 6 photos (suffisant pour l'ambiance)
  for (const p of s.photos.slice(0, 6)) {
    contenu.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.apercuB64 } });
  }
  let consigne = `Date d'aujourd'hui : ${dateFr()}.\nNombre de photos : ${s.photos.length}.\n\nMessage du Rav :\n${s.texte.trim() || '(pas de texte, base-toi sur les photos)'}`;
  if (demandeModif && s.brouillon) {
    consigne += `\n\nVoici les textes actuels :\nINSTAGRAM :\n${s.brouillon.instagram}\n\nFACEBOOK :\n${s.brouillon.facebook}\n\nLe Rav demande cette modification : ${demandeModif}\nRéécris les deux textes en appliquant sa demande.`;
  }
  contenu.push({ type: 'text', text: consigne });
  const modeles = [process.env.POSTS_MODEL || 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
  let derniereErreur;
  for (const m of modeles) {
    try { return await appelClaude(m, contenu); }
    catch (e) { derniereErreur = e; console.error('Posts — rédaction échouée avec', m, ':', e.message); }
  }
  throw derniereErreur;
}

async function genererEtMontrer(from, s, demandeModif) {
  s.etape = 'redaction';
  await ctx.sendWhatsApp(from, demandeModif ? '✏️ Je modifie le post…' : `✍️ Je rédige ton post avec ${s.photos.length} photo${s.photos.length > 1 ? 's' : ''}… (environ 20 secondes)`);
  try {
    s.brouillon = await rediger(s, demandeModif);
  } catch (e) {
    s.etape = s.brouillon ? 'validation' : 'collecte';
    await ctx.sendWhatsApp(from, `⚠️ Je n'ai pas réussi à rédiger le post (${e.message}). Écris « fini » pour réessayer, ou « annuler ».`);
    return;
  }
  s.etape = 'validation';
  toucher(s);
  await ctx.sendWhatsApp(from, `📸 INSTAGRAM\n\n${s.brouillon.instagram}`);
  await attendre(500);
  await ctx.sendWhatsApp(from, `📘 FACEBOOK\n\n${s.brouillon.facebook}`);
  await attendre(500);
  const config = await configMeta().catch(() => null);
  const titre = config && config.pageToken
    ? `Je publie sur ${config.igId ? 'Facebook et Instagram' : 'Facebook (Instagram pas encore relié)'} ?\n\nPour modifier, appuie sur ✏️ ou écris directement ce que tu veux changer.`
    : `⚠️ La publication automatique n'est pas encore configurée : copie les textes ci-dessus pour l'instant.\n\nPour modifier, écris ce que tu veux changer.`;
  await boutonsValidation(from, titre);
}

// ─── Meta : page Facebook + compte Instagram ──────────────────
let cacheMeta = null;
async function graphGet(chemin, token) {
  const sep = chemin.includes('?') ? '&' : '?';
  const r = await fetch(`${GRAPH}/${chemin}${sep}access_token=${encodeURIComponent(token)}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}
async function graphPost(chemin, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${chemin}`, { method: 'POST', body });
  const d = await r.json();
  if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
  return d;
}
// Accepte un jeton de page OU un jeton utilisateur/système (on retrouve la page)
async function configMeta(forcer) {
  const token = process.env.META_PAGE_TOKEN;
  if (!token) return { pageToken: null };
  if (cacheMeta && !forcer && Date.now() - cacheMeta.t < 6 * 3600 * 1000) return cacheMeta;
  const voulu = process.env.META_PAGE_ID || null;
  let page = null;
  try {
    const comptes = await graphGet('me/accounts?fields=id,name,access_token,instagram_business_account&limit=50', token);
    if (comptes.data && comptes.data.length) {
      page = comptes.data.find(p => !voulu || p.id === voulu) || comptes.data[0];
    }
  } catch (e) { /* le jeton est probablement déjà un jeton de page */ }
  if (!page) {
    const moi = await graphGet('me?fields=id,name,instagram_business_account', token);
    page = { ...moi, access_token: token };
  }
  cacheMeta = {
    t: Date.now(),
    pageId: page.id,
    pageName: page.name,
    pageToken: page.access_token,
    igId: process.env.META_IG_USER_ID || (page.instagram_business_account && page.instagram_business_account.id) || null
  };
  return cacheMeta;
}

async function publierFacebook(cfg, photos, message) {
  const ids = [];
  for (const p of photos) {
    const r = await graphPost(`${cfg.pageId}/photos`, { url: p.url, published: 'false' }, cfg.pageToken);
    ids.push(r.id);
  }
  const params = { message };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const post = await graphPost(`${cfg.pageId}/feed`, params, cfg.pageToken);
  return `https://www.facebook.com/${post.id}`;
}

async function attendreConteneur(id, token) {
  for (let i = 0; i < 30; i++) {
    const d = await graphGet(`${id}?fields=status_code`, token);
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR' || d.status_code === 'EXPIRED') throw new Error('Instagram a refusé une photo');
    await attendre(2000);
  }
  throw new Error('Instagram met trop de temps à traiter les photos');
}
async function publierInstagram(cfg, photos, caption) {
  const tok = cfg.pageToken;
  let conteneur;
  if (photos.length === 1) {
    const c = await graphPost(`${cfg.igId}/media`, { image_url: photos[0].urlInsta, caption }, tok);
    conteneur = c.id;
  } else {
    const enfants = [];
    for (const p of photos) {
      const c = await graphPost(`${cfg.igId}/media`, { image_url: p.urlInsta, is_carousel_item: 'true' }, tok);
      enfants.push(c.id);
    }
    for (const id of enfants) await attendreConteneur(id, tok);
    const c = await graphPost(`${cfg.igId}/media`, { media_type: 'CAROUSEL', children: enfants.join(','), caption }, tok);
    conteneur = c.id;
  }
  await attendreConteneur(conteneur, tok);
  const pub = await graphPost(`${cfg.igId}/media_publish`, { creation_id: conteneur }, tok);
  try {
    const d = await graphGet(`${pub.id}?fields=permalink`, tok);
    return d.permalink || 'https://www.instagram.com/habadsmaurice/';
  } catch (e) { return 'https://www.instagram.com/habadsmaurice/'; }
}

async function publier(from, s, cibles) {
  const cfg = await configMeta(true).catch(e => ({ pageToken: null, erreur: e.message }));
  if (!cfg.pageToken) {
    await ctx.sendWhatsApp(from, `⚠️ La publication automatique n'est pas encore configurée${cfg.erreur ? ` (${cfg.erreur})` : ''}.\n\nLes textes ci-dessus sont prêts : copie-les et publie avec tes photos.`);
    return;
  }
  s.etape = 'publication';
  await ctx.sendWhatsApp(from, '🚀 Publication en cours…');
  const lignes = [];
  let ok = 0;
  if (cibles.facebook) {
    try { lignes.push(`📘 Facebook : publié ✅\n${await publierFacebook(cfg, s.photos, s.brouillon.facebook)}`); ok++; }
    catch (e) { lignes.push(`📘 Facebook : échec ❌ (${e.message})`); }
  }
  if (cibles.instagram) {
    if (!cfg.igId) lignes.push("📸 Instagram : pas encore relié à la page Facebook ❌");
    else {
      try { lignes.push(`📸 Instagram : publié ✅\n${await publierInstagram(cfg, s.photos, s.brouillon.instagram)}`); ok++; }
      catch (e) { lignes.push(`📸 Instagram : échec ❌ (${e.message})`); }
    }
  }
  try {
    await ctx.pool.query(
      'INSERT INTO posts_sociaux (texte_source, instagram, facebook, photos, resultat) VALUES ($1,$2,$3,$4,$5)',
      [s.texte, s.brouillon.instagram, s.brouillon.facebook, JSON.stringify(s.photos.map(p => p.url)), lignes.join('\n')]
    );
  } catch (e) { console.error('Posts — sauvegarde :', e.message); }
  if (ok > 0) delete sessions[from]; else s.etape = 'validation';
  await ctx.sendWhatsApp(from, lignes.join('\n\n') + (ok > 0 ? '\n\nKol Touv !' : '\n\nTu peux réessayer avec ✅ Publier.'));
  if (ok === 0) await boutonsValidation(from);
}

// ─── Points d'entrée appelés depuis index.js ──────────────────
function demarrer(from, texteInitial) {
  sessions[from] = { etape: 'collecte', photos: [], enCours: 0, texte: texteInitial || '', brouillon: null, maj: Date.now(), timer: null };
  return sessions[from];
}

// Messages texte. Renvoie true si le message a été pris en charge.
async function handleText(from, text) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const t = String(text || '').trim();
  let s = sessionActive(from);

  const declencheur = t.match(/^post(?:\s+insta(?:gram)?|\s+facebook|\s+fb)?(?=$|[\s:\-])\s*[:\-]?\s*([\s\S]*)$/i);
  if (declencheur && (!s || s.etape !== 'collecte' || /^post$/i.test(t))) {
    s = demarrer(from, declencheur[1] || '');
    await ctx.sendWhatsApp(from, `📸 Nouveau post Instagram + Facebook\n\nEnvoie-moi les photos (jusqu'à ${MAX_PHOTOS})${s.texte ? '' : ' et un petit texte sur l\'activité'}.\n\nQuand c'est tout, écris « fini ».\n\n(« annuler » pour arrêter)`);
    return true;
  }
  if (!s) return false;
  toucher(s);

  if (MOTS_ANNULER.test(t)) {
    delete sessions[from];
    await ctx.sendWhatsApp(from, '❌ Post annulé.');
    return true;
  }

  if (s.etape === 'redaction' || s.etape === 'publication') {
    await ctx.sendWhatsApp(from, '⏳ Un instant, je suis en train de travailler sur le post…');
    return true;
  }

  if (s.etape === 'collecte') {
    if (MOTS_FIN.test(t)) {
      for (let i = 0; i < 30 && s.enCours > 0; i++) await attendre(1000);
      if (!s.photos.length) {
        await ctx.sendWhatsApp(from, "Je n'ai pas encore reçu de photo 🙂 Envoie au moins une photo, puis écris « fini ».");
        return true;
      }
      await genererEtMontrer(from, s);
      return true;
    }
    s.texte = (s.texte ? s.texte + '\n' : '') + t;
    await ctx.sendWhatsApp(from, s.photos.length
      ? '📝 Texte noté. Écris « fini » quand c\'est tout.'
      : '📝 Texte noté. Envoie maintenant les photos, puis « fini ».');
    return true;
  }

  if (s.etape === 'validation' || s.etape === 'modification') {
    if (/^(publier|publie|valider|valide|oui)\s*[.!]*$/i.test(t)) { await publier(from, s, { facebook: true, instagram: true }); return true; }
    if (/^(insta(gram)?)\s*(seulement|uniquement)?$/i.test(t)) { await publier(from, s, { facebook: false, instagram: true }); return true; }
    if (/^(facebook|fb)\s*(seulement|uniquement)?$/i.test(t)) { await publier(from, s, { facebook: true, instagram: false }); return true; }
    // Tout autre texte = demande de modification
    await genererEtMontrer(from, s, t);
    return true;
  }
  return false;
}

// Photos. Renvoie true si l'image a été prise en charge par un post en cours.
async function handleImage(from, message) {
  if (!ctx || !ctx.isAdmin(from)) return false;
  const s = sessionActive(from);
  if (!s) return false;
  toucher(s);
  if (s.etape !== 'collecte') {
    await ctx.sendWhatsApp(from, "Le post est déjà rédigé. Pour ajouter des photos, écris « annuler » puis recommence avec « post ».");
    return true;
  }
  const mediaId = message.image && message.image.id;
  const legende = message.image && message.image.caption;
  if (legende) s.texte = (s.texte ? s.texte + '\n' : '') + legende;
  if (!mediaId) return true;
  if (s.photos.length + s.enCours >= MAX_PHOTOS) {
    if (!s.limiteSignalee) { s.limiteSignalee = true; await ctx.sendWhatsApp(from, `Maximum ${MAX_PHOTOS} photos par post : j'ai gardé les ${MAX_PHOTOS} premières.`); }
    return true;
  }
  s.enCours++;
  try {
    const photo = await preparerPhoto(mediaId);
    photo.ordre = Number(message.timestamp || Date.now() / 1000);
    s.photos.push(photo);
    s.photos.sort((a, b) => a.ordre - b.ordre);
  } catch (e) {
    console.error('Posts — photo :', e.message);
    await ctx.sendWhatsApp(from, `⚠️ Une photo n'a pas pu être reçue (${e.message}).`);
  } finally {
    s.enCours--;
  }
  // Un seul accusé de réception quand toutes les photos d'un envoi sont arrivées
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (sessions[from] !== s || s.etape !== 'collecte' || s.enCours > 0 || !s.photos.length) return;
    const n = s.photos.length;
    ctx.sendWhatsApp(from, `📸 ${n} photo${n > 1 ? 's' : ''} reçue${n > 1 ? 's' : ''}.\n\n${s.texte ? 'Écris « fini » quand c\'est tout.' : 'Envoie un petit texte sur l\'activité, puis « fini ».'}`).catch(() => {});
  }, 4000);
  return true;
}

async function handleBouton(from, buttonId) {
  if (!ctx || !ctx.isAdmin(from)) return;
  const s = sessionActive(from);
  if (!s || !s.brouillon) { await ctx.sendWhatsApp(from, 'Ce post a expiré. Écris « post » pour recommencer.'); return; }
  toucher(s);
  if (s.etape === 'redaction' || s.etape === 'publication') { await ctx.sendWhatsApp(from, '⏳ Un instant…'); return; }
  if (buttonId === 'post_publier') return publier(from, s, { facebook: true, instagram: true });
  if (buttonId === 'post_annuler') { delete sessions[from]; await ctx.sendWhatsApp(from, '❌ Post annulé.'); return; }
  if (buttonId === 'post_modifier') {
    s.etape = 'modification';
    await ctx.sendWhatsApp(from, '✏️ Dis-moi ce que tu veux changer.\n\nExemples : « plus court », « ajoute que c\'était pour Sim\'hat Torah », « plus joyeux », « enlève les hashtags ».\n\nTu peux aussi écrire « insta seulement » ou « facebook seulement » pour publier sur un seul réseau.');
  }
}

function init(options) {
  ctx = options;
  ctx.pool.query(`CREATE TABLE IF NOT EXISTS posts_sociaux (
    id SERIAL PRIMARY KEY, texte_source TEXT, instagram TEXT, facebook TEXT,
    photos JSONB, resultat TEXT, created_at TIMESTAMP DEFAULT NOW())`).catch(e => console.error('Table posts_sociaux :', e.message));

  // Vérifier la configuration Meta : /admin/posts/verifier?password=...
  ctx.app.get('/admin/posts/verifier', async (req, res) => {
    if (req.query.password !== ctx.adminPassword) return res.status(401).send('Mot de passe incorrect');
    try {
      const cfg = await configMeta(true);
      if (!cfg.pageToken) return res.json({ ok: false, message: "La variable META_PAGE_TOKEN n'est pas encore ajoutée sur Railway." });
      res.json({
        ok: true,
        page_facebook: `${cfg.pageName} (${cfg.pageId})`,
        instagram: cfg.igId ? `relié (${cfg.igId})` : "PAS relié : le compte Instagram doit être un compte professionnel connecté à la page Facebook",
        message: cfg.igId ? 'Tout est prêt : Facebook et Instagram.' : 'Facebook prêt, Instagram à relier.'
      });
    } catch (e) {
      res.json({ ok: false, message: 'Jeton Meta refusé : ' + e.message });
    }
  });

  // Historique des posts publiés
  ctx.app.get('/admin/posts', async (req, res) => {
    if (req.query.password !== ctx.adminPassword) return res.status(401).json({ ok: false });
    const r = await ctx.pool.query('SELECT * FROM posts_sociaux ORDER BY created_at DESC LIMIT 100');
    res.json({ ok: true, posts: r.rows });
  });

  console.log('Posts Instagram/Facebook prêts');
  return { handleText, handleImage, handleBouton };
}

module.exports = { init };
