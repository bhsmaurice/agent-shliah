// Clips et nouveautés : viennent de Shliah Bot (le même endroit que la page web de la radio)
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BOT_URL, type CodeRadio } from './config';

export type Clip = { id: number; youtube_id: string; titre: string | null; auteur: string | null; lien: string };
export type Musique = { radio: CodeRadio; radio_nom: string; titre: string; artiste: string | null; duree: number; ajoute: number; pochette: string | null };

function useListe<T>(chemin: string, cle: string) {
  const [liste, setListe] = useState<T[]>([]);
  const [etat, setEtat] = useState<'chargement' | 'ok' | 'erreur'>('chargement');
  const [tour, setTour] = useState(0); // « tirer pour actualiser »
  const charger = useCallback(() => setTour((n) => n + 1), []);
  useEffect(() => {
    let vivant = true;
    const aller = () => {
      fetch(`${BOT_URL}${chemin}`)
        .then((r) => r.json())
        .then((d) => { if (vivant) { setListe(d[cle] || []); setEtat('ok'); } })
        .catch(() => { if (vivant) setEtat((e) => (e === 'ok' ? 'ok' : 'erreur')); });
    };
    aller();
    const t = setInterval(aller, 5 * 60 * 1000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') aller(); });
    return () => { vivant = false; clearInterval(t); sub.remove(); };
  }, [chemin, cle, tour]);
  return { liste, etat, recharger: charger };
}

export const useClips = () => useListe<Clip>('/radio/clips', 'clips');
export const useNouveautes = () => useListe<Musique>('/radio/nouveautes', 'musiques');

// Petite mémoire locale (pastilles « nouveau », guide des clips…)
export async function lire(cle: string): Promise<string | null> {
  try { return await AsyncStorage.getItem(cle); } catch { return null; }
}
export async function ecrire(cle: string, valeur: string) {
  try { await AsyncStorage.setItem(cle, valeur); } catch {}
}

export function depuis(ts: number, maintenant: number) {
  const s = maintenant / 1000 - ts;
  if (s < 3600) return "à l'instant";
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const j = Math.floor(s / 86400);
  if (j === 1) return 'hier';
  if (j < 30) return `il y a ${j} j`;
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
