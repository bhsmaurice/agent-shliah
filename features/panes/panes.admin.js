// ═══════════════════════════════════════════════════════════════════════════
// ÉCRIRE AU RABBI — Interface admin des PANIM
// ═══════════════════════════════════════════════════════════════════════════

function getAdminPassword() {
  return window.localStorage.getItem('adminPassword') || window.ADMIN_PASSWORD || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function chargerPanes() {
  const container = document.getElementById('panes-container');
  if (!container) return;

  container.innerHTML = '<div class="card" style="text-align:center;color:#777;">Chargement des lettres au Rabbi…</div>';

  try {
    const password = encodeURIComponent(getAdminPassword());
    const res = await fetch('/admin/panes?password=' + password);
    const data = await res.json();
    if (!data.ok) {
      container.innerHTML = `<div class="card" style="color:#b42318;">Erreur : ${escapeHtml(data.error || 'Impossible de charger les PANIM')}</div>`;
      return;
    }
    afficherStatsPanes(data.stats || {});
    afficherPanes(data.panes || []);
  } catch (e) {
    container.innerHTML = `<div class="card" style="color:#b42318;">Erreur réseau : ${escapeHtml(e.message)}</div>`;
  }
}

function afficherStatsPanes(stats) {
  const el = document.getElementById('panes-stats');
  if (!el) return;
  el.innerHTML = `
    <div class="card" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center;">
      <div><div style="font-size:24px;font-weight:700;">${Number(stats.nouveau || 0)}</div><div style="font-size:11px;color:#777;">Nouveaux</div></div>
      <div><div style="font-size:24px;font-weight:700;">${Number(stats.a_transmettre || 0)}</div><div style="font-size:11px;color:#777;">À transmettre</div></div>
      <div><div style="font-size:24px;font-weight:700;">${Number(stats.transmis || 0)}</div><div style="font-size:11px;color:#777;">Transmis</div></div>
    </div>`;
}

function badgeStatut(statut) {
  if (statut === 'transmis') return '<span style="background:#dcfce7;color:#166534;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">✓ Transmis</span>';
  if (statut === 'a_transmettre') return '<span style="background:#fff7ed;color:#9a3412;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">À transmettre</span>';
  return '<span style="background:#eef2ff;color:#4338ca;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">Nouveau</span>';
}

function afficherPanes(panes) {
  const container = document.getElementById('panes-container');
  if (!container) return;

  if (!panes.length) {
    container.innerHTML = '<div class="card" style="text-align:center;color:#999;">Aucune lettre au Rabbi pour le moment.</div>';
    return;
  }

  container.innerHTML = panes.map((p) => {
    const dateFr = new Date(p.created_at).toLocaleString('fr-FR');
    const transmis = p.statut === 'transmis';
    const nextAction = transmis
      ? ''
      : `<button onclick="marquerPaneTransmis(${Number(p.id)})" style="width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#16a34a;color:white;font-weight:700;cursor:pointer;">✓ Marquer comme transmis à l’Ohel</button>`;

    return `
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;">
          <div>
            <div style="font-weight:800;font-size:15px;">✉️ ${escapeHtml(p.reference)}</div>
            <div style="font-size:11px;color:#777;margin-top:2px;">${escapeHtml(dateFr)}</div>
          </div>
          ${badgeStatut(p.statut)}
        </div>

        <div style="font-size:13px;line-height:1.7;">
          <div><strong>Nom hébraïque :</strong> ${escapeHtml(p.prenom_hebreu)} ben/bat ${escapeHtml(p.mere_hebreu)}</div>
          <div><strong>Bra’ha :</strong> ${escapeHtml(p.categorie || 'Autre')}</div>
          <div><strong>WhatsApp :</strong> ${escapeHtml(p.phone)}</div>
        </div>

        <div style="margin-top:12px;padding:12px;background:#f8fafc;border-radius:10px;white-space:pre-wrap;font-size:13px;line-height:1.65;">${escapeHtml(p.demande)}</div>

        <details style="margin-top:10px;">
          <summary style="cursor:pointer;font-weight:700;font-size:12px;">Voir la lettre complète</summary>
          <div style="margin-top:8px;padding:12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;white-space:pre-wrap;direction:auto;font-size:13px;line-height:1.7;">${escapeHtml(p.lettre)}</div>
        </details>

        ${nextAction}
      </div>`;
  }).join('');
}

async function marquerPaneTransmis(id) {
  if (!confirm('Confirmer que ce PAN a bien été transmis à l’Ohel du Rabbi ?')) return;

  try {
    const res = await fetch('/admin/panes/' + id + '/statut', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: getAdminPassword(), statut: 'transmis' })
    });
    const data = await res.json();
    if (!data.ok) return alert('Erreur : ' + (data.error || 'inconnue'));
    await chargerPanes();
  } catch (e) {
    alert('Erreur réseau : ' + e.message);
  }
}

window.chargerPanes = chargerPanes;
window.marquerPaneTransmis = marquerPaneTransmis;
