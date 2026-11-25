// Lecteur de la radio partagé par toute l'appli :
// lecture en arrière-plan, commandes et titre sur l'écran verrouillé,
// « en ce moment » de chaque radio (mis à jour toutes les 15 s depuis AzuraCast).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { RADIO_URL, STATIONS, fluxAudio, station, type CodeRadio } from './config';

export type EnCeMoment = { titre: string; artiste: string; pochette: string | null; direct: string | null; auditeurs: number };
type Etat = {
  actuelle: CodeRadio | null; // radio choisie (même en pause)
  enLecture: boolean;
  chargement: boolean;
  infos: Partial<Record<CodeRadio, EnCeMoment>>;
  jouer: (code: CodeRadio) => void;
  arreter: () => void;
  basculer: (code: CodeRadio) => void;
};

const Ctx = createContext<Etat | null>(null);

function lireInfos(liste: any[]): Partial<Record<CodeRadio, EnCeMoment>> {
  const out: Partial<Record<CodeRadio, EnCeMoment>> = {};
  for (const s of liste || []) {
    const code = s?.station?.shortcode as CodeRadio;
    if (!STATIONS.some((x) => x.code === code)) continue;
    const song = s?.now_playing?.song || {};
    out[code] = {
      titre: song.title || song.text || '',
      artiste: song.artist || '',
      pochette: song.art ? String(song.art).replace(/^http:/, 'https:') : null,
      direct: s?.live?.is_live ? s.live.streamer_name || 'En direct' : null,
      auditeurs: s?.listeners?.current ?? 0,
    };
  }
  return out;
}

export function RadioProvider({ children }: { children: ReactNode }) {
  const player = useAudioPlayer(null, { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const [actuelle, setActuelle] = useState<CodeRadio | null>(null);
  const [voulu, setVoulu] = useState(false); // l'utilisateur veut écouter
  const [infos, setInfos] = useState<Partial<Record<CodeRadio, EnCeMoment>>>({});
  const dernier = useRef('');

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  }, []);

  // « En ce moment » des 3 radios (toutes les 15 s, et au retour dans l'appli)
  useEffect(() => {
    let vivant = true;
    const rafraichir = () => {
      fetch(`${RADIO_URL}/api/nowplaying`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (vivant && d) setInfos(lireInfos(d)); })
        .catch(() => {});
    };
    rafraichir();
    const t = setInterval(rafraichir, 15000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') rafraichir(); });
    return () => { vivant = false; clearInterval(t); sub.remove(); };
  }, []);

  // Pause / lecture depuis l'écran verrouillé, un appel, un casque… : on suit le lecteur
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.playing) setVoulu(true);
      else if (!s.isBuffering && s.isLoaded && s.currentTime > 0 && s.timeControlStatus === 'paused') setVoulu(false);
    });
    return () => sub.remove();
  }, [player]);

  // Titre / artiste / pochette sur l'écran verrouillé
  useEffect(() => {
    if (!actuelle || !voulu) return;
    const i = infos[actuelle];
    const meta = {
      title: i?.direct ? `🔴 ${i.direct}` : i?.titre || station(actuelle).nom,
      artist: i?.direct ? station(actuelle).nom : i?.artiste || station(actuelle).nom,
      albumTitle: station(actuelle).nom,
      artworkUrl: i?.pochette || undefined,
    };
    const cle = JSON.stringify(meta);
    if (cle === dernier.current) return;
    dernier.current = cle;
    try { player.updateLockScreenMetadata(meta); } catch {}
  }, [infos, actuelle, voulu, player]);

  const jouer = useCallback((code: CodeRadio) => {
    // On repart toujours du direct (pas d'un vieux morceau en mémoire)
    player.replace({ uri: `${fluxAudio(code)}?t=${Date.now()}` });
    const i = infos[code];
    try {
      player.setActiveForLockScreen(true, {
        title: i?.titre || station(code).nom, artist: i?.artiste || station(code).nom,
        albumTitle: station(code).nom, artworkUrl: i?.pochette || undefined,
      }, { isLiveStream: true });
    } catch {}
    dernier.current = '';
    player.play();
    setActuelle(code);
    setVoulu(true);
  }, [player, infos]);

  const arreter = useCallback(() => {
    player.pause();
    setVoulu(false);
  }, [player]);

  const basculer = useCallback((code: CodeRadio) => {
    if (actuelle === code && (status.playing || voulu)) arreter(); else jouer(code);
  }, [actuelle, status.playing, voulu, arreter, jouer]);


  const valeur = useMemo<Etat>(() => ({
    actuelle, enLecture: voulu, chargement: voulu && (status.isBuffering || !status.playing), infos, jouer, arreter, basculer,
  }), [actuelle, voulu, status.isBuffering, status.playing, infos, jouer, arreter, basculer]);

  return <Ctx.Provider value={valeur}>{children}</Ctx.Provider>;
}

export function useRadio() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRadio doit être utilisé dans RadioProvider');
  return c;
}
