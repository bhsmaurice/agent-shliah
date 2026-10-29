# Posts Instagram + Facebook depuis WhatsApp — Agent Shliah (29 octobre 2026)

## Utilisation (numéro admin seulement)
1. Écrire « post » au bot (ou « post Soirée Sim'hat Torah… » avec le texte direct).
2. Transférer les photos (max 10) + un petit texte (la légende d'une photo compte aussi).
3. Écrire « fini » → le bot rédige un post Instagram ET un post Facebook (style community manager).
4. Boutons : ✅ Publier (les deux réseaux) · ✏️ Modifier · ❌ Annuler.
   - Tout texte écrit à ce moment = demande de modification (« plus court », « plus joyeux »…).
   - « insta seulement » / « facebook seulement » pour un seul réseau.
   - Rien n'est publié sans appuyer sur ✅ Publier.
5. « annuler » à tout moment. Une session expire après 3 h.

## Règles de rédaction
- Toujours « Beth Habad S. Maurice », jamais « Saint-Maurice » (même en hashtag).
- Aucun fait inventé (nombres, noms, dates), personne nommée sur les photos.
- Instagram : accroche, emojis modérés, « 📍 Beth Habad S. Maurice » + 8 à 12 hashtags.
- Facebook : plus développé, invitation + habadsmaurice.com, 2-3 hashtags.

## Technique
- Fichier : `features/posts/posts.bot.js` (branché dans index.js : boutons `post_`, images, texte avant les Lettres Séfer Torah).
- Photos stockées dans la table `medias` (servies par /media/:id) : une version normale + une version recadrée pour Instagram (entre 4:5 et 1,91:1).
- Rédaction : Claude (POSTS_MODEL, défaut claude-sonnet-5-5, repli Haiku) qui regarde jusqu'à 6 photos.
- Publication : API Meta v25.0. Facebook = photos non publiées puis /feed avec attached_media. Instagram = photo seule ou carrousel, puis media_publish.
- Historique : table `posts_sociaux`, consultable via /admin/posts?password=...

## Variables Railway
- META_PAGE_TOKEN (obligatoire pour publier) : jeton de page, ou jeton utilisateur système (la page est retrouvée via /me/accounts).
- META_PAGE_ID (facultatif, si plusieurs pages), META_IG_USER_ID (facultatif, retrouvé depuis la page), POSTS_MODEL (facultatif).
- Sans META_PAGE_TOKEN : le bot renvoie les textes à copier.
- Vérification : https://agent-shliah-production.up.railway.app/admin/posts/verifier?password=MOT_DE_PASSE_ADMIN

## Permissions Meta nécessaires
pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management.
Le compte Instagram doit être professionnel et relié à la page Facebook.
