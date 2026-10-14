// ═══════════════════════════════════════════════════════════════
// RÉPERTOIRE — page admin + API
// Page : https://TON-APP.up.railway.app/admin/repertoire
// (page servie directement par Railway : pas de souci de cache GitHub Pages)
// ═══════════════════════════════════════════════════════════════

function init({ app, pool, adminPassword, normaliserTel, viderCacheMetiers }) {
  const ok = (pw) => pw === adminPassword;
  const refus = (res) => res.status(401).json({ ok: false, message: 'Mot de passe incorrect' });
  const propre = (v) => (v && String(v).trim()) || null;

  // ─── Personnes ───────────────────────────────────────────
  app.get('/admin/repertoire/liste', async (req, res) => {
    if (!ok(req.query.password)) return refus(res);
    const r = await pool.query('SELECT * FROM repertoire ORDER BY prenom, nom');
    res.json({ ok: true, personnes: r.rows });
  });

  app.post('/admin/repertoire/ajouter', async (req, res) => {
    const { password, prenom, nom, ville, telephone, metier, note } = req.body;
    if (!ok(password)) return refus(res);
    const tel = normaliserTel(telephone);
    if (!propre(prenom) || tel.length < 9) return res.status(400).json({ ok: false, message: 'Prénom et téléphone requis' });
    try {
      await pool.query(
        'INSERT INTO repertoire (prenom, nom, ville, telephone, metier, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [propre(prenom), propre(nom), propre(ville), tel, propre(metier), propre(note)]);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ ok: false, message: 'Ce numéro est déjà dans le répertoire' });
      throw e;
    }
    viderCacheMetiers();
    res.json({ ok: true, message: 'Ajouté !' });
  });

  app.put('/admin/repertoire/:id', async (req, res) => {
    const { password, prenom, nom, ville, telephone, metier, note, actif } = req.body;
    if (!ok(password)) return refus(res);
    const tel = normaliserTel(telephone);
    if (!propre(prenom) || tel.length < 9) return res.status(400).json({ ok: false, message: 'Prénom et téléphone requis' });
    try {
      await pool.query(
        'UPDATE repertoire SET prenom=$1, nom=$2, ville=$3, telephone=$4, metier=$5, note=$6, actif=$7 WHERE id=$8',
        [propre(prenom), propre(nom), propre(ville), tel, propre(metier), propre(note), actif !== false, req.params.id]);
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ ok: false, message: 'Ce numéro est déjà utilisé par une autre fiche' });
      throw e;
    }
    viderCacheMetiers();
    res.json({ ok: true, message: 'Mis à jour !' });
  });

  app.delete('/admin/repertoire/:id', async (req, res) => {
    if (!ok(req.body.password)) return refus(res);
    await pool.query('DELETE FROM repertoire WHERE id=$1', [req.params.id]);
    viderCacheMetiers();
    res.json({ ok: true, message: 'Supprimé' });
  });

  // Import en masse : une ligne = prénom ; nom ; ville ; téléphone ; métier
  app.post('/admin/repertoire/import', async (req, res) => {
    const { password, texte } = req.body;
    if (!ok(password)) return refus(res);
    let ajoutes = 0, deja = 0, erreurs = [];
    const lignes = String(texte || '').split('\n').map(l => l.trim()).filter(Boolean);
    for (const [i, ligne] of lignes.entries()) {
      const [prenom, nom, ville, telephone, metier] = ligne.split(/[;\t]/).map(x => (x || '').trim());
      const tel = normaliserTel(telephone);
      if (!prenom || tel.length < 9) { erreurs.push('ligne ' + (i + 1)); continue; }
      try {
        const r = await pool.query('INSERT INTO repertoire (prenom, nom, ville, telephone, metier) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telephone) DO NOTHING',
          [prenom, nom || null, ville || null, tel, metier || null]);
        if (r.rowCount) ajoutes++; else deja++;
      } catch (e) { erreurs.push('ligne ' + (i + 1)); }
    }
    viderCacheMetiers();
    res.json({ ok: true, message: `${ajoutes} ajouté(s)` + (deja ? `, ${deja} déjà présent(s)` : '') + (erreurs.length ? ` — erreurs : ${erreurs.slice(0, 10).join(', ')}${erreurs.length > 10 ? '…' : ''}` : '') });
  });

  // ─── Accès ───────────────────────────────────────────────
  app.get('/admin/repertoire/acces', async (req, res) => {
    if (!ok(req.query.password)) return refus(res);
    const r = await pool.query(`
      SELECT repertoire_acces.*, contacts.prenom, contacts.nom
      FROM repertoire_acces LEFT JOIN contacts ON contacts.phone = repertoire_acces.phone`);
    const n = await pool.query('SELECT phone, COUNT(*) AS n FROM repertoire_logs GROUP BY phone');
    const nb = {}; n.rows.forEach(x => { nb[x.phone] = parseInt(x.n, 10); });
    const ordre = { inconnu: 0, bloque: 1, en_attente: 2, valide: 3 };
    const acces = r.rows.map(a => Object.assign(a, { nb_recherches: nb[a.phone] || 0 }))
      .sort((a, b) => (ordre[a.statut] ?? 9) - (ordre[b.statut] ?? 9) || new Date(b.created_at) - new Date(a.created_at));
    res.json({ ok: true, acces });
  });

  app.put('/admin/repertoire/acces', async (req, res) => {
    const { password, phone, statut } = req.body;
    if (!ok(password)) return refus(res);
    const p = normaliserTel(phone);
    if (!p) return res.status(400).json({ ok: false, message: 'Numéro requis' });
    if (statut === 'supprimer') {
      await pool.query('DELETE FROM repertoire_acces WHERE phone=$1', [p]);
    } else if (['valide', 'bloque'].includes(statut)) {
      await pool.query(
        `INSERT INTO repertoire_acces (phone, statut, essais, valide_le) VALUES ($1,$2,0, CASE WHEN $2='valide' THEN NOW() END)
         ON CONFLICT (phone) DO UPDATE SET statut=$2, essais=0, valide_le = CASE WHEN $2='valide' THEN NOW() ELSE repertoire_acces.valide_le END`,
        [p, statut]);
    } else return res.status(400).json({ ok: false, message: 'Statut inconnu' });
    res.json({ ok: true, message: 'OK' });
  });

  app.get('/admin/repertoire/logs', async (req, res) => {
    if (!ok(req.query.password)) return refus(res);
    const r = await pool.query(`
      SELECT l.*, c.prenom, c.nom FROM repertoire_logs l LEFT JOIN contacts c ON c.phone = l.phone
      ORDER BY l.created_at DESC LIMIT 100`);
    res.json({ ok: true, logs: r.rows });
  });

  // ─── Page admin ──────────────────────────────────────────
  app.get('/admin/repertoire', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(PAGE_HTML);
  });

  console.log('📒 Routes admin répertoire prêtes');
}

const PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Répertoire — Shliah Bot</title>
<style>
:root{--violet:#7c3aed;--navy:#1A2540;--bg:#F4F2ED;--muted:#7A8AAA;--border:#E0D8C8;--vert:#16a34a;--rouge:#dc2626;--orange:#d97706}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--navy);font-size:14px}
.wrap{max-width:860px;margin:0 auto;padding:12px 16px}
h1{font-size:18px;margin:4px 0 10px}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tab{padding:6px 12px;border:1px solid var(--border);background:#fff;border-radius:6px;cursor:pointer}
.tab.on{background:var(--navy);color:#fff;border-color:var(--navy)}
.card{background:#fff;border:1px solid var(--border);border-left:4px solid var(--violet);border-radius:6px;padding:8px 10px;margin-bottom:6px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.muted{color:var(--muted);font-size:12px}
input,textarea,select{font:inherit;padding:6px 8px;border:1px solid var(--border);border-radius:5px;width:100%}
textarea{min-height:90px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;margin-bottom:6px}
button{font:inherit;padding:6px 10px;border:0;border-radius:5px;cursor:pointer;background:var(--violet);color:#fff}
button.gris{background:#e5e7eb;color:var(--navy)}button.rouge{background:var(--rouge)}button.vert{background:var(--vert)}
.badge{font-size:11px;padding:2px 6px;border-radius:10px;background:#eee}
.b-valide{background:#dcfce7;color:var(--vert)}.b-bloque{background:#fee2e2;color:var(--rouge)}.b-inconnu{background:#fef3c7;color:var(--orange)}.b-en_attente{background:#e0e7ff;color:#4338ca}
.card.off{opacity:.5}.card.inconnu{border-left-color:var(--orange)}.card.bloque{border-left-color:var(--rouge)}.card.valide{border-left-color:var(--vert)}
#msg{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:var(--navy);color:#fff;padding:8px 14px;border-radius:6px;display:none}
.hide{display:none}
</style></head><body><div class="wrap">
<h1>📒 Répertoire de la communauté</h1>

<div id="login" class="card"><div class="row"><input id="pw" type="password" placeholder="Mot de passe admin" class="grow"><button onclick="connexion()">Entrer</button></div></div>

<div id="app" class="hide">
  <div class="tabs">
    <div class="tab on" data-t="personnes" onclick="onglet('personnes')">Personnes</div>
    <div class="tab" data-t="acces" onclick="onglet('acces')">Accès</div>
    <div class="tab" data-t="logs" onclick="onglet('logs')">Historique</div>
  </div>

  <div id="t-personnes">
    <div class="card">
      <div class="muted" style="margin-bottom:6px">⚠️ Ajoute uniquement les personnes qui ont donné leur accord.</div>
      <div class="grid">
        <input id="f-prenom" placeholder="Prénom *"><input id="f-nom" placeholder="Nom">
        <input id="f-ville" placeholder="Ville"><input id="f-tel" placeholder="Téléphone *">
        <input id="f-metier" placeholder="Métier(s) : plombier, chauffagiste"><input id="f-note" placeholder="Note (facultatif)">
      </div>
      <div class="row"><button id="b-save" onclick="enregistrer()">Ajouter</button><button class="gris hide" id="b-cancel" onclick="resetForm()">Annuler</button>
      <span class="grow"></span><button class="gris" onclick="toggle('import')">Import en masse</button></div>
      <div id="import" class="hide" style="margin-top:8px">
        <div class="muted">Une ligne par personne : prénom ; nom ; ville ; téléphone ; métier (on peut coller depuis Excel)</div>
        <textarea id="import-txt" placeholder="Igal;Cohen;Saint-Maurice;0612345678;plombier"></textarea>
        <button onclick="importer()">Importer</button>
      </div>
    </div>
    <input id="filtre" placeholder="🔍 Chercher..." oninput="afficherPersonnes()" style="margin-bottom:6px">
    <div id="liste"></div>
  </div>

  <div id="t-acces" class="hide">
    <div class="card"><div class="row"><input id="a-tel" placeholder="Numéro à autoriser (ex : 0612345678)" class="grow"><button class="vert" onclick="setAcces(document.getElementById('a-tel').value,'valide')">Autoriser</button></div></div>
    <div id="acces"></div>
  </div>

  <div id="t-logs" class="hide"><div id="logs"></div></div>
</div>
<div id="msg"></div></div>

<script>
let PW='', personnes=[], editId=null;
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tel=d=>{d=String(d||'');return d.startsWith('33')&&d.length===11?('0'+d.slice(2)).replace(/(\\d{2})(?=\\d)/g,'$1 '):'+'+d};
function flash(t){const m=document.getElementById('msg');m.textContent=t;m.style.display='block';setTimeout(()=>m.style.display='none',2500)}
function toggle(id){document.getElementById(id).classList.toggle('hide')}
async function api(method,url,body){
  const opt={method,headers:{'Content-Type':'application/json'}};
  if(method==='GET')url+=(url.includes('?')?'&':'?')+'password='+encodeURIComponent(PW);
  else opt.body=JSON.stringify(Object.assign({password:PW},body||{}));
  const r=await fetch(url,opt);const j=await r.json().catch(()=>({ok:false,message:'Erreur'}));
  if(!j.ok)flash(j.message||'Erreur');return j;
}
async function connexion(){
  PW=document.getElementById('pw').value;
  const j=await api('GET','/admin/repertoire/liste');
  if(!j.ok)return;
  try{sessionStorage.setItem('rep_pw',PW)}catch(e){}
  document.getElementById('login').classList.add('hide');document.getElementById('app').classList.remove('hide');
  personnes=j.personnes;afficherPersonnes();
}
function onglet(t){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.dataset.t===t));
  ['personnes','acces','logs'].forEach(x=>document.getElementById('t-'+x).classList.toggle('hide',x!==t));
  if(t==='acces')chargerAcces();if(t==='logs')chargerLogs();
}
async function chargerPersonnes(){const j=await api('GET','/admin/repertoire/liste');if(j.ok){personnes=j.personnes;afficherPersonnes()}}
function afficherPersonnes(){
  const f=document.getElementById('filtre').value.toLowerCase();
  const l=personnes.filter(p=>!f||[p.prenom,p.nom,p.ville,p.metier,p.telephone].join(' ').toLowerCase().includes(f));
  document.getElementById('liste').innerHTML=l.length?l.map(p=>
    '<div class="card '+(p.actif?'':'off')+'"><div class="row"><div class="grow"><b>'+esc(p.prenom)+' '+esc(p.nom||'')+'</b> '
    +(p.metier?'<span class="badge">🔧 '+esc(p.metier)+'</span> ':'')+(p.actif?'':'<span class="badge">masqué</span>')
    +'<div class="muted">'+esc(p.ville||'—')+' · '+tel(p.telephone)+(p.note?' · '+esc(p.note):'')+'</div></div>'
    +'<button class="gris" onclick="editer('+p.id+')">✎</button>'
    +'<button class="gris" onclick="basculer('+p.id+')">'+(p.actif?'Masquer':'Afficher')+'</button>'
    +'<button class="rouge" onclick="supprimer('+p.id+')">✕</button></div></div>').join('')
    :'<div class="muted">Aucune personne pour l\\'instant.</div>';
}
function lireForm(){return{prenom:v('f-prenom'),nom:v('f-nom'),ville:v('f-ville'),telephone:v('f-tel'),metier:v('f-metier'),note:v('f-note')}}
function v(id){return document.getElementById(id).value.trim()}
function resetForm(){editId=null;['prenom','nom','ville','tel','metier','note'].forEach(k=>document.getElementById('f-'+k).value='');
  document.getElementById('b-save').textContent='Ajouter';document.getElementById('b-cancel').classList.add('hide')}
function editer(id){const p=personnes.find(x=>x.id===id);if(!p)return;editId=id;
  document.getElementById('f-prenom').value=p.prenom||'';document.getElementById('f-nom').value=p.nom||'';
  document.getElementById('f-ville').value=p.ville||'';document.getElementById('f-tel').value=tel(p.telephone);
  document.getElementById('f-metier').value=p.metier||'';document.getElementById('f-note').value=p.note||'';
  document.getElementById('b-save').textContent='Enregistrer';document.getElementById('b-cancel').classList.remove('hide');window.scrollTo(0,0)}
async function enregistrer(){
  const d=lireForm();
  let j;
  if(editId){const p=personnes.find(x=>x.id===editId);j=await api('PUT','/admin/repertoire/'+editId,Object.assign(d,{actif:p?p.actif:true}))}
  else j=await api('POST','/admin/repertoire/ajouter',d);
  if(j.ok){flash(j.message);resetForm();chargerPersonnes()}
}
async function basculer(id){const p=personnes.find(x=>x.id===id);if(!p)return;
  const j=await api('PUT','/admin/repertoire/'+id,{prenom:p.prenom,nom:p.nom,ville:p.ville,telephone:p.telephone,metier:p.metier,note:p.note,actif:!p.actif});
  if(j.ok)chargerPersonnes()}
async function supprimer(id){if(!confirm('Supprimer définitivement ?'))return;const j=await api('DELETE','/admin/repertoire/'+id);if(j.ok){flash('Supprimé');chargerPersonnes()}}
async function importer(){const j=await api('POST','/admin/repertoire/import',{texte:document.getElementById('import-txt').value});
  if(j.ok){flash(j.message);document.getElementById('import-txt').value='';chargerPersonnes()}}
const LIB={valide:'Validé',bloque:'Bloqué',inconnu:'Numéro inconnu',en_attente:'Question en cours'};
async function chargerAcces(){const j=await api('GET','/admin/repertoire/acces');if(!j.ok)return;
  document.getElementById('acces').innerHTML=j.acces.length?j.acces.map(a=>
    '<div class="card '+a.statut+'"><div class="row"><div class="grow"><b>'+esc([a.prenom,a.nom].filter(Boolean).join(' ')||tel(a.phone))+'</b> '
    +'<span class="badge b-'+a.statut+'">'+(LIB[a.statut]||a.statut)+'</span>'
    +'<div class="muted">'+tel(a.phone)+' · '+a.nb_recherches+' recherche(s)'+(a.essais?' · '+a.essais+' mauvaise(s) réponse(s)':'')+'</div></div>'
    +(a.statut!=='valide'?'<button class="vert" onclick="setAcces(\\''+a.phone+'\\',\\'valide\\')">Autoriser</button>':'')
    +(a.statut!=='bloque'?'<button class="rouge" onclick="setAcces(\\''+a.phone+'\\',\\'bloque\\')">Bloquer</button>':'')
    +'<button class="gris" onclick="setAcces(\\''+a.phone+'\\',\\'supprimer\\')" title="Repart de zéro">↺</button></div></div>').join('')
    :'<div class="muted">Personne n\\'a encore demandé l\\'accès.</div>'}
async function setAcces(phone,statut){const j=await api('PUT','/admin/repertoire/acces',{phone,statut});if(j.ok){flash('OK');document.getElementById('a-tel').value='';chargerAcces()}}
async function chargerLogs(){const j=await api('GET','/admin/repertoire/logs');if(!j.ok)return;
  document.getElementById('logs').innerHTML=j.logs.length?j.logs.map(l=>
    '<div class="card"><b>'+esc([l.prenom,l.nom].filter(Boolean).join(' ')||tel(l.phone))+'</b> — '+esc(l.recherche)
    +'<div class="muted">'+new Date(l.created_at).toLocaleString('fr-FR')+' · résultat : '+esc(l.resultat)+'</div></div>').join('')
    :'<div class="muted">Aucune recherche pour l\\'instant.</div>'}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')connexion()});
try{const s=sessionStorage.getItem('rep_pw');if(s){document.getElementById('pw').value=s;connexion()}}catch(e){}
</script></body></html>`;

module.exports = { init };
