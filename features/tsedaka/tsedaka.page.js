// ═══════════════════════════════════════════════════════════════
// PAGE ADMIN TSEDAKA (mobile) — /tsedaka?password=...
// + création rapide d'un Cerfa pour un don (/admin/tsedaka/quick-cerfa)
// + doublons de dons masqués (statut 'doublon', rien n'est supprimé)
// ═══════════════════════════════════════════════════════════════

function init({ app, pool, adminPassword, generateCerfaPDF, getNextCerfaNumero, sendWhatsAppDocument, envoyerEmail, marquerOrigineCerfa }) {

  // ─── Doublons : un même paiement enregistré deux fois (une ligne avec Cerfa, une sans, à moins de 5 min) ───
  async function masquerDoublons() {
    try {
      const r = await pool.query(`
        UPDATE tsedaka_dons d SET statut = 'doublon'
        WHERE d.cerfa_numero IS NULL AND COALESCE(d.statut, '') <> 'doublon'
          AND EXISTS (
            SELECT 1 FROM tsedaka_dons k
            WHERE k.id <> d.id AND k.cerfa_numero IS NOT NULL AND k.montant = d.montant
              AND (k.phone = d.phone OR d.phone IS NULL)
              AND ABS(EXTRACT(EPOCH FROM (k.created_at - d.created_at))) < 300
          )`);
      if (r.rowCount) console.log('Tsedaka : ' + r.rowCount + ' doublon(s) de dons masqué(s)');
    } catch (e) { console.error('Doublons Tsedaka :', e.message); }
  }
  // Colonnes utilisées par la page (ajoutées si elles manquent, sans rien effacer)
  (async () => {
    for (const q of [
      'ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS cerfa_numero TEXT',
      'ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS statut TEXT',
      'ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS email TEXT',
      'ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS prenom TEXT',
      'ALTER TABLE tsedaka_dons ADD COLUMN IF NOT EXISTS nom TEXT',
      'ALTER TABLE tsedaka_abonnes ADD COLUMN IF NOT EXISTS email TEXT',
    ]) await pool.query(q).catch(e => console.error('Tsedaka colonnes :', e.message));
  })();
  setTimeout(masquerDoublons, 8000);

  // ─── Créer un Cerfa pour un don précis ───
  app.post('/admin/tsedaka/quick-cerfa', async (req, res) => {
    const { password, don_id, email, montant, prenom, nom, phone, societe, adresse } = req.body;
    if (password !== adminPassword) return res.json({ ok: false, error: 'Mot de passe incorrect' });
    try {
      const montantNum = parseFloat(String(montant).replace(',', '.'));
      if (!prenom || !nom || isNaN(montantNum) || montantNum <= 0) return res.json({ ok: false, error: 'Prénom, nom et montant requis' });
      let don = null;
      if (don_id) {
        const d = await pool.query('SELECT * FROM tsedaka_dons WHERE id = $1', [don_id]);
        don = d.rows[0] || null;
        if (don && don.cerfa_numero) return res.json({ ok: false, error: 'Ce don a déjà le Cerfa ' + don.cerfa_numero });
      }
      let tel = String(phone || '').replace(/\D/g, '');
      if (tel.startsWith('0') && tel.length === 10) tel = '33' + tel.slice(1);
      const numero = await getNextCerfaNumero();
      const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      const dateDonIso = don ? new Date(don.created_at).toISOString().slice(0, 10)
        : paris.getFullYear() + '-' + String(paris.getMonth() + 1).padStart(2, '0') + '-' + String(paris.getDate()).padStart(2, '0');
      const dateVersement = new Date(dateDonIso + 'T00:00:00').toLocaleDateString('fr-FR');
      const nomFinal = societe && societe.trim() ? societe.trim() : nom.trim();
      const prenomFinal = societe && societe.trim() ? '-' : prenom.trim();
      const adresseFinale = (adresse || '').trim();
      const pdfBuffer = await generateCerfaPDF({ numero, nom: nomFinal, prenom: prenomFinal, adresse: adresseFinale, montant: montantNum, mode: 'Carte bancaire', dateVersement });

      await pool.query(
        'INSERT INTO cerfa_receipts (numero, nom, prenom, adresse, montant, mode_paiement, date_don, email, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [numero, nomFinal, prenomFinal, adresseFinale, montantNum, 'Stripe', dateDonIso, email || null, tel || null]);
      marquerOrigineCerfa(numero, 'tsedaka');
      if (don) await pool.query("UPDATE tsedaka_dons SET cerfa_numero = $1, statut = 'complet', phone = COALESCE(phone, $2), email = COALESCE(email, $3) WHERE id = $4", [numero, tel || null, email || null, don.id]);
      else await pool.query("INSERT INTO tsedaka_dons (phone, montant, cerfa_numero, statut, email) VALUES ($1,$2,$3,'complet',$4)", [tel || null, montantNum, numero, email || null]);
      if (tel) await pool.query('INSERT INTO tsedaka_abonnes (phone, prenom, nom) VALUES ($1,$2,$3) ON CONFLICT (phone) DO NOTHING', [tel, prenom.trim(), nom.trim()]).catch(() => {});

      const envois = [];
      if (tel) { try { await sendWhatsAppDocument(tel, pdfBuffer, 'Cerfa_' + numero + '.pdf'); envois.push('WhatsApp'); } catch (e) { console.error('Cerfa WhatsApp :', e.message); } }
      if (email && email.includes('@')) {
        const societeText = societe ? `<br/><strong>Organisme :</strong> ${societe}` : '';
        const r = await envoyerEmail({ to: email, subject: 'Votre reçu fiscal Tsedaka - ' + numero, html: `Bonjour ${prenom},<br/><br/>Merci pour votre don de ${montantNum} € au Beth Habad S. Maurice.${societeText}<br/>Votre reçu fiscal (numéro ${numero}) est ci-joint.<br/><br/>Kol Touv,<br/>Beth Habad S. Maurice`, attachments: [{ filename: 'Cerfa_' + numero + '.pdf', content: pdfBuffer }] });
        if (r && r.ok) envois.push('email');
      }
      res.json({ ok: true, numero, envois });
    } catch (e) {
      console.error('quick-cerfa :', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  // ─── La page ───
  app.get('/tsedaka', async (req, res) => {
    const { password } = req.query;
    if (password !== adminPassword) return res.status(401).send('Mot de passe incorrect');
    try {
      await masquerDoublons();
      const dons = (await pool.query(`
        SELECT d.id, d.created_at, d.montant, d.phone, d.cerfa_numero, d.statut,
               COALESCE(NULLIF(a.prenom, ''), NULLIF(c.prenom, '-'), NULLIF(d.prenom, '')) AS prenom,
               COALESCE(NULLIF(a.nom, ''), c.nom, d.nom) AS nom,
               COALESCE(d.email, a.email, c.email) AS email
        FROM tsedaka_dons d
        LEFT JOIN tsedaka_abonnes a ON a.phone = d.phone
        LEFT JOIN cerfa_receipts c ON c.numero = d.cerfa_numero
        WHERE COALESCE(d.statut, '') <> 'doublon'
        ORDER BY d.created_at DESC LIMIT 1000`)).rows;
      const cerfas = (await pool.query(`
        SELECT id, numero, prenom, nom, montant, created_at, date_don, email, phone, origine, mode_paiement
        FROM cerfa_receipts ORDER BY created_at DESC LIMIT 1000`)).rows;
      const ab = (await pool.query('SELECT COUNT(*)::int AS n, COUNT(CASE WHEN carte_gardee THEN 1 END)::int AS cartes, COUNT(CASE WHEN rappel_quotidien THEN 1 END)::int AS rappels FROM tsedaka_abonnes')).rows[0];
      const data = { dons, cerfas, abonnes: ab, maj: new Date().toISOString() };
      const json = s => JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(PAGE.replace('__DATA__', json(data)).replace('__PW__', json(password)));
    } catch (e) {
      res.status(500).send('Erreur : ' + e.message);
    }
  });

  console.log('💜 Page Tsedaka (mobile) prête');
}

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F6F8FC">
<title>Tsédaka — Admin</title>
<style>
:root{--bg:#F6F8FC;--card:#fff;--ink:#0B1B3F;--muted:#5B6B8C;--line:#E4E9F2;--blue:#0A5BFF;--blue-soft:#EAF1FF;--green:#0F8A4B;--green-soft:#E3F6EA;--orange:#B25E00;--orange-soft:#FFF1D9;--red:#C62828;--violet:#7C3AED}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif;font-size:16px}
button,input,select{font:inherit;color:inherit}
.app{max-width:720px;margin:0 auto;padding:18px 16px calc(96px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand h1{margin:0;font-size:28px;font-weight:800;letter-spacing:-.5px}
.brand p{margin:2px 0 0;color:var(--muted);font-size:14px}
.avatar{width:46px;height:46px;border-radius:50%;background:#DCE7FF;color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0}
.titre{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin:22px 0 4px}
.titre h2{margin:0;font-size:32px;font-weight:800;letter-spacing:-.8px}
.maj{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;background:none;border:0;padding:4px 0;cursor:pointer;white-space:nowrap}
.maj svg{color:var(--blue)}
.sous{margin:0 0 16px;color:var(--muted);font-size:15px}
.outils{display:flex;gap:10px;margin-bottom:10px}
.champ{flex:1;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0 14px;height:50px;box-shadow:0 1px 2px rgba(11,27,63,.04)}
.champ input,.champ select{border:0;outline:0;background:none;flex:1;min-width:0;height:100%;font-size:16px}
.champ select{appearance:none;-webkit-appearance:none;cursor:pointer}
.champ svg{color:var(--muted);flex-shrink:0}
.icone-btn{width:50px;height:50px;border-radius:14px;border:1px solid var(--line);background:var(--card);display:flex;align-items:center;justify-content:center;color:var(--blue);cursor:pointer;position:relative}
.icone-btn .pastille{position:absolute;top:8px;right:8px;width:8px;height:8px;border-radius:50%;background:var(--blue);display:none}
.icone-btn.actif .pastille{display:block}
.compte{color:var(--muted);font-size:13px;margin:6px 2px 10px}
.carte{background:var(--card);border-radius:18px;padding:16px 16px 14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(11,27,63,.06),0 4px 14px rgba(11,27,63,.04)}
.carte-haut{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.nom{font-weight:700;font-size:18px;line-height:1.25;word-break:break-word}
.nom.vide{color:var(--muted)}
.date{color:var(--muted);font-size:14px;margin-top:3px}
.montant{color:var(--blue);font-weight:800;font-size:22px;white-space:nowrap}
.statut{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:5px 10px;border-radius:999px;font-size:13px;font-weight:600}
.statut.ok{background:var(--green-soft);color:var(--green)}
.statut.attente{background:var(--orange-soft);color:var(--orange)}
.statut.orig{background:#F3EEFF;color:var(--violet);margin-left:6px}
.statut.orig.bot{background:#EAF1FF;color:#1D4ED8}
.actions{display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.btn{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;height:44px;border-radius:12px;border:1.5px solid #CFDBF5;background:var(--card);color:var(--blue);font-weight:600;font-size:15px;cursor:pointer}
.btn.plein{background:var(--blue);border-color:var(--blue);color:#fff}
.btn:disabled{opacity:.45}
.vide-liste{text-align:center;color:var(--muted);padding:40px 10px}
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border-radius:16px;padding:14px;box-shadow:0 1px 3px rgba(11,27,63,.06)}
.kpi b{display:block;font-size:22px;font-weight:800}
.kpi span{color:var(--muted);font-size:13px}
.kpi.bleu b{color:var(--blue)} .kpi.orange b{color:var(--orange)} .kpi.vert b{color:var(--green)}
.alerte{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--orange-soft);color:var(--orange);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-weight:600;cursor:pointer;border:0;width:100%;text-align:left}
.section{font-weight:700;font-size:17px;margin:18px 2px 10px}
.barres{background:var(--card);border-radius:16px;padding:16px;box-shadow:0 1px 3px rgba(11,27,63,.06)}
.barre{display:grid;grid-template-columns:70px 1fr 80px;gap:10px;align-items:center;margin:8px 0;font-size:14px}
.barre .fond{height:10px;background:#EEF2F9;border-radius:6px;overflow:hidden}
.barre .rempli{height:100%;background:var(--blue);border-radius:6px}
.barre .val{text-align:right;font-weight:600}
nav.bas{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);z-index:20}
nav.bas .in{max-width:720px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr)}
nav.bas button{background:none;border:0;padding:10px 0 9px;display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--muted);font-size:13px;cursor:pointer;position:relative}
nav.bas button.on{color:var(--blue);font-weight:600}
nav.bas button.on::after{content:"";position:absolute;bottom:0;left:22%;right:22%;height:3px;background:var(--blue);border-radius:3px 3px 0 0}
.voile{position:fixed;inset:0;background:rgba(11,27,63,.4);display:none;z-index:40}
.voile.ouvert{display:block}
.feuille{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;padding:10px 18px calc(20px + env(safe-area-inset-bottom));z-index:50;transform:translateY(105%);transition:transform .22s ease;max-height:88vh;overflow:auto;max-width:720px;margin:0 auto}
.feuille.ouvert{transform:none}
.poignee{width:40px;height:5px;border-radius:3px;background:#D5DCE8;margin:0 auto 12px}
.feuille h3{margin:0 0 4px;font-size:20px}
.feuille .info{color:var(--muted);font-size:14px;margin-bottom:14px}
.choix{display:flex;align-items:center;gap:12px;width:100%;background:none;border:0;border-bottom:1px solid var(--line);padding:15px 4px;font-size:16px;cursor:pointer;text-align:left}
.choix:last-child{border-bottom:0}
.choix svg{color:var(--blue);flex-shrink:0}
.form label{display:block;font-size:13px;color:var(--muted);margin:12px 0 5px;font-weight:600}
.form input{width:100%;height:46px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:16px;background:#fff}
.form .deux{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.form .btn{margin-top:18px;flex:none;width:100%}
.puces{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.puce{border:1.5px solid var(--line);background:#fff;border-radius:999px;padding:8px 14px;font-size:14px;cursor:pointer}
.puce.on{border-color:var(--blue);background:var(--blue-soft);color:var(--blue);font-weight:600}
.toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:#fff;padding:12px 16px;border-radius:12px;font-size:14px;z-index:60;max-width:90vw;display:none}
.toast.err{background:var(--red)}
@media (min-width:700px){.liste{display:grid;grid-template-columns:1fr 1fr;gap:12px}.liste .carte{margin:0}.kpis{grid-template-columns:repeat(4,1fr)}}

/* Espace de gestion : hiérarchie plus nette, densité adaptée à chaque écran. */
:root{--bg:#F3F5FA;--ink:#192B4E;--muted:#7A879E;--line:#E3E8F1;--blue:#4263C7;--blue-soft:#EDF1FF;--green:#348060;--green-soft:#EAF6EF;--orange:#A77A2E;--orange-soft:#FFF5E3}
html,body{font-size:15px;letter-spacing:-.1px}button{transition:background .15s,border-color .15s,box-shadow .15s}button:focus-visible{outline:3px solid #9FB3EC;outline-offset:3px}.app{max-width:1120px;padding:28px 28px calc(116px + env(safe-area-inset-bottom))}.top{padding:0 0 22px;border-bottom:1px solid var(--line)}.brand{position:relative;padding-left:48px}.brand:before{content:'T';position:absolute;left:0;top:2px;width:35px;height:39px;border-radius:10px;background:#263D6C;color:white;display:grid;place-items:center;font-size:21px;font-weight:700}.brand h1{font-size:21px;letter-spacing:-.6px;font-weight:750}.brand p{font-size:11px;margin-top:4px}.avatar{width:37px;height:37px;background:#E7ECF7;color:#5D729D;font-size:11px;border:3px solid white;box-shadow:0 1px 3px #1E31500B}.titre{margin-top:28px;align-items:center}.titre h2{font-size:29px;letter-spacing:-1px;font-weight:750}.maj{font-size:10px;gap:7px;padding:8px 10px;border-radius:8px;background:#fff;border:1px solid var(--line)}.maj svg{width:14px;height:14px}.sous{font-size:12px;margin:7px 0 23px;line-height:1.7}.resume-dons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 25px}.resume-case{padding:18px 20px;background:white;border:1px solid var(--line);border-radius:12px;min-width:0;text-align:left}.resume-case span{display:block;font-size:10px;color:var(--muted);margin-bottom:10px;font-weight:500}.resume-case strong{font-size:25px;font-weight:700;letter-spacing:-.8px;line-height:1.2;display:block}.resume-case em{display:block;font-size:10px;color:#8A96A9;font-style:normal;margin-top:8px}.resume-case.primary{background:#263D6C;border-color:#263D6C;color:white;box-shadow:0 6px 16px #263D6C13}.resume-case.primary span{color:#BBC9E1}.resume-case.primary em{color:#9FB1D2}.resume-case.attention strong{color:#A47831}.resume-case.attention{cursor:pointer}.resume-case.attention:hover{border-color:#D2B67D;background:#FFFCF5}.barre-filtres{display:grid;grid-template-columns:minmax(0,1fr) 235px;gap:12px;margin-bottom:16px}.outils{margin:0;gap:8px}.champ{height:44px;border-radius:9px;box-shadow:none;padding:0 13px;min-width:0}.champ:focus-within{border-color:#A6B6E3;box-shadow:0 0 0 3px #4263C70B}.champ input,.champ select{font-size:12px}.champ svg{width:17px;height:17px}.icone-btn{width:44px;height:44px;border-radius:9px;color:#63769D;flex-shrink:0}.icone-btn:hover,.icone-btn.actif{background:var(--blue-soft);border-color:#C4D0EE;color:var(--blue)}.icone-btn svg{width:18px;height:18px}.compte{font-size:10px;color:#8B96AA;letter-spacing:.2px;margin:4px 1px 14px}.liste{gap:13px;align-items:stretch}.carte{border-radius:12px;padding:18px 18px 13px;border:1px solid var(--line);box-shadow:0 2px 4px #263D6C03;margin-bottom:12px;position:relative;overflow:hidden}.carte:hover{border-color:#C6D1E7;box-shadow:0 4px 16px #263D6C08}.carte-haut{gap:13px}.carte-haut>div:first-child{min-width:0}.nom{font-size:14px;font-weight:650;line-height:1.5;letter-spacing:-.2px}.nom.vide{font-weight:500;color:#8A94A8}.date{font-size:10px;margin-top:5px;line-height:1.6;color:#8A96A9}.montant{font-size:23px;color:#253B65;font-weight:700;letter-spacing:-.7px;font-variant-numeric:tabular-nums}.statut{font-size:10px;gap:5px;padding:5px 8px;margin-top:17px;font-weight:500;letter-spacing:0;line-height:1.5}.statut svg{width:12px;height:12px}.statut.ok{border:1px solid #DDEFE4}.statut.attente{border:1px solid #F5E8CC}.actions{gap:7px;margin-top:17px;padding-top:12px;border-color:#EFF2F7}.btn{height:35px;border-radius:7px;border:1px solid #E0E6F2;font-size:11px;gap:7px;font-weight:600;color:#5872B0;background:#F9FAFE}.btn svg{width:15px;height:15px}.btn:hover{background:#EDF1FB;border-color:#CCD6ED}.btn.plein{color:#fff;background:#4263C7;border-color:#4263C7}.btn.plein:hover{background:#354FA6}.actions .btn:last-child{background:white;color:#7A88A1;border-color:#E8ECF3;flex:.72}.don-carte.sans-cerfa:before{content:'';position:absolute;left:0;top:18px;bottom:18px;width:3px;background:#E5C98E;border-radius:0 3px 3px 0}.kpi{border:1px solid var(--line);border-radius:12px;box-shadow:none;padding:19px}.kpi b{font-size:25px;letter-spacing:-.7px}.kpi span{font-size:11px;display:block;margin-top:7px}.section{font-size:13px;font-weight:650;margin-top:25px}.barres{box-shadow:none;border:1px solid var(--line);border-radius:12px}.barre{font-size:11px}.barre .fond{height:7px}.barre .rempli{background:#7F96D7}.alerte{font-size:12px;border:1px solid #F0DFB8;border-radius:10px}.feuille{border-radius:18px 18px 0 0;box-shadow:0 -10px 50px #192B4E12}.feuille h3{font-size:20px;letter-spacing:-.4px}.feuille .info{font-size:12px}.choix{font-size:13px}.choix svg{width:19px;height:19px}.form label{font-size:11px}.form .btn{height:44px;font-size:13px}.puce{font-size:12px;border-radius:8px}.toast{font-size:12px;border-radius:10px}.vide-liste{padding:50px 18px;border:1px dashed #D8E0EE;background:#FFFFFF70;border-radius:12px;font-size:12px;grid-column:1/-1}nav.bas{border:1px solid #E0E6F0;box-shadow:0 -3px 20px #192B4E04}nav.bas .in{max-width:680px}nav.bas button{font-size:10px;gap:5px;padding:12px 0}nav.bas button svg{width:20px;height:20px}nav.bas button.on{color:#4263C7}nav.bas button.on:after{height:2px;left:35%;right:35%}
@media(min-width:700px){.liste{grid-template-columns:repeat(2,minmax(0,1fr))}.liste .carte{display:flex;flex-direction:column;margin:0}.liste .carte .actions{margin-top:auto;padding-top:12px}.liste .carte .statut{align-self:flex-start;margin-bottom:15px}.feuille{bottom:25px;border-radius:16px;max-width:520px;padding:22px 25px 25px}.feuille .poignee{display:none}nav.bas{left:50%;right:auto;bottom:18px;transform:translateX(-50%);width:510px;border-radius:15px;padding:0 12px}nav.bas .in{width:100%}nav.bas button.on:after{bottom:5px;left:39%;right:39%}.kpis{gap:13px}}
@media(min-width:1080px){.liste{grid-template-columns:repeat(3,minmax(0,1fr))}.carte{padding:17px 16px 13px}.montant{font-size:21px}.nom{font-size:13px}.actions .btn{font-size:10px}.actions .btn:last-child{flex:.7}}
@media(max-width:600px){.app{padding:20px 16px calc(98px + env(safe-area-inset-bottom))}.top{padding-bottom:19px}.brand h1{font-size:20px}.brand p{font-size:10px}.titre{margin-top:23px}.titre h2{font-size:27px}.maj{font-size:9px;padding:7px}.sous{font-size:11px;margin-bottom:19px}.resume-dons{gap:7px;margin-bottom:19px}.resume-case{padding:13px 10px;border-radius:10px}.resume-case span{font-size:9px;line-height:1.4;margin-bottom:9px}.resume-case strong{font-size:21px;letter-spacing:-.8px}.resume-case em{font-size:8px;line-height:1.5;margin-top:7px}.barre-filtres{grid-template-columns:1fr;gap:8px;margin-bottom:12px}.champ{height:43px}.icone-btn{height:43px;width:43px}.carte{padding:17px 16px 12px;border-radius:12px}.nom{font-size:14px}.date{font-size:10px}.montant{font-size:24px}.statut{font-size:10px;margin-top:14px}.actions{margin-top:14px}.btn{height:39px;font-size:12px}.compte{margin-bottom:11px}.kpi b{font-size:23px}.brand:before{width:33px;height:37px}.brand{padding-left:44px}}
@media(max-width:600px){.champ input,.champ select{font-size:16px}.icone-btn{height:44px;width:44px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}

.brand:before{display:none}.brand{padding-left:50px}.module-logo{position:absolute;left:0;top:0;width:38px;height:43px;display:grid;place-items:center;border-radius:11px;background:#263D6C;color:#fff;box-shadow:0 3px 9px #263D6C15}.module-logo svg{width:30px;height:30px}@media(max-width:600px){.brand{padding-left:46px}.module-logo{width:35px;height:40px;border-radius:10px}.module-logo svg{width:28px;height:28px}}

/* Identité commune : bleu du formulaire, caractères plus grands et contrastes lisibles. */
:root{--bg:#F5F7FC;--card:#fff;--ink:#253D78;--muted:#7D8AA4;--line:#DFE6F1;--blue:#253D78;--blue-soft:#EDF2FD;--green:#4F7956;--green-soft:#EEF5E9;--orange:#98671D;--orange-soft:#FFF7DE}
html,body{font-family:Arial,Helvetica,sans-serif;font-size:17px;color:var(--ink);letter-spacing:0}.app{max-width:1240px;padding:30px 32px calc(125px + env(safe-area-inset-bottom))}.top{padding-bottom:25px}.brand{padding-left:60px}.brand h1{font-family:'Trebuchet MS',Arial,sans-serif;font-size:27px;line-height:1.2;font-weight:700;letter-spacing:-.7px}.brand p{font-size:14px;line-height:1.6;margin-top:4px}.module-logo{width:46px;height:50px;border-radius:13px;background:#253D78}.module-logo svg{width:35px;height:35px}.avatar{width:45px;height:45px;font-size:14px}.titre{margin-top:32px}.titre h2{font-family:'Trebuchet MS',Arial,sans-serif;font-size:37px;letter-spacing:-1px;font-weight:700}.sous{font-size:16px;line-height:1.8;margin-top:8px;margin-bottom:26px}.maj{font-size:13px;padding:11px 13px;gap:8px;border-radius:10px}.maj svg{width:17px;height:17px}.resume-dons{gap:16px;margin-bottom:27px}.resume-case{padding:22px 24px;border-radius:16px}.resume-case span{font-size:14px;line-height:1.5;margin-bottom:12px}.resume-case strong{font-family:'Trebuchet MS',Arial,sans-serif;font-size:34px;letter-spacing:-1px;font-weight:700}.resume-case em{font-size:12px;line-height:1.7;margin-top:10px}.resume-case.primary{background:#253D78;border-color:#253D78;box-shadow:0 7px 22px #253D7810}.resume-case.primary span{color:#CCD7ED}.resume-case.primary em{color:#ACBEDF}.resume-case.attention{background:#FFFBEF;border-color:#EDDCB0}.barre-filtres{grid-template-columns:minmax(0,1fr) 265px;gap:14px;margin-bottom:16px}.outils{gap:10px}.champ{height:54px;padding:0 17px;border-radius:12px}.champ input,.champ select{font-size:16px}.champ svg{width:21px;height:21px}.icone-btn{width:54px;height:54px;border-radius:12px}.icone-btn svg{width:23px;height:23px}.compte{font-size:14px;margin:10px 2px 18px;line-height:1.7;color:#8491AA}.liste{gap:17px}.carte{border-radius:16px;padding:23px 23px 18px;box-shadow:0 3px 14px #253D7804}.carte-haut{gap:15px}.nom{font-size:18px;line-height:1.5;font-weight:600;letter-spacing:-.2px}.date{font-size:14px;margin-top:7px;line-height:1.7;color:#8A96AD}.montant{font-family:'Trebuchet MS',Arial,sans-serif;font-size:31px;line-height:1.25;font-weight:700;letter-spacing:-1px;color:#253D78}.statut{font-size:13px;line-height:1.6;padding:6px 10px;gap:7px;margin-top:19px;max-width:100%;overflow-wrap:anywhere}.statut svg{width:15px;height:15px;flex-shrink:0}.statut.attente{border-color:#F0DAA0}.actions{padding-top:16px;gap:10px}.btn{height:46px;font-size:14px;font-weight:600;border-radius:11px;gap:8px;background:#F4F7FE;color:#253D78;border-color:#DCE4F3}.btn svg{width:19px;height:19px}.btn.plein{background:#253D78;border-color:#253D78}.btn.plein:hover{background:#314F91}.actions .btn:last-child{font-size:14px;color:#7184AA}.kpi{border-radius:16px;padding:22px}.kpi b{font-family:'Trebuchet MS',Arial,sans-serif;font-size:32px;color:#253D78}.kpi span{font-size:14px;line-height:1.6}.section{font-family:'Trebuchet MS',Arial,sans-serif;font-size:21px;font-weight:700;letter-spacing:-.3px;margin:27px 2px 16px}.alerte{font-size:15px;padding:16px 18px;border-radius:12px}.barres{padding:21px;border-radius:16px}.barre{font-size:14px;grid-template-columns:90px 1fr 95px;margin:13px 0}.barre .fond{height:9px}.feuille{max-width:600px;padding:27px 28px}.feuille h3{font-family:'Trebuchet MS',Arial,sans-serif;font-size:27px;line-height:1.3;color:#253D78}.feuille .info{font-size:15px;line-height:1.8;margin:10px 0 18px}.choix{font-size:16px;line-height:1.6;padding:17px 4px;gap:13px}.choix svg{width:22px;height:22px}.puce{font-size:15px;padding:11px 16px;border-radius:11px}.form label{font-size:14px;line-height:1.7;margin-top:16px}.form input{font-size:17px;height:53px;border-radius:12px}.form .btn{font-size:16px;height:53px}.toast{font-size:15px;padding:14px 20px;border-radius:13px;line-height:1.7}.vide-liste{font-size:15px;padding:60px 20px}nav.bas{width:590px;border-radius:17px}nav.bas button{font-size:13px;padding:13px 0;gap:6px}nav.bas button svg{width:23px;height:23px}nav.bas button.on{color:#253D78}nav.bas button.on:after{background:#253D78}
@media(min-width:700px){.liste{grid-template-columns:repeat(2,minmax(0,1fr))}.liste .carte .statut{margin-bottom:20px}.liste .carte .actions{padding-top:16px}.actions .btn:last-child{flex:.7}.kpis{gap:16px}}
@media(max-width:699px){.app{padding:22px 17px calc(108px + env(safe-area-inset-bottom))}.top{padding-bottom:21px}.brand{padding-left:51px}.brand h1{font-size:24px}.brand p{font-size:12px}.module-logo{width:39px;height:44px;border-radius:11px}.module-logo svg{width:30px;height:30px}.avatar{width:39px;height:39px;font-size:12px}.titre{margin-top:25px}.titre h2{font-size:32px}.maj{font-size:11px;padding:9px}.maj svg{width:16px;height:16px}.sous{font-size:14px;line-height:1.8;margin-bottom:21px}.resume-dons{grid-template-columns:1fr 1fr;gap:10px;margin-bottom:22px}.resume-case{padding:17px 15px;border-radius:13px}.resume-case.primary{grid-column:1/-1;display:grid;grid-template-columns:1fr auto;column-gap:12px;align-items:center}.resume-case.primary span{margin:0}.resume-case.primary strong{grid-column:2;grid-row:1/3;font-size:35px}.resume-case.primary em{grid-column:1;margin-top:4px;font-size:11px}.resume-case span{font-size:12px;margin-bottom:9px}.resume-case strong{font-size:29px}.resume-case em{font-size:10px;line-height:1.6}.barre-filtres{grid-template-columns:1fr;gap:9px}.champ{height:51px;padding:0 14px}.champ input,.champ select{font-size:16px}.icone-btn{height:51px;width:51px}.compte{font-size:13px;margin-bottom:13px}.carte{padding:20px 18px 16px;border-radius:15px;margin-bottom:13px}.nom{font-size:17px}.date{font-size:13px}.montant{font-size:29px}.statut{font-size:12px;padding:6px 9px}.btn,.actions .btn:last-child{font-size:14px;height:45px}.actions{gap:9px;margin-top:16px}.kpi{padding:18px}.kpi b{font-size:28px}.kpi span{font-size:12px}.section{font-size:20px}.barre{font-size:12px;grid-template-columns:74px 1fr 80px}.feuille{padding:17px 20px calc(24px + env(safe-area-inset-bottom));max-width:none}.feuille h3{font-size:25px}.feuille .info{font-size:14px}.choix{font-size:16px}.form .deux{gap:12px}.form label{font-size:13px}.puce{font-size:14px}nav.bas{left:0;right:0;bottom:0;width:auto;transform:none;border-radius:0;padding:0 8px env(safe-area-inset-bottom)}nav.bas button{font-size:12px;padding:12px 0}.toast{font-size:14px}}


/* Comfortable phone controls, safe-area navigation and readable detail sheets. */
@media(max-width:699px){
.app{width:100%;min-width:0;padding-bottom:calc(116px + env(safe-area-inset-bottom))}.top{gap:12px}.brand{min-width:0}.brand p{line-height:1.5}.avatar{flex-shrink:0}.titre{gap:12px}.maj{min-height:44px;flex-shrink:0}.liste{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}.liste .carte{margin:0;min-width:0}.carte-haut{flex-wrap:wrap;gap:10px}.carte-haut>div:first-child{flex:1 1 155px}.nom{overflow-wrap:anywhere}.montant{flex-shrink:0}.statut{white-space:normal;line-height:1.6}.actions{display:flex;flex-wrap:wrap}.actions .btn,.actions .btn:last-child{min-height:48px;height:auto;padding:12px 10px;line-height:1.4;flex:1 1 120px}.champ{min-width:0;height:53px}.champ input,.champ select{min-width:0;width:100%;font-size:16px}.icone-btn{height:53px;width:53px}.resume-case{min-width:0}.resume-case strong{overflow-wrap:anywhere}.resume-case.primary{grid-template-columns:minmax(0,1fr) auto}.resume-case.primary strong{font-size:31px}.resume-case em{font-size:11px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{min-width:0}.kpi b{overflow-wrap:anywhere}.barres{padding:16px 12px}.feuille{max-height:92vh;max-height:92dvh;overscroll-behavior:contain;padding-left:18px;padding-right:18px}.feuille .info{overflow-wrap:anywhere}.choix{min-height:52px}.form input,.form select{font-size:16px;min-height:52px;max-width:100%}.form .deux{grid-template-columns:minmax(0,1fr)}.form .btn{min-height:52px}.puce{min-height:46px}.toast{max-width:calc(100% - 32px);bottom:calc(90px + env(safe-area-inset-bottom));overflow-wrap:anywhere}nav.bas{padding-bottom:env(safe-area-inset-bottom)}nav.bas button{min-height:66px;touch-action:manipulation}button,a,input,select{touch-action:manipulation}
}
</style></head>
<body>
<div class="app">
  <div class="top">
    <div class="brand"><span class="module-logo tsedaka-logo"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 14h18v13H7z" fill="#FFFFFF" fill-opacity=".13" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6 14l4-5h12l4 5M12 17h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="16" cy="5" r="3" fill="#E8D28E"/><path d="M16 3.5v3" stroke="#9B7B31" stroke-width="1.2" stroke-linecap="round"/><path d="M11 22h10" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round"/></svg></span><h1>Tsédaka</h1><p>Beth Habad S. Maurice Plateau</p></div>
    <div class="avatar">LB</div>
  </div>
  <div class="titre"><h2 id="titre">Dons</h2>
    <button class="maj" onclick="location.reload()" title="Actualiser"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg><span id="maj"></span></button>
  </div>
  <p class="sous" id="sous">Gérez les dons et les reçus fiscaux</p>
  <div id="vue"></div>
</div>

<nav class="bas"><div class="in">
  <button data-v="accueil" onclick="aller('accueil')"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>Accueil</button>
  <button data-v="dons" onclick="aller('dons')"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/><path d="M5 11.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/></svg>Dons</button>
  <button data-v="cerfa" onclick="aller('cerfa')"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>Cerfa</button>
  <button data-v="stats" onclick="aller('stats')"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 20V11M12 20V5M18 20v-7"/></svg>Statistiques</button>
</div></nav>

<div class="voile" id="voile" onclick="fermer()"></div>
<div class="feuille" id="feuille"><div class="poignee"></div><div id="feuille-contenu"></div></div>
<div class="toast" id="toast"></div>

<script>
const DATA = __DATA__;
const PW = __PW__;
const IC = {
  doc:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  dots:'<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  ok:'<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="m7 12.5 3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  horloge:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  dl:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  mail:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  wa:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.2A8.5 8.5 0 1 1 20 11.5z"/></svg>',
  copie:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  loupe:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  filtre:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="#fff"/><circle cx="15" cy="12" r="2" fill="#fff"/><circle cx="8" cy="17" r="2" fill="#fff"/></svg>',
  cal:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  plus:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
};
const etat = { vue: 'dons', q: '', periode: 'tout', statut: 'tous', qc: '', periodeC: 'tout', origine: 'tous' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const euros = n => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const MOIS = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
function quand(iso){ const d = new Date(iso); const p = new Date(d.toLocaleString('en-US',{timeZone:'Europe/Paris'})); return p.getDate()+' '+MOIS[p.getMonth()]+' '+p.getFullYear()+' · '+String(p.getHours()).padStart(2,'0')+':'+String(p.getMinutes()).padStart(2,'0'); }
function nomDe(x){ const p = (x.prenom && x.prenom !== '-' && x.prenom !== '?') ? x.prenom : ''; const n = (x.nom && x.nom !== '?') ? x.nom : ''; return (p + ' ' + n).trim(); }
function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,''); }
function dansPeriode(iso, periode){
  if (periode === 'tout') return true;
  const d = new Date(iso), now = new Date();
  const debutJour = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (periode === 'jour') return d >= debutJour;
  if (periode === '7j') return d >= new Date(debutJour - 6*864e5);
  if (periode === 'mois') return d >= new Date(now.getFullYear(), now.getMonth(), 1);
  if (periode === 'moisdernier') return d >= new Date(now.getFullYear(), now.getMonth()-1, 1) && d < new Date(now.getFullYear(), now.getMonth(), 1);
  if (periode === 'annee') return d >= new Date(now.getFullYear(), 0, 1);
  return true;
}
const PERIODES = [['tout','Toutes les dates'],['jour',"Aujourd'hui"],['7j','7 derniers jours'],['mois','Ce mois-ci'],['moisdernier','Le mois dernier'],['annee','Cette année']];
function toast(msg, err){ const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.style.display = 'block'; clearTimeout(window._t); window._t = setTimeout(() => t.style.display = 'none', 3200); }

// ── Navigation ──
const TITRES = { accueil: ['Accueil','Vue d’ensemble de la Tsédaka'], dons: ['Dons','Gérez les dons et les reçus fiscaux'], cerfa: ['Cerfa','Tous les reçus fiscaux'], stats: ['Statistiques','Les chiffres de la Tsédaka'] };
function aller(v){ etat.vue = v; try{ history.replaceState(null,'','#'+v); }catch(e){} document.querySelectorAll('nav.bas button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); document.getElementById('titre').textContent = TITRES[v][0]; document.getElementById('sous').textContent = TITRES[v][1]; rendre(); window.scrollTo(0,0); }
function rendre(){ ({ accueil: vueAccueil, dons: vueDons, cerfa: vueCerfa, stats: vueStats })[etat.vue](); }

// ── Dons ──
function donsFiltres(){ const q = norm(etat.q); return DATA.dons.filter(d => (!q || norm(nomDe(d) + ' ' + (d.email||'') + ' ' + (d.phone||'') + ' ' + (d.cerfa_numero||'') + ' ' + d.montant).includes(q)) && dansPeriode(d.created_at, etat.periode) && (etat.statut === 'tous' || (etat.statut === 'ok' ? !!d.cerfa_numero : !d.cerfa_numero))); }
function carteDon(d){
  const n = nomDe(d);
  const statut = d.cerfa_numero ? '<span class="statut ok">'+IC.ok+'Cerfa créé · '+esc(d.cerfa_numero)+'</span>' : '<span class="statut attente">'+IC.horloge+'Cerfa à créer</span>';
  const bouton1 = d.cerfa_numero ? '<button class="btn" onclick="voirRecu(\\''+esc(d.cerfa_numero)+'\\')">'+IC.doc+'Voir le reçu</button>' : '<button class="btn plein" onclick="ouvrirCreer('+d.id+')">'+IC.doc+'Créer le Cerfa</button>';
  return '<div class="carte don-carte '+(d.cerfa_numero?'avec-cerfa':'sans-cerfa')+'" id="don-'+d.id+'"><div class="carte-haut"><div><div class="nom'+(n?'':' vide')+'">'+(n?esc(n):'Donateur non renseigné')+'</div><div class="date">'+quand(d.created_at)+'</div></div><div class="montant">'+euros(d.montant)+'</div></div>'+statut+'<div class="actions">'+bouton1+'<button class="btn" onclick="actionsDon('+d.id+')">'+IC.dots+'Actions</button></div></div>';
}
function barreOutils(champQ, champP, filtreActif, onFiltre){
  return '<div class="barre-filtres"><div class="outils"><label class="champ">'+IC.loupe+'<input type="search" placeholder="Rechercher un donateur" value="'+esc(etat[champQ])+'" oninput="etat.'+champQ+'=this.value;majListe()"></label><button class="icone-btn'+(filtreActif?' actif':'')+'" onclick="'+onFiltre+'()" title="Filtres">'+IC.filtre+'<span class="pastille"></span></button></div>'
    + '<label class="champ" style="margin-bottom:6px">'+IC.cal+'<select onchange="etat.'+champP+'=this.value;majListe()">'+PERIODES.map(p => '<option value="'+p[0]+'"'+(etat[champP]===p[0]?' selected':'')+'>'+p[1]+'</option>').join('')+'</select><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></label></div>';
}
function resumeDons(){const total=DATA.dons.reduce((n,d)=>n+Number(d.montant||0),0),attente=DATA.dons.filter(d=>!d.cerfa_numero).length;return '<div class="resume-dons"><div class="resume-case primary"><span>Total collecté</span><strong>'+euros(total)+'</strong><em>Tous les dons chargés</em></div><div class="resume-case"><span>Dons reçus</span><strong>'+DATA.dons.length+'</strong><em>Merci à chaque donateur</em></div><button class="resume-case attention" onclick="etat.statut=\\'attente\\';vueDons()"><span>Cerfa à préparer</span><strong>'+attente+'</strong><em>Afficher les dons concernés ↗</em></button></div>';}
function vueDons(){ document.getElementById('vue').innerHTML = resumeDons() + barreOutils('q','periode', etat.statut !== 'tous', 'filtresDons') + '<div class="compte" id="compte"></div><div class="liste" id="liste"></div>'; majListe(); }
function majListe(){
  if (etat.vue === 'dons'){ const l = donsFiltres(); const tot = l.reduce((s,d)=>s+Number(d.montant||0),0); document.getElementById('compte').textContent = l.length+' don'+(l.length>1?'s':'')+' · '+euros(tot); document.getElementById('liste').innerHTML = l.length ? l.map(carteDon).join('') : '<div class="vide-liste">Aucun don pour cette recherche.</div>'; }
  if (etat.vue === 'cerfa'){ const l = cerfasFiltres(); const tot = l.reduce((s,c)=>s+Number(c.montant||0),0); document.getElementById('compte').textContent = l.length+' reçu'+(l.length>1?'s':'')+' · '+euros(tot); document.getElementById('liste').innerHTML = l.length ? l.map(carteCerfa).join('') : '<div class="vide-liste">Aucun reçu pour cette recherche.</div>'; }
}
function filtresDons(){
  ouvrir('<h3>Filtres</h3><div class="info">Afficher les dons :</div><div class="puces">'+[['tous','Tous'],['attente','Cerfa à créer'],['ok','Cerfa créé']].map(p => '<button class="puce'+(etat.statut===p[0]?' on':'')+'" onclick="etat.statut=\\''+p[0]+'\\';fermer();vueDons()">'+p[1]+'</button>').join('')+'</div>');
}

// ── Cerfa ──
function cerfasFiltres(){ const q = norm(etat.qc); return DATA.cerfas.filter(c => (!q || norm(nomDe(c)+' '+c.numero+' '+(c.email||'')+' '+c.montant).includes(q)) && dansPeriode(c.created_at, etat.periodeC) && (etat.origine === 'tous' || (etat.origine === 'tsedaka' ? c.origine === 'tsedaka' : c.origine !== 'tsedaka'))); }
function carteCerfa(c){
  const n = nomDe(c); const ts = c.origine === 'tsedaka';
  return '<div class="carte"><div class="carte-haut"><div><div class="nom'+(n?'':' vide')+'">'+(n?esc(n):'Donateur non renseigné')+'</div><div class="date">'+quand(c.created_at)+(c.mode_paiement?' · '+esc(c.mode_paiement):'')+'</div></div><div class="montant">'+euros(c.montant)+'</div></div><span class="statut ok">'+IC.ok+esc(c.numero)+'</span><span class="statut orig'+(ts?'':' bot')+'">'+(ts?'💜 Tsédaka':'🤖 Bot / Admin')+'</span><div class="actions"><button class="btn" onclick="voirRecu(\\''+esc(c.numero)+'\\')">'+IC.doc+'Voir le reçu</button><button class="btn" onclick="actionsCerfa(\\''+esc(c.numero)+'\\')">'+IC.dots+'Actions</button></div></div>';
}
function vueCerfa(){ document.getElementById('vue').innerHTML = barreOutils('qc','periodeC', etat.origine !== 'tous', 'filtresCerfa') + '<div class="compte" id="compte"></div><div class="liste" id="liste"></div>'; majListe(); }
function filtresCerfa(){
  ouvrir('<h3>Filtres</h3><div class="info">Origine du reçu :</div><div class="puces">'+[['tous','Tous'],['tsedaka','💜 Tsédaka'],['bot','🤖 Bot / Admin']].map(p => '<button class="puce'+(etat.origine===p[0]?' on':'')+'" onclick="etat.origine=\\''+p[0]+'\\';fermer();vueCerfa()">'+p[1]+'</button>').join('')+'</div>');
}

// ── Accueil ──
function vueAccueil(){
  const dons = DATA.dons, aCreer = dons.filter(d => !d.cerfa_numero), total = dons.reduce((s,d)=>s+Number(d.montant||0),0);
  const moisDons = dons.filter(d => dansPeriode(d.created_at,'mois')), totalMois = moisDons.reduce((s,d)=>s+Number(d.montant||0),0);
  let h = '<div class="kpis"><div class="kpi bleu"><b>'+euros(total)+'</b><span>Total collecté</span></div><div class="kpi"><b>'+euros(totalMois)+'</b><span>Ce mois-ci</span></div><div class="kpi vert"><b>'+dons.filter(d=>d.cerfa_numero).length+'</b><span>Cerfa créés</span></div><div class="kpi"><b>'+(DATA.abonnes.n||0)+'</b><span>Abonnés</span></div></div>';
  if (aCreer.length) h += '<button class="alerte" onclick="etat.statut=\\'attente\\';aller(\\'dons\\')"><span>'+IC.horloge+' '+aCreer.length+' don'+(aCreer.length>1?'s':'')+' sans Cerfa</span><span>Voir →</span></button>';
  h += '<div class="section">Derniers dons</div><div class="liste">' + (dons.slice(0,5).map(carteDon).join('') || '<div class="vide-liste">Aucun don.</div>') + '</div>';
  document.getElementById('vue').innerHTML = h;
}

// ── Statistiques ──
function vueStats(){
  const dons = DATA.dons, total = dons.reduce((s,d)=>s+Number(d.montant||0),0), avec = dons.filter(d=>d.cerfa_numero).length;
  let h = '<div class="kpis"><div class="kpi bleu"><b>'+euros(dons.length ? total/dons.length : 0)+'</b><span>Moyenne par don</span></div><div class="kpi"><b>'+dons.length+'</b><span>Dons</span></div><div class="kpi vert"><b>'+(dons.length ? Math.round(avec/dons.length*100) : 0)+' %</b><span>Avec Cerfa</span></div><div class="kpi"><b>'+(DATA.abonnes.rappels||0)+'</b><span>Rappel quotidien</span></div></div>';
  const now = new Date(), mois = [];
  for (let i = 5; i >= 0; i--){ const d = new Date(now.getFullYear(), now.getMonth()-i, 1); mois.push({ d, t: 0 }); }
  dons.forEach(x => { const d = new Date(x.created_at); const m = mois.find(m => m.d.getFullYear()===d.getFullYear() && m.d.getMonth()===d.getMonth()); if (m) m.t += Number(x.montant||0); });
  const max = Math.max(1, ...mois.map(m => m.t));
  h += '<div class="section">6 derniers mois</div><div class="barres">' + mois.map(m => '<div class="barre"><span>'+MOIS[m.d.getMonth()]+' '+String(m.d.getFullYear()).slice(2)+'</span><div class="fond"><div class="rempli" style="width:'+Math.round(m.t/max*100)+'%"></div></div><span class="val">'+euros(m.t)+'</span></div>').join('') + '</div>';
  h += '<div class="section">Cartes enregistrées</div><div class="kpis"><div class="kpi"><b>'+(DATA.abonnes.cartes||0)+'</b><span>Cartes gardées</span></div><div class="kpi"><b>'+DATA.cerfas.filter(c=>c.origine==='tsedaka').length+'</b><span>Cerfa Tsédaka</span></div></div>';
  document.getElementById('vue').innerHTML = h;
}

// ── Feuille du bas ──
function ouvrir(html){ document.getElementById('feuille-contenu').innerHTML = html; document.getElementById('voile').classList.add('ouvert'); document.getElementById('feuille').classList.add('ouvert'); }
function fermer(){ document.getElementById('voile').classList.remove('ouvert'); document.getElementById('feuille').classList.remove('ouvert'); }

// ── Actions ──
function voirRecu(numero){ window.open('/admin/tsedaka/cerfa-download/'+encodeURIComponent(numero)+'?password='+encodeURIComponent(PW), '_blank'); }
function lignesActions(numero, email, phone){
  const n = esc(numero);
  return '<button class="choix" onclick="voirRecu(\\''+n+'\\');fermer()">'+IC.dl+'Télécharger le PDF</button>'
    + '<button class="choix" onclick="envoyerEmail(\\''+n+'\\',\\''+esc(email||'')+'\\')">'+IC.mail+'Envoyer par email'+(email?' <span style="color:var(--muted);font-size:13px">('+esc(email)+')</span>':'')+'</button>'
    + '<button class="choix" onclick="envoyerWa(\\''+n+'\\',\\''+esc(phone||'')+'\\')">'+IC.wa+'Envoyer par WhatsApp'+(phone?' <span style="color:var(--muted);font-size:13px">(+'+esc(phone)+')</span>':'')+'</button>'
    + '<button class="choix" onclick="copier(\\''+n+'\\')">'+IC.copie+'Copier le numéro du reçu</button>';
}
function actionsDon(id){
  const d = DATA.dons.find(x => x.id === id); if (!d) return;
  const titre = '<h3>'+(esc(nomDe(d)) || 'Donateur non renseigné')+'</h3><div class="info">'+euros(d.montant)+' · '+quand(d.created_at)+'</div>';
  if (!d.cerfa_numero) return ouvrir(titre + '<button class="choix" onclick="ouvrirCreer('+d.id+')">'+IC.plus+'Créer le Cerfa</button>' + (d.phone ? '<a class="choix" href="https://wa.me/'+esc(d.phone)+'" target="_blank" style="text-decoration:none;color:inherit">'+IC.wa+'Écrire sur WhatsApp</a>' : ''));
  ouvrir(titre + lignesActions(d.cerfa_numero, d.email, d.phone));
}
function actionsCerfa(numero){ const c = DATA.cerfas.find(x => x.numero === numero); if (!c) return; ouvrir('<h3>'+(esc(nomDe(c)) || 'Reçu '+esc(numero))+'</h3><div class="info">'+esc(numero)+' · '+euros(c.montant)+'</div>' + lignesActions(numero, c.email, c.phone)); }
async function envoyerEmail(numero, email){
  if (!email) email = prompt('Adresse email du donateur :') || '';
  if (!email.includes('@')) return toast('Adresse email manquante', true);
  fermer(); toast('Envoi en cours…');
  try { const r = await fetch('/admin/tsedaka/cerfa-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW,numero,email})}); const d = await r.json(); toast(d.ok ? 'Email envoyé ✓' : 'Erreur : '+(d.error||'envoi impossible'), !d.ok); } catch(e){ toast('Erreur de connexion', true); }
}
async function envoyerWa(numero, phone){
  if (!phone) phone = (prompt('Numéro WhatsApp (ex : 0612345678) :') || '').replace(/\\D/g,'');
  if (phone.startsWith('0') && phone.length === 10) phone = '33' + phone.slice(1);
  if (phone.length < 9) return toast('Numéro manquant', true);
  fermer(); toast('Envoi en cours…');
  try { const r = await fetch('/admin/tsedaka/cerfa-whatsapp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW,numero,phone})}); const d = await r.json(); toast(d.ok ? 'Envoyé sur WhatsApp ✓' : 'Erreur : '+(d.error||'envoi impossible'), !d.ok); } catch(e){ toast('Erreur de connexion', true); }
}
function copier(t){ try { navigator.clipboard.writeText(t); toast('Copié : '+t); } catch(e){ toast(t); } fermer(); }

// ── Créer le Cerfa ──
function ouvrirCreer(id){
  const d = DATA.dons.find(x => x.id === id); if (!d) return;
  const p = (d.prenom && d.prenom !== '-') ? d.prenom : '';
  ouvrir('<h3>Créer le Cerfa</h3><div class="info">'+euros(d.montant)+' · '+quand(d.created_at)+'</div><div class="form">'
    + '<div class="deux"><div><label>Prénom</label><input id="c-prenom" value="'+esc(p)+'"></div><div><label>Nom</label><input id="c-nom" value="'+esc(d.nom||'')+'"></div></div>'
    + '<label>Société (si c\\'est une entreprise)</label><input id="c-societe">'
    + '<label>Adresse</label><input id="c-adresse" placeholder="Rue, code postal, ville">'
    + '<div class="deux"><div><label>Email</label><input id="c-email" type="email" value="'+esc(d.email||'')+'"></div><div><label>Téléphone</label><input id="c-phone" inputmode="tel" value="'+esc(d.phone ? '+'+d.phone : '')+'"></div></div>'
    + '<label>Montant (€)</label><input id="c-montant" inputmode="decimal" value="'+esc(String(d.montant).replace('.',','))+'">'
    + '<button class="btn plein" id="c-ok" onclick="creer('+d.id+')">'+IC.doc+'Créer et envoyer le Cerfa</button></div>');
}
async function creer(id){
  const v = k => document.getElementById('c-'+k).value.trim();
  if (!v('prenom') || !v('nom')) return toast('Prénom et nom obligatoires', true);
  if (!v('email') && !v('phone')) return toast('Il faut un email ou un téléphone pour envoyer le reçu', true);
  const b = document.getElementById('c-ok'); b.disabled = true; b.textContent = 'Création…';
  try {
    const r = await fetch('/admin/tsedaka/quick-cerfa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW,don_id:id,prenom:v('prenom'),nom:v('nom'),societe:v('societe'),adresse:v('adresse'),email:v('email'),phone:v('phone'),montant:v('montant')})});
    const d = await r.json();
    if (!d.ok){ b.disabled = false; b.textContent = 'Créer et envoyer le Cerfa'; return toast('Erreur : '+(d.error||'création impossible'), true); }
    const don = DATA.dons.find(x => x.id === id);
    if (don){ don.cerfa_numero = d.numero; don.prenom = v('prenom'); don.nom = v('nom'); don.email = v('email') || don.email; }
    DATA.cerfas.unshift({ numero: d.numero, prenom: v('prenom'), nom: v('nom'), montant: don ? don.montant : v('montant'), created_at: new Date().toISOString(), email: v('email'), phone: (v('phone')||'').replace(/\\D/g,''), origine: 'tsedaka', mode_paiement: 'Stripe' });
    fermer(); rendre();
    toast('Cerfa '+d.numero+' créé'+(d.envois && d.envois.length ? ' et envoyé par '+d.envois.join(' et ') : '')+' ✓');
  } catch(e){ b.disabled = false; b.textContent = 'Créer et envoyer le Cerfa'; toast('Erreur de connexion', true); }
}

// ── Démarrage ──
(function(){ const d = new Date(DATA.maj); const p = new Date(d.toLocaleString('en-US',{timeZone:'Europe/Paris'})); document.getElementById('maj').textContent = 'Mis à jour à ' + String(p.getHours()).padStart(2,'0') + ':' + String(p.getMinutes()).padStart(2,'0'); const h = (location.hash||'').slice(1); aller(TITRES[h] ? h : 'dons'); })();
</script>
</body></html>`;

module.exports = { init };
