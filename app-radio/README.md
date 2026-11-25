# Radio Hayous — l'appli (iPhone et Android)

Appli de la radio du Beth Habad S Maurice, faite avec Expo.

- **Radio** : Radio Hayous, Radio Nigounim, Radio Calme en direct. La radio continue écran éteint ;
  titre, pochette et commandes sur l'écran verrouillé.
- **Clips** : les clips YouTube envoyés à Shliah Bot, en plein écran, on glisse vers le haut (comme TikTok).
- **Nouveautés** : les dernières musiques ajoutées, et « Être prévenu des nouveautés » (notifications).

Les données viennent de la radio (radio.habadsmaurice.com) et de Shliah Bot (`/radio/clips`,
`/radio/nouveautes`, `/radio/push`). Les adresses sont dans `src/lib/config.ts`.

## Commandes

```bash
npm install
npm run typecheck && npm run lint
npx eas-cli@latest init                        # relie l'appli au compte Expo (une seule fois)
npx eas-cli@latest build -p ios --profile production
npx eas-cli@latest submit -p ios               # envoie sur App Store Connect
npx eas-cli@latest update --branch production  # met à jour les écrans sans repasser par Apple
```
