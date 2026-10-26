'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {notifications,emailTemplate,heroAttachment}=require('../features/lettres-sefer-torah/notifications');
const order={id:'490c8950-4c3b-4ff6-916b-151b2c738c10',email:'parent@example.org',payment_status:'paid',diploma_status:'registered',children:[{name:'Sarah',surname:'Exemple'}],total_cents:1900,donation_cents:1800};
function setup(initial={...order},deliveries=[{ok:true}]){
 const jobs=new Map(),sent=[];let current=initial;
 const pool={async query(sql,args=[]){
  if(sql.startsWith('CREATE TABLE'))return{rows:[]};
  if(sql.startsWith('INSERT INTO lettres_notifications')){const key=args.join(':');if(!jobs.has(key))jobs.set(key,{order_id:args[0],kind:args[1],state:'pending',attempts:0});return{rows:[]};}
  if(sql.startsWith('WITH jobs AS')){const selected=[...jobs.values()].filter(j=>(!args[0]||j.order_id===args[0])&&j.state==='pending'&&j.attempts<5);selected.forEach(j=>{j.state='sending';j.attempts++});return{rows:selected.map(j=>({...j}))};}
  if(sql.startsWith('SELECT * FROM lettres_orders'))return{rows:current?[current]:[]};
  if(sql.startsWith('UPDATE lettres_notifications')){const j=jobs.get(args[0]+':'+args[1]);if(sql.includes("state='sent'"))j.state='sent';else if(sql.includes("state='failed'"))j.state='failed';else if(sql.includes("state='skipped'"))j.state='skipped';return{rows:[]};}
  throw Error(sql);
 }};
 const feature=notifications({pool,send:async msg=>{sent.push(msg);return deliveries.shift()||{ok:true}},attachment:async()=>({filename:'hero.png',content:Buffer.from('image'),cid:'lettres-sofer'})});
 return{feature,jobs,sent,setOrder:o=>{current=o}};
}
test('Une notification par étape, même après doubles appels et traitements concurrents',async()=>{const h=setup();await h.feature.queue(order,'confirmed');await h.feature.queue(order,'confirmed');await Promise.all([h.feature.flush(),h.feature.flush()]);await h.feature.queue(order,'confirmed');await h.feature.flush();assert.equal(h.sent.length,1);assert.equal([...h.jobs.values()][0].state,'sent');assert.equal(h.sent[0].to,order.email);assert.match(h.sent[0].idempotencyKey,/confirmed-v1$/);assert.equal(h.sent[0].attachments[0].cid,'lettres-sofer');});
test('Ni paiement en attente ni adresse absente ne déclenchent un e-mail',async()=>{const h=setup();await h.feature.queue({...order,payment_status:'pending'},'confirmed');await h.feature.queue({...order,email:null},'confirmed');await h.feature.flush();assert.equal(h.jobs.size,0);assert.equal(h.sent.length,0);});
test('Échec réel conservé, reprise avec la même clé et aucun faux succès',async()=>{const h=setup({...order},[{ok:false,error:'Service indisponible'},{ok:true}]);await h.feature.queue(order,'confirmed');await h.feature.flush();const job=[...h.jobs.values()][0];assert.equal(job.state,'failed');job.state='pending';await h.feature.flush();assert.equal(job.state,'sent');assert.equal(h.sent[0].idempotencyKey,h.sent[1].idempotencyKey);assert.equal(h.sent[0].html,h.sent[1].html);});
test('Une étape transmise dépassée ne part plus, disponibilité réservée au statut reçu',async()=>{const h=setup({...order,diploma_status:'available'});await h.feature.queue(order,'registered');await h.feature.queue(order,'available');await h.feature.flush();assert.equal(h.sent.length,1);assert.match(h.sent[0].subject,/attend au Beth Habad/);assert.equal([...h.jobs.values()].find(j=>j.kind==='registered').state,'skipped');});
test('Les trois modèles échappent les noms et distinguent paiement, transmission et retrait',()=>{for(const kind of ['confirmed','registered','available']){const m=emailTemplate({...order,children:[{name:'<script>alert(1)</script>',surname:'A&B'}]},kind);assert(!m.html.includes('<script>'));assert(m.html.includes('&lt;script&gt;'));assert(m.html.includes('A&amp;B'));assert(m.html.includes('cid:lettres-sofer'));assert(m.html.includes('#253d78'));}assert.match(emailTemplate(order,'confirmed').html,/ne constitue pas un diplôme/);assert.match(emailTemplate(order,'available').html,/passer les récupérer/);});
test('L’illustration du site et sa plume forment une image PNG intégrée à l’e-mail',async()=>{const a=await heroAttachment();assert.equal(a.cid,'lettres-sofer');assert.equal(a.content.subarray(1,4).toString(),'PNG');assert(a.content.length>10000);});
