// Notifications des nouveautés : le téléphone s'inscrit auprès de Shliah Bot,
// qui envoie une notification quand l'admin touche « Prévenir les abonnés ».
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { BOT_URL } from './config';
import { ecrire, lire } from './donnees';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export type Resultat = { ok: true } | { ok: false; raison: string };

export async function dejaInscrit() {
  return (await lire('push_token')) !== null;
}

export async function activerNotifications(): Promise<Resultat> {
  if (!Device.isDevice) return { ok: false, raison: 'Les notifications ne marchent que sur un vrai téléphone.' };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('nouveautes', {
      name: 'Nouveautés de la radio', importance: AndroidImportance.DEFAULT, lightColor: '#e8335e',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, raison: 'Les notifications sont refusées. Vous pouvez les autoriser dans Réglages > Radio Hayous > Notifications.' };
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { ok: false, raison: "L'appli n'est pas encore reliée à Expo (projectId manquant)." };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    const r = await fetch(`${BOT_URL}/radio/push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, plateforme: Platform.OS }),
    });
    if (!r.ok) throw new Error(String(r.status));
    await ecrire('push_token', token);
    return { ok: true };
  } catch {
    return { ok: false, raison: 'Pas de connexion. Réessayez dans un instant.' };
  }
}
