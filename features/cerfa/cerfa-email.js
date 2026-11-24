'use strict';

const { createHash, randomBytes } = require('node:crypto');

const logo = Buffer.from('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', 'base64');
const brand = 'Beth Habad S Maurice';
const donUrl = 'https://habad-s-maurice.kehila.io/don';
const partnerUrl = 'mailto:bhsmaurice@gmail.com?subject=Devenir%20partenaire%20du%20Beth%20Habad';
const expiryDays = 30;
const amounts = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function button(url, title, primary = true) {
  const background = primary ? '#243353' : '#fff9ee';
  const color = primary ? '#ffffff' : '#614712';
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:${background};color:${color};border:1px solid ${primary ? '#243353' : '#e4d2ab'};border-radius:9px;padding:12px 17px;text-decoration:none;font-size:14px;font-weight:bold;line-height:20px;">${title}</a>`;
}

function frame({ title, subtitle, content, preview }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f7;color:#26334c;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preview}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f7;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#fff;border:1px solid #e5e8ee;border-radius:16px;">
<tr><td align="center" style="padding:24px 20px 22px;border-bottom:2px solid #d2aa53;">
<img src="cid:logo-beth-habad" width="64" height="64" alt="${brand}" style="margin:0 auto 8px;display:block;">
<p style="margin:0 0 12px;color:#76581e;font-weight:bold;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;">${brand}</p>
<h1 style="margin:0;color:#243353;font-family:Georgia,serif;font-size:30px;line-height:1.18;">${title}</h1>
<p style="margin:9px 0 0;color:#626b7d;font-size:14px;line-height:1.5;">${subtitle}</p>
</td></tr>
<tr><td style="padding:24px 24px 28px;font-size:15px;line-height:1.62;">${content}</td></tr>
<tr><td align="center" style="padding:17px 16px;background:#faf8f2;border-top:1px solid #eee7d9;font-size:12px;line-height:1.6;color:#586075;">
${brand}<br>30 avenue du Maréchal de Lattre de Tassigny, 94410 S Maurice<br>
<a href="tel:+33770241746" style="color:#243353;">07 70 24 17 46</a> · <a href="https://habadsmaurice.com/" style="color:#243353;">habadsmaurice.com</a>
</td></tr></table></td></tr></table></body></html>`;
}

function summary(fields) {
  return `<table width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;background:#f5f7fb;border:1px solid #e7ebf1;border-radius:10px;border-collapse:separate;">${fields.filter(([, value]) => value).map(([label, value]) => `
<tr><th scope="row" align="left" style="padding:8px 12px;font-size:13px;color:#626b7d;font-weight:normal;">${label}</th><td align="right" style="padding:8px 12px;color:#243353;font-size:14px;font-weight:bold;">${escapeHtml(value)}</td></tr>`).join('')}</table>`;
}

function renderCerfaEmail(data, { backup = false, downloadUrl = '' } = {}) {
  const name = [data.prenom, data.nom].filter(value => value && value !== '-').join(' ').trim();
  const amount = amounts.format(Number(data.montant));
  const receiptNumber = escapeHtml(data.numero);
  const details = [
    ['Reçu fiscal', data.numero], ['Montant du don', amount],
    ['Date du don', data.dateVersement], ['Mode de paiement', data.mode]
  ];
  const download = downloadUrl ? `<p style="margin:0 0 8px;">${button(downloadUrl, backup ? 'Télécharger le reçu PDF' : 'Télécharger mon reçu PDF')}</p>` : '';
  const attachment = `<p style="margin:0;color:#626b7d;font-size:13px;">Le PDF est joint à ce message.${downloadUrl ? ` Le lien est valable ${expiryDays} jours.` : ''}</p>`;
  if (backup) {
    const fields = [['Donateur', name], ['Adresse', data.adresse], ['E-mail du donateur', data.email], ...details];
    return {
      subject: `Sauvegarde CERFA ${data.numero} · ${brand}`,
      html: frame({
        title: 'Copie du reçu fiscal', subtitle: `Sauvegarde interne · ${receiptNumber}`, preview: 'Copie de sauvegarde du reçu fiscal.',
        content: summary(fields) + download + attachment
      })
    };
  }
  return {
    subject: `Merci pour votre don · Votre reçu fiscal ${data.numero}`,
    html: frame({
      title: 'Merci pour votre générosité',
      subtitle: `Votre reçu fiscal ${receiptNumber}`,
      preview: 'Merci pour votre don. Votre reçu fiscal est joint à ce message.',
      content: `<p style="margin:0 0 14px;">Bonjour${name ? ` ${escapeHtml(name)}` : ''},</p>
<p style="margin:0 0 14px;">Myriam et moi vous remercions chaleureusement pour votre don de <strong>${escapeHtml(amount)}</strong> au Beth Habad S Maurice.</p>
<p style="margin:0 0 18px;">Votre soutien nous permet d’accueillir les familles, de proposer des cours et d’organiser des activités pour les enfants. Merci de faire vivre ces rendez-vous avec nous.</p>
<p style="margin:0 0 20px;">Avec toute notre gratitude,<br><strong>Rav Levi et Myriam Basanger</strong></p>
${summary(details)}${download}${attachment}
<div style="margin-top:22px;padding-top:17px;border-top:1px solid #eee7d9;">
<p style="margin:0 0 10px;font-weight:bold;color:#243353;">Continuer à soutenir le Beth Habad</p>
<p style="margin:0 0 8px;">${button(donUrl, 'Refaire un don via Kehila', false)}</p>
<p style="margin:0;"><a href="${partnerUrl}" style="color:#614712;font-size:14px;">Devenir partenaire du Beth Habad</a></p></div>`
    })
  };
}

function init({ app, pool, publicBaseUrl, sendEmail }) {
  const digest = token => createHash('sha256').update(token).digest('hex');
  let ready;
  function ensureTable() {
    return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS cerfa_email_downloads (
      token_hash CHAR(64) PRIMARY KEY, numero TEXT NOT NULL, pdf BYTEA NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    )`).catch(error => {
      ready = null;
      throw error;
    });
  }

  async function createDownload(numero, pdf) {
    if (!publicBaseUrl) return '';
    const url = new URL(publicBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const token = randomBytes(32).toString('base64url');
    await ensureTable();
    await pool.query('DELETE FROM cerfa_email_downloads WHERE expires_at <= NOW()');
    await pool.query(
      `INSERT INTO cerfa_email_downloads (token_hash, numero, pdf, expires_at)
       VALUES ($1,$2,$3,NOW() + ($4::int * INTERVAL '1 day'))`,
      [digest(token), numero, pdf, expiryDays]
    );
    return new URL('/recu-fiscal/telecharger/' + token, url).href;
  }

  app.get('/recu-fiscal/telecharger/:token', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
    const { token } = req.params;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(404).send('Lien introuvable ou expiré. Le reçu est également joint à votre e-mail.');
    try {
      await ensureTable();
      const { rows: [receipt] } = await pool.query(
        'SELECT numero, pdf FROM cerfa_email_downloads WHERE token_hash=$1 AND expires_at > NOW()',
        [digest(token)]
      );
      if (!receipt) return res.status(404).send('Lien introuvable ou expiré. Le reçu est également joint à votre e-mail.');
      const numero = receipt.numero.replace(/[^a-z0-9_-]/gi, '_');
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Cerfa_${numero}.pdf"` });
      return res.send(receipt.pdf);
    } catch (error) {
      console.error('Téléchargement CERFA indisponible', error.code || error.name);
      return res.status(503).send('Téléchargement indisponible. Retrouvez le reçu en pièce jointe de votre e-mail.');
    }
  });

  async function send(data, pdfBuffer, backup = false) {
    if (!backup && !data.email) return;
    let downloadUrl = '';
    try {
      downloadUrl = await createDownload(data.numero, pdfBuffer);
    } catch (error) {
      console.error('Lien CERFA indisponible', error.code || error.name);
    }
    const message = renderCerfaEmail(data, { backup, downloadUrl });
    return sendEmail({
      ...message,
      to: backup ? undefined : data.email,
      attachments: [
        { filename: `Cerfa_${data.numero}.pdf`, content: pdfBuffer },
        { filename: 'logo-beth-habad.jpg', content: logo, cid: 'logo-beth-habad' }
      ]
    });
  }

  return { send };
}

module.exports = { init, renderCerfaEmail };
