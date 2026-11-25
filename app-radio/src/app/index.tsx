// Onglet Radio : les 3 radios, ce qui passe en ce moment, lecture / arrêt
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STATIONS, type Station } from '../lib/config';
import { useRadio } from '../lib/radio';

function Carte({ s }: { s: Station }) {
  const { actuelle, enLecture, chargement, infos, basculer } = useRadio();
  const active = actuelle === s.code && enLecture;
  const i = infos[s.code];
  const ligne = i?.direct ? `🔴 En direct · ${i.direct}` : i?.titre ? `${i.titre}${i.artiste ? ' · ' + i.artiste : ''}` : s.sousTitre;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${active ? 'Arrêter' : 'Écouter'} ${s.nom}`}
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); basculer(s.code); }}
      style={({ pressed }) => [styles.carteOmbre, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}
    >
      <LinearGradient colors={s.couleurs} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.carte}>
        <View style={styles.pochette}>
          {i?.pochette ? <Image source={i.pochette} style={StyleSheet.absoluteFill} contentFit="cover" transition={300} /> : <Ionicons name="musical-notes" size={30} color="#fff" />}
        </View>
        <View style={styles.texte}>
          <Text style={styles.nom}>{s.nom}</Text>
          <Text style={styles.ligne} numberOfLines={1}>{ligne}</Text>
          {active && <Text style={styles.enDirect}>{chargement ? 'Connexion…' : '● À L’ÉCOUTE'}</Text>}
        </View>
        <View style={styles.bouton}>
          {active && chargement ? <ActivityIndicator color={s.couleurs[1]} /> : <Ionicons name={active ? 'stop' : 'play'} size={26} color={s.couleurs[1]} style={!active && { marginLeft: 3 }} />}
        </View>
      </LinearGradient>
    </Pressable>
  );
}

export default function Radio() {
  const haut = useSafeAreaInsets().top;
  const sombre = useColorScheme() === 'dark';
  return (
    <ScrollView style={{ backgroundColor: sombre ? '#000' : '#fff' }} contentContainerStyle={[styles.page, { paddingTop: haut + 24 }]} contentInsetAdjustmentBehavior="automatic">
      <Text style={[styles.titre, sombre && { color: '#fff' }]}>Radio Hayous</Text>
      <Text style={[styles.sous, sombre && { color: 'rgba(235,235,245,.6)' }]}>Beth Habad S Maurice · touchez une radio pour l’écouter</Text>
      {STATIONS.map((s) => <Carte key={s.code} s={s} />)}
      <Text style={[styles.astuce, sombre && { color: 'rgba(235,235,245,.45)' }]}>La radio continue même écran éteint. Les commandes sont sur l’écran verrouillé.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 120 },
  titre: { fontSize: 36, fontWeight: '800', letterSpacing: -0.6, color: '#000' },
  sous: { fontSize: 16, color: 'rgba(60,60,67,.6)', marginTop: 4, marginBottom: 24 },
  carteOmbre: { marginBottom: 16, borderRadius: 26, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 15, shadowOffset: { width: 0, height: 12 }, elevation: 6 },
  carte: { height: 120, borderRadius: 26, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 14, overflow: 'hidden' },
  pochette: { width: 64, height: 64, borderRadius: 14, backgroundColor: 'rgba(255,255,255,.22)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  texte: { flex: 1, minWidth: 0 },
  nom: { color: '#fff', fontSize: 22, fontWeight: '800' },
  ligne: { color: 'rgba(255,255,255,.9)', fontSize: 14, marginTop: 3 },
  enDirect: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginTop: 6 },
  bouton: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  astuce: { textAlign: 'center', color: 'rgba(60,60,67,.45)', fontSize: 13, marginTop: 8, lineHeight: 18 },
});
