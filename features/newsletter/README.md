# Newsletter du jeudi

Le bot Railway prépare la newsletter sans dépendre d'un ordinateur : premier sommaire WhatsApp le jeudi à 10h, aperçu email à midi pour bhsmaurice@gmail.com, corrections et validation d'une version précise par boutons WhatsApp. Le parcours commence le 19 novembre 2026 ; aucune action ne cible l'édition Toldot déjà prête.

Les textes, affiches et toutes les photos des posts publiés depuis sept jours sont chargés directement dans PostgreSQL. Chaque photo est lue pour la rédaction ; l'ordre est conservé dans l'email. Les annonces/horaires viennent des infos publiques du bot et des corrections de l'administrateur. Une information incertaine bloque la validation. Aucun accès aux contacts, Cerfa, paiements ou infos privées du bot.

Les horaires de Chabbat sont recherchés pour le vendredi/samedi de l'édition, d'abord dans shabbat_horaires à la date exacte, sinon dans l'API officielle Hebcal (Paris, allumage 18 minutes, sortie 8,5 degrés), avec crédit et lien de source dans l'email. Les anciennes constantes du bot ne sont pas réutilisées. Une date, localisation ou paire d'horaires incorrecte/incomplète bloque la validation. Les horaires d'offices restent distincts.

La rédaction réutilise la clé Anthropic du bot. Modèle configurable par NEWSLETTER_AI_MODEL, par défaut claude-sonnet-5-5. Les photos envoyées au modèle sont redimensionnées pour la lecture ; les images de l'email conservent leur source complète. Sharp est déjà une dépendance du projet.

## Connexion Kehila

Ajouter KEHILA_API_KEY dans les variables du service Railway. Créer une clé dédiée avec seulement : messages:read, messages:write, messages:send, email_templates:read, email_templates:write, uploads:write.

La clé lit la configuration de la dernière campagne newsletter observée (99bf6828-f735-4109-aab5-b198457e77b9) pour retrouver l'expéditeur et le ciblage. KEHILA_NEWSLETTER_SOURCE_CAMPAIGN_ID peut désigner une autre campagne existante explicitement vérifiée. L'audience est présentée dans l'aperçu, figée par empreinte et relue avant la programmation. Les ciblages CRM complexes et les ciblages ambigus sont refusés ; aucun remplacement silencieux par tous les contacts.

Après validation seulement : toutes les photos sont téléversées dans Kehila ; un NOUVEAU modèle puis une NOUVELLE campagne sont créés. Le HTML, l'audience, l'expéditeur et la date sont relus. La campagne est mise en file pour le jeudi à 21h30 Europe/Paris. La mise en file ne prouve pas la réception en boîte. Aucun modèle existant n'est modifié et aucun ancien email n'est réenvoyé.

Référence officielle vérifiée : https://api.unisoft.world/integrations/latest/docs et https://api.unisoft.world/integrations/v2/openapi.json?lang=fr. Les mutations historiques de création/envoi n'offrent pas de clé d'idempotence : tout résultat incertain bloque la reprise automatique. Contrôler Kehila avant une intervention manuelle.

## WhatsApp

Commandes administrateur uniquement :
- newsletter : statut / boutons du dernier aperçu
- newsletter ajouter … : compléter les informations, invalider l'aperçu antérieur
- newsletter aperçu : préparer et envoyer une nouvelle version
- newsletter modifier : capturer les corrections dans le prochain message
- annuler : annuler la saisie des corrections en cours
- newsletter renvoyer : retrouver les boutons de la version actuelle
- newsletter programmer : retenter uniquement une programmation déjà approuvée dont le précédent échec est certain et sans mutation ambiguë
- newsletter test : test technique email + WhatsApp, sans édition ni envoi abonnés

Les notifications automatiques utilisent directement le modèle français shliah_newsletter_admin (ou NEWSLETTER_WHATSAPP_TEMPLATE), un paramètre texte normalisé sur une ligne. Il a été soumis en catégorie utilitaire le 12 novembre 2026 sur le compte « Beth habad S Maurice » (1012876561295832, portefeuille Milevcreation). L'approbation doit être vérifiée dans Meta. Une acceptation initiale d'un message libre ne permet pas de détecter tous les refus hors fenêtre : le module ne s'appuie donc pas sur une erreur HTTP 131047 pour choisir le modèle. Après un message/bouton de l'administrateur dans ce processus, les réponses utilisent le format libre/interactif pendant au maximum 23 heures. Un redémarrage privilégie le modèle. La réponse « newsletter » réaffiche les boutons de la version exacte. En cas de refus immédiat, une alerte email remplace la notification.

GET /admin/newsletter/whatsapp-check vérifie en lecture seule que le numéro configuré appartient au compte du modèle, puis renvoie son statut français. NEWSLETTER_WHATSAPP_ACCOUNT_ID permet de désigner un autre compte explicitement vérifié. POST /admin/newsletter/whatsapp-test envoie seulement un test de modèle au numéro administrateur, après vérification de l'approbation ; aucune édition créée/modifiée. Ces routes utilisent X-Admin-Password et ne révèlent aucune clé.

Une acceptation API email/WhatsApp n'est pas une preuve de réception réelle. Le module ne prétend jamais qu'un message est livré en boîte.

## Durabilité et sécurité

Deux tables propres au module : newsletter_editions et newsletter_jobs. Verrou PostgreSQL dédié sur une connexion réservée pour sérialiser jobs/corrections/validation. Les boutons portent l'UUID de l'édition et sa révision. Une version modifiée nécessite un nouvel aperçu et une nouvelle validation. Les jobs horaires sont revendiqués une seule fois et un échec doit être relancé explicitement ; aucun rejeu incertain.

Les routes d'export et le MCP des posts restent strictement en lecture seule. Les nouvelles routes de statut et test sont distinctes et utilisent X-Admin-Password, jamais EXPORT_API_KEY : GET /admin/newsletter/status et POST /admin/newsletter/test. Aucune nouvelle dépendance.

La tâche ChatGPT précédente est à désactiver après déploiement pour éviter deux préparations concurrentes ; la planification se fait maintenant dans le serveur du bot. Les exécutions ratées pendant une extinction Railway ne sont rattrapées que le jeudi avant 21h ; aucune diffusion tardive automatique.

Tests : node --test tests/newsletter.test.js tests/export.test.js tests/export-mcp.test.js. Couvrent fuseaux/CET/CEST, conservation de toutes les images, échappement HTML, refus d'une copie IA incomplète, versions périmées, audience changée, contenu Kehila changé et réponse d'envoi perdue. Le parcours réel Kehila exige une clé configurée ; ne pas le déclarer validé avant test.
