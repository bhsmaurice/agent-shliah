'use strict';
// ═══════════════════════════════════════════════════════════════
// DON « LETTRE AU RABBI » — paiement Stripe (Apple Pay, Google Pay, carte)
// appelé depuis la page habadsmaurice.com/ecrire-au-rabbi/ (extension WordPress).
// Les dons payés sont ajoutés dans tsedaka_dons (statut « en_attente » = Cerfa à faire),
// donc ils apparaissent dans la page admin Tsedaka avec le bouton « + Cerfa ».
// ═══════════════════════════════════════════════════════════════
const MIN_CENTS = 100;          // 1 €
const MAX_CENTS = 2000000;      // 20 000 €
const SOURCE = 'lettre_au_rabbi';
const APPLE_PAY_DOMAINS = ['habadsmaurice.com', 'www.habadsmaurice.com'];

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function clean(value, max) {
  if (value == null) return '';
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function init({ app, pool }) {
  const secret = () => process.env.STRIPE_SECRET_KEY;
  // Même clé publique que la tsédaka et les lettres du Séfer Torah.
  const pubkey = () => process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51Q6souBngKkhbSLJhjuyihq5xKbBHFF2G7xcXlMMJjNBJelgxO4Gm9dcFROLx0Nrfb3I1p1ouJAjKOJUCKR9ylXW00ZO4ScuyM';

  async function stripe(endpoint, data, idempotencyKey) {
    if (!secret()) throw problem('Le paiement n’est pas encore configuré.', 503);
    const headers = { Authorization: 'Bearer ' + secret() };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const options = { method: data ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(20000) };
    if (data) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; options.body = new URLSearchParams(data); }
    const r = await fetch('https://api.stripe.com/v1/' + endpoint, options);
    const value = await r.json();
    if (!r.ok) {
      console.error('Don Rabbi Stripe:', value && value.error && value.error.message);
      throw problem('Le paiement n’a pas pu être préparé. Réessayez.', 502);
    }
    return value;
  }

  // Apple Pay exige que le domaine du site soit déclaré dans Stripe (une seule fois).
  async function declarerDomainesApplePay() {
    if (!secret()) return;
    for (const domain of APPLE_PAY_DOMAINS) {
      try {
        const list = await stripe('payment_method_domains?domain_name=' + encodeURIComponent(domain));
        if (list.data && list.data.length) continue;
        await stripe('payment_method_domains', { domain_name: domain });
        console.log('Don Rabbi : domaine Apple Pay déclaré', domain);
      } catch (e) { console.error('Don Rabbi domaine Apple Pay', domain, e.message); }
    }
  }
  setTimeout(declarerDomainesApplePay, 10000);

  // Petite limite anti-abus par adresse IP.
  const limits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (now - v.since > 600000) limits.delete(k); }, 600000).unref();
  function limit(req, res, next) {
    const now = Date.now(), key = req.ip, s = limits.get(key);
    if (s && now - s.since < 60000) { if (++s.count > 120) return res.status(429).json({ ok: false, error: 'Trop de demandes. Réessayez dans une minute.' }); }
    else limits.set(key, { since: now, count: 1 });
    next();
  }
  function safe(handler) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { await handler(req, res); }
      catch (e) {
        if (!e.status) console.error('Don Rabbi:', e.message);
        res.status(e.status || 503).json({ ok: false, error: e.status ? e.message : 'Service momentanément indisponible. Réessayez sans repayer.' });
      }
    };
  }

  app.get('/don-rabbi/api/config', limit, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, enabled: Boolean(secret() && pubkey()), publishableKey: pubkey() });
  });

  // Crée le paiement (sans débiter). Le montant est fixé ici, côté serveur.
  app.post('/don-rabbi/api/create', limit, safe(async (req, res) => {
    const b = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(b.requestId || '')) throw problem('Demande invalide.');
    const cents = Number(b.amountCents);
    if (!Number.isSafeInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) throw problem('Montant invalide (minimum 1 €).');
    const email = clean(b.email, 160);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem('E-mail invalide.');
    const prenom = clean(b.prenom, 100), nom = clean(b.nom, 100), ref = clean(b.ref, 40);
    const pi = await stripe('payment_intents', {
      amount: String(cents), currency: 'eur',
      'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never',
      ...(email ? { receipt_email: email } : {}),
      description: 'Don – Lettre au Rabbi – Beth Habad S. Maurice',
      'metadata[source]': SOURCE, 'metadata[prenom]': prenom, 'metadata[nom]': nom,
      'metadata[email]': email, 'metadata[lettre_ref]': ref,
    }, 'don-rabbi-' + b.requestId.toLowerCase() + '-' + cents);
    res.json({ ok: true, clientSecret: pi.client_secret, paymentIntentId: pi.id, amountCents: pi.amount });
  }));

  // Vérifie le paiement auprès de Stripe puis l'enregistre dans les dons Tsedaka.
  app.post('/don-rabbi/api/confirm', limit, safe(async (req, res) => {
    const id = String((req.body || {}).paymentIntentId || '');
    if (!/^pi_[A-Za-z0-9]{10,}$/.test(id)) throw problem('Paiement introuvable.', 404);
    const pi = await stripe('payment_intents/' + encodeURIComponent(id));
    if (!pi.metadata || pi.metadata.source !== SOURCE) throw problem('Paiement introuvable.', 404);
    const paid = pi.status === 'succeeded' && pi.currency === 'eur' && pi.amount_received === pi.amount;
    if (paid) {
      const montant = pi.amount / 100;
      const deja = await pool.query('SELECT 1 FROM tsedaka_dons WHERE stripe_payment_intent_id = $1 LIMIT 1', [pi.id]);
      if (!deja.rows.length) {
        await pool.query(
          "INSERT INTO tsedaka_dons (stripe_payment_intent_id, montant, email, prenom, nom, statut) VALUES ($1,$2,$3,$4,$5,'en_attente')",
          [pi.id, montant, pi.metadata.email || null, pi.metadata.prenom || null, pi.metadata.nom || null]
        );
        console.log('✅ Don Lettre au Rabbi :', pi.id, montant + '€');
      }
    }
    res.json({ ok: true, paid, amountCents: pi.amount, status: pi.status, lettreRef: pi.metadata.lettre_ref || '' });
  }));

  // Reçu fiscal (Cerfa) : le montant vient de Stripe, jamais du navigateur.
  // Réutilise la génération Cerfa de la tsédaka (/tsedaka/cerfa) : PDF par e-mail + WhatsApp,
  // et le don passe en « complet » dans la page admin Tsedaka.
  app.post('/don-rabbi/api/cerfa', limit, safe(async (req, res) => {
    const b = req.body || {};
    const id = String(b.paymentIntentId || '');
    if (!/^pi_[A-Za-z0-9]{10,}$/.test(id)) throw problem('Paiement introuvable.', 404);
    const prenom = clean(b.prenom, 100), nom = clean(b.nom, 100), adresse = clean(b.adresse, 250);
    const tel = clean(b.telephone, 30).replace(/[^\d+]/g, ''), email = clean(b.email, 160);
    if (!prenom || !nom || !adresse) throw problem('Prénom, nom et adresse sont nécessaires pour le reçu fiscal.');
    if (tel.replace(/\D/g, '').length < 8) throw problem('Indiquez un numéro de téléphone valide.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem('E-mail invalide.');
    const pi = await stripe('payment_intents/' + encodeURIComponent(id));
    if (!pi.metadata || pi.metadata.source !== SOURCE || pi.status !== 'succeeded') throw problem('Paiement introuvable.', 404);
    const don = await pool.query('SELECT cerfa_numero FROM tsedaka_dons WHERE stripe_payment_intent_id = $1 LIMIT 1', [pi.id]);
    if (don.rows[0] && don.rows[0].cerfa_numero) return res.json({ ok: true, deja: true });
    const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/tsedaka/cerfa', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ prenom, nom, adresse, tel: email || tel, montant: String(pi.amount / 100), phone: tel, email: email || pi.metadata.email || '' }),
    });
    if (!r.ok) throw problem('Le reçu n’a pas pu être demandé. Réessayez.', 502);
    res.json({ ok: true });
  }));

  return { declarerDomainesApplePay };
}

module.exports = { init };
