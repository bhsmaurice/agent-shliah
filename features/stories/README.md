# Stories du samedi soir

Module distinct des posts et de la newsletter. Admin : `/admin/stories` sur le serveur du bot, mot de passe existant.

## Fonctionnement

L’administrateur écrit « statu », envoie une image ou un MP4, puis reçoit un aperçu et les boutons Valider / Annuler. Une image reste sans musique ; le MP4 conserve son audio. Les brouillons et sessions sont en PostgreSQL. Les boutons expirent après 12h et sont liés à la révision exacte. La validation publie seulement en stories Instagram et Facebook, jamais dans le fil. Les résultats sont gardés par réseau. En cas d’incertitude après appel Meta, aucun nouvel essai automatique.

Le rendez-vous hebdomadaire se configure dans l’admin. Le samedi de 20h30 à 21h Europe/Paris, après la sortie de Chabbat/Yom Tov vérifiée via le calendrier existant des posts, le bot choisit un nigoun différent de l’édition précédente. Il crée au plus une édition par date et envoie le modèle WhatsApp `shliah_stories_admin` en français, sans paramètre. L’administrateur répond « statu » pour recevoir le clip et valider. Hors de cette plage ou calendrier incertain, aucune préparation. Si la notification est refusée, alerte email administrateur.

## Prérequis

Les accès `META_PAGE_TOKEN`, `META_PAGE_ID` et `META_IG_USER_ID` existants sont réutilisés via `posts.configMeta`. Aucun jeton supplémentaire n’est demandé ni stocké dans le code. `PUBLIC_BASE_URL` doit être HTTPS et accessible à Meta. `STORIES_GRAPH_VERSION` vaut v25.0 par défaut ; `STORIES_WHATSAPP_TEMPLATE` permet un autre modèle explicitement approuvé.

La notification a été soumise à Meta le 14 novembre 2026, identifiant 29509636722002743. Vérifier son approbation avant le test. Aucun envoi abonnés.

## Nigounim sélectionnés

L’admin permet d’enregistrer l’affiche, puis de générer deux clips de 15 secondes avec FFmpeg, fondus audio et crédits visibles :

- Nigoun du Baal Chem Tov, flûte par Nizzan Zvi Cohen : https://commons.wikimedia.org/wiki/File:Niggun_Habaal_Shem_Tov.ogg ; CC BY 4.0.
- Nigoun Hitkachrout de Rabbi Yitzchak Ginsburgh : https://commons.wikimedia.org/wiki/File:Niggun_hitkashrut.wav ; CC BY-SA 4.0, autorisation VRT 2017040810011998. La vidéo adaptée porte la même licence.

Les crédits, liens et modifications sont conservés dans la base, intégrés aux clips et présentés sur `/stories/credits`. L’affiche est conservée intégralement avec marges blanches et une zone de crédits. Deux nigounim alternent automatiquement. Un changement demandé manuellement peut reprendre celui de la semaine précédente. D’autres clips MP4 peuvent être ajoutés avec leur autorisation. Seuls des domaines de médias explicitement autorisés peuvent être importés, sans redirection ; limites de taille et délais appliqués.

Les médias sont publics via une URL UUID aléatoire pour être lus par Meta. N’y déposer aucune information privée. Le mot de passe admin n’est pas sauvegardé par la nouvelle page. La configuration hebdomadaire reste en pause jusqu’à l’activation explicite, qui vérifie les deux clips, le visuel et les accès Meta.

## Tests

`node --check index.js` et `node --test tests/stories.test.js`. Tests des heures Paris été/hiver, rotation, droits administrateur, versions des boutons, endpoints stories, publications partielles et absence de double publication. Faire ensuite une vérification du rendu réel et des connexions sur Railway. L’acceptation API Meta n’est pas une preuve de livraison ou de fin de traitement.

## Limites

Les textes seuls ou exemples ne déclenchent pas encore la création d’un nouveau design. Pas de sélection dans le catalogue musical des applications. Pas de publication automatique en statut WhatsApp : partager le clip reçu depuis le téléphone. Si la sortie de Chabbat est après 21h, le rendez-vous est omis cette semaine. Aucune relance de publication en cas de réponse Meta ambiguë, contrôle humain requis.

## Modes et rappels

L’entrée « Statuts et stories » est accessible sous Communauté dans le panneau admin principal. Elle ouvre la page du module sans transférer de mot de passe dans l’URL.

Réglage habituel (`mode`) et exception pour le prochain samedi seulement (`next_mode`) : `music` = clip avec nigoun ; `image` = visuel sans musique ; `reminder` = notification seule sans contenu à publier. L’exception est consommée uniquement lorsque l’édition hebdomadaire est effectivement créée. Une édition rappel porte `kind=reminder`, `status=reminder`, aucun média et aucun bouton de validation ; le chemin de publication n’accepte jamais cet état. Elle n’exige ni connexion Instagram/Facebook ni clips. Le modèle WhatsApp français sans paramètre est `shliah_stories_rappel` (ou `STORIES_REMINDER_TEMPLATE`), avec email de secours s’il est refusé. La réponse « statu » après un rappel explique le rappel ; « statu nouveau » démarre un envoi manuel. Les réglages existants conservent leur mode musical par défaut.

## Page guidée et connexion depuis l’admin

Deux espaces : création manuelle (image, MP4, texte rendu en image, modèle Chavoua Tov) et programmation (routine du samedi + rappels personnels récurrents). Le son est facultatif ; un nigoun peut être intégré aux images/textes/modèles, et le son d’un MP4 peut être supprimé. Les fichiers importés depuis la page sont limités à 7 Mo. Chaque brouillon conserve les réseaux choisis, puis la validation utilise sa révision exacte. Une sélection WhatsApp seule donne un fichier prêt à partager, aucun appel de publication Meta. Les rappels personnels ont leurs propres jours, heure Paris et texte, une livraison maximum par jour et rappel, avec contrôle Chabbat/Yom Tov et email de secours. Modèle à approuver : `shliah_rappel_personnel`, français, paramètre texte unique dans le corps.

Le menu principal utilise l’authentification admin existante pour obtenir un code aléatoire à usage unique, valable 60 secondes. Seul son hash est stocké. Le code passe dans le fragment du lien, immédiatement effacé par la page après lecture, puis est échangé contre un cookie de session signé, HttpOnly, Secure, SameSite=Lax, limité au chemin `/admin/stories` et à huit heures. Le mot de passe n’apparaît pas dans l’URL. Les écritures authentifiées par cookie exigent l’origine exacte du bot. Un changement du mot de passe invalide les signatures des sessions précédentes. Le jeton de passage ne peut pas être réutilisé. Aucun mot de passe supplémentaire ni nouvel accès à Meta.

## Programmation depuis WhatsApp (administrateur seulement)

- `statut programmer` ou `programme ce visuel tous les lundis à 15h` : envoyer ensuite l'image ou la vidéo, choisir les jours et l'heure de notification (Europe/Paris), le nigoun/sans musique/rappel et les réseaux, puis écrire `confirmer`.
- `statut programmes` : liste et codes ; `statut modifier CODE` : modifier les jours, l'heure et les options du même visuel ; `statut arrêter CODE` : désactiver la programmation et ses aperçus encore en attente.
- `statut annuler` : quitter la préparation sans changer les programmations existantes.
- Chaque échéance crée un aperçu à valider, jamais une publication directe. Hors fenêtre WhatsApp, le modèle `shliah_rappel_personnel` invite à répondre `statu` pour ouvrir l'aperçu. Il doit être approuvé par Meta ; sinon email de secours. Dans les 23h suivant un message administrateur, l'aperçu peut être envoyé directement.
- Les occurrences sont uniques par programmation/date/révision, avec une fenêtre de rattrapage de 15 minutes et exclusion Chabbat/Yom Tov. Aucun rattrapage tardif ni nouvel essai automatique après résultat incertain. Modifier/arrêter invalide les aperçus précédents. Les autres utilisateurs ne peuvent ni accéder au dialogue ni valider.
- Les images avec musique utilisent les enregistrements licenciés et leur attribution, composés avec le visuel propre à cette programmation. Les vidéos gardent leur son. « Rappel uniquement » ne propose aucun réseau de publication ; le média est destiné au partage manuel.
