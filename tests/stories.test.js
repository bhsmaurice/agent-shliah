'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { due, paris, choose, parseButton, init } = require('../features/stories/stories.server');
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

function publicationHarness({ failInstagram = false } = {}) {
  const row = { id:'12345678-1234-1234-1234-123456789012', owner:'admin', revision:1, status:'preview', media_id:'media', results:{} };
  const calls = [];
  const pool = { async query(sql,args=[]) {
    if (sql.startsWith('CREATE TABLE')) return {rows:[]};
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
