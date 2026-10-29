// ═══════════════════════════════════════════════════════════════
// SMS — page admin : https://TON-APP.up.railway.app/admin/sms
// (servie directement par Railway : pas de souci de cache GitHub Pages)
// ═══════════════════════════════════════════════════════════════
const PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS — Shliah Bot</title>
<style>
:root{--violet:#7c3aed;--navy:#1A2540;--bg:#F4F2ED;--muted:#7A8AAA;--border:#E0D8C8;--vert:#16a34a;--rouge:#dc2626;--orange:#d97706}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--navy);font-size:14px}
.wrap{max-width:860px;margin:0 auto;padding:12px 16px}
h1{font-size:18px;margin:4px 0 10px}h3{font-size:14px;margin:0 0 6px}
.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}.tab{padding:6px 12px;border:1px solid var(--border);background:#fff;border-radius:6px;cursor:pointer}
.tab.on{background:var(--navy);color:#fff;border-color:var(--navy)}
.card{background:#fff;border:1px solid var(--border);border-left:4px solid var(--violet);border-radius:6px;padding:8px 10px;margin-bottom:6px}
.card.ok{border-left-color:var(--vert)}.card.ko{border-left-color:var(--rouge)}.card.warn{border-left-color:var(--orange)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.muted{color:var(--muted);font-size:12px}
input,textarea,select{font:inherit;padding:6px 8px;border:1px solid var(--border);border-radius:5px;width:100%}
textarea{min-height:110px}
button{font:inherit;padding:6px 12px;border:0;border-radius:5px;cursor:pointer;background:var(--violet);color:#fff}
button.gris{background:#e5e7eb;color:var(--navy)}button.vert{background:var(--vert)}button.rouge{background:var(--rouge)}
button:disabled{opacity:.5;cursor:default}
.badge{font-size:11px;padding:2px 6px;border-radius:10px;background:#eee}
.apercu{white-space:pre-wrap;background:#f8fafc;border:1px dashed var(--border);border-radius:5px;padding:6px 8px;margin-top:6px}
.code{font-family:monospace;font-size:12px;word-break:break-all;background:#f8fafc;padding:4px 6px;border-radius:4px}
#msg{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:var(--navy);color:#fff;padding:8px 14px;border-radius:6px;display:none;z-index:9}
.hide{display:none}label{display:block;margin:6px 0 3px;font-weight:600;font-size:13px}
</style></head><body><div class="wrap">
<h1>📱 SMS — Beth Habad S. Maurice</h1>

<div id="login" class="card"><div class="row"><input id="pw" type="password" placeholder="Mot de passe admin" class="grow"><button onclick="connexion()">Entrer</button></div></div>

<div id="app" class="hide">
  <div id="etat"></div>
  <div class="tabs">
    <div class="tab on" data-t="envoyer" onclick="onglet('envoyer')">Envoyer</div>
    <div class="tab" data-t="historique" onclick="onglet('historique')">Historique</div>
    <div class="tab" data-t="recus" onclick="onglet('recus')">SMS reçus</div>
    <div class="tab" data-t="stop" onclick="onglet('stop')">STOP</div>
    <div class="tab" data-t="reglages" onclick="onglet('reglages')">Réglages</div>
  </div>

  <div id="t-envoyer">
    <div class="card">
      <label>À qui ?</label>
      <select id="cible" onchange="majCible()">
        <option value="abonnes_evenements">📅 Abonnés événements</option>
        <option value="abonnes_chabbat">🕯️ Abonnés Chabbat</option>
        <option value="tous">👥 Tous les contacts du bot</option>
        <option value="liste">✍️ Une personne ou une liste de numéros</option>
      </select>
      <div id="bloc-liste" class="hide"><label>Numéros (un par ligne, ou séparés par des virgules)</label><textarea id="liste" style="min-height:60px" placeholder="06 12 34 56 78" oninput="apercuDiff()"></textarea></div>
      <label>Type de message</label>
      <select id="pushtype" onchange="apercuDiff()">
        <option value="marketing">Annonce, événement, appel aux dons (mention STOP ajoutée, pas la nuit ni le dimanche)</option>
        <option value="alert">Information pratique ou personnelle (envoi immédiat, sans STOP)</option>
      </select>
      <label>Message</label>
      <textarea id="texte" placeholder="Chalom ! Ce soir 20h30 : soirée Hassidout au Beth Habad. Kol Touv !" oninput="apercuDiff()"></textarea>
      <div id="apercu" class="muted" style="margin-top:6px"></div>
      <div class="row" style="margin-top:8px"><span class="grow"></span><button id="b-envoyer" class="vert" onclick="envoyer()" disabled>Envoyer</button></div>
    </div>
    <div class="muted">Les emojis sont enlevés et les lettres ê, â, î, ô, ç sont simplifiées : ça permet de tenir dans 1 SMS au lieu de 2 ou 3. Jamais d'envoi pendant Chabbat et les fêtes.</div>
  </div>

  <div id="t-historique" class="hide"><div id="historique"></div></div>
  <div id="t-recus" class="hide"><div id="recus"></div></div>
  <div id="t-stop" class="hide">
    <div class="card"><div class="row"><input id="stop-tel" class="grow" placeholder="Numéro à ne plus jamais contacter"><button class="rouge" onclick="stop(document.getElementById('stop-tel').value,false)">Ajouter STOP</button></div></div>
    <div id="stops"></div>
  </div>
  <div id="t-reglages" class="hide"><div id="reglages"></div></div>
</div>
<div id="msg"></div></div>

<script>
let PW='',INFO=null,timer=null,dernier=null;
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tel=d=>{d=String(d||'');return d.startsWith('33')&&d.length===11?('0'+d.slice(2)).replace(/(\\d{2})(?=\\d)/g,'$1 '):'+'+d};
const date=d=>new Date(d).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
function flash(t){const m=document.getElementById('msg');m.textContent=t;m.style.display='block';setTimeout(()=>m.style.display='none',3500)}
async function api(method,url,body){
  const opt={method,headers:{'Content-Type':'application/json'}};
  if(method==='GET')url+=(url.includes('?')?'&':'?')+'password='+encodeURIComponent(PW);
  else opt.body=JSON.stringify(Object.assign({password:PW},body||{}));
  const r=await fetch(url,opt);const j=await r.json().catch(()=>({ok:false,message:'Erreur serveur'}));
  if(!j.ok&&j.message)flash(j.message);return j;
}
async function connexion(){
  PW=document.getElementById('pw').value;
  const j=await api('GET','/admin/sms/info');if(!j.ok)return;
  try{sessionStorage.setItem('sms_pw',PW)}catch(e){}
  document.getElementById('login').classList.add('hide');document.getElementById('app').classList.remove('hide');
  INFO=j;afficherEtat();majCible();
}
function afficherEtat(){
  const i=INFO;let h='';
  if(!i.configure)h='<div class="card ko"><b>⚠️ SMSFactor pas encore branché</b><div class="muted">Ajoute la variable SMSFACTOR_TOKEN dans Railway → Variables.</div></div>';
  else if(i.erreurSolde)h='<div class="card ko"><b>⚠️ SMSFactor répond une erreur</b><div class="muted">'+esc(i.erreurSolde)+'</div></div>';
  else h='<div class="card ok"><div class="row"><div class="grow"><b>✅ SMSFactor branché</b> <span class="badge">'+(i.solde.illimite?'illimité':i.solde.credits+' crédits')+'</span></div><span class="muted">Expéditeur : '+esc(i.expediteur)+'</span></div></div>';
  if(i.chabbat)h+='<div class="card warn"><b>🕯️ Chabbat / Yom Tov en cours</b> — les envois reprennent à la sortie.</div>';
  document.getElementById('etat').innerHTML=h;
  const o=document.getElementById('cible').options,c=i.cibles;
  o[0].text='📅 Abonnés événements ('+c.abonnes_evenements+')';o[1].text='🕯️ Abonnés Chabbat ('+c.abonnes_chabbat+')';o[2].text='👥 Tous les contacts du bot ('+c.tous+')';
}
function onglet(t){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.dataset.t===t));
  ['envoyer','historique','recus','stop','reglages'].forEach(x=>document.getElementById('t-'+x).classList.toggle('hide',x!==t));
  if(['historique','recus','stop'].includes(t))chargerHistorique();if(t==='reglages')afficherReglages();
}
function majCible(){
  const c=document.getElementById('cible').value;
  document.getElementById('bloc-liste').classList.toggle('hide',c!=='liste');
  document.getElementById('pushtype').value=c==='liste'?'alert':'marketing';
  apercuDiff();
}
function apercuDiff(){clearTimeout(timer);timer=setTimeout(apercu,400)}
function corps(){return{cible:document.getElementById('cible').value,liste:document.getElementById('liste').value,texte:document.getElementById('texte').value,pushtype:document.getElementById('pushtype').value}}
async function apercu(){
  const b=corps(),btn=document.getElementById('b-envoyer'),z=document.getElementById('apercu');
  if(!b.texte.trim()){z.innerHTML='';btn.disabled=true;return}
  const j=await api('POST','/admin/sms/apercu',b);if(!j.ok)return;dernier=j;
  z.innerHTML='<b>'+j.nb+' destinataire(s)</b> · '+j.sms_par_message+' SMS par personne ('+j.caracteres+' caractères'+(j.unicode?', mode spécial : 70 caractères par SMS':'')+')'
   +' · <b>'+j.total_sms+' crédits</b> ≈ '+j.cout_estime.toFixed(2).replace('.',',')+' €'
   +(j.exclusStop?' · '+j.exclusStop+' exclu(s) STOP':'')+(j.invalides.length?' · <span style="color:var(--rouge)">numéro(s) invalide(s) : '+esc(j.invalides.join(', '))+'</span>':'')
   +'<div class="apercu">'+esc(j.texte)+(b.pushtype==='marketing'?'\\n<span class="muted">+ mention STOP ajoutée automatiquement</span>':'')+'</div>';
  btn.disabled=!j.nb||!INFO.configure;btn.textContent='Envoyer à '+j.nb+' personne(s)';
}
async function envoyer(){
  if(!dernier)return;
  if(!confirm('Envoyer ce SMS à '+dernier.nb+' personne(s) ('+dernier.total_sms+' crédits) ?'))return;
  const btn=document.getElementById('b-envoyer');btn.disabled=true;btn.textContent='Envoi…';
  const j=await api('POST','/admin/sms/envoyer',corps());
  if(j.ok){flash('✅ '+j.message);document.getElementById('texte').value='';document.getElementById('apercu').innerHTML='';const i=await api('GET','/admin/sms/info');if(i.ok){INFO=i;afficherEtat()}}
  else{flash('❌ '+(j.erreur||j.message||'Erreur'));btn.disabled=false;btn.textContent='Envoyer'}
}
const ORIG={admin:'Admin',whatsapp:'Par WhatsApp',reponse_sms:'Réponse du bot',relance_paiement:'Secours relance paiement',secours:'Secours'};
const CIB={abonnes_chabbat:'Abonnés Chabbat',abonnes_evenements:'Abonnés événements',tous:'Tous',liste:'Liste'};
const STAT={envoye:['ok','Envoyé'],partiel:['warn','Partiel'],erreur:['ko','Erreur'],bloque_chabbat:['warn','Bloqué (Chabbat)'],stop:['warn','STOP']};
async function chargerHistorique(){
  const j=await api('GET','/admin/sms/historique');if(!j.ok)return;
  document.getElementById('historique').innerHTML=j.envois.length?j.envois.map(e=>{const s=STAT[e.statut]||['','?'];
    return '<div class="card '+s[0]+'"><div class="row"><div class="grow"><b>'+(e.phone?tel(e.phone):(CIB[e.cible]||e.cible||'—'))+'</b> <span class="badge">'+s[1]+'</span> <span class="badge">'+(ORIG[e.origine]||esc(e.origine))+'</span>'
    +'<div class="muted">'+date(e.created_at)+' · '+e.nb_envoyes+'/'+e.nb_destinataires+' envoyé(s) · '+(+e.cout||0)+' crédit(s)'+(e.erreur?' · '+esc(e.erreur):'')+'</div>'
    +'<div class="apercu">'+esc(e.texte)+'</div></div></div></div>'}).join(''):'<div class="muted">Aucun SMS envoyé pour l\\'instant.</div>';
  document.getElementById('recus').innerHTML=(INFO.numero?'':'<div class="card warn">Pas de numéro dédié : les gens ne peuvent pas encore répondre par SMS. Voir Réglages.</div>')
    +(j.recus.length?j.recus.map(r=>'<div class="card"><b>'+esc([r.prenom,r.nom].filter(Boolean).join(' ')||tel(r.phone))+'</b> <span class="muted">'+date(r.created_at)+'</span>'
    +'<div class="apercu">'+esc(r.message)+'</div>'+(r.reponse?'<div class="muted" style="margin-top:4px">🤖 '+esc(r.reponse)+'</div>':'')+'</div>').join(''):'<div class="muted">Aucun SMS reçu.</div>');
  document.getElementById('stops').innerHTML=j.stops.length?j.stops.map(s=>'<div class="card ko"><div class="row"><div class="grow"><b>'+tel(s.phone)+'</b> <span class="muted">'+date(s.created_at)+'</span></div>'
    +'<button class="gris" onclick="stop(\\''+s.phone+'\\',true)">Retirer</button></div></div>').join(''):'<div class="muted">Personne n\\'a demandé STOP.</div>';
}
async function stop(phone,retirer){if(retirer&&!confirm('Cette personne recevra de nouveau les SMS. Elle est d\\'accord ?'))return;
  const j=await api('POST','/admin/sms/stop',{phone,retirer});if(j.ok){flash(j.message);document.getElementById('stop-tel').value='';chargerHistorique()}}
function afficherReglages(){const i=INFO;
  document.getElementById('reglages').innerHTML=
   '<div class="card"><h3>État</h3><div class="muted">Clé SMSFactor : '+(i.configure?'✅':'❌ manquante')+' · Expéditeur : '+esc(i.expediteur)
   +' · Numéro dédié : '+(i.numero?esc(i.numero):'aucun')+' · Secours WhatsApp → SMS : '+(i.secours?'activé':'coupé')+' · Le bot répond aux SMS : '+(i.reponseAuto?'oui':'non')+'</div></div>'
   +'<div class="card"><h3>Pour que les gens puissent répondre par SMS (plus tard)</h3><div class="muted">1. Louer un numéro dédié chez SMSFactor (7 € HT/mois)<br>2. Railway → Variables : SMS_NUMERO = ce numéro<br>3. Sur my.smsfactor.com/developers/webhooks, créer deux webhooks :</div>'
   +'<div class="muted" style="margin-top:6px">Type <b>MO</b> (réponses) :</div><div class="code">'+esc(i.webhooks.reponses)+'</div>'
   +'<div class="muted" style="margin-top:6px">Type <b>STOP</b> :</div><div class="code">'+esc(i.webhooks.stop)+'</div></div>'
   +'<div class="card"><h3>Par WhatsApp</h3><div class="muted">Écris au bot : <b>sms</b> suivi de ton message → il demande à qui, montre l\\'aperçu et le prix, tu valides.<br><b>sms 06 12 34 56 78 ton message</b> → à une seule personne.<br><b>sms crédits</b> → ton solde.</div></div>';
}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')connexion()});
try{const s=sessionStorage.getItem('sms_pw');if(s){document.getElementById('pw').value=s;connexion()}}catch(e){}
</script></body></html>`;

module.exports = { PAGE_HTML };
