# Lettres Séfer Torah — installation

## Emplacements

- Site public : `https://habadsmaurice.com/lettre-sefer-Torah/`.
- Déposer **uniquement** les deux fichiers de `site/lettre-sefer-Torah/` dans ce dossier : `index.html`, `payment.php`. Le nom du dossier est sensible à la casse.
- Le serveur PHP doit disposer de cURL et pouvoir joindre Railway. Aucun secret à insérer dans ces deux fichiers.
- Serveur Railway : nouvelle fonctionnalité `features/lettres-sefer-torah/`, chargée par `index.js`.
- Onglet dans `admin.html` : « Lettres Séfer Torah », ouvrant `/lettres-sefer-torah` sur le serveur configuré dans Shliah Bot.

## Variables Railway

- `DATABASE_URL`, `ADMIN_PASSWORD`, `STRIPE_SECRET_KEY` : variables déjà utilisées par le bot. Conserver le compte Stripe de la tsédaka.
- `STRIPE_PUBLISHABLE_KEY` : recommandé. À défaut, la clé publique du formulaire de tsédaka existant est reprise. En test, renseigner impérativement la clé publique **test** et la clé secrète **test** du même compte.
- `RESEND_API_KEY` et la configuration e-mail existante : nécessaires pour envoyer les Cerfa.
- `LETTRES_STRIPE_WEBHOOK_SECRET` : secret de signature d’un webhook Stripe recevant `payment_intent.succeeded` à l’adresse `https://agent-shliah-production.up.railway.app/lettres-sefer-torah/stripe-webhook`.
- `LETTRES_FULL_RECEIPT_APPROVED=true` : activer seulement après validation de l’éligibilité fiscale du total lettres + don. Par défaut, le reçu porte sur le don ajouté. Sans don ajouté, aucune demande ni émission n’est autorisée, quel que soit ce réglage. Le montant éligible est figé lors de la première confirmation du règlement.

## Paiements et inscriptions

1. Le serveur valide les enfants, enregistre une commande en attente et recalcule 1 € par enfant + participation.
2. Il crée un PaymentIntent Stripe idempotent. Le formulaire affiche Apple Pay sur les appareils compatibles et une carte bancaire ; aucun débit simulé n’est possible sur la livraison publique.
3. Le serveur vérifie le statut Stripe, la devise, le montant encaissé et la référence de commande. L’inscription n’est marquée payée qu’après ces vérifications.
4. Le webhook signé confirme les paiements même si le parent ferme l’onglet. Le bouton admin « Vérifier les paiements en attente » permet une récupération manuelle si le webhook n’est pas encore configuré.
5. Les commandes en attente ne sont pas comptées comme des inscriptions payées. Aucun détail d’enfant n’est placé dans les métadonnées Stripe.

Apple Pay nécessite l’activation dans Stripe et l’enregistrement du domaine public `habadsmaurice.com` dans les domaines de moyens de paiement Stripe. Vérifier le parcours sur Safari/iPhone compatible après déploiement.

Le diplôme n’est pas créé automatiquement et aucune inscription n’est envoyée à kidstorah.org par ce code. Le tableau permet de suivre « À préparer », « Inscription transmise », « Diplôme envoyé » après traitement effectif par le Beth Habad.

## Cerfa communs

- La demande est enregistrée uniquement pour un paiement confirmé avec don supplémentaire.
- L’administrateur ouvre la fiche et crée le reçu après vérification : il utilise **la table `cerfa_receipts` et le compteur `cerfa_counters` existants**, avec l’origine `lettres`. Aucun fichier de reçus parallèle.
- L’envoi e-mail est déclenché explicitement depuis cette fiche ; le statut « envoyé » n’est écrit qu’après confirmation de succès du service e-mail. Une panne après acceptation de l’e-mail et avant validation en base peut nécessiter une vérification manuelle avant de relancer.
- La génération est protégée par transaction et verrou : une même commande ne reçoit pas deux Cerfa par deux clics simultanés.
- Les reçus émis sont disponibles dans l’onglet Cerfa habituel, avec un nouveau filtre « Lettres Séfer Torah ».

## Accès et limites

Les lectures et actions admin requièrent le mot de passe existant, envoyé dans un en-tête. L’onglet transfère ce mot de passe via le fragment de l’URL (pas dans les journaux HTTP), puis la page retire ce fragment. La session reste dans `sessionStorage`, pas dans le code public.

Le suivi charge les 3 000 derniers règlements ; l’export CSV reprend le filtre courant. Les montants de commande sont répétés sur chaque ligne enfant : ne pas les sommer par ligne. Le suivi des diplômes reste manuel. Aucune modification des autres modules, tables ou reçus existants n’est nécessaire, hormis l’ajout non destructif de l’origine et des tables dédiées.

Les tests utilisent de faux paiements, une base simulée et de faux e-mails. Aucun paiement, aucun message et aucun reçu réels n’a été déclenché pendant la préparation. Tester aussi sur une base PostgreSQL de préproduction et Stripe test avant mise en ligne.

## Validation locale

`node --test tests/lettres.test.js`

`node --check index.js`

`node --check features/lettres-sefer-torah/lettres.server.js`

Vérifier `php -l site/lettre-sefer-Torah/payment.php` sur l’hébergement PHP (PHP n’est pas présent dans l’environnement de préparation).
