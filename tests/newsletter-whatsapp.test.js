'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsApp } = require('../features/newsletter/newsletter.whatsapp');

test('background notifications use templates; replies recover exact version buttons', async () => {
  let time = 100000, calls = [];
  const wa = createWhatsApp({ token: 'test', phoneNumberId: '1', adminPhone: '2', now: () => time, fetcher: async (_url, options) => {
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ messages: [{ id: 'accepted' }] }) };
  } });
  await wa.send('Aperçu\n\nversion\t1', [{id:'nl_version_1',title:'Valider'}]);
  assert.equal(calls[0].type, 'template');
  assert.equal(calls[0].template.components[0].parameters[0].text, 'Aperçu version 1');
  assert.equal(calls[0].to, '2');
  wa.markInteraction();
  await wa.send('Version 1', [{id:'nl_version_1',title:'Valider'}]);
  assert.equal(calls[1].type, 'interactive');
  assert.equal(calls[1].interactive.action.buttons[0].reply.id,'nl_version_1');
  time += 24 * 3600000;
  await wa.send('Autre jeudi'); assert.equal(calls[2].type,'template');
  wa.markInteraction(); await wa.send('Test',null,{forceTemplate:true}); assert.equal(calls[3].type,'template');
});

test('window rejection retries with template, but API acceptance is required', async () => {
  let n = 0;
  const wa = createWhatsApp({ token:'test',phoneNumberId:'1',adminPhone:'2',fetcher:async()=>({ok:++n>1,status:400,json:async()=> n===1 ? {error:{code:131047}} : {messages:[{id:'ok'}]}}) });
  wa.markInteraction(); assert.equal(await wa.send('Suivi'),'ok'); assert.equal(n,2);
  const rejected = createWhatsApp({token:'test',phoneNumberId:'1',adminPhone:'2',fetcher:async()=>({ok:false,status:400,json:async()=>({error:{code:132001}})})});
  await assert.rejects(rejected.send('Suivi'),/132001/);
});

test('template check refuses a different phone account and validates French approval', async()=>{
  const calls=[];
  const fetcher=async url=>{calls.push(url);return {ok:true,json:async()=>({data:url.includes('phone_numbers')?[{id:'1'}]:[{name:'shliah_newsletter_admin',language:'fr',status:'APPROVED',category:'UTILITY'}]})};};
  const wrong=createWhatsApp({token:'test',phoneNumberId:'other',adminPhone:'2',fetcher});
  assert.deepEqual(await wrong.check(),{sameAccount:false,approved:false});assert.equal(calls.length,1);
  const correct=createWhatsApp({token:'test',phoneNumberId:'1',adminPhone:'2',fetcher});
  assert.equal((await correct.check()).approved,true);
  assert.ok(calls.every(url=>!url.includes('test')));
});
