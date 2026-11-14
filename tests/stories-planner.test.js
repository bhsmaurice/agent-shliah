'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {init,schedule}=require('../features/stories/stories.planner');
const {paris}=require('../features/stories/stories.server');
test('French schedule recognises days and Paris time without confusing the course time',()=>{
 assert.deepEqual(schedule('Tous les lundis et mercredis à 15h30'),{days:[1,3],time:'15:30'});
 assert.deepEqual(schedule('programme ce visuel tous les mardis à 15h'),{days:[2],time:'15:00'});
 for(const v of ['lundi 25h','lundi 15h90','demain à 15h','lundi'])assert.equal(schedule(v),null);
});
function harness(){let session,plans=[],notified=0;const texts=[],drafts=[],claims=new Set();
 const pool={async query(sql,a=[]){
  if(sql.startsWith('INSERT INTO story_admin_activity'))return {rows:[]};
  if(sql.startsWith('INSERT INTO story_plan_sessions')){session=JSON.parse(a[1]);return {rows:[]};}
  if(sql.startsWith('SELECT data FROM story_plan_sessions'))return {rows:session?[{data:session}]:[]};
  if(sql.startsWith('DELETE FROM story_plan_sessions')){const valid=session&&(!a[1]||JSON.stringify(session)===a[1]);const d=session;if(valid)session=null;return {rows:valid?[{data:d}]:[]};}
  if(sql.startsWith('INSERT INTO story_plans(')){plans.push({id:a[0],owner:a[1],media_id:a[2],days:JSON.parse(a[3]),time:a[4],mode:a[5],targets:JSON.parse(a[6]),revision:1,enabled:true});return {rows:[]};}
  if(sql==='SELECT * FROM story_plans WHERE enabled')return {rows:plans.filter(p=>p.enabled)};
  if(sql.startsWith('SELECT id FROM story_plans'))return {rows:plans.filter(p=>p.id===a[0]&&p.enabled&&p.revision===a[1])};
  if(sql.startsWith('INSERT INTO story_plan_jobs')){const key=a.join(':');if(claims.has(key))return {rows:[]};claims.add(key);return {rows:[{plan_id:a[0]}]};}
  if(sql.startsWith('UPDATE story_plan_jobs'))return {rows:[]};
  if(sql.startsWith('INSERT INTO story_media'))return {rows:[]};
  throw Error(sql);
 }};
 const options={pool,ensureDB:async()=>{},isAdmin:p=>p==='admin',adminPhone:'admin',text:async(p,t)=>texts.push(t),paris,isHolyTime:async()=>false,downloadMedia:async()=>({buffer:Buffer.from('video'),mimeType:'video/mp4'}),createDraft:async(...args)=>{drafts.push(args);return {id:'draft'};},preview:async()=>{throw Error('Must wait for user response');},notifyPlan:async()=>{notified++;},addMusic:async()=>{throw Error('Not used');}};
 return {options,bot:init(options),texts,plans,drafts,get session(){return session;},get notified(){return notified;}};
}
test('only admin creates a persistent plan; confirmation never publishes; weekly ticks only notify once',async()=>{
 const h=harness();assert.equal(await h.bot.handleText('visitor','statut programmer'),false);assert.equal(await h.bot.handleMedia('visitor',{}),false);
 await h.bot.handleText('admin','programme ce visuel tous les lundis à 15h');
 await h.bot.handleMedia('admin',{video:{id:'source'}});
 assert.equal(h.session.step,'mode');
 await h.bot.handleText('admin','vidéo');await h.bot.handleText('admin','les deux');
 assert.equal(h.plans.length,0);assert.match(h.texts.at(-1),/confirmer/);
 await h.bot.handleText('admin','confirmer');assert.equal(h.plans.length,1);assert.equal(h.drafts.length,0);
 const second=init(h.options);
 await Promise.all([h.bot.tick(new Date('2026-11-16T14:00:00Z')),second.tick(new Date('2026-11-16T14:00:00Z'))]);
 assert.equal(h.notified,1);assert.equal(h.drafts.length,1);assert.deepEqual(h.drafts[0][5],['instagram','facebook']);
 await h.bot.tick(new Date('2026-11-23T14:00:00Z'));assert.equal(h.notified,2);
});
test('reminder and manual WhatsApp occurrences have no publishing targets; holy times and late runs are blocked',async()=>{
 const h=harness();h.plans.push({id:'p',owner:'admin',media_id:'m',days:[1],time:'15:00',mode:'reminder',targets:['instagram'],enabled:true,revision:1});
 await init({...h.options,isHolyTime:async()=>true}).tick(new Date('2026-11-16T14:00:00Z'));assert.equal(h.notified,0);
 await h.bot.tick(new Date('2026-11-16T14:16:00Z'));assert.equal(h.notified,0);
 await h.bot.tick(new Date('2026-11-16T14:00:00Z'));assert.deepEqual(h.drafts[0][5],[]);
});
test('normal visitor questions and admin questions outside setup are not intercepted',async()=>{
 const h=harness();assert.equal(await h.bot.handleText('visitor','horaires'),false);assert.equal(await h.bot.handleText('admin','horaires'),false);
});
