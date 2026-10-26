'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {notifications}=require('./notifications');
const MAX_DONATION = 10000000;
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function text(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw problem(label + ' invalide.');
  return value.trim();
}
function validateOrder(body) {
  if (!/^[0-9a-f-]{36}$/i.test(body.requestId || '')) throw problem('Identifiant de demande invalide.');
  if (!Array.isArray(body.children) || !body.children.length || body.children.length > 30) throw problem('Ajoutez entre 1 et 30 enfants.');
  const children = body.children.map(c => {
    if (!c || !['Garçon', 'Fille'].includes(c.gender) || !Number.isInteger(c.age) || c.age < 0 || c.age > 120) throw problem('Genre ou âge invalide.');
    return { name: text(c.name, 'Prénom'), surname: text(c.surname, 'Nom'), mother: text(c.mother, 'Prénom de la maman'), gender: c.gender, age: c.age };
  });
  const phone = text(body.phone, 'Téléphone', 15);
  if (!/^\d{8,15}$/.test(phone)) throw problem('Le téléphone doit contenir de 8 à 15 chiffres.');
  const email = body.email == null || body.email === '' ? null : text(body.email, 'E-mail', 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem('E-mail invalide.');
  if (!Number.isSafeInteger(body.donationCents) || body.donationCents < 0 || body.donationCents > MAX_DONATION) throw problem('Participation invalide.');
  return { requestId: body.requestId.toLowerCase(), children, phone, email, donationCents: body.donationCents, totalCents: children.length * 100 + body.donationCents };
}
function validateDonor(raw) {
  const d = {};
  for (const k of ['firstName', 'lastName', 'address', 'postalCode', 'city', 'country', 'email', 'phone']) d[k] = text(raw?.[k], k, k === 'address' ? 200 : 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) || !/^\d{8,15}$/.test(d.phone)) throw problem('E-mail ou téléphone invalide.');
  return d;
}
function eligibleCents(order, fullApproved) { return order.donation_cents > 0 ? (fullApproved ? order.total_cents : order.donation_cents) : 0; }
function paymentMatches(pi, order) { return pi.status === 'succeeded' && pi.currency === 'eur' && pi.amount === order.total_cents && pi.amount_received === order.total_cents && pi.metadata?.lettres_order_id === order.id; }
function init({ app, pool, adminPassword, generateCerfaPDF, envoyerEmail }) {
  const secret = () => process.env.STRIPE_SECRET_KEY;
  const pubkey = () => process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51Q6souBngKkhbSLJhjuyihq5xKbBHFF2G7xcXlMMJjNBJelgxO4Gm9dcFROLx0Nrfb3I1p1ouJAjKOJUCKR9ylXW00ZO4ScuyM'; // Clé publique déjà utilisée par la tsédaka.
  const tokens = id => crypto.createHmac('sha256', secret()).update('lettres:' + id).digest('hex');
  const checkToken = (id, token) => { if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false; return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(tokens(id))); };
  const notices=notifications({pool,send:envoyerEmail});
  let ready;
  function ensureDB() {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS lettres_orders (
      id UUID PRIMARY KEY, request_id UUID UNIQUE NOT NULL, children JSONB NOT NULL, phone TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK(total_cents > 0), donation_cents INTEGER NOT NULL CHECK(donation_cents >= 0),
      stripe_payment_intent_id TEXT UNIQUE, payment_status TEXT NOT NULL DEFAULT 'pending',
      receipt_eligible_cents INTEGER NOT NULL DEFAULT 0, receipt_status TEXT NOT NULL DEFAULT 'not_requested',
      receipt_data JSONB, cerfa_numero TEXT, diploma_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .then(() => pool.query('ALTER TABLE lettres_orders ADD COLUMN IF NOT EXISTS email TEXT'))
      .then(() => pool.query('ALTER TABLE cerfa_receipts ADD COLUMN IF NOT EXISTS origine TEXT'))
      .then(() => notices.ensure())
      .catch(e => { ready = null; throw e; });
    return ready;
  }
  function safe(handler) { return async (req, res) => { res.set('Cache-Control', 'no-store'); try { await ensureDB(); await handler(req, res); } catch (e) { if (!e.status) console.error('Lettres:', e.message); res.status(e.status || 503).json({ ok: false, error: e.status ? e.message : 'Service temporairement indisponible. Réessayez sans repayer.' }); } }; }
  function admin(req, res, next) {
    if (!adminPassword || req.get('X-Admin-Password') !== adminPassword) return res.status(401).json({ ok: false, error: 'Connexion administrateur requise.' });
    next();
  }
  const limits = new Map();
  const cleanLimits = setInterval(() => { const now = Date.now(); for (const [key, v] of limits) if (now - v.since > 600000) limits.delete(key); }, 600000);
  cleanLimits.unref();
  function publicLimit(req, res, next) {
    const now = Date.now(), key = req.ip, state = limits.get(key);
    if (state && now - state.since < 60000) { if (++state.count > 120) return res.status(429).json({ error: 'Trop de demandes. Réessayez dans une minute.' }); }
    else limits.set(key, { since: now, count: 1 });
    next();
  }
  async function stripe(endpoint, data, idempotencyKey) {
    if (!secret()) throw problem('Stripe n’est pas encore configuré.', 503);
    const headers = { Authorization: 'Bearer ' + secret() };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const options = { method: data ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(20000) };
    if (data) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; options.body = new URLSearchParams(data); }
    const r = await fetch('https://api.stripe.com/v1/' + endpoint, options), value = await r.json();
    if (!r.ok) throw problem('Stripe n’a pas pu traiter la demande. Réessayez.', 502);
    return value;
  }
  async function owned(body) {
    if (!secret()) throw problem('Paiement non configuré.', 503);
    if (!/^[0-9a-f-]{36}$/i.test(body.orderId || '') || !checkToken(body.orderId, body.orderToken)) throw problem('Commande introuvable.', 404);
    const r = await pool.query('SELECT * FROM lettres_orders WHERE id=$1', [body.orderId]);
    if (!r.rows[0]) throw problem('Commande introuvable.', 404);
    return r.rows[0];
  }
  async function confirmOrder(order) {
    if (!order.stripe_payment_intent_id) return order;
    const pi = await stripe('payment_intents/' + encodeURIComponent(order.stripe_payment_intent_id));
    if (paymentMatches(pi, order)) {
      const amount = eligibleCents(order, process.env.LETTRES_FULL_RECEIPT_APPROVED !== 'false');
      const r = await pool.query(`UPDATE lettres_orders SET payment_status='paid',paid_at=COALESCE(paid_at,NOW()),
        receipt_eligible_cents=CASE WHEN payment_status='paid' THEN receipt_eligible_cents ELSE $2 END,updated_at=NOW() WHERE id=$1 RETURNING *`, [order.id, amount]);
      const paid=r.rows[0];
      await notices.queue(paid,'confirmed');
      await notices.flush(paid.id).catch(e=>console.error('Lettres notification:',e.message));
      return paid;
    }
    return order;
  }
  app.get('/lettres-sefer-torah/api/config', publicLimit, (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, enabled: Boolean(secret() && pubkey()), publishableKey: pubkey() }); });
  app.post('/lettres-sefer-torah/api/orders', publicLimit, safe(async (req, res) => {
    if (!secret() || !pubkey()) throw problem('Le paiement n’est pas encore activé.', 503);
    const data = validateOrder(req.body), id = crypto.randomUUID();
    await pool.query(`INSERT INTO lettres_orders(id,request_id,children,phone,total_cents,donation_cents,email) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(request_id) DO NOTHING`, [id, data.requestId, JSON.stringify(data.children), data.phone, data.totalCents, data.donationCents, data.email]);
    let order = (await pool.query('SELECT * FROM lettres_orders WHERE request_id=$1', [data.requestId])).rows[0];
    if (order.total_cents !== data.totalCents || order.donation_cents !== data.donationCents || order.phone !== data.phone || (order.email || null) !== data.email || !isDeepStrictEqual(order.children, data.children)) throw problem('Cette demande a changé. Revenez au formulaire et recommencez.', 409);
    const pi = order.stripe_payment_intent_id ? await stripe('payment_intents/' + encodeURIComponent(order.stripe_payment_intent_id)) : await stripe('payment_intents', {
      amount: String(order.total_cents), currency: 'eur', ...(order.email ? { receipt_email: order.email } : {}), 'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[lettres_order_id]': order.id, 'metadata[source]': 'lettres_sefer_torah', description: 'Lettres Séfer Torah enfants — Beth Habad S. Maurice'
    }, 'lettres-' + order.id);
    await pool.query('UPDATE lettres_orders SET stripe_payment_intent_id=$2 WHERE id=$1', [order.id, pi.id]);
    res.json({ ok: true, orderId: order.id, orderToken: tokens(order.id), clientSecret: pi.client_secret, amountCents: order.total_cents, alreadyPaid: paymentMatches(pi, order) });
  }));
  app.post('/lettres-sefer-torah/api/status', publicLimit, safe(async (req, res) => {
    const order = await confirmOrder(await owned(req.body));
    res.json({ ok: true, paid: order.payment_status === 'paid', registrationSaved: order.payment_status === 'paid', lettersCount: order.children.length, totalCents: order.total_cents, donationCents: order.donation_cents, receiptEligibleCents: order.receipt_eligible_cents });
  }));
  app.post('/lettres-sefer-torah/api/receipt', publicLimit, safe(async (req, res) => {
    const order = await confirmOrder(await owned(req.body));
    if (order.payment_status !== 'paid' || order.donation_cents <= 0 || order.receipt_eligible_cents <= 0) throw problem('Aucun reçu fiscal ne peut être demandé pour ce règlement.', 403);
    const donor = validateDonor(req.body.donor);
    await pool.query(`UPDATE lettres_orders SET receipt_data=$2,receipt_status='requested',updated_at=NOW() WHERE id=$1 AND cerfa_numero IS NULL`, [order.id, JSON.stringify(donor)]);
    const receipt = await issueReceipt(order.id);
    const delivery = await sendReceipt(order.id);
    res.json({ ok: true, numero: receipt.numero, sent: true, alreadySent: Boolean(delivery.alreadySent) });
  }));
  // Pas de secret dans l’URL : le mot de passe passe une fois dans le fragment,
  // puis le navigateur l’enlève et l’envoie dans un en-tête pour les lectures.
  app.get('/lettres-sefer-torah', (req, res) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.sendFile(path.join(__dirname, 'admin.html')); });
  app.get('/lettres-sefer-torah/admin/orders', admin, safe(async (req, res) => {
    const r = await pool.query(`SELECT o.*,c.id AS receipt_id,COALESCE((SELECT json_agg(json_build_object('kind',n.kind,'state',n.state,'sent_at',n.sent_at,'attempts',n.attempts)) FROM lettres_notifications n WHERE n.order_id=o.id),'[]'::json) AS notifications FROM lettres_orders o LEFT JOIN cerfa_receipts c ON c.numero=o.cerfa_numero ORDER BY o.created_at DESC LIMIT 3000`);
    res.json({ ok: true, orders: r.rows });
  }));
  app.post('/lettres-sefer-torah/admin/reconcile', admin, safe(async (req, res) => {
    const r = await pool.query(`SELECT * FROM lettres_orders WHERE payment_status='pending' AND stripe_payment_intent_id IS NOT NULL ORDER BY created_at DESC LIMIT 50`);
    let confirmed = 0;
    for (const order of r.rows) { if ((await confirmOrder(order)).payment_status === 'paid') confirmed++; }
    res.json({ ok: true, confirmed, checked: r.rows.length });
  }));
  app.post('/lettres-sefer-torah/admin/diploma', admin, safe(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.body.orderId || '') || !['pending','registered','available','sent'].includes(req.body.status)) throw problem('Statut invalide.');
    const client=await pool.connect();let order;
    try{await client.query('BEGIN');
      const r=await client.query("UPDATE lettres_orders SET diploma_status=$2,updated_at=NOW() WHERE id=$1 AND payment_status='paid' RETURNING *",[req.body.orderId,req.body.status]);
      order=r.rows[0];if(!order)throw problem('Inscription payée introuvable.',404);
      if(['registered','available'].includes(req.body.status))await notices.queue(order,req.body.status,client);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    await notices.flush(order.id).catch(e=>console.error('Lettres notification:',e.message));
    res.json({ok:true,emailMissing:!order.email});
  }));
  app.post('/lettres-sefer-torah/admin/notifications/retry',admin,safe(async(req,res)=>{
    if(!/^[0-9a-f-]{36}$/i.test(req.body.orderId||''))throw problem('Commande invalide.');
    await pool.query("UPDATE lettres_notifications SET state='pending',attempts=0,updated_at=NOW() WHERE order_id=$1 AND state='failed'",[req.body.orderId]);
    await notices.flush(req.body.orderId);res.json({ok:true});
  }));
  async function issueReceipt(orderId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = (await client.query('SELECT * FROM lettres_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
      if (!order || order.payment_status !== 'paid' || order.donation_cents <= 0 || order.receipt_eligible_cents <= 0 || !order.receipt_data) throw problem('Aucune demande de Cerfa éligible.', 403);
      if (order.cerfa_numero) { await client.query('COMMIT'); return { ok: true, numero: order.cerfa_numero, existing: true }; }
      const donor = validateDonor(order.receipt_data), year = new Date(order.paid_at).getFullYear();
      const counter = await client.query(`INSERT INTO cerfa_counters(year,last_number) VALUES($1,1) ON CONFLICT(year) DO UPDATE SET last_number=cerfa_counters.last_number+1 RETURNING last_number`, [year]);
      const numero = 'BH' + year + '-' + String(counter.rows[0].last_number).padStart(3, '0');
      const address = [donor.address, donor.postalCode + ' ' + donor.city, donor.country].join(', '), day = new Date(order.paid_at).toISOString().slice(0, 10);
      // Vérifier que le PDF peut être généré avant de valider le reçu en base.
      await generateCerfaPDF({ numero, nom: donor.lastName, prenom: donor.firstName, adresse: address, montant: order.receipt_eligible_cents / 100, mode: 'Paiement en ligne', dateVersement: new Date(day + 'T12:00:00Z').toLocaleDateString('fr-FR') });
      await client.query(`INSERT INTO cerfa_receipts(numero,nom,prenom,adresse,montant,mode_paiement,date_don,email,phone,origine) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'lettres')`, [numero, donor.lastName, donor.firstName, address, order.receipt_eligible_cents / 100, 'Paiement en ligne', day, donor.email, donor.phone]);
      await client.query(`UPDATE lettres_orders SET cerfa_numero=$2,receipt_status='issued',updated_at=NOW() WHERE id=$1`, [order.id, numero]);
      await client.query('COMMIT');
      return { ok: true, numero };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async function sendReceipt(orderId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = (await client.query('SELECT * FROM lettres_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
      if (!order || order.payment_status !== 'paid' || order.donation_cents <= 0 || !order.cerfa_numero) throw problem('Créez d’abord le reçu fiscal.', 403);
      if (order.receipt_status === 'sent') { await client.query('COMMIT'); return { ok: true, alreadySent: true }; }
      const c = (await client.query('SELECT * FROM cerfa_receipts WHERE numero=$1', [order.cerfa_numero])).rows[0];
      if (!c?.email) throw problem('E-mail manquant.');
      const pdf = await generateCerfaPDF({ numero: c.numero, nom: c.nom, prenom: c.prenom, adresse: c.adresse, montant: c.montant, mode: c.mode_paiement, dateVersement: new Date(c.date_don).toLocaleDateString('fr-FR') });
      const delivery = await envoyerEmail({ to: c.email, subject: 'Votre reçu fiscal ' + c.numero, html: 'Bonjour,<br>Merci pour votre soutien. Vous trouverez votre reçu fiscal en pièce jointe.<br>Beth Habad S. Maurice', idempotencyKey: 'lettres-cerfa-' + order.id + '-' + c.numero, attachments: [{ filename: 'Cerfa_' + c.numero + '.pdf', content: pdf }] });
      if (!delivery?.ok) throw problem('Le Cerfa est créé, mais l’e-mail n’a pas été envoyé. Réessayez.', 502);
      await client.query(`UPDATE lettres_orders SET receipt_status='sent',updated_at=NOW() WHERE id=$1`, [order.id]);
      await client.query('COMMIT'); return { ok: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  app.post('/lettres-sefer-torah/admin/receipt/generate', admin, safe(async (req,res)=>{
    if(!/^[0-9a-f-]{36}$/i.test(req.body.orderId||''))throw problem('Commande invalide.');
    res.json(await issueReceipt(req.body.orderId));
  }));
  app.post('/lettres-sefer-torah/admin/receipt/send', admin, safe(async (req,res)=>{
    if(!/^[0-9a-f-]{36}$/i.test(req.body.orderId||''))throw problem('Commande invalide.');
    res.json(await sendReceipt(req.body.orderId));
  }));
  async function webhook(req, res) {
    res.set('Cache-Control', 'no-store');
    const signingSecret = process.env.LETTRES_STRIPE_WEBHOOK_SECRET;
    if (!signingSecret) return res.status(503).json({ error: 'Webhook non configuré.' });
    try {
      const parts = String(req.get('stripe-signature') || '').split(',').map(s => s.split('='));
      const timestamp = parts.find(p => p[0] === 't')?.[1];
      if (!/^\d+$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !Buffer.isBuffer(req.body)) throw problem('Signature invalide.', 400);
      const expected = crypto.createHmac('sha256', signingSecret).update(timestamp + '.').update(req.body).digest('hex');
      const signatures = parts.filter(p => p[0] === 'v1').map(p => p[1]);
      if (!signatures.some(v => /^[a-f0-9]{64}$/.test(v || '') && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)))) throw problem('Signature invalide.', 400);
      const event = JSON.parse(req.body.toString('utf8'));
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data?.object;
        if (pi?.metadata?.source === 'lettres_sefer_torah') {
          await ensureDB();
          const order = (await pool.query('SELECT * FROM lettres_orders WHERE stripe_payment_intent_id=$1', [pi.id])).rows[0];
          if (!order) throw problem('Commande pas encore disponible. Réessayer.', 503);
          await confirmOrder(order); // Revérification auprès de Stripe ; doublons sans effet.
        }
      }
      return res.json({ ok: true });
    } catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : 'Webhook temporairement indisponible.' }); }
  }
  const notificationTimer=setInterval(()=>ensureDB().then(()=>notices.flush()).catch(e=>console.error('Lettres notification:',e.message)),60000);
  notificationTimer.unref();
  return { ensureDB, confirmOrder, webhook };
}
module.exports = { init, validateOrder, validateDonor, eligibleCents, paymentMatches };
