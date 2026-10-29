// ═══════════════════════════════════════════════════════════════
// SMS — page admin : https://TON-APP.up.railway.app/admin/sms
// (servie directement par Railway, même design que Lettres Séfer Torah)
// ═══════════════════════════════════════════════════════════════
const PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS — Beth Habad S. Maurice</title>
<style>
:root{--ink:#253D78;--ink2:#314F91;--muted:#7D8AA4;--line:#DFE6F1;--bg:#F5F7FC;--vert:#618345;--vertbg:#EEF6E8;--or:#98671D;--orbg:#FFFBEF;--orline:#EDDCB0;--rouge:#B14E52;--rougebg:#FCEDEE}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px Arial,Helvetica,sans-serif}
header{max-width:1176px;margin:0 auto;padding:30px 0 25px;display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:14px}.logo{width:46px;height:50px;display:grid;place-items:center;border-radius:13px;background:var(--ink);color:#fff;box-shadow:0 3px 9px #253D7815;flex-shrink:0}.logo svg{width:30px;height:30px}
.brand strong{font-family:'Trebuchet MS',Arial,sans-serif;font-size:27px;line-height:1.2;letter-spacing:-.7px}.caption{display:block;font-size:14px;color:var(--muted);margin-top:4px}
header>a{font-size:14px;color:#7184AA;text-decoration:none;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px;white-space:nowrap}
main{max-width:1240px;margin:0 auto;padding:30px 32px 48px}
h1{font-family:'Trebuchet MS',Arial,sans-serif;font-size:37px;letter-spacing:-1px;margin:0 0 9px}main>p{font-size:16px;line-height:1.8;color:var(--muted);margin:0 0 26px}
h2{font-family:'Trebuchet MS',Arial,sans-serif;font-size:21px;margin:0 0 6px}h3{font-size:15px;margin:0 0 8px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:0 0 28px}
.stat{padding:22px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 3px 14px #253D7804}
.stat span{display:block;font-size:14px;color:var(--muted);margin-bottom:12px}.stat strong{font-family:'Trebuchet MS',Arial,sans-serif;font-size:34px;letter-spacing:-1px}
.stat.fonce{background:var(--ink);border-color:var(--ink);color:#fff;box-shadow:0 7px 22px #253D7810}.stat.fonce span{color:#CCD7ED}
.stat.jaune{background:var(--orbg);border-color:var(--orline)}.stat.jaune strong{color:var(--or)}
button,input,select,textarea{font:15px Arial,Helvetica,sans-serif;border:1px solid var(--line);border-radius:11px;padding:12px 15px;background:#fff;color:var(--ink)}
input,select,textarea{width:100%}textarea{min-height:140px;resize:vertical;line-height:1.6}
button{cursor:pointer;min-height:46px;transition:background .15s,border-color .15s}button:hover{background:#EDF2FD;border-color:#BFCDEB}button:disabled{opacity:.45;cursor:default}
.primary{background:var(--ink);border-color:var(--ink);color:#fff}.primary:hover{background:var(--ink2);color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9FB3EC;outline-offset:3px}
.tabs{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}.tabs button.on{background:var(--ink);border-color:var(--ink);color:#fff}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 3px 14px #253D7804;padding:24px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--muted);margin:18px 0 7px}label:first-child{margin-top:0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.bandeau{border-radius:13px;padding:14px 18px;margin-bottom:18px;font-size:14px;line-height:1.7}.b-ok{background:var(--vertbg);color:var(--vert)}.b-ko{background:var(--rougebg);color:var(--rouge)}.b-or{background:var(--orbg);color:var(--or);border:1px solid var(--orline)}
.apercu{margin-top:16px;padding:16px;border-radius:12px;background:#F4F7FD;font-size:14px;line-height:1.7}
.bulle{white-space:pre-wrap;background:#fff;border:1px solid var(--line);border-radius:14px 14px 14px 4px;padding:12px 14px;margin-top:10px;max-width:420px;font-size:15px}
.chiffres{display:flex;gap:18px;flex-wrap:wrap}.chiffres b{font-size:18px}
.tag{display:inline-block;background:#EDF2FC;color:#5579B0;padding:5px 9px;font-size:11px;border-radius:20px;white-space:nowrap}.t-ok{background:var(--vertbg);color:var(--vert)}.t-ko{background:var(--rougebg);color:var(--rouge)}.t-or{background:#FFF3D5;color:#9C7A24}
.table{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:auto;box-shadow:0 3px 14px #253D7804}
table{border-collapse:collapse;width:100%;min-width:760px;text-align:left}th{padding:17px 16px;font-size:12px;letter-spacing:.4px;color:#8C98AD;background:#FAFBFF}
td{padding:16px;border-top:1px solid #ECF0F6;font-size:14px;vertical-align:top;line-height:1.6}td .txt{white-space:pre-wrap;max-width:420px;color:#4A5D86}
small,.muted{display:block;color:var(--muted);font-size:13px;line-height:1.6}.empty{padding:45px;text-align:center;color:var(--muted)}
.code{font-family:monospace;font-size:13px;word-break:break-all;background:#F4F7FD;padding:10px 12px;border-radius:9px;margin-top:6px}
#login{max-width:420px;margin:70px auto;padding:28px;background:#fff;border-radius:16px;border:1px solid var(--line)}#login input,#login button{margin-top:12px;width:100%}
#msg{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:12px 18px;border-radius:11px;display:none;z-index:9;font-size:14px}
[hidden]{display:none!important}
@media(max-width:1240px){header{margin:0 32px}}
@media(max-width:650px){#login{margin:40px 4%}header{margin:0 4%;padding:18px 0}.brand strong{font-size:18px}main{padding:24px 4%}h1{font-size:26px}.stats{grid-template-columns:1fr 1fr;gap:10px}.stat{padding:15px}.stat strong{font-size:24px}.card{padding:18px}}
</style></head><body>
<header><div class="brand"><span class="logo"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="9" y="3" width="14" height="26" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M14 25.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12.5 9.5h7a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4l-2.5 2v-2h-.5A1.5 1.5 0 0 1 11 15v-4a1.5 1.5 0 0 1 1.5-1.5z" fill="#E8D28E"/></svg></span>
<div><strong>SMS</strong><small class="caption">Beth Habad S. Maurice Plateau</small></div></div>
<a href="/admin/repertoire">Répertoire ↗</a></header>

<form id="login" onsubmit="connexion();return false"><h2>Votre espace SMS</h2><p class="muted">Utilisez le mot de passe de votre admin Shliah Bot.</p>
<input id="pw" type="password" autocomplete="current-password" aria-label="Mot de passe"><button class="primary" type="submit">Ouvrir</button></form>

<main id="app" hidden>
  <h1>Vos messages SMS.</h1>
  <p>Envois à la communauté, historique, réponses reçues et désinscriptions.</p>
  <div id="etat"></div>
  <div class="stats">
    <div class="stat"><span>SMS restants</span><strong id="s-credits">–</strong></div>
    <div class="stat fonce"><span>Envoyés ce mois-ci</span><strong id="s-mois">0</strong></div>
    <div class="stat"><span>Abonnés événements</span><strong id="s-abonnes">0</strong></div>
    <div class="stat jaune"><span>Désinscrits (STOP)</span><strong id="s-stop">0</strong></div>
  </div>

  <div class="tabs">
    <button class="on" data-t="envoyer" onclick="onglet('envoyer')">Envoyer</button>
    <button data-t="historique" onclick="onglet('historique')">Historique</button>
    <button data-t="recus" onclick="onglet('recus')">SMS reçus</button>
    <button data-t="stop" onclick="onglet('stop')">STOP</button>
    <button data-t="reglages" onclick="onglet('reglages')">Réglages</button>
  </div>

  <section id="t-envoyer">
    <div class="card">
      <label for="cible">À qui ?</label>
      <select id="cible" onchange="majCible()">
        <option value="abonnes_evenements">Abonnés événements</option>
        <option value="abonnes_chabbat">Abonnés Chabbat</option>
        <option value="tous">Tous les contacts du bot</option>
        <option value="liste">Une personne ou une liste de numéros</option>
      </select>
      <div id="bloc-liste" hidden><label for="liste">Numéros (un par ligne, ou séparés par des virgules)</label><textarea id="liste" style="min-height:80px" placeholder="06 12 34 56 78" oninput="apercuDiff()"></textarea></div>
      <label for="pushtype">Type de message</label>
      <select id="pushtype" onchange="apercuDiff()">
        <option value="marketing">Annonce, événement, appel aux dons (STOP ajouté, pas la nuit ni le dimanche)</option>
        <option value="alert">Information pratique ou personnelle (envoi immédiat, sans STOP)</option>
      </select>
      <label for="texte">Message</label>
      <textarea id="texte" placeholder="Chalom ! Ce soir 20h30 : soirée Hassidout au Beth Habad. Kol Touv !" oninput="apercuDiff()"></textarea>
      <div id="apercu"></div>
      <div class="row" style="margin-top:18px"><small class="grow">Les emojis sont enlevés et ê, â, î, ô, ç simplifiés pour tenir dans 1 SMS. Jamais d'envoi pendant Chabbat et les fêtes.</small>
      <button id="b-envoyer" class="primary" onclick="envoyer()" disabled>Envoyer</button></div>
    </div>
  </section>

  <section id="t-historique" hidden><div id="historique"></div></section>
  <section id="t-recus" hidden><div id="recus"></div></section>
  <section id="t-stop" hidden>
    <div class="card"><div class="row"><input id="stop-tel" class="grow" placeholder="Numéro à ne plus jamais contacter"><button onclick="stop(document.getElementById('stop-tel').value,false)">Ajouter STOP</button></div></div>
    <div id="stops"></div>
  </section>
  <section id="t-reglages" hidden><div id="reglages"></div></section>
  <button style="margin-top:20px" onclick="deconnexion()">Fermer la session</button>
</main>
<div id="msg" role="status"></div>

<script>
let PW='',INFO=null,timer=null,dernier=null;
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tel=d=>{d=String(d||'');return d.startsWith('33')&&d.length===11?('0'+d.slice(2)).replace(/(\\d{2})(?=\\d)/g,'$1 '):'+'+d};
const date=d=>new Date(d).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(' ','<br>');
const $=id=>document.getElementById(id);
function flash(t){const m=$('msg');m.textContent=t;m.style.display='block';clearTimeout(flash.t);flash.t=setTimeout(()=>m.style.display='none',3500)}
async function api(method,url,body){
  const opt={method,headers:{'Content-Type':'application/json'}};
  if(method==='GET')url+=(url.includes('?')?'&':'?')+'password='+encodeURIComponent(PW);
  else opt.body=JSON.stringify(Object.assign({password:PW},body||{}));
  const r=await fetch(url,opt);const j=await r.json().catch(()=>({ok:false,message:'Erreur serveur'}));
  if(!j.ok&&j.message)flash(j.message);return j;
}
async function connexion(){
  PW=$('pw').value;const j=await api('GET','/admin/sms/info');if(!j.ok)return;
  try{sessionStorage.setItem('sms_pw',PW)}catch(e){}
  $('login').hidden=true;$('app').hidden=false;INFO=j;afficherEtat();majCible();
}
function deconnexion(){try{sessionStorage.removeItem('sms_pw')}catch(e){}location.reload()}
async function rafraichir(){const i=await api('GET','/admin/sms/info');if(i.ok){INFO=i;afficherEtat()}}
function afficherEtat(){
  const i=INFO;let h='';
  if(!i.configure)h='<div class="bandeau b-ko"><b>SMSFactor pas encore branché.</b> Ajoutez la variable SMSFACTOR_TOKEN dans Railway → Variables.</div>';
  else if(i.erreurSolde)h='<div class="bandeau b-ko"><b>SMSFactor répond une erreur :</b> '+esc(i.erreurSolde)+'</div>';
  else h='<div class="bandeau b-ok"><b>SMSFactor branché.</b> Expéditeur affiché : '+esc(i.expediteur)+'</div>';
  if(i.chabbat)h+='<div class="bandeau b-or"><b>Chabbat / Yom Tov en cours</b> — les envois reprennent à la sortie.</div>';
  $('etat').innerHTML=h;
  $('s-credits').textContent=i.solde?(i.solde.illimite?'∞':i.solde.credits):'–';
  $('s-mois').textContent=i.envoyesMois||0;$('s-abonnes').textContent=i.cibles.abonnes_evenements;$('s-stop').textContent=i.stops;
  const o=$('cible').options,c=i.cibles;
  o[0].text='Abonnés événements ('+c.abonnes_evenements+')';o[1].text='Abonnés Chabbat ('+c.abonnes_chabbat+')';o[2].text='Tous les contacts du bot ('+c.tous+')';
}
function onglet(t){
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x.dataset.t===t));
  ['envoyer','historique','recus','stop','reglages'].forEach(x=>$('t-'+x).hidden=x!==t);
  if(['historique','recus','stop'].includes(t))chargerHistorique();if(t==='reglages')afficherReglages();
}
function majCible(){const c=$('cible').value;$('bloc-liste').hidden=c!=='liste';$('pushtype').value=c==='liste'?'alert':'marketing';apercuDiff()}
function apercuDiff(){clearTimeout(timer);timer=setTimeout(apercu,400)}
function corps(){return{cible:$('cible').value,liste:$('liste').value,texte:$('texte').value,pushtype:$('pushtype').value}}
async function apercu(){
  const b=corps(),btn=$('b-envoyer'),z=$('apercu');
  if(!b.texte.trim()){z.innerHTML='';btn.disabled=true;btn.textContent='Envoyer';return}
  const j=await api('POST','/admin/sms/apercu',b);if(!j.ok)return;dernier=j;
  z.innerHTML='<div class="apercu"><div class="chiffres"><span><b>'+j.nb+'</b> destinataire(s)</span><span><b>'+j.sms_par_message+'</b> SMS par personne</span><span><b>'+j.total_sms+'</b> crédit(s) ≈ <b>'+j.cout_estime.toFixed(2).replace('.',',')+' €</b></span></div>'
   +'<small>'+j.caracteres+' caractères'+(j.unicode?' · mode spécial (70 caractères par SMS)':'')+(j.exclusStop?' · '+j.exclusStop+' exclu(s) STOP':'')+'</small>'
   +(j.invalides.length?'<small style="color:var(--rouge)">Numéro(s) invalide(s) : '+esc(j.invalides.join(', '))+'</small>':'')
   +'<div class="bulle">'+esc(j.texte)+(b.pushtype==='marketing'?'\\n<span style="color:var(--muted)">+ mention STOP ajoutée</span>':'')+'</div></div>';
  btn.disabled=!j.nb||!INFO.configure;btn.textContent=j.nb?'Envoyer à '+j.nb+' personne'+(j.nb>1?'s':''):'Envoyer';
}
async function envoyer(){
  if(!dernier)return;
  if(!confirm('Envoyer ce SMS à '+dernier.nb+' personne(s) ('+dernier.total_sms+' crédits) ?'))return;
  const btn=$('b-envoyer');btn.disabled=true;btn.textContent='Envoi…';
  const j=await api('POST','/admin/sms/envoyer',corps());
  if(j.ok){flash('✓ '+j.message);$('texte').value='';$('apercu').innerHTML='';btn.textContent='Envoyer';rafraichir()}
  else{flash(j.erreur||j.message||'Erreur');btn.disabled=false;btn.textContent='Envoyer'}
}
const ORIG={admin:'Page admin',whatsapp:'WhatsApp',reponse_sms:'Réponse du bot',relance_paiement:'Secours relance',secours:'Secours'};
const CIB={abonnes_chabbat:'Abonnés Chabbat',abonnes_evenements:'Abonnés événements',tous:'Tous les contacts',liste:'Liste'};
const STAT={envoye:['t-ok','Envoyé'],partiel:['t-or','Partiel'],erreur:['t-ko','Erreur'],bloque_chabbat:['t-or','Bloqué (Chabbat)'],stop:['t-or','STOP']};
const vide=t=>'<div class="table"><div class="empty">'+t+'</div></div>';
async function chargerHistorique(){
  const j=await api('GET','/admin/sms/historique');if(!j.ok)return;
  $('historique').innerHTML=j.envois.length?'<div class="table"><table><thead><tr><th>DATE</th><th>DESTINATAIRES</th><th>MESSAGE</th><th>ENVOYÉS</th><th>CRÉDITS</th><th>ORIGINE</th><th>STATUT</th></tr></thead><tbody>'
    +j.envois.map(e=>{const s=STAT[e.statut]||['','?'];return '<tr><td>'+date(e.created_at)+'</td><td><b>'+(e.phone?tel(e.phone):esc(CIB[e.cible]||e.cible||'—'))+'</b></td>'
    +'<td><div class="txt">'+esc(e.texte)+'</div>'+(e.erreur?'<small style="color:var(--rouge)">'+esc(e.erreur)+'</small>':'')+'</td><td>'+e.nb_envoyes+' / '+e.nb_destinataires+'</td><td>'+(+e.cout||0)+'</td>'
    +'<td><span class="tag">'+esc(ORIG[e.origine]||e.origine)+'</span></td><td><span class="tag '+s[0]+'">'+s[1]+'</span></td></tr>'}).join('')+'</tbody></table></div>'
    :vide('Aucun SMS envoyé pour l\\'instant.');
  $('recus').innerHTML=(INFO.numero?'':'<div class="bandeau b-or">Pas de numéro dédié : les gens ne peuvent pas encore répondre par SMS (voir Réglages).</div>')
    +(j.recus.length?'<div class="table"><table><thead><tr><th>DATE</th><th>DE</th><th>MESSAGE REÇU</th><th>RÉPONSE DU BOT</th></tr></thead><tbody>'
    +j.recus.map(r=>'<tr><td>'+date(r.created_at)+'</td><td><b>'+esc([r.prenom,r.nom].filter(Boolean).join(' ')||tel(r.phone))+'</b><small>'+tel(r.phone)+'</small></td><td><div class="txt">'+esc(r.message)+'</div></td><td><div class="txt">'+esc(r.reponse||'—')+'</div></td></tr>').join('')
    +'</tbody></table></div>':vide('Aucun SMS reçu.'));
  $('stops').innerHTML=j.stops.length?'<div class="table"><table><thead><tr><th>NUMÉRO</th><th>DEPUIS LE</th><th></th></tr></thead><tbody>'
    +j.stops.map(s=>'<tr><td><b>'+tel(s.phone)+'</b></td><td>'+date(s.created_at)+'</td><td style="text-align:right"><button onclick="stop(\\''+s.phone+'\\',true)">Retirer</button></td></tr>').join('')+'</tbody></table></div>'
    :vide('Personne n\\'a demandé STOP.');
}
async function stop(phone,retirer){if(retirer&&!confirm('Cette personne recevra de nouveau les SMS. Elle est d\\'accord ?'))return;
  const j=await api('POST','/admin/sms/stop',{phone,retirer});if(j.ok){flash(j.message);$('stop-tel').value='';chargerHistorique();rafraichir()}}
function afficherReglages(){const i=INFO;
  $('reglages').innerHTML=
   '<div class="card"><h3>État</h3><small>Clé SMSFactor : '+(i.configure?'branchée':'manquante')+' · Expéditeur : '+esc(i.expediteur)+' · Numéro dédié : '+(i.numero?esc(i.numero):'aucun')
   +'<br>Secours WhatsApp → SMS : '+(i.secours?'activé':'coupé')+' · Le bot répond aux SMS : '+(i.reponseAuto?'oui':'non')+'</small></div>'
   +'<div class="card"><h3>Par WhatsApp</h3><small>Écrivez au bot <b>sms</b> suivi du message : il demande à qui, montre l\\'aperçu et le prix, vous validez.<br><b>sms 06 12 34 56 78 message</b> → une seule personne · <b>sms crédits</b> → le solde.</small></div>'
   +'<div class="card"><h3>Pour que les gens puissent répondre par SMS (plus tard)</h3><small>1. Louer un numéro dédié chez SMSFactor (7 € HT/mois)<br>2. Railway → Variables : SMS_NUMERO = ce numéro<br>3. Sur my.smsfactor.com → Webhooks, créer ces deux webhooks :</small>'
   +'<label>Type MO (réponses)</label><div class="code">'+esc(i.webhooks.reponses)+'</div><label>Type STOP</label><div class="code">'+esc(i.webhooks.stop)+'</div></div>';
}
try{const s=sessionStorage.getItem('sms_pw');if(s){$('pw').value=s;connexion()}}catch(e){}
</script></body></html>`;

module.exports = { PAGE_HTML };
