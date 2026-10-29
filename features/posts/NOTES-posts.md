# Posts Instagram + Facebook depuis WhatsApp — Agent Shliah (29 octobre 2026)

## Utilisation (numéro admin seulement)
1. Écrire « post » au bot (ou « post Soirée Sim'hat Torah… » avec le texte direct).
2. Transférer les photos (max 10) + un petit texte (la légende d'une photo compte aussi).
3. Écrire « fini » → le bot (community manager) :
   - choisit les photos et leur ordre (couverture = visages/groupe/ambiance plutôt qu'un plat ; retire floues/doublons ; garde au moins 3 photos s'il y en a 3+),
   - envoie l'aperçu des photos dans l'ordre (n°1 = couverture, version recadrée Instagram) + un conseil qui explique son choix,
   - rédige le post Instagram ET le post Facebook.
4. Boutons : ✅ Publier (les deux réseaux) · ✏️ Modifier · ❌ Annuler.
   - Tout texte écrit à ce moment = demande de modification, textes ou photos (« plus court », « garde toutes les photos », « mets la 3 en premier »). Les numéros = positions de l'aperçu. L'aperçu est renvoyé si l'ordre change.
   - « insta seulement » / « facebook seulement » pour un seul réseau.
   - Rien n'est publié sans appuyer sur ✅ Publier.
5. « annuler » à tout moment. Une session expire après 3 h.

## Posts programmés (« post pro »)
- « post pro » (ou « post programmé ») → même parcours (photos, texte, « fini », aperçu), puis bouton 📅 Programmer → « Pour quand ? ».
- Date en langage naturel (« dimanche 10h », « 3 novembre 18h30 », « demain soir ») comprise par Claude Haiku, en heure de Paris (heure d'été gérée). Sans heure = 10h00. Max 60 jours, minimum 2 minutes dans le futur.
- Confirmation avec boutons ✅ Oui / 📅 Changer la date.
- Chabbat et Yom Tov interdits : calendrier Hebcal (Paris, allumage 18 min avant) ; une date pendant Chabbat/fête → proposition 15 min après la sortie. Si Hebcal est injoignable : blocage prudent du vendredi 15h au samedi 22h. Revérification juste avant la publication (si c'est Chabbat, le post est décalé après la sortie).
- « mes posts » = liste des posts programmés ; « annuler post 2 » = supprimer le n°2.
- Table `posts_programmes` (statut programme / en_cours / publie / echec / annule). Vérification chaque minute + 30 s après chaque démarrage (rien n'est perdu si Railway redémarre). Le post est réservé (en_cours) avant publication : jamais publié deux fois.
- À la publication : message WhatsApp à Levi avec les liens ; si la fenêtre WhatsApp de 24 h est fermée, e-mail de secours (Resend, bhsmaurice@gmail.com).

## Story (automatique)
- Après publication, la photo de couverture est publiée en story Instagram ET Facebook : format 1080×1920, fond = la photo floutée, photo entière au centre, bandeau blanc avec le logo (logo-bh.png à la racine du dépôt).
- « pas de story » (dans le texte ou avant de valider) pour l'enlever, « avec story » pour la remettre.
- Une story ratée n'empêche pas le post. Pas de stickers/lien/musique possibles via l'API.

## Tags Instagram
- Écrire les comptes dans le message : « tag @moshe.cohen @sarah_levy ». Ils sont identifiés sur la photo de couverture et mentionnés dans le texte Instagram (pas de @ dans le texte Facebook).
- Facebook ne permet pas d'identifier des personnes via l'API.
- Si Instagram refuse un compte (nom faux, compte privé), le post est republié sans les identifications et le bot le signale.

## Règles de rédaction
- Toujours « Beth Habad S. Maurice », jamais « Saint-Maurice » (même en hashtag).
- Aucun fait inventé (nombres, noms, dates), personne nommée sur les photos.
- Instagram : accroche, emojis modérés, « 📍 Beth Habad S. Maurice » + 8 à 12 hashtags.
- Facebook : plus développé, invitation + habadsmaurice.com, 2-3 hashtags.

## Technique
- Fichier : `features/posts/posts.bot.js` (branché dans index.js : boutons `post_`, images, texte avant les Lettres Séfer Torah).
- Photos stockées dans la table `medias` (servies par /media/:id) : une version normale + une version recadrée pour Instagram (entre 4:5 et 1,91:1).
- Rédaction + choix des photos : Claude (POSTS_MODEL, défaut claude-sonnet-5-5, repli Haiku) voit toutes les photos (max 10), répond en JSON {photos, conseil, instagram, facebook}. Facebook et Instagram sont publiés avec la même sélection, dans le même ordre.
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
