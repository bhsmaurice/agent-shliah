# SMS (SMSFactor)

Page admin : `https://TON-APP.up.railway.app/admin/sms` (page à part, servie par Railway)

## Ce que ça fait
- **Envoi groupé** : abonnés événements, abonnés Chabbat, tous les contacts du bot, ou une liste de numéros
- **Par WhatsApp (admin)** : `sms` + message → le bot demande à qui → aperçu + prix → ✅ Envoyer
  - `sms 06 12 34 56 78 message` → une seule personne
  - `sms crédits` → solde
- **Secours** : les relances de paiement partent par SMS si WhatsApp ne passe pas
- **Réponses par SMS** (si numéro dédié) : le bot répond comme sur WhatsApp, max 20 réponses/jour/personne, tout est enregistré dans Conversations (préfixe `[SMS]`)
- **STOP** : les désinscrits sont exclus automatiquement
- **Chabbat / Yom Tov** : aucun envoi (calendrier Hebcal, Paris)
- Les emojis sont enlevés et ê â î ô ç simplifiés → 1 SMS au lieu de 2-3

## Deux types de SMS
- **Annonce / appel aux dons** (`marketing`) : SMSFactor ajoute la mention STOP. Interdit la nuit, le dimanche et les jours fériés → SMSFactor décale l'envoi.
- **Information pratique / personnelle** (`alert`) : envoi immédiat, sans STOP. À utiliser seulement pour de la vraie info (horaire changé, colis, rappel perso).

## Variables Railway
| Variable | Obligatoire | Rôle |
|---|---|---|
| `SMSFACTOR_TOKEN` | oui | token API (my.smsfactor.com → Développeurs → Tokens API) |
| `SMS_EXPEDITEUR` | non | nom affiché, 11 caractères max (défaut `BHSMAURICE`, `aucun` = numéro court) |
| `SMS_NUMERO` | non | numéro dédié loué chez SMSFactor (pour les réponses) |
| `SMS_PRIX` | non | prix d'un SMS pour l'estimation (défaut 0.066) |
| `SMS_SECOURS` | non | `off` pour couper le secours WhatsApp → SMS |
| `SMS_REPONSE_AUTO` | non | `off` pour que le bot ne réponde pas aux SMS reçus |

## Webhooks (seulement avec un numéro dédié)
Les deux adresses à coller sur my.smsfactor.com/developers/webhooks sont affichées dans `/admin/sms` → onglet Réglages (types **MO** et **STOP**).

## Fichiers
- `sms.core.js` — numéros, nettoyage du texte, calcul du nombre de SMS
- `sms.server.js` — envoi SMSFactor, tables, routes admin, webhooks, secours, Chabbat
- `sms.bot.js` — commande WhatsApp `sms`
- `sms.admin.js` — page admin
- Tests : `tests/sms.test.js`
