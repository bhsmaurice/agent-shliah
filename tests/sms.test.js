'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normaliserTel, nettoyerPourSMS, compterSMS } = require('../features/sms/sms.core');

test('Numéros français normalisés', () => {
  assert.equal(normaliserTel('06 12 34 56 78'), '33612345678');
  assert.equal(normaliserTel('+33 7 70 24 17 46'), '33770241746');
  assert.equal(normaliserTel('0033612345678'), '33612345678');
  assert.equal(normaliserTel('612345678'), '33612345678');
  assert.equal(normaliserTel('20h30'), '');
});

test('Emojis enlevés, accents simplifiés, texte tient dans 1 SMS', () => {
  const t = nettoyerPourSMS('🕯️ Chabbat Chalom ! Fête à la Maîtrise — « Kiddouch » 12h30 💐');
  assert.equal(t, 'Chabbat Chalom ! Fete à la Maitrise - "Kiddouch" 12h30');
  const c = compterSMS(t);
  assert.equal(c.unicode, false);
  assert.equal(c.sms, 1);
});

test('Hébreu conservé (mode unicode, 70 caractères)', () => {
  const t = nettoyerPourSMS('שבת שלום Chabbat Chalom');
  assert.match(t, /שבת/);
  assert.equal(compterSMS(t).unicode, true);
});

test('Découpage : 160 / 153, mention STOP comptée', () => {
  assert.equal(compterSMS('a'.repeat(160)).sms, 1);
  assert.equal(compterSMS('a'.repeat(161)).sms, 2);
  assert.equal(compterSMS('a'.repeat(150), { stop: true }).sms, 2);
  assert.equal(compterSMS('€'.repeat(80)).sms, 1);
  assert.equal(compterSMS('€'.repeat(81)).sms, 2);
});

test('Envoi groupé : STOP exclus, doublons retirés, appel SMSFactor correct, journal écrit', async () => {
  process.env.SMSFACTOR_TOKEN = 'test-token';
  const requetes = [], journal = [];
  const pool = { async query(sql, args) {
    if (/^CREATE/.test(sql)) return { rows: [] };
    if (/FROM contacts WHERE abonne_evenements/.test(sql)) return { rows: [{ phone: '33612345678' }, { phone: '33612345679' }, { phone: '33612345678' }] };
    if (/SELECT phone FROM sms_stop/.test(sql)) return { rows: [{ phone: '33612345679' }] };
    if (/INSERT INTO sms_envois/.test(sql)) { journal.push(args); return { rows: [] }; }
    return { rows: [] };
  } };
  const vraiFetch = global.fetch;
  global.fetch = async (url, opt) => {
    if (String(url).includes('hebcal')) return { ok: true, json: async () => ({ items: [] }) };
    requetes.push({ url, opt });
    return { ok: true, json: async () => ({ status: 1, message: 'OK', ticket: '42', cost: 1, credits: 99, sent: 1 }) };
  };
  try {
    const app = { get() {}, post() {} };
    const sms = require('../features/sms/sms.server').init({ app, pool, adminPassword: 'x' });
    const d = await sms.destinataires('abonnes_evenements');
    assert.deepEqual(d.numeros, ['33612345678']);
    assert.equal(d.exclusStop, 1);
    const r = await sms.envoyer({ numeros: d.numeros, texte: 'Soirée 🎉 ce soir', pushtype: 'marketing' });
    assert.equal(r.ok, true);
    assert.equal(r.envoyes, 1);
    const corps = JSON.parse(requetes[0].opt.body);
    assert.equal(requetes[0].url, 'https://api.smsfactor.com/send');
    assert.equal(requetes[0].opt.headers.Authorization, 'Bearer test-token');
    assert.equal(corps.sms.message.text, 'Soirée ce soir');
    assert.equal(corps.sms.message.pushtype, 'marketing');
    assert.equal(corps.sms.message.sender, 'BHSMAURICE');
    assert.deepEqual(corps.sms.recipients.gsm.map(g => g.value), ['33612345678']);
    assert.equal(journal.length, 1);
  } finally { global.fetch = vraiFetch; delete process.env.SMSFACTOR_TOKEN; }
});
