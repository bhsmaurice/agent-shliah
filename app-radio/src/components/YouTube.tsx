// Lecteur YouTube officiel (API IFrame) dans une WebView.
// La page est servie « depuis » radio.habadsmaurice.com : YouTube exige une origine pour les vidéos intégrées.
import { useEffect, useMemo, useRef, type ComponentType, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView as WebViewBase, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { RADIO_URL } from '../lib/config';

// Les types de react-native-webview n'acceptent pas encore « ref » ; à l'exécution, il est bien transmis.
type WebViewHandle = { injectJavaScript: (code: string) => void };
const WebView = WebViewBase as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

type Props = {
  videoId: string;
  playing: boolean;
  muted: boolean;
  onPlaying?: () => void;
  onEnded?: () => void;
};

const page = (id: string, muted: boolean) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body><div id="p"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
var player, envoyer = function(m){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(m); };
function onYouTubeIframeAPIReady(){
  player = new YT.Player('p', { width:'100%', height:'100%', videoId:${JSON.stringify(id)},
    playerVars:{ playsinline:1, controls:0, rel:0, modestbranding:1, iv_load_policy:3, fs:0, disablekb:1, autoplay:1, mute:${muted ? 1 : 0}, origin:${JSON.stringify(RADIO_URL)} },
    events:{
      onReady:function(){ envoyer('pret'); },
      onStateChange:function(e){ if(e.data===1) envoyer('lecture'); if(e.data===0) envoyer('fin'); }
    }});
}
window.commande = function(c){ if(!player || !player[c]) return; player[c](); };
</script></body></html>`;

export function YouTube({ videoId, playing, muted, onPlaying, onEnded }: Props) {
  const ref = useRef<WebViewHandle>(null);
  const pret = useRef(false);
  // La page ne change que si la vidéo change (le son et la pause passent par des commandes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => page(videoId, muted), [videoId]);

  const cmd = (c: string) => ref.current?.injectJavaScript(`window.commande(${JSON.stringify(c)});true;`);
  useEffect(() => { if (pret.current) cmd(playing ? 'playVideo' : 'pauseVideo'); }, [playing]);
  useEffect(() => { if (pret.current) cmd(muted ? 'mute' : 'unMute'); }, [muted]);

  const message = (e: WebViewMessageEvent) => {
    const m = e.nativeEvent.data;
    if (m === 'pret') { pret.current = true; cmd(muted ? 'mute' : 'unMute'); cmd(playing ? 'playVideo' : 'pauseVideo'); }
    if (m === 'lecture') onPlaying?.();
    if (m === 'fin') onEnded?.();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ html, baseUrl: RADIO_URL }}
        onMessage={message}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo={false}
        scrollEnabled={false}
        bounces={false}
        style={styles.web}
        originWhitelist={['*']}
      />
    </View>
  );
}

const styles = StyleSheet.create({ web: { flex: 1, backgroundColor: '#000' } });
