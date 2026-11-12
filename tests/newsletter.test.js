'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paris, sendAt, fetchShabbat, render, collect, compose } = require('../features/newsletter/newsletter.render');
const { upcomingWeek, buttonId, parseButton, canApprove, init } = require('../features/newsletter/newsletter.server');
const { audience, schedule } = require('../features/newsletter/newsletter.kehila');
const sharp = require('sharp');
const source = { type: 'EMAIL', allContact: true, emailConfig: 'sender' };
const target = audience(source);
const document = { week: '2026-11-19', posts: [{ id: '1', photoIds: ['5','3'] }], shabbat: null, copy: { subject: 'Communauté', intro: 'Bonjour <script>', posts: [{ id:'1',title:'Une rencontre',caption:'Merci à tous' }], notices: [], missing: [] } };
const photos = { '5': { width:2,height:1,mime:'image/jpeg',data:Buffer.from('photo5') }, '3': { width:2,height:1,mime:'image/jpeg',data:Buffer.from('photo3') } };

test('Paris schedules preserve 10h/12h/21h30 across DST and protect current ready edition', () => {
  assert.equal(paris(new Date('2026-11-19T09:00:00Z')).hour, 10);
  assert.equal(paris(new Date('2026-07-09T08:00:00Z')).hour, 10);
  assert.equal(sendAt('2026-11-19').toISOString(),'2026-11-19T20:30:00.000Z');
  assert.equal(sendAt('2027-07-01').toISOString(),'2027-07-01T19:30:00.000Z');
  assert.equal(upcomingWeek(new Date('2026-11-12T11:00:00Z')),'2026-11-19');
});
test('approval binds exact revision, accepted preview, audience and send deadline', () => {
  const row = { id:'12345678-1234-1234-1234-123456789abc',week:'2026-11-19',revision:3,status:'preview',preview_sent_at:new Date(),audience_hash:target.hash,document };
  const now = new Date('2026-11-19T12:00:00Z');
  assert.equal(Boolean(canApprove(row,3,now)),true);
  assert.equal(Boolean(canApprove(row,2,now)),false);
  assert.equal(Boolean(canApprove({...row,status:'scheduled'},3,now)),false);
  assert.equal(Boolean(canApprove({...row,preview_sent_at:null},3,now)),false);
  assert.equal(Boolean(canApprove({...row,document:{...document,copy:{...document.copy,missing:['heure inconnue']}}},3,now)),false);
  assert.equal(Boolean(canApprove(row,3,new Date('2026-11-19T21:00:00Z'))),false);
  assert.deepEqual(parseButton(buttonId('approve',row)),{action:'approve',id:row.id,revision:3});
  assert.equal(parseButton('nl_approve_SQL_3'),null);
});
test('Shabbat lookup is tied to the edition date, checks Paris and rejects incomplete data', async()=>{
  const pool={async query(_sql,args){assert.deepEqual(args,['2026-11-20']);return {rows:[]};}};
  const payload={location:{tzid:'Europe/Paris',geonameid:2988507},items:[{category:'candles',date:'2026-11-20T16:46:00+01:00'},{category:'havdalah',date:'2026-11-21T17:56:00+01:00'},{category:'parashat',date:'2026-11-21',title:'Parashat Vayetzei'}]};
  const fetcher=async url=>{assert.equal(url.searchParams.get('gd'),'20');return {ok:true,async json(){return payload;}};};
  const data=await fetchShabbat('2026-11-19',pool,fetcher);assert.equal(data.entree,'16h46');assert.equal(data.sortie,'17h56');
  payload.items.pop();payload.items.pop();await assert.rejects(fetchShabbat('2026-11-19',pool,fetcher),/complets/);
});
test('renderer includes every photo in order, escapes input and excludes export secrets', () => {
  const html = render(document,photos,'https://bot.example');
  assert.ok(html.indexOf('/media/5') < html.indexOf('/media/3'));
  assert.equal((html.match(/<img /g)||[]).length,2);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('{{mailing_unsubscribe}}'));
  assert.ok(!html.includes('key='));
  assert.throws(()=>render(document,{'5':photos['5']},'https://bot.example'),/Photo manquante/);
});
test('collection reads only public social posts and their exact attached media', async () => {
  const image = await sharp({create:{width:2,height:1,channels:3,background:'#ffffff'}}).png().toBuffer();
  const calls=[];
  const pool={async query(sql,params){calls.push({sql,params}); return sql.includes('FROM posts_sociaux') ? {rows:[{id:1,created_at:new Date(),instagram:'Texte',photos:['https://bot/media/5','https://bot/media/3'],resultat:'Instagram : publié ✅'}]} : {rows:[{id:5,data:image,mime_type:'image/png'},{id:3,data:image,mime_type:'image/png'}]};}};
  const data=await collect(pool);
  assert.deepEqual(data.posts[0].photoIds,['5','3']);
  assert.deepEqual(calls[1].params,[['5','3']]);
  assert.equal(data.photos['3'].width,2);
  assert.ok(calls.every(c=>!/(contacts|cerfa|paiements|infos_privees)/.test(c.sql)));
});
test('composer refuses invented or missing posts', async () => {
  const fetcher=async()=>({ok:true,async json(){return {content:[{type:'text',text:JSON.stringify({...document.copy,posts:[]})}]};}});
  await assert.rejects(compose({posts:document.posts,photos:{},infos:[],week:document.week,notes:'',anthropicKey:'test',fetcher}),/Brouillon incomplet/);
});
test('audience refuses ambiguous or unsupported CRM targeting', () => {
  assert.throws(()=>audience({...source,categories:['x']}),/ambigu/);
  assert.throws(()=>audience({...source,crmTarget:{}}),/non pris en charge/);
  assert.throws(()=>audience({...source,emailConfig:null}),/ambigu/);
});

function fakeKehila({ changedAudience=false, uncertainSend=false, changedHtml=false }={}) {
  const calls=[]; let html; let campaign; let sent=false;
  const fetcher=async (url,options)=>{
    const path=url.replace('https://api.unisoft.world/integrations/v2',''); calls.push({path,method:options.method});
    const body=typeof options.body==='string'?JSON.parse(options.body):options.body;
    let data;
    if(path==='/campaigns/11111111-1111-1111-1111-111111111111')data=changedAudience?{...source,allContact:false,categories:['different']}:source;
    else if(path==='/uploads')data={url:'https://api.unisoft.world/medias/photo'+calls.length+'.jpg'};
    else if(path==='/email-templates'&&options.method==='POST'){html=body.html;data={id:'template'};}
    else if(path==='/email-templates/template')data={id:'template',html:changedHtml?'modified':html};
    else if(path==='/campaigns'&&options.method==='POST'){campaign={...body,id:'campaign',state:'INIT'};data=campaign;}
    else if(path==='/campaigns/campaign')data={...campaign,state:sent?'VALIDATE':'INIT'};
    else if(path==='/campaigns/campaign/targets')data={total:123};
    else if(path==='/campaigns/campaign/send'){if(uncertainSend)throw new Error('Lost response');sent=true;return {ok:true,async json(){return {success:true,commandId:'command',data:{state:'VALIDATE',targets:123}};}};}
    else throw new Error('Unexpected '+path);
    return {ok:true,async json(){return {success:true,data};}};
  };
  return {fetcher,calls};
}
function edition(){return {week:'2026-11-19',revision:3,document,source_campaign:'11111111-1111-1111-1111-111111111111',audience_hash:target.hash};}
test('Kehila uploads all photos, creates new content, verifies it and queues future delivery once', async()=>{
  const mock=fakeKehila(); const saved=[];
  const result=await schedule({edition:edition(),photos,baseUrl:'https://bot.example',key:'test',save:async x=>saved.push(x),fetcher:mock.fetcher,now:new Date('2026-11-19T12:00:00Z')});
  assert.equal(result.targetCount,123);
  assert.equal(mock.calls.filter(c=>c.path==='/uploads').length,2);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/send')).length,1);
  assert.equal(saved.at(-1).status,'scheduled');
  assert.equal(saved.at(-1).command_id,'command');
});
test('changed audience or content blocks dispatch; lost send response is marked uncertain', async()=>{
  for(const opt of [{changedAudience:true},{changedHtml:true}]){
    const mock=fakeKehila(opt);
    await assert.rejects(schedule({edition:edition(),photos,baseUrl:'https://bot.example',key:'test',save:async()=>{},fetcher:mock.fetcher,now:new Date('2026-11-19T12:00:00Z')}));
    assert.equal(mock.calls.filter(c=>c.path.endsWith('/send')).length,0);
  }
  const mock=fakeKehila({uncertainSend:true});
  await assert.rejects(schedule({edition:edition(),photos,baseUrl:'https://bot.example',key:'test',save:async()=>{},fetcher:mock.fetcher,now:new Date('2026-11-19T12:00:00Z')}),e=>e.uncertain===true);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/send')).length,1);
});
test('native scheduler makes no query and sends nothing for ready Toldot week',async()=>{
  let queries=0;const pool={async query(){queries++;return {rows:[]};}};
  const feature=init({app:{get(){},post(){}},pool});await feature.ready;
  queries=0; await feature.tick(new Date('2026-11-12T11:00:00Z'));
  assert.equal(queries,0);
});
