'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { due, paris, choose, parseButton, init, effectiveMode } = require('../features/stories/stories.server');
test('Paris schedule respects winter, summer, Saturday and Shabbat end', () => {
  assert.equal(due(new Date('2026-11-14T19:30:00Z'), 1080), true);
  assert.equal(due(new Date('2026-11-14T19:29:00Z'), 1080), false);
  assert.equal(due(new Date('2026-11-14T20:01:00Z'), 1080), false);
  assert.equal(due(new Date('2026-11-13T19:30:00Z'), 1080), false);
  assert.equal(due(new Date('2026-11-14T19:30:00Z'), NaN), false);
  assert.equal(due(new Date('2026-07-18T18:30:00Z'), 1350), false);
  assert.equal(paris(new Date('2026-07-18T18:30:00Z')).minute, 1230);
});
test('rotation never repeats the preceding nigoun', () => {
  assert.equal(choose([{ id: 'a' }, { id: 'b' }], 'a').id, 'b');
  assert.equal(choose([{ id: 'a' }], 'a'), null);
});
test('approval is revision-bound', () => {
  assert.deepEqual(parseButton('st_approve_12345678-1234-1234-1234-123456789012_2'), { action: 'approve', id: '12345678-1234-1234-1234-123456789012', revision: 2 });
  assert.equal(parseButton('post_approve_1'), null);
});
test('unauthorized users and stale buttons cannot invoke external publication', async () => {
  let queries = 0, external = 0;
  const f = init({ app: { get() {}, post() {} }, pool: { async query() { queries++; return { rows: [] }; } }, isAdmin: p => p === 'admin', env: {}, fetcher: async () => { external++; return { ok: true, json: async () => ({messages:[{id:'wa'}]}) }; } });
  assert.equal(await f.handleText('visitor', 'statu'), false);
  await f.handleButton('visitor', 'st_approve_12345678-1234-1234-1234-123456789012_1');
  assert.equal(queries, 0);
  await f.handleButton('admin', 'st_approve_12345678-1234-1234-1234-123456789012_1');
  assert.equal(external, 1); // Only the WhatsApp “already processed” response.
});

function publicationHarness({ failInstagram = false, targets = ['instagram','facebook'] } = {}) {
  const row = { id:'12345678-1234-1234-1234-123456789012', owner:'admin', revision:1, status:'preview', media_id:'media', results:{}, targets };
  const calls = [];
  const pool = { async query(sql,args=[]) {
    if (sql.startsWith('CREATE TABLE') || sql === 'SELECT * FROM story_reminders WHERE enabled') return {rows:[]};
    if (sql.startsWith("UPDATE story_drafts SET status='busy'")) {
      if (row.status !== 'preview' || args[2] !== row.revision || args[1] !== row.owner) return {rows:[]};
      row.status='busy'; return {rows:[row]};
    }
    if (sql.startsWith('SELECT mime')) return {rows:[{mime:'video/mp4'}]};
    if (sql.startsWith('UPDATE story_drafts SET results')) { row.results=JSON.parse(args[1]); return {rows:[]}; }
    if (sql.startsWith("UPDATE story_drafts SET status='processed'")) {row.status='processed';return {rows:[]};}
    if (sql.startsWith('UPDATE story_drafts SET status=$2')) {row.status=args[1];return {rows:[]};}
    throw Error('Unexpected DB request');
  } };
  const fetcher = async(url,opts)=>{
    calls.push({url,body:opts.body&&JSON.parse(opts.body),headers:opts.headers});
    let d;
    if (url.includes('/phone/messages')) d={messages:[{id:'wa'}]};
    else if (url.includes('/ig/media_publish')) d={id:'ig-published'};
    else if (url.includes('/ig/media')) {if(failInstagram) return {ok:false,status:400,json:async()=>({error:{code:10}})};d={id:'container'};}
    else if (url.includes('/container?')) d={status_code:'FINISHED'};
    else if (url.includes('rupload')) d={success:true};
    else if (url.includes('video_stories')) d=calls.at(-1).body.upload_phase==='start'?{video_id:'fb-video',upload_url:'https://rupload.facebook.com/video'}:{success:true};
    else throw Error('Unexpected network request');
    return {ok:true,json:async()=>d};
  };
  const f=init({app:{get(){},post(){}},pool,isAdmin:p=>p==='admin',phoneNumberId:'phone',whatsappToken:'wa-test',publicBaseUrl:'https://bot.example',getMeta:async()=>({pageToken:'page-test',igId:'ig',pageId:'fb'}),fetcher});
  return {f,calls,row};
}
test('validated video uses story endpoints on both networks exactly once',async()=>{
  const {f,calls,row}=publicationHarness();
  const button='st_approve_'+row.id+'_1';
  await f.handleButton('admin',button);
  assert.equal(row.status,'processed');
  assert.equal(row.results.instagram.status,'accepted');
  assert.equal(row.results.facebook.status,'accepted');
  assert.equal(calls.find(c=>c.url.endsWith('/ig/media')).body.media_type,'STORIES');
  assert.ok(calls.some(c=>c.url.includes('/fb/video_stories')));
  assert.ok(!calls.some(c=>c.url.includes('/feed')));
  const published=calls.filter(c=>!c.url.includes('/messages')).length;
  await f.handleButton('admin',button);
  assert.equal(calls.filter(c=>!c.url.includes('/messages')).length,published);
});
test('partial failure is recorded, no automatic retry of accepted Facebook story',async()=>{
  const {f,calls,row}=publicationHarness({failInstagram:true});
  await f.handleButton('admin','st_approve_'+row.id+'_1');
  assert.equal(row.results.instagram.status,'check_required');
  assert.equal(row.results.facebook.status,'accepted');
  assert.equal(calls.filter(c=>c.url.endsWith('/ig/media')).length,1);
});
test('Saturday worker blocks holy times and claims each week only once across instances',async()=>{
  let claimed=false,notify=0;
  const pool={async query(sql,args){
    if(sql==='SELECT * FROM story_plans WHERE enabled'||sql==='SELECT * FROM story_reminders WHERE enabled')return {rows:[]};
    if(sql.startsWith('CREATE TABLE')) return {rows:[]};
    if(sql==='SELECT * FROM story_settings WHERE id=1')return {rows:[{enabled:true,cover:'cover'}]};
    if(sql.startsWith('SELECT * FROM story_clips'))return {rows:[{id:'one',media_id:'m1'},{id:'two',media_id:'m2'}]};
    if(sql.startsWith('SELECT clip_id'))return {rows:[]};
    if(sql.startsWith('INSERT INTO story_drafts')){if(claimed)return {rows:[]};claimed=true;assert.equal(args[1],'2026-11-14');return {rows:[{id:'edition'}]};}
    throw Error('Unexpected DB call '+sql);
  }};
  const options={app:{get(){},post(){}},pool,isAdmin:()=>true,adminPhone:'admin',phoneNumberId:'phone',env:{},fetcher:async()=>{notify++;return {ok:true,json:async()=>({messages:[{id:'accepted'}]})};}};
  const blocked=init({...options,isHolyTime:async()=>new Date()});
  await blocked.tick(new Date('2026-11-14T19:30:00Z'));assert.equal(claimed,false);
  const a=init({...options,isHolyTime:async()=>null}), b=init({...options,isHolyTime:async()=>null});
  await Promise.all([a.tick(new Date('2026-11-14T19:30:00Z')),b.tick(new Date('2026-11-14T19:30:00Z'))]);
  assert.equal(notify,1);
});
test('one-time choice overrides default and falls back after consumption',()=>{
  assert.equal(effectiveMode({mode:'music',next_mode:'reminder'}),'reminder');
  assert.equal(effectiveMode({mode:'image',next_mode:null}),'image');
  assert.equal(effectiveMode({mode:'reminder'}),'reminder');
});
for (const mode of ['image','reminder']) test(mode+' schedule does not require music or call publishing endpoints',async()=>{
  let inserted,consumed=false;const calls=[];
  const pool={async query(sql,args=[]){
    if(sql.startsWith('CREATE TABLE') || sql === 'SELECT * FROM story_plans WHERE enabled' || sql === 'SELECT * FROM story_reminders WHERE enabled')return {rows:[]};
    if(sql==='SELECT * FROM story_settings WHERE id=1')return {rows:[{enabled:true,mode:'music',next_mode:mode,cover:mode==='image'?'cover':null}]};
    if(sql.startsWith('INSERT INTO story_drafts')){inserted=args;return {rows:[{id:'draft'}]};}
    if(sql.startsWith('UPDATE story_settings SET next_mode=NULL')){consumed=true;return {rows:[]};}
    throw Error('Unexpected query for '+mode+': '+sql);
  }};
  const f=init({app:{get(){},post(){}},pool,isAdmin:()=>true,adminPhone:'admin',phoneNumberId:'phone',isHolyTime:async()=>null,env:{},fetcher:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({messages:[{id:'wa'}]})};}});
  await f.tick(new Date('2026-11-14T19:30:00Z'));
  assert.equal(consumed,true);assert.equal(inserted[5],mode==='reminder'?'reminder':'story');
  assert.equal(inserted[6],mode==='reminder'?'reminder':'preview');
  assert.equal(inserted[3],mode==='image'?'cover':null);
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/phone/messages'));
  assert.equal(calls[0].body.template.name,mode==='reminder'?'shliah_stories_rappel':'shliah_stories_admin');
});
test('reminder override is not consumed if the weekly edition was already claimed',async()=>{
  let consumed=false;
  const pool={async query(sql){if(sql.startsWith('CREATE TABLE') || sql === 'SELECT * FROM story_plans WHERE enabled' || sql === 'SELECT * FROM story_reminders WHERE enabled')return {rows:[]};if(sql==='SELECT * FROM story_settings WHERE id=1')return {rows:[{enabled:true,mode:'reminder',next_mode:'reminder'}]};if(sql.startsWith('INSERT INTO story_drafts'))return {rows:[]};if(sql.startsWith('UPDATE story_settings'))consumed=true;return {rows:[]};}};
  const f=init({app:{get(){},post(){}},pool,isAdmin:()=>true,isHolyTime:async()=>null,fetcher:async()=>{throw Error('Must not notify twice');}});
  await f.tick(new Date('2026-11-14T19:30:00Z'));assert.equal(consumed,false);
});
const helpers=require('../features/stories/stories.helpers');
test('Facebook-only approval never sends an Instagram request',async()=>{const {f,calls,row}=publicationHarness({targets:['facebook']});await f.handleButton('admin','st_approve_'+row.id+'_1');assert.equal(row.results.facebook.status,'accepted');assert.ok(!calls.some(c=>c.url.includes('/ig/')));});
test('manual text escapes markup; reminders reject invalid times and days',()=>{
  const svg=helpers.textSvg('<script>alert(1)</script> & bonjour');assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));assert.ok(svg.includes('&amp;'));
  assert.throws(()=>helpers.targets(['unknown']));assert.deepEqual(helpers.targets(['facebook','facebook']),['facebook']);
  assert.throws(()=>helpers.reminder({days:[7],time:'20:30',message:'Test'}));assert.throws(()=>helpers.reminder({days:[1],time:'24:00',message:'Test'}));
  assert.deepEqual(helpers.reminder({days:[1,1,3],time:'20:30',message:' Test '}),{days:[1,3],time:'20:30',message:'Test'});
});
function routeHarness(){
  const routes=new Map(),handoffs=new Set();
  const app={get(path,...f){routes.set('GET '+path,f);},post(path,...f){routes.set('POST '+path,f);}};
  const pool={async query(sql,args=[]){
    if(sql.startsWith('INSERT INTO story_handoffs'))handoffs.add(args[0]);
    if(sql.startsWith('DELETE FROM story_handoffs WHERE hash')){const found=handoffs.delete(args[0]);return {rows:found?[{hash:args[0]}]:[]};}
    return {rows:[]};
  }};
  init({app,pool,isAdmin:()=>true,adminPassword:'test-password',publicBaseUrl:'https://bot.example'});
  async function dispatch(method,path,{headers={},body={}}={}){const req={method,headers,body,get:n=>headers[n.toLowerCase()]};const result={code:200,headers:{},body:null};const res={status(n){result.code=n;return this;},sendStatus(n){result.code=n;return this;},set(k,v){result.headers[k]=v;return this;},json(d){result.body=d;return this;}};const handlers=routes.get(method+' '+path);assert.ok(handlers,'route '+path);let i=0;async function next(){if(handlers[i])return handlers[i++](req,res,next);}await next();return result;}
  return {dispatch};
}
test('admin handoff redeems once, creates a secure cookie and blocks cross-origin writes',async()=>{
  const {dispatch}=routeHarness();
  assert.equal((await dispatch('POST','/admin/stories/session')).code,401);
  const handoff=await dispatch('POST','/admin/stories/session',{headers:{'x-admin-password':'test-password'}});assert.match(handoff.body.token,/^[a-f0-9]{64}$/);
  const session=await dispatch('POST','/admin/stories/session/redeem',{body:{token:handoff.body.token}});assert.equal(session.code,200);assert.match(session.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await dispatch('POST','/admin/stories/session/redeem',{body:{token:handoff.body.token}})).code,401);
  const cookie=session.headers['Set-Cookie'].split(';')[0];
  assert.equal((await dispatch('GET','/admin/stories/reminders',{headers:{cookie}})).code,200);
  assert.equal((await dispatch('POST','/admin/stories/reminders',{headers:{cookie,origin:'https://evil.example'},body:{}})).code,403);
  assert.equal((await dispatch('GET','/admin/stories/reminders',{headers:{cookie:cookie.slice(0,-1)+'x'}})).code,401);
});
test('custom reminder delivers once, uses email fallback and never publishes a story',async()=>{
  let claimed=false,emails=0,whatsapp=0;const pool={async query(sql){
    if(sql==='SELECT * FROM story_reminders WHERE enabled')return {rows:[{id:'r',days:[6],time:'20:30',message:'Préparer <mon statut>'}]};
    if(sql.startsWith('INSERT INTO story_reminder_jobs')){if(claimed)return {rows:[]};claimed=true;return {rows:[{date:'2026-11-14'}]};}return {rows:[]};
  }};
  const f=init({app:{get(){},post(){}},pool,isAdmin:()=>true,phoneNumberId:'phone',isHolyTime:async()=>null,env:{},fetcher:async(url)=>{assert.ok(url.endsWith('/phone/messages'));whatsapp++;return {ok:false,status:400,json:async()=>({error:{code:132001}})};},envoyerEmail:async data=>{emails++;assert.ok(data.html.includes('&lt;mon statut&gt;'));return {ok:true};}});
  await f.reminderTick(new Date('2026-11-14T19:30:00Z'));await f.reminderTick(new Date('2026-11-14T19:31:00Z'));assert.equal(emails,1);assert.equal(whatsapp,1);
});
test('an old approval cannot publish after its recurring plan was stopped or edited',async()=>{
 const row={id:'12345678-1234-1234-1234-123456789012',owner:'admin',revision:1,status:'preview',kind:'story',slot:'plan:12345678-1234-1234-1234-123456789013:2026-11-14:1',results:{}};let external=0;
 const f=init({app:{get(){},post(){}},pool:{async query(sql){if(sql.startsWith('UPDATE story_drafts SET status=\'busy\''))return {rows:[row]};return {rows:[]};}},isAdmin:p=>p==='admin',env:{},getMeta:async()=>{throw Error('Must never reach publishing');},fetcher:async()=>{external++;return {ok:true,json:async()=>({messages:[{id:'notice'}]})};}});
 await f.handleButton('admin','st_approve_'+row.id+'_1');assert.equal(external,1);
});
