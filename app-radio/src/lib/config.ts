// Adresses et réglages de la radio (un seul endroit à modifier)
export const RADIO_URL = 'https://radio.habadsmaurice.com';
export const BOT_URL = 'https://agent-shliah-production.up.railway.app';
export const WHATSAPP_BOT = '33743564227';

export type CodeRadio = 'hayous' | 'nigounim' | 'calme';

export type Station = {
  code: CodeRadio;
  nom: string;
  sousTitre: string;
  couleurs: [string, string];
  sf: string; // icône SF Symbol (iOS)
  md: string; // icône Material (Android)
};

export const STATIONS: Station[] = [
  { code: 'hayous', nom: 'Radio Hayous', sousTitre: 'La joie, en continu', couleurs: ['#ff8a5c', '#e8335e'], sf: 'music.note', md: 'music_note' },
  { code: 'nigounim', nom: 'Radio Nigounim', sousTitre: 'Les nigounim hassidiques', couleurs: ['#f7b733', '#c56a1a'], sf: 'flame.fill', md: 'local_fire_department' },
  { code: 'calme', nom: 'Radio Calme', sousTitre: 'Pour se poser', couleurs: ['#4facfe', '#6a5af9'], sf: 'moon.stars.fill', md: 'bedtime' },
];

export const station = (code: string) => STATIONS.find((s) => s.code === code) ?? STATIONS[0];
export const fluxAudio = (code: CodeRadio) => `${RADIO_URL}/listen/${code}/radio.mp3`;

export const ROSE = '#e8335e';
