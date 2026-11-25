import { useEffect } from 'react';
import { DynamicColorIOS, Platform } from 'react-native';
import { NativeTabs } from 'expo-router/native-tabs';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { RadioProvider } from '../lib/radio';
import { ROSE } from '../lib/config';
import '../lib/notifications';

const teinte = Platform.OS === 'ios' ? DynamicColorIOS({ light: ROSE, dark: '#ff5c7f' }) : ROSE;

export default function Racine() {
  // Toucher une notification « nouveauté » ouvre l'onglet Nouveautés
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => router.navigate('/nouveautes'));
    return () => sub.remove();
  }, []);

  return (
    <RadioProvider>
      <NativeTabs tintColor={teinte}>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>Radio</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="dot.radiowaves.left.and.right" md="radio" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="clips">
          <NativeTabs.Trigger.Label>Clips</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="play.rectangle.on.rectangle.fill" md="smart_display" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="nouveautes">
          <NativeTabs.Trigger.Label>Nouveautés</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        </NativeTabs.Trigger>
      </NativeTabs>
    </RadioProvider>
  );
}
