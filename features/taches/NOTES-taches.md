# Mon carnet — assistant personnel de Levi (30 octobre 2026)

Réservé au numéro admin. Code : `features/taches/taches.bot.js` (branché dans index.js : texte après « sms », messages vocaux `type === 'audio'`).

## WhatsApp
- « tâche commander les plaques dimanche » → Claude (Haiku, ou TACHES_MODEL) range : titre, dossier, date, heure, personne, notes. Un message peut contenir plusieurs tâches.
- Mots acceptés au début : tâche / tache / todo / à faire / rappel / rappelle-moi / note.
- Message vocal → transcription OpenAI (OPENAI_API_KEY, modèle TRANSCRIPTION_MODEL ou whisper-1) → même rangement. Un vocal peut aussi être une commande (« mes tâches »).
- « mes tâches » (ou « tâches », « mon carnet ») → liste numérotée : en retard / aujourd'hui / cette semaine / plus tard / sans date.
- « fait 2 », « fait 1 et 3 » → cocher. « fait » tout seul juste après un rappel → coche la tâche rappelée.
- « supprimer tâche 2 ».
- « résumé » → résumé du jour tout de suite ; « résumé 7h30 » → change l'heure ; « pas de résumé » → désactive.

## Automatique (vérification chaque minute)
- Résumé du matin (défaut 08:00) : 3 priorités (en retard puis aujourd'hui), le reste en chiffres, + demandes / Cerfa / paiements en attente de l'admin. Vendredi : « à finir avant Chabbat ». Pas envoyé un jour de Chabbat ou de Yom Tov (Hebcal Paris).
- Rappel à l'heure prévue pour les tâches qui ont une heure ; jamais pendant Chabbat/fête (envoyé à la sortie).
- Fenêtre WhatsApp de 24 h : si Levi n'a pas écrit au bot depuis 23 h (ou si WhatsApp refuse), copie par e-mail (Resend, RESEND_TO_EMAIL).

## Base de données
- `taches` (id, titre, dossier, echeance DATE, heure 'HH:MM', personne, notes, statut a_faire/fait/supprime, rappel_envoye, source whatsapp/vocal/admin, created_at, fait_le).
- `taches_config` (heure_resume, resume_envoye, dernier_message).
- Dossiers : Mezouzot et Téfilines, Commandes, Communauté, Dons, Personnel, Autre.

## Admin
- Page « Mon carnet » (sous Accueil, admin seulement) : ajout en phrase libre, filtres par dossier, cocher, modifier (titre, dossier, date, heure de rappel, personne, notes), supprimer, heure du résumé.
- Accueil : encadré « Tes priorités du jour ». Téléphone : « Carnet » dans la barre du bas (à la place de Cerfa, toujours dans le menu).
- Routes : GET /admin/taches, POST /admin/taches ({texte} ou champs), POST /admin/taches/config, POST /admin/taches/:id.

## Étape 2 (prévue)
Relances automatiques (attente de réponse + bouton WhatsApp avec message prêt, numéro retrouvé dans les contacts), projets avec étapes à cocher, tâches qui reviennent (« chaque mois »), bilan du dimanche, message transféré → tâche.
