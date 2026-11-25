// Onglet Nouveautés : dernières musiques ajoutées + s'inscrire aux notifications
import { useEffect, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { STATIONS, WHATSAPP_BOT, station, type CodeRadio } from '../lib/config';
import { depuis, useNouveautes, type Musique } from '../lib/donnees';
import { activerNotifications, dejaInscrit } from '../lib/notifications';
import { useRadio } from '../lib/radio';

export default function Nouveautes() {
  const { liste, etat, recharger } = useNouveautes();
  const { jouer } = useRadio();
  const sombre = useColorScheme() === 'dark';
  const [filtre, setFiltre] = useState<'tous' | CodeRadio>('tous');
  const [inscrit, setInscrit] = useState(false);
  const [patiente, setPatiente] = useState(false);
  const [maintenant] = useState(() => Date.now());
  useEffect(() => { dejaInscrit().then(setInscrit); }, []);

  const c = { texte: sombre ? '#fff' : '#000', gris: sombre ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)', ligne: sombre ? 'rgba(84,84,88,.5)' : 'rgba(60,60,67,.18)', puce: sombre ? 'rgba(118,118,128,.24)' : 'rgba(118,118,128,.12)' };
  const radios = STATIONS.filter((s) => liste.some((m) => m.radio === s.code));
  const visibles = liste.filter((m) => filtre === 'tous' || m.radio === filtre);

  const sInscrire = async () => {
    setPatiente(true);
    const r = await activerNotifications();
    setPatiente(false);
    if (r.ok) { setInscrit(true); Alert.alert('C’est noté !', 'Vous recevrez une notification à chaque nouvelle musique.'); }
    else Alert.alert('Notifications', r.raison, [
      { text: 'Recevoir par WhatsApp', onPress: () => Linking.openURL(`https://wa.me/${WHATSAPP_BOT}?text=${encodeURIComponent('Je veux recevoir les nouveautés de la radio 🎵')}`) },
      { text: 'OK', style: 'cancel' },
    ]);
  };

  const ligne = ({ item }: { item: Musique }) => {
    const s = station(item.radio);
    const neuf = maintenant / 1000 - item.ajoute < 7 * 86400;
    return (
      <Pressable
        onPress={() => { jouer(item.radio); router.navigate('/'); }}
        accessibilityLabel={`${item.titre}, écouter ${s.nom}`}
        style={({ pressed }) => [styles.ligne, { borderBottomColor: c.ligne, opacity: pressed ? 0.6 : 1 }]}
      >
        <LinearGradient colors={s.couleurs} style={styles.art}>
          {item.pochette ? <Image source={item.pochette} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} /> : <Ionicons name="musical-note" size={24} color="#fff" />}
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.tt, { color: c.texte }]} numberOfLines={1}>{item.titre}</Text>
          <Text style={[styles.mt, { color: c.gris }]} numberOfLines={1}>{item.artiste ? `${item.artiste} · ` : ''}{s.nom} · {depuis(item.ajoute, maintenant)}</Text>
        </View>
        {neuf && <Text style={styles.nouveau}>NOUVEAU</Text>}
      </Pressable>
    );
  };

  const entete = (
    <View>
      <Text style={[styles.titre, { color: c.texte }]}>Nouveautés</Text>
      <Text style={[styles.sous, { color: c.gris }]}>Les dernières musiques ajoutées sur vos radios</Text>
      {!inscrit && (
        <Pressable onPress={sInscrire} disabled={patiente} style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
          <LinearGradient colors={['#ff8a5c', '#e8335e']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.notif}>
            <View style={styles.notifIc}><Ionicons name="notifications" size={24} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.notifT}>{patiente ? 'Un instant…' : 'Être prévenu des nouveautés'}</Text>
              <Text style={styles.notifS}>Une notification à chaque nouvelle musique</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,.85)" />
          </LinearGradient>
        </Pressable>
      )}
      {radios.length > 1 && (
        <View style={styles.puces}>
          {(['tous', ...radios.map((r) => r.code)] as const).map((k) => (
            <Pressable key={k} onPress={() => setFiltre(k)} style={[styles.puce, { backgroundColor: filtre === k ? c.texte : c.puce }]}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: filtre === k ? (sombre ? '#000' : '#fff') : c.texte }}>{k === 'tous' ? 'Toutes' : station(k).nom.replace('Radio ', '')}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: sombre ? '#000' : '#fff' }}
      contentContainerStyle={styles.page}
      contentInsetAdjustmentBehavior="automatic"
      data={visibles}
      keyExtractor={(m, i) => `${m.radio}-${m.ajoute}-${i}`}
      renderItem={ligne}
      ListHeaderComponent={entete}
      ListEmptyComponent={<Text style={[styles.vide, { color: c.gris }]}>{etat === 'chargement' ? 'Chargement…' : etat === 'erreur' ? 'Pas de connexion.\nRéessayez dans un instant.' : 'Pas encore de nouveautés.'}</Text>}
      onRefresh={recharger}
      refreshing={false}
    />
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 120 },
  titre: { fontSize: 36, fontWeight: '800', letterSpacing: -0.6 },
  sous: { fontSize: 16, marginTop: 4, marginBottom: 18 },
  notif: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 18, marginBottom: 18 },
  notifIc: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,.2)', alignItems: 'center', justifyContent: 'center' },
  notifT: { color: '#fff', fontSize: 17, fontWeight: '700' },
  notifS: { color: 'rgba(255,255,255,.9)', fontSize: 13, marginTop: 2 },
  puces: { flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  puce: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  ligne: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  art: { width: 58, height: 58, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tt: { fontSize: 17, fontWeight: '600' },
  mt: { fontSize: 14, marginTop: 2 },
  nouveau: { fontSize: 11, fontWeight: '700', color: '#e8335e', backgroundColor: 'rgba(232,51,94,.1)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  vide: { textAlign: 'center', paddingVertical: 50, fontSize: 16, lineHeight: 22 },
});
