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
const path = require('node:path');
const fs = require('node:fs');

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

async function boutonsValidation(from, titre, s) {
  await ctx.sendWhatsAppButtons(from, titre || 'Que veux-tu faire ?', [
    s && s.programme ? { id: 'post_programmer', title: '📅 Programmer' } : { id: 'post_publier', title: '✅ Publier' },
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
  const apercu = await sharp(base).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  const idBase = await stocker(base);
  const idInsta = await stocker(insta);
  return {
    url: `${ctx.publicBaseUrl}/media/${idBase}`,
    urlInsta: `${ctx.publicBaseUrl}/media/${idInsta}`,
    idBase,
    apercuB64: apercu.toString('base64')
  };
}

// ─── Story : photo de couverture en 1080×1920 + bandeau logo ───
let logoCache = null;
function logoBuffer() {
  if (logoCache === null) {
    try { logoCache = fs.readFileSync(path.join(__dirname, '..', '..', 'logo-bh.png')); }
    catch (e) { logoCache = false; console.error('Posts — logo introuvable :', e.message); }
  }
  return logoCache || null;
}
async function fabriquerStory(photo) {
  const r = await ctx.pool.query('SELECT data FROM medias WHERE id=$1', [photo.idBase]);
  if (!r.rows.length) throw new Error('photo introuvable');
  const src = r.rows[0].data;
  const W = 1080, H = 1920;
  // Fond : la même photo, agrandie et floutée
  const fond = await sharp(src).resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.75 }).toBuffer();
  // Photo entière, centrée dans la zone au-dessus du bandeau (y de 80 à 1440)
  const zoneHaut = 80, zoneBas = 1440;
  const centre = await sharp(src).resize(W - 60, zoneBas - zoneHaut, { fit: 'inside' }).toBuffer();
  const mc = await sharp(centre).metadata();
  const couches = [{ input: centre, left: Math.round((W - mc.width) / 2), top: zoneHaut + Math.round((zoneBas - zoneHaut - mc.height) / 2) }];
  // Bandeau blanc arrondi avec le logo
  const logo = logoBuffer();
  if (logo) {
    const lg = await sharp(logo).resize(760, null, { fit: 'inside' }).png().toBuffer();
    const ml = await sharp(lg).metadata();
    const bw = ml.width + 80, bh = ml.height + 50;
    const bande = Buffer.from(`<svg width="${bw}" height="${bh}"><rect width="${bw}" height="${bh}" rx="34" ry="34" fill="#ffffff" fill-opacity="0.94"/></svg>`);
    const bx = Math.round((W - bw) / 2), by = H - bh - 150;
    couches.push({ input: bande, left: bx, top: by });
    couches.push({ input: lg, left: bx + 40, top: by + 25 });
  }
  const img = await sharp(fond).composite(couches).jpeg({ quality: 90 }).toBuffer();
  const id = await stocker(img);
  return `${ctx.publicBaseUrl}/media/${id}`;
}

// ─── Tags Instagram : « tag @moshe.cohen @sarah_levy » ─────────
function extraireTags(texte) {
  const tags = [];
  const re = /(^|[\s,;(])@([A-Za-z0-9._]{1,30})/g;
  let m;
  while ((m = re.exec(String(texte || ''))) !== null) {
    const u = m[2].replace(/\.+$/, '');
    if (u && !tags.some(t => t.toLowerCase() === u.toLowerCase())) tags.push(u);
  }
  return tags.slice(0, 20);
}
function userTagsJson(tags) {
  // Positions réparties sur la photo (Instagram exige x et y entre 0 et 1)
  return JSON.stringify(tags.map((u, i) => ({ username: u, x: Number(((i + 1) / (tags.length + 1)).toFixed(2)), y: 0.85 })));
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
- Si on te donne des comptes Instagram à identifier, mentionne-les tous (avec le @) dans le texte Instagram, naturellement. Dans le texte Facebook, n'écris aucun @ ni nom de compte. N'ajoute jamais de @ que le Rav n'a pas donné (sauf @habadsmaurice si utile).

CHOIX DES PHOTOS (comme un vrai community manager) :
- Chaque photo est annoncée par « Photo N ». Choisis lesquelles publier et dans quel ordre.
- La photo n°1 est la couverture : elle doit donner envie de s'arrêter. Privilégie les visages souriants, le groupe, l'ambiance, l'action, une belle lumière. Évite en couverture un plat, un objet ou une table vide, sauf si l'activité porte justement sur ça.
- Alterne ensuite les plans (groupe, détails, moments forts) pour raconter l'activité.
- Retire les photos floues, trop sombres, mal cadrées ou presque identiques à une autre. Garde au moins 3 photos s'il y en a 3 ou plus, sauf demande contraire du Rav.
- Le conseil : 1 à 3 phrases courtes et simples pour le Rav, qui expliquent ton choix (quelle photo en couverture et pourquoi, ce que tu as retiré et pourquoi). Désigne les photos par ce qu'on y voit (« la photo du groupe autour de la table »), pas seulement par leur numéro.

Réponds UNIQUEMENT avec un objet JSON :
{"photos": [numéros des photos à publier, dans l'ordre], "conseil": "...", "instagram": "...", "facebook": "..."}`;

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
  return {
    instagram: String(json.instagram).trim(),
    facebook: String(json.facebook).trim(),
    photos: Array.isArray(json.photos) ? json.photos : null,
    conseil: json.conseil ? String(json.conseil).trim() : ''
  };
}

async function rediger(s, demandeModif) {
  const contenu = [];
  // Claude regarde toutes les photos (max 10), chacune annoncée par son numéro
  s.photos.forEach((p, i) => {
    contenu.push({ type: 'text', text: `Photo ${i + 1}` });
    contenu.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.apercuB64 } });
  });
  let consigne = `Date d'aujourd'hui : ${dateFr()}.\nNombre de photos reçues : ${s.photos.length}.\n\nMessage du Rav :\n${s.texte.trim() || '(pas de texte, base-toi sur les photos)'}`;
  const tags = extraireTags(s.texte);
  if (tags.length) consigne += `\n\nComptes Instagram à identifier : ${tags.map(t => '@' + t).join(' ')}`;
  if (demandeModif && s.brouillon) {
    const ordreActuel = (s.selection || []).map((n, i) => `position ${i + 1} de l'aperçu = Photo ${n + 1}`).join(', ');
    consigne += `\n\nVoici le post actuel :\nPHOTOS PUBLIÉES DANS CET ORDRE : ${ordreActuel}\n(Quand le Rav parle de « la photo 2 », il parle de la position 2 de l'aperçu.)\n\nINSTAGRAM :\n${s.brouillon.instagram}\n\nFACEBOOK :\n${s.brouillon.facebook}\n\nLe Rav demande cette modification : ${demandeModif}\nApplique sa demande (textes et/ou photos). Ne change que ce qu'il demande, garde le reste identique. Renvoie toujours le JSON complet avec la liste des photos.`;
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

// Numéros renvoyés par Claude (1, 2, 3…) → index valides, sans doublon.
// Si la liste est vide ou illisible, on garde toutes les photos dans l'ordre reçu.
function choisirSelection(liste, total) {
  const vus = new Set();
  const sel = [];
  for (const v of liste || []) {
    const i = parseInt(v, 10) - 1;
    if (Number.isInteger(i) && i >= 0 && i < total && !vus.has(i)) { vus.add(i); sel.push(i); }
  }
  return sel.length ? sel.slice(0, MAX_PHOTOS) : Array.from({ length: total }, (_, i) => i);
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
  const ancienne = (s.selection || []).join(',');
  s.selection = choisirSelection(s.brouillon.photos, s.photos.length);
  s.etape = 'validation';
  toucher(s);
  // Aperçu des photos dans l'ordre de publication (au premier passage, ou si l'ordre a changé)
  if (!demandeModif || ancienne !== s.selection.join(',')) {
    const n = s.selection.length, total = s.photos.length;
    await ctx.sendWhatsApp(from, `🖼️ Mon choix : ${n} photo${n > 1 ? 's' : ''}${n < total ? ` sur ${total}` : ''}, dans cet ordre (la n°1 = la couverture) :`);
    for (let i = 0; i < n; i++) {
      await ctx.sendWhatsAppImage(from, s.photos[s.selection[i]].urlInsta, `${i + 1}${i === 0 ? ' · couverture' : ''}`);
      await attendre(700);
    }
  }
  if (s.brouillon.conseil) {
    await ctx.sendWhatsApp(from, `💡 ${s.brouillon.conseil}`);
    await attendre(500);
  }
  await ctx.sendWhatsApp(from, `📸 INSTAGRAM\n\n${s.brouillon.instagram}`);
  await attendre(500);
  await ctx.sendWhatsApp(from, `📘 FACEBOOK\n\n${s.brouillon.facebook}`);
  await attendre(500);
  const tagsApercu = extraireTags(s.texte);
  const infos = [];
  if (tagsApercu.length) infos.push(`🏷️ Identifiés sur Instagram : ${tagsApercu.map(t => '@' + t).join(', ')}`);
  infos.push(s.story === false
    ? '📲 Story : non (écris « avec story » pour l\'ajouter)'
    : '📲 Story : la photo de couverture sera aussi publiée en story Instagram et Facebook (écris « pas de story » pour l\'enlever)');
  await ctx.sendWhatsApp(from, infos.join('\n\n'));
  await attendre(400);
  const config = await configMeta().catch(() => null);
  const titre = config && config.pageToken
    ? `${s.programme ? 'Je programme ce post' : 'Je publie'} sur ${config.igId ? 'Facebook et Instagram' : 'Facebook (Instagram pas encore relié)'} ?\n\nPour modifier, écris directement ce que tu veux changer (texte ou photos), ex. « garde toutes les photos », « mets la 3 en premier », « plus court ».`
    : `⚠️ La publication automatique n'est pas encore configurée : copie les textes ci-dessus pour l'instant.\n\nPour modifier, écris ce que tu veux changer.`;
  await boutonsValidation(from, titre, s);
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
async function publierInstagram(cfg, photos, caption, tags, infos) {
  const tok = cfg.pageToken;
  const avecTags = tags && tags.length ? { user_tags: userTagsJson(tags) } : {};
  let conteneur;
  if (photos.length === 1) {
    const c = await graphPost(`${cfg.igId}/media`, { image_url: photos[0].urlInsta, caption, ...avecTags }, tok);
    conteneur = c.id;
  } else {
    const enfants = [];
    for (let i = 0; i < photos.length; i++) {
      const extra = i === 0 ? avecTags : {}; // les identifications vont sur la couverture
      const c = await graphPost(`${cfg.igId}/media`, { image_url: photos[i].urlInsta, is_carousel_item: 'true', ...extra }, tok);
      enfants.push(c.id);
    }
    for (const id of enfants) await attendreConteneur(id, tok);
    const c = await graphPost(`${cfg.igId}/media`, { media_type: 'CAROUSEL', children: enfants.join(','), caption }, tok);
    conteneur = c.id;
  }
  await attendreConteneur(conteneur, tok);
  const pub = await graphPost(`${cfg.igId}/media_publish`, { creation_id: conteneur }, tok);
  if (infos) infos.id = pub.id; // gardé pour pouvoir modifier la légende depuis l'admin
  try {
    const d = await graphGet(`${pub.id}?fields=permalink`, tok);
    return d.permalink || 'https://www.instagram.com/habadsmaurice/';
  } catch (e) { return 'https://www.instagram.com/habadsmaurice/'; }
}

async function publierStoryInstagram(cfg, url) {
  const c = await graphPost(`${cfg.igId}/media`, { image_url: url, media_type: 'STORIES' }, cfg.pageToken);
  await attendreConteneur(c.id, cfg.pageToken);
  await graphPost(`${cfg.igId}/media_publish`, { creation_id: c.id }, cfg.pageToken);
}
async function publierStoryFacebook(cfg, url) {
  const ph = await graphPost(`${cfg.pageId}/photos`, { url, published: 'false' }, cfg.pageToken);
  await graphPost(`${cfg.pageId}/photo_stories`, { photo_id: ph.id }, cfg.pageToken);
}

// Cœur de la publication (utilisé tout de suite ou à l'heure programmée)
// contenu = { photos: [{url, urlInsta, idBase}], brouillon: {instagram, facebook}, texte, story }
async function executerPublication(cfg, contenu, cibles) {
  const lignes = [];
  let ok = 0;
  const photos = contenu.photos;
  const igInfos = {};
  if (cibles.facebook) {
    try { lignes.push(`📘 Facebook : publié ✅\n${await publierFacebook(cfg, photos, contenu.brouillon.facebook)}`); ok++; }
    catch (e) { lignes.push(`📘 Facebook : échec ❌ (${e.message})`); }
  }
  if (cibles.instagram) {
    if (!cfg.igId) lignes.push("📸 Instagram : pas encore relié à la page Facebook ❌");
    else {
      const tags = extraireTags(contenu.texte);
      try { lignes.push(`📸 Instagram : publié ✅\n${await publierInstagram(cfg, photos, contenu.brouillon.instagram, tags, igInfos)}`); ok++; }
      catch (e) {
        if (tags.length) {
          // Un compte identifié peut être refusé (nom faux, compte privé) : on republie sans les identifications
          try {
            lignes.push(`📸 Instagram : publié ✅ mais sans les identifications (Instagram les a refusées : ${e.message})\n${await publierInstagram(cfg, photos, contenu.brouillon.instagram, [], igInfos)}`);
            ok++;
          } catch (e2) { lignes.push(`📸 Instagram : échec ❌ (${e2.message})`); }
        } else lignes.push(`📸 Instagram : échec ❌ (${e.message})`);
      }
    }
  }
  // Story avec la photo de couverture (si au moins un post est parti)
  if (ok > 0 && contenu.story !== false) {
    try {
      const urlStory = await fabriquerStory(photos[0]);
      const st = [];
      if (cibles.instagram && cfg.igId) {
        try { await publierStoryInstagram(cfg, urlStory); st.push('Instagram ✅'); } catch (e) { st.push(`Instagram ❌ (${e.message})`); }
      }
      if (cibles.facebook) {
        try { await publierStoryFacebook(cfg, urlStory); st.push('Facebook ✅'); } catch (e) { st.push(`Facebook ❌ (${e.message})`); }
      }
      if (st.length) lignes.push(`📲 Story : ${st.join(' · ')}`);
    } catch (e) { lignes.push(`📲 Story : échec ❌ (${e.message})`); }
  }
  try {
    await ctx.pool.query(
      'INSERT INTO posts_sociaux (texte_source, instagram, facebook, photos, resultat, ig_media_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [contenu.texte, contenu.brouillon.instagram, contenu.brouillon.facebook, JSON.stringify(photos.map(p => p.url)), lignes.join('\n'), igInfos.id || null]
    );
  } catch (e) {
    console.error('Posts — sauvegarde :', e.message);
    // Secours : sauvegarde sans la colonne ig_media_id (si elle n'existe pas encore)
    try {
      await ctx.pool.query('INSERT INTO posts_sociaux (texte_source, instagram, facebook, photos, resultat) VALUES ($1,$2,$3,$4,$5)',
        [contenu.texte, contenu.brouillon.instagram, contenu.brouillon.facebook, JSON.stringify(photos.map(p => p.url)), lignes.join('\n')]);
    } catch (e2) { console.error('Posts — sauvegarde (secours) :', e2.message); }
  }
  return { lignes, ok };
}

function contenuSession(s) {
  const sel = s.selection && s.selection.length ? s.selection : s.photos.map((_, i) => i);
  return {
    photos: sel.map(i => ({ url: s.photos[i].url, urlInsta: s.photos[i].urlInsta, idBase: s.photos[i].idBase })),
    brouillon: { instagram: s.brouillon.instagram, facebook: s.brouillon.facebook },
    texte: s.texte,
    story: s.story
  };
}

async function publier(from, s, cibles) {
  const cfg = await configMeta(true).catch(e => ({ pageToken: null, erreur: e.message }));
  if (!cfg.pageToken) {
    await ctx.sendWhatsApp(from, `⚠️ La publication automatique n'est pas encore configurée${cfg.erreur ? ` (${cfg.erreur})` : ''}.\n\nLes textes ci-dessus sont prêts : copie-les et publie avec tes photos.`);
    return;
  }
  s.etape = 'publication';
  await ctx.sendWhatsApp(from, '🚀 Publication en cours…');
  const { lignes, ok } = await executerPublication(cfg, contenuSession(s), cibles);
  if (ok > 0) delete sessions[from]; else s.etape = 'validation';
  await ctx.sendWhatsApp(from, lignes.join('\n\n') + (ok > 0 ? '\n\nKol Touv !' : '\n\nTu peux réessayer avec ✅ Publier.'));
  if (ok === 0) await boutonsValidation(from, null, s);
}

// ═══ POSTS PROGRAMMÉS (« post pro ») ════════════════════════════
const FMT_DATE = { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };
function dateLisible(d) { return new Date(d).toLocaleString('fr-FR', FMT_DATE).replace(':', 'h'); }

// Heure de Paris (AAAA-MM-JJ HH:MM) → instant exact, en tenant compte de l'heure d'été
function parisVersDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const voulu = Date.UTC(y, mo - 1, d, h, mi);
    const vu = Date.UTC(p.getFullYear(), p.getMonth(), p.getDate(), p.getHours(), p.getMinutes());
    t += voulu - vu;
  }
  return new Date(t);
}

// Comprendre « dimanche 10h », « 3 novembre 18h30 », « demain soir 20h »
async function comprendreDate(texte) {
  const now = maintenantParis();
  const pad = n => String(n).padStart(2, '0');
  const ref = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      system: `Nous sommes le ${dateFr()}, il est ${ref.slice(11)} à Paris (${ref}). Convertis la date/heure demandée en heure de Paris. Si aucune heure n'est donnée, mets 10:00 ; « matin » = 10:00, « midi » = 12:00, « après-midi » = 15:00, « soir » = 20:00. Toujours une date future. Réponds UNIQUEMENT en JSON : {"date": "AAAA-MM-JJ HH:MM"} ou {"date": null} si ce n'est pas une date.`,
      messages: [{ role: 'user', content: String(texte).slice(0, 200) }]
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json();
  const txt = (data.content || []).map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  return j.date ? parisVersDate(j.date) : null;
}

// Chabbat et Yom Tov à Paris (Hebcal) : de l'allumage des bougies à la sortie
let cacheCalendrier = { t: 0, periodes: null };
async function periodesInterdites() {
  if (cacheCalendrier.periodes && Date.now() - cacheCalendrier.t < 6 * 3600 * 1000) return cacheCalendrier.periodes;
  const iso = d => d.toISOString().slice(0, 10);
  const debut = new Date(Date.now() - 3 * 86400000), fin = new Date(Date.now() + 75 * 86400000);
  const url = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&ss=on&c=on&M=on&b=18&i=off&geo=geoname&geonameid=2988507'
    + `&start=${iso(debut)}&end=${iso(fin)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'ShliahBot/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Hebcal HTTP ' + r.status);
  const items = (await r.json()).items || [];
  const periodes = [];
  for (const it of items.filter(i => i.category === 'candles')) {
    const a = new Date(it.date).getTime();
    const sortie = items.find(i => i.category === 'havdalah' && new Date(i.date).getTime() > a);
    if (sortie) periodes.push({ debut: a, fin: new Date(sortie.date).getTime() });
  }
  cacheCalendrier = { t: Date.now(), periodes };
  return periodes;
}
// Renvoie null si la date est permise, sinon la première heure permise après la sortie
async function verifierChabbat(date) {
  const t = date.getTime();
  try {
    const p = (await periodesInterdites()).find(x => t >= x.debut && t <= x.fin);
    return p ? new Date(p.fin + 15 * 60000) : null;
  } catch (e) {
    // Calendrier indisponible : prudence, on bloque du vendredi 15h au samedi 22h (heure de Paris)
    console.error('Posts — calendrier :', e.message);
    const d = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const minutes = d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();
    if (minutes >= 5 * 1440 + 15 * 60 && minutes <= 6 * 1440 + 22 * 60) {
      const samedi = new Date(d); samedi.setDate(d.getDate() + (6 - d.getDay())); 
      const pad = n => String(n).padStart(2, '0');
      return parisVersDate(`${samedi.getFullYear()}-${pad(samedi.getMonth() + 1)}-${pad(samedi.getDate())} 22:15`);
    }
    return null;
  }
}

async function demanderDate(from, s) {
  s.etape = 'date';
  await ctx.sendWhatsApp(from, '📅 Pour quand ?\n\nExemples : « dimanche 10h », « 3 novembre 18h30 », « demain soir 20h ».');
}

async function gererDate(from, s, t) {
  let d;
  try { d = await comprendreDate(t); } catch (e) { d = null; }
  if (!d || isNaN(d.getTime())) { await ctx.sendWhatsApp(from, "Je n'ai pas compris la date 🤔 Écris par exemple « dimanche 10h » ou « 3 novembre 18h30 »."); return; }
  if (d.getTime() < Date.now() + 2 * 60000) { await ctx.sendWhatsApp(from, `Cette heure est déjà passée (${dateLisible(d)}). Donne une date à venir.`); return; }
  if (d.getTime() > Date.now() + 60 * 86400000) { await ctx.sendWhatsApp(from, 'Maximum 60 jours à l\'avance. Donne une date plus proche.'); return; }
  const apres = await verifierChabbat(d);
  if (apres) {
    s.dateProposee = apres.getTime();
    s.etape = 'date_confirmation';
    await ctx.sendWhatsApp(from, `🕯️ ${dateLisible(d)} tombe pendant Chabbat ou une fête : je ne publie pas à ce moment-là.`);
    await ctx.sendWhatsAppButtons(from, `Je te propose juste après la sortie :\n📅 ${dateLisible(apres)}`, [
      { id: 'post_date_ok', title: '✅ Oui' },
      { id: 'post_date_changer', title: '📅 Autre date' }
    ]);
    return;
  }
  s.dateProposee = d.getTime();
  s.etape = 'date_confirmation';
  await ctx.sendWhatsAppButtons(from, `📅 Programmé le ${dateLisible(d)} ?\n\nÀ cette heure-là je publie le post sur Facebook et Instagram${s.story === false ? '' : ', avec la story'}, et je te préviens.`, [
    { id: 'post_date_ok', title: '✅ Oui' },
    { id: 'post_date_changer', title: '📅 Changer la date' }
  ]);
}

async function enregistrerProgramme(from, s) {
  const r = await ctx.pool.query(
    `INSERT INTO posts_programmes (phone, date_publication, contenu) VALUES ($1, $2, $3) RETURNING id`,
    [from, new Date(s.dateProposee), JSON.stringify(contenuSession(s))]
  );
  const quand = dateLisible(s.dateProposee);
  delete sessions[from];
  await ctx.sendWhatsApp(from, `✅ C'est programmé pour le ${quand}.\n\nÉcris « mes posts » pour voir tes posts programmés, ou « annuler post » pour en supprimer un.`);
  return r.rows[0].id;
}

async function listeProgrammes(from) {
  const r = await ctx.pool.query(`SELECT id, date_publication, contenu FROM posts_programmes WHERE statut='programme' ORDER BY date_publication ASC`);
  return r.rows;
}

async function montrerProgrammes(from) {
  const rows = await listeProgrammes(from);
  if (!rows.length) { await ctx.sendWhatsApp(from, '📅 Aucun post programmé pour le moment.\n\nÉcris « post pro » pour en programmer un.'); return; }
  const lignes = rows.map((p, i) => {
    const c = p.contenu || {};
    const debut = String((c.brouillon && c.brouillon.instagram) || '').split('\n')[0].slice(0, 70);
    return `${i + 1}. ${dateLisible(p.date_publication)}\n   ${debut}${(c.photos || []).length ? ` (${c.photos.length} photo${c.photos.length > 1 ? 's' : ''})` : ''}`;
  });
  await ctx.sendWhatsApp(from, `📅 Tes posts programmés :\n\n${lignes.join('\n\n')}\n\nPour en supprimer un : « annuler post 2 »`);
}

async function annulerProgramme(from, numero) {
  const rows = await listeProgrammes(from);
  if (!rows.length) { await ctx.sendWhatsApp(from, '📅 Aucun post programmé.'); return; }
  if (!numero) { await montrerProgrammes(from); return; }
  const p = rows[numero - 1];
  if (!p) { await ctx.sendWhatsApp(from, `Il n'y a pas de post n°${numero}. Écris « mes posts » pour voir la liste.`); return; }
  const r = await ctx.pool.query(`UPDATE posts_programmes SET statut='annule' WHERE id=$1 AND statut='programme' RETURNING id`, [p.id]);
  await ctx.sendWhatsApp(from, r.rows.length ? `🗑️ Post n°${numero} du ${dateLisible(p.date_publication)} annulé.` : 'Ce post est déjà parti ou annulé.');
}

// Message WhatsApp avec vérification (la fenêtre de 24 h peut être fermée) ; sinon e-mail de secours
async function prevenir(phone, texte) {
  let envoye = false;
  try {
    const r = await fetch(`${GRAPH}/${ctx.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: texte } })
    });
    const d = await r.json();
    envoye = Boolean(d && d.messages);
  } catch (e) { /* e-mail ci-dessous */ }
  if (!envoye && ctx.envoyerEmail) {
    const html = '<div style="font-family:Arial,sans-serif;white-space:pre-wrap;">' + texte.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>';
    await ctx.envoyerEmail({ subject: '📅 Post programmé — Shliah Bot', html }).catch(() => {});
  }
}

let publicationEnCours = false;
async function verifierProgrammes() {
  if (publicationEnCours) return;
  publicationEnCours = true;
  try {
    // On « réserve » chaque post avant de le publier : jamais publié deux fois
    const r = await ctx.pool.query(`UPDATE posts_programmes SET statut='en_cours'
      WHERE id IN (SELECT id FROM posts_programmes WHERE statut='programme' AND date_publication <= NOW() ORDER BY date_publication LIMIT 3)
      RETURNING *`);
    for (const p of r.rows) {
      let resultat;
      try {
        // Sécurité : jamais pendant Chabbat / Yom Tov (si les fêtes ont changé entre-temps)
        const apres = await verifierChabbat(new Date());
        if (apres) {
          await ctx.pool.query(`UPDATE posts_programmes SET statut='programme', date_publication=$2 WHERE id=$1`, [p.id, apres]);
          continue;
        }
        const cfg = await configMeta(true);
        if (!cfg.pageToken) throw new Error("publication automatique non configurée");
        const { lignes, ok } = await executerPublication(cfg, p.contenu, { facebook: true, instagram: true });
        resultat = lignes.join('\n\n');
        await ctx.pool.query(`UPDATE posts_programmes SET statut=$2, resultat=$3 WHERE id=$1`, [p.id, ok > 0 ? 'publie' : 'echec', resultat]);
        await prevenir(p.phone, `📅 Ton post programmé du ${dateLisible(p.date_publication)} :\n\n${resultat}`);
      } catch (e) {
        await ctx.pool.query(`UPDATE posts_programmes SET statut='echec', resultat=$2 WHERE id=$1`, [p.id, e.message]);
        await prevenir(p.phone, `⚠️ Ton post programmé du ${dateLisible(p.date_publication)} n'a pas pu partir : ${e.message}\n\nÉcris « post » pour le refaire.`);
      }
    }
  } catch (e) {
    console.error('Posts programmés :', e.message);
  } finally {
    publicationEnCours = false;
  }
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

  // Posts programmés : liste et annulation (à tout moment)
  if (/^mes posts( programm[ée]s)?\s*[?.!]*$/i.test(t)) { await montrerProgrammes(from); return true; }
  const annul = t.match(/^(?:annuler|supprimer|annule|supprime)\s+(?:le\s+)?post\s*(?:n?°?\s*(\d+))?\s*$/i);
  if (annul) { await annulerProgramme(from, annul[1] ? parseInt(annul[1], 10) : null); return true; }

  // « post pro » = post programmé
  const pro = t.match(/^post\s+(?:pro|programm[ée]e?)(?=$|[\s:\-])\s*[:\-]?\s*([\s\S]*)$/i);
  if (pro) {
    s = demarrer(from, pro[1] || '');
    s.programme = true;
    await ctx.sendWhatsApp(from, `📅 Nouveau post PROGRAMMÉ (Instagram + Facebook)\n\nEnvoie-moi les photos (jusqu'à ${MAX_PHOTOS})${s.texte ? '' : ' et un petit texte sur l\'activité'}.\n\nQuand c'est tout, écris « fini ». Je te demanderai ensuite la date.\n\n(« annuler » pour arrêter)`);
    return true;
  }

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
    if (/\b(pas de|sans) story\b/i.test(t)) s.story = false;
    s.texte = (s.texte ? s.texte + '\n' : '') + t;
    await ctx.sendWhatsApp(from, s.photos.length
      ? '📝 Texte noté. Écris « fini » quand c\'est tout.'
      : '📝 Texte noté. Envoie maintenant les photos, puis « fini ».');
    return true;
  }

  if (s.etape === 'date') { await gererDate(from, s, t); return true; }
  if (s.etape === 'date_confirmation') {
    if (/^(oui|ok|valide|confirme)\s*[.!]*$/i.test(t)) { await enregistrerProgramme(from, s); return true; }
    await gererDate(from, s, t); // une autre date
    return true;
  }

  if (s.etape === 'validation' || s.etape === 'modification') {
    if (s.programme && /^(programmer|programme|publier|publie|valider|valide|oui)\s*[.!]*$/i.test(t)) { await demanderDate(from, s); return true; }
    if (/^(pas de|sans) story\s*[.!]*$/i.test(t)) { s.story = false; await ctx.sendWhatsApp(from, '👍 Pas de story pour ce post.'); await boutonsValidation(from, null, s); return true; }
    if (/^(avec( la)?|mets? (une|la)?) ?story\s*[.!]*$/i.test(t)) { s.story = true; await ctx.sendWhatsApp(from, '👍 La couverture sera aussi publiée en story.'); await boutonsValidation(from, null, s); return true; }
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
  if (buttonId === 'post_programmer' || buttonId === 'post_date_changer') return demanderDate(from, s);
  if (buttonId === 'post_date_ok') {
    if (!s.dateProposee) return demanderDate(from, s);
    return enregistrerProgramme(from, s);
  }
  if (buttonId === 'post_annuler') { delete sessions[from]; await ctx.sendWhatsApp(from, '❌ Post annulé.'); return; }
  if (buttonId === 'post_modifier') {
    s.etape = 'modification';
    await ctx.sendWhatsApp(from, '✏️ Dis-moi ce que tu veux changer.\n\nExemples : « plus court », « ajoute que c\'était pour Sim\'hat Torah », « mets la photo 3 en premier », « garde toutes les photos », « enlève la pizza ».\n\nTu peux aussi écrire « insta seulement » ou « facebook seulement » pour publier sur un seul réseau.');
  }
}

function init(options) {
  ctx = options;
  ctx.pool.query(`CREATE TABLE IF NOT EXISTS posts_sociaux (
    id SERIAL PRIMARY KEY, texte_source TEXT, instagram TEXT, facebook TEXT,
    photos JSONB, resultat TEXT, created_at TIMESTAMP DEFAULT NOW())`)
    .then(() => ctx.pool.query(`ALTER TABLE posts_sociaux ADD COLUMN IF NOT EXISTS ig_media_id TEXT, ADD COLUMN IF NOT EXISTS modifie_le TIMESTAMP`))
    .catch(e => console.error('Table posts_sociaux :', e.message));

  ctx.pool.query(`CREATE TABLE IF NOT EXISTS posts_programmes (
    id SERIAL PRIMARY KEY, phone TEXT NOT NULL, date_publication TIMESTAMPTZ NOT NULL,
    contenu JSONB NOT NULL, statut TEXT DEFAULT 'programme', resultat TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW())`)
    .then(() => {
      // Vérification chaque minute (et 30 s après le démarrage, pour rattraper un redémarrage)
      setTimeout(verifierProgrammes, 30000);
      setInterval(verifierProgrammes, 60000);
    })
    .catch(e => console.error('Table posts_programmes :', e.message));

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

  // Onglet « Posts » de l'admin : posts programmés (à venir, en cours, en échec)
  ctx.app.get('/admin/posts/programmes', async (req, res) => {
    if (req.query.password !== ctx.adminPassword) return res.status(401).json({ ok: false });
    try {
      const r = await ctx.pool.query(`SELECT id, date_publication, contenu, statut, resultat, created_at FROM posts_programmes
        WHERE statut IN ('programme','en_cours') OR (statut = 'echec' AND date_publication > NOW() - INTERVAL '30 days')
        ORDER BY date_publication ASC LIMIT 100`);
      res.json({ ok: true, programmes: r.rows });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  // Annuler un post programmé depuis l'admin (même règle que « annuler post » sur WhatsApp)
  ctx.app.post('/admin/posts/programmes/:id/annuler', async (req, res) => {
    if (!req.body || req.body.password !== ctx.adminPassword) return res.status(401).json({ ok: false });
    try {
      const r = await ctx.pool.query(`UPDATE posts_programmes SET statut='annule' WHERE id=$1 AND statut='programme' RETURNING id`, [req.params.id]);
      res.json(r.rows.length ? { ok: true, message: 'Post programmé annulé' } : { ok: false, message: 'Ce post est déjà parti ou annulé.' });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  // Modifier le texte d'un post programmé (avant qu'il parte)
  ctx.app.post('/admin/posts/programmes/:id/modifier', async (req, res) => {
    const b = req.body || {};
    if (b.password !== ctx.adminPassword) return res.status(401).json({ ok: false });
    try {
      const r = await ctx.pool.query(`UPDATE posts_programmes
        SET contenu = jsonb_set(jsonb_set(contenu, '{brouillon,instagram}', to_jsonb($2::text)), '{brouillon,facebook}', to_jsonb($3::text))
        WHERE id=$1 AND statut='programme' RETURNING id`, [req.params.id, String(b.instagram || ''), String(b.facebook || '')]);
      res.json(r.rows.length ? { ok: true, message: 'Texte du post programmé modifié' } : { ok: false, message: 'Ce post est déjà parti ou annulé.' });
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  // Modifier le texte d'un post déjà publié, directement sur Facebook et/ou Instagram
  // (les photos ne peuvent pas être changées par l'API Meta)
  ctx.app.post('/admin/posts/:id/modifier', async (req, res) => {
    const b = req.body || {};
    if (b.password !== ctx.adminPassword) return res.status(401).json({ ok: false });
    try {
      const r = await ctx.pool.query('SELECT * FROM posts_sociaux WHERE id=$1', [req.params.id]);
      const post = r.rows[0];
      if (!post) return res.json({ ok: false, message: 'Post introuvable' });
      const cfg = await configMeta(true);
      if (!cfg.pageToken) return res.json({ ok: false, message: "La variable META_PAGE_TOKEN n'est pas configurée sur Railway." });
      const reponse = { ok: true };
      const fbTexte = typeof b.facebook === 'string' ? b.facebook : post.facebook;
      const igTexte = typeof b.instagram === 'string' ? b.instagram : post.instagram;
      if (b.reseaux && b.reseaux.facebook) {
        const m = String(post.resultat || '').match(/facebook\.com\/(\d+(?:_\d+)?)/);
        if (!m) reponse.facebook = { ok: false, message: 'Post Facebook introuvable' };
        else {
          try { await graphPost(m[1], { message: fbTexte }, cfg.pageToken); reponse.facebook = { ok: true }; }
          catch (e) { reponse.facebook = { ok: false, message: e.message }; }
        }
      }
      if (b.reseaux && b.reseaux.instagram) {
        if (!post.ig_media_id) reponse.instagram = { ok: false, manuel: true, message: "Ce post a été publié avant la mise à jour : Instagram ne peut pas être modifié automatiquement." };
        else {
          try { await graphPost(post.ig_media_id, { caption: igTexte }, cfg.pageToken); reponse.instagram = { ok: true }; }
          catch (e) { reponse.instagram = { ok: false, manuel: true, message: e.message }; }
        }
      }
      // On garde toujours le nouveau texte dans l'historique (même si Instagram doit être corrigé à la main)
      await ctx.pool.query('UPDATE posts_sociaux SET facebook=$2, instagram=$3, modifie_le=NOW() WHERE id=$1', [post.id, fbTexte, igTexte]);
      res.json(reponse);
    } catch (e) { res.json({ ok: false, message: e.message }); }
  });

  console.log('Posts Instagram/Facebook prêts');
  return { handleText, handleImage, handleBouton };
}

module.exports = { init };
