// ═══════════════════════════════════════════════════════════════════════════
// PANES ADMIN - Affichage des Panes
// ═══════════════════════════════════════════════════════════════════════════

async function chargerPanes() {
  try {
    const res = await fetch('/admin/panes');
    const data = await res.json();
    if (!data.ok) { alert('Erreur: ' + data.error); return; }
    afficherPanes(data.panes);
  } catch (e) { alert('Erreur reseau: ' + e.message); }
}

function afficherPanes(panes) {
  const container = document.getElementById('panes-container');
  if (!panes || panes.length === 0) {
    container.innerHTML = '<div class="card" style="text-align:center;color:#999;">Aucune pane reçue</div>';
    return;
  }
  
  container.innerHTML = panes.map((p) => {
    const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const dateFr = new Date(p.created_at).toLocaleString('fr-FR');
    
    return `
      <div class="demande-card">
        <div class="demande-header">
          <div class="demande-type" style="background:#7c3aed;color:white;">🏛️ Pane</div>
          <div class="demande-date">${dateFr}</div>
        </div>
        <div class="demande-phone">📱 ${p.phone || 'N/A'}</div>
        <div style="font-size:13px;color:#333;margin:10px 0;line-height:1.6;">
          <strong>Nom:</strong> ${data.nom || 'N/A'} ${data.prenom || ''}<br>
          <strong>Mere:</strong> ${data.mere || 'N/A'}<br>
          <strong>Demande:</strong><br>${data.demande || 'N/A'}
        </div>
      </div>
    `;
  }).join('');
}

setTimeout(() => { chargerPanes(); }, 500);
