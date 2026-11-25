// Onglet Clips : plein écran, on glisse vers le haut pour le clip suivant (comme TikTok)
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, FlatList, Linking, Pressable, Share, StyleSheet, Text, View, type LayoutChangeEvent, type ListViewToken } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { YouTube } from '../components/YouTube';
import { ecrire, lire, useClips, type Clip } from '../lib/donnees';
import { useRadio } from '../lib/radio';

const mini = (c: Clip) => `https://i.ytimg.com/vi/${c.youtube_id}/hqdefault.jpg`;

export default function Clips() {
  const { liste, etat } = useClips();
  const { enLecture, arreter } = useRadio();
  const ins = useSafeAreaInsets();
  const [hauteur, setHauteur] = useState(0);
  const [actif, setActifBrut] = useState(0);
  const actifRef = useRef(0);
  const [visible, setVisible] = useState(false); // onglet affiché
  const [muet, setMuet] = useState(false);
  const [enPause, setEnPause] = useState(false);
  const [videoVue, setVideoVue] = useState(false);
  const liste$ = useRef<FlatList<Clip>>(null);

  useFocusEffect(useCallback(() => { setVisible(true); return () => setVisible(false); }, []));

  // Une seule chose à la fois : quand un clip joue avec le son, la radio s'arrête
  const quandLecture = () => { setVideoVue(true); if (!muet && enLecture) arreter(); };

  // Nouveau clip à l'écran : on repart de zéro (vidéo cachée tant qu'elle ne joue pas)
  const vus = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const v = viewableItems.find((x) => x.isViewable);
    if (v?.index == null) return;
    const i = v.index;
    if (actifRef.current === i) return;
    actifRef.current = i;
    setActifBrut(i); setVideoVue(false); setEnPause(false);
  }, []);

  const suivant = () => { if (actif + 1 < liste.length) liste$.current?.scrollToIndex({ index: actif + 1, animated: true }); };

  // Guide « Glissez vers le haut » : les 3 premières fois
  const [guide, setGuide] = useState(false);
  const [fondu] = useState(() => new Animated.Value(0));
  const [main] = useState(() => new Animated.Value(0));
  const cacherGuide = useCallback(() => {
    Animated.timing(fondu, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => setGuide(false));
  }, [fondu]);
  useEffect(() => {
    if (!visible || liste.length < 2 || !hauteur) return;
    let fini = false;
    (async () => {
      const n = Number((await lire('guide_clips')) || 0);
      if (n >= 3 || fini) return;
      await ecrire('guide_clips', String(n + 1));
      setTimeout(() => {
        if (fini) return;
        setGuide(true);
        Animated.timing(fondu, { toValue: 1, duration: 300, useNativeDriver: true }).start();
        Animated.loop(Animated.timing(main, { toValue: 1, duration: 1500, useNativeDriver: true })).start();
        // L'écran remonte un peu pour montrer le clip suivant, puis revient
        const coup = (d: number) => setTimeout(() => !fini && liste$.current?.scrollToOffset({ offset: d, animated: true }), 0);
        coup(130); setTimeout(() => coup(0), 650); setTimeout(() => coup(130), 1500); setTimeout(() => coup(0), 2150);
        setTimeout(() => cacherGuide(), 4300);
      }, 800);
    })();
    return () => { fini = true; };
  }, [visible, liste.length, hauteur, fondu, main, cacherGuide]);

  const page = ({ item, index }: { item: Clip; index: number }) => {
    const estActif = index === actif;
    return (
      <View style={{ height: hauteur, backgroundColor: '#000' }}>
        <Image source={mini(item)} style={StyleSheet.absoluteFill} blurRadius={40} contentFit="cover" />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,.45)' }]} />
        <View style={styles.centre}>
          <Pressable style={styles.cadre} onPress={() => setEnPause((p) => !p)} accessibilityLabel={enPause ? 'Lecture' : 'Pause'}>
            <Image source={mini(item)} style={StyleSheet.absoluteFill} contentFit="cover" />
            {estActif && visible && <View style={[StyleSheet.absoluteFill, { opacity: videoVue ? 1 : 0 }]}><YouTube videoId={item.youtube_id} playing={!enPause} muted={muet} onPlaying={quandLecture} onEnded={suivant} /></View>}
            {(!estActif || !videoVue || enPause) && <View style={styles.lecture}><Ionicons name="play" size={30} color="#fff" style={{ marginLeft: 3 }} /></View>}
          </Pressable>
        </View>
        <View style={[styles.infos, { bottom: ins.bottom + 96 }]}>
          <Text style={styles.titreClip} numberOfLines={3}>{item.titre || 'Clip'}</Text>
          {!!item.auteur && <Text style={styles.auteur}>{item.auteur}</Text>}
        </View>
        <View style={[styles.cote, { bottom: ins.bottom + 96 }]}>
          <Rond icone={muet ? 'volume-mute' : 'volume-high'} label={muet ? 'Activer le son' : 'Couper le son'} onPress={() => setMuet((m) => !m)} />
          <Rond icone="share-outline" label="Partager" onPress={() => Share.share({ message: `${item.titre || 'Un clip'} — via Radio Hayous\n${item.lien}` })} />
          <Rond icone="logo-youtube" label="Ouvrir sur YouTube" onPress={() => Linking.openURL(item.lien)} />
        </View>
      </View>
    );
  };

  return (
    <View style={styles.fond} onLayout={(e: LayoutChangeEvent) => setHauteur(e.nativeEvent.layout.height)}>
      {etat !== 'ok' || !liste.length ? (
        <View style={styles.vide}>
          <Ionicons name="play-circle" size={56} color="rgba(255,255,255,.5)" />
          <Text style={styles.videTitre}>{etat === 'erreur' ? 'Pas de connexion' : etat === 'chargement' ? 'Chargement…' : 'Bientôt des clips'}</Text>
          <Text style={styles.videTexte}>{etat === 'erreur' ? 'Réessayez dans un instant.' : 'Les clips de vos chanteurs préférés arrivent ici.'}</Text>
        </View>
      ) : hauteur > 0 && (
        <FlatList
          ref={liste$}
          data={liste}
          keyExtractor={(c) => String(c.id)}
          renderItem={page}
          pagingEnabled
          snapToInterval={hauteur}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: hauteur, offset: hauteur * i, index: i })}
          onViewableItemsChanged={vus}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          onScrollBeginDrag={() => guide && cacherGuide()}
          windowSize={3}
          contentInsetAdjustmentBehavior="never"
        />
      )}
      <View style={[styles.haut, { paddingTop: ins.top + 10 }]} pointerEvents="none">
        <Text style={styles.hautTitre}>Clips</Text>
        {liste.length > 0 && <Text style={styles.hautN}>{actif + 1} / {liste.length}</Text>}
      </View>
      {guide && (
        <Animated.View style={[StyleSheet.absoluteFill, styles.guide, { opacity: fondu }]} pointerEvents="box-none">
          <Pressable style={StyleSheet.absoluteFill} onPress={cacherGuide} />
          <Ionicons name="chevron-up" size={30} color="#fff" />
          <Animated.View style={{ transform: [{ translateY: main.interpolate({ inputRange: [0, 1], outputRange: [40, -50] }) }], opacity: main.interpolate({ inputRange: [0, 0.2, 0.75, 1], outputRange: [0, 1, 1, 0] }) }}>
            <Ionicons name="hand-left" size={64} color="#fff" />
          </Animated.View>
          <Text style={styles.guideTitre}>Glissez vers le haut</Text>
          <Text style={styles.guideTexte}>pour voir le clip suivant</Text>
        </Animated.View>
      )}
    </View>
  );
}

function Rond({ icone, label, onPress }: { icone: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={label} onPress={() => { Haptics.selectionAsync(); onPress(); }} style={({ pressed }) => [styles.rond, pressed && { transform: [{ scale: 0.88 }] }]}>
      <Ionicons name={icone} size={24} color="#fff" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fond: { flex: 1, backgroundColor: '#000' },
  centre: { flex: 1, justifyContent: 'center' },
  cadre: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden' },
  lecture: { position: 'absolute', left: '50%', top: '50%', width: 64, height: 64, marginLeft: -32, marginTop: -32, borderRadius: 32, backgroundColor: 'rgba(0,0,0,.45)', alignItems: 'center', justifyContent: 'center' },
  infos: { position: 'absolute', left: 18, right: 84 },
  titreClip: { color: '#fff', fontSize: 19, fontWeight: '700', lineHeight: 24, textShadowColor: 'rgba(0,0,0,.6)', textShadowRadius: 8 },
  auteur: { color: 'rgba(255,255,255,.85)', fontSize: 15, marginTop: 5 },
  cote: { position: 'absolute', right: 12, gap: 18 },
  rond: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,.16)', alignItems: 'center', justifyContent: 'center' },
  haut: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: 18, paddingBottom: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hautTitre: { color: '#fff', fontSize: 17, fontWeight: '700' },
  hautN: { color: 'rgba(255,255,255,.7)', fontSize: 13, fontWeight: '600' },
  vide: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  videTitre: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 6 },
  videTexte: { color: 'rgba(255,255,255,.75)', fontSize: 16, textAlign: 'center', lineHeight: 22 },
  guide: { backgroundColor: 'rgba(0,0,0,.35)', alignItems: 'center', justifyContent: 'center', gap: 10 },
  guideTitre: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 4 },
  guideTexte: { color: 'rgba(255,255,255,.85)', fontSize: 14 },
});
