'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {init}=require('../features/stories/stories.server');
function setup(query){const routes={};init({app:{get(path,...f){routes['GET '+path]=f;},post(path,...f){routes['POST '+path]=f;}},pool:{query},adminPhone:'admin',adminPassword:'password',isAdmin:p=>p==='admin',publicBaseUrl:'https://bot.example',env:{}});return routes;}
async function call(routes,key,body={},params={}){let status=200,result;const res={set(){return this;},status(n){status=n;return this;},json(d){result=d;return this;},sendStatus(n){status=n;return this;}};await routes[key].at(-1)({body,params},res);return {status,result};}
test('page lists WhatsApp plans and received media from the shared store',async()=>{
 const routes=setup(async(sql,args)=>{if(sql.startsWith('SELECT p.*')){assert.deepEqual(args,['admin']);return {rows:[{id:'plan',media_id:'image',origin:'whatsapp',mime:'image/jpeg'}]};}if(sql.startsWith('SELECT DISTINCT m.id')){assert.deepEqual(args,['admin']);return {rows:[{id:'image',mime:'image/jpeg'}]};}return {rows:[]};});
 const {result}=await call(routes,'GET /admin/stories/plans');assert.equal(result.plans[0].origin,'whatsapp');assert.equal(result.media[0].url,'https://bot.example/stories/media/image');
});
test('page reuses an owned WhatsApp image for a weekly plan without publishing',async()=>{
 const writes=[];const routes=setup(async(sql,args)=>{if(sql.startsWith('SELECT DISTINCT'))return {rows:[{id:'owned',mime:'image/jpeg'}]};if(sql.startsWith('INSERT INTO story_plans('))writes.push(args);return {rows:[]};});
 const input={title:'Tanya',media_id:'owned',days:[1],time:'15:00',mode:'image',targets:['instagram']};
 const good=await call(routes,'POST /admin/stories/plans',input);assert.equal(good.status,200);assert.equal(writes.length,1);assert.equal(writes[0][1],'admin');assert.equal(writes[0][3],'owned');
 const foreign=await call(routes,'POST /admin/stories/plans',{...input,media_id:'foreign'});assert.equal(foreign.status,400);assert.equal(writes.length,1);
 const bad=await call(routes,'POST /admin/stories/plans',{...input,time:'26:00'});assert.equal(bad.status,400);
});
test('page rejects stale edits and pause invalidates pending approval',async()=>{
 let cancelled=false;const routes=setup(async(sql)=>{if(sql.startsWith('UPDATE story_plans SET enabled'))return {rows:[{id:'p'}]};if(sql.startsWith("UPDATE story_drafts SET status='cancelled'"))cancelled=true;return {rows:[]};});
 const stale=await call(routes,'POST /admin/stories/plans',{id:'12345678-1234-1234-1234-123456789012',revision:1,title:'x',days:[1],time:'15:00',mode:'image',targets:['instagram'],media_id:'owned'});assert.equal(stale.status,409);
 assert.equal((await call(routes,'POST /admin/stories/plans/:id/toggle',{revision:1,enabled:false},{id:'p'})).status,200);assert.equal(cancelled,true);
 assert.equal(routes['GET /admin/stories/plans'].length,2);assert.equal(routes['POST /admin/stories/plans'].length,2);
});
