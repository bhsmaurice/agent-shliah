// ═══════════════════════════════════════════════════════════════════════════
// ÉCRIRE AU RABBI — Interface admin des PANIM
// ═══════════════════════════════════════════════════════════════════════════

function getAdminPassword() { return window.localStorage.getItem('adminPassword') || window.ADMIN_PASSWORD || ''; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

async function chargerPanes() {
  const container = document.getElementById('panes-container');
  if (!container) return;
  container.innerHTML = '<div class="card" style="text-align:center;color:#777;">Chargement des lettres au Rabbi…</div>';
  try {
    const searchEl = document.getElementById('panes-search');
    const search = searchEl ? '&search=' + encodeURIComponent(searchEl.value || '') : '';
    const res = await fetch('/admin/panes?password=' + encodeURIComponent(getAdminPassword()) + search);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Impossible de charger les PANIM');
    afficherStatsPanes(data.stats || {});
    afficherPanes(data.panes || []);
  } catch (e) { container.innerHTML = `<div class="card" style="color:#b42318;">Erreur : ${escapeHtml(e.message)}</div>`; }
}

function afficherStatsPanes(stats) {
  const el = document.getElementById('panes-stats'); if (!el) return;
  el.innerHTML = `<div class="card" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center;">
    <div><div style="font-size:24px;font-weight:700;">${Number(stats.nouveau||0)}</div><div style="font-size:11px;color:#777;">Nouveaux</div></div>
    <div><div style="font-size:24px;font-weight:700;">${Number(stats.a_transmettre||0)}</div><div style="font-size:11px;color:#777;">À transmettre</div></div>
    <div><div style="font-size:24px;font-weight:700;">${Number(stats.transmis||0)}</div><div style="font-size:11px;color:#777;">Transmis</div></div></div>`;
}
function badgeStatut(s) {
  if(s==='transmis') return '<span style="background:#dcfce7;color:#166534;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">✓ Transmis</span>';
  if(s==='a_transmettre') return '<span style="background:#fff7ed;color:#9a3412;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">À transmettre</span>';
  return '<span style="background:#eef2ff;color:#4338ca;padding:4px 8px;border-radius:20px;font-size:11px;font-weight:700;">Nouveau</span>';
}
function afficherPanes(panes) {
  const container=document.getElementById('panes-container'); if(!container)return;
  if(!panes.length){container.innerHTML='<div class="card" style="text-align:center;color:#999;">Aucune lettre au Rabbi pour le moment.</div>';return;}
  container.innerHTML=panes.map(p=>{
    const dateFr=new Date(p.created_at).toLocaleString('fr-FR');
    const phone=String(p.phone||'').replace(/\D/g,'');
    const actions=p.statut==='transmis'?'':`<button onclick="marquerPaneTransmis(${Number(p.id)})" style="width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#16a34a;color:white;font-weight:700;cursor:pointer;">✓ Marquer transmis à l’Ohel</button>`;
    return `<div class="card" style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:12px;"><div><div style="font-weight:800;font-size:15px;">✉️ ${escapeHtml(p.reference)}</div><div style="font-size:11px;color:#777;">${escapeHtml(dateFr)}</div></div>${badgeStatut(p.statut)}</div>
      <div style="font-size:13px;line-height:1.7;"><div><strong>Prénom hébraïque :</strong> ${escapeHtml(p.prenom_hebreu)}</div><div><strong>Mère :</strong> ${escapeHtml(p.mere_hebreu)}</div><div><strong>Bra'ha :</strong> ${escapeHtml(p.categorie||'Autre')}</div><div><strong>WhatsApp :</strong> ${escapeHtml(p.phone)}</div></div>
      <div style="margin-top:12px;padding:12px;background:#f8fafc;border-radius:10px;white-space:pre-wrap;font-size:13px;line-height:1.65;">${escapeHtml(p.demande)}</div>
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:700;font-size:12px;">Voir la lettre complète</summary><div style="margin-top:8px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;white-space:pre-wrap;font-size:13px;line-height:1.7;">${escapeHtml(p.lettre)}</div></details>
      <a href="https://wa.me/${phone}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:10px;padding:10px;border:1px solid #16a34a;border-radius:10px;color:#166534;text-decoration:none;font-weight:700;">Ouvrir WhatsApp</a>${actions}</div>`;
  }).join('');
}
async function marquerPaneTransmis(id){
  if(!confirm('Confirmer que ce PAN a bien été transmis à l’Ohel du Rabbi ?'))return;
  try{const res=await fetch('/admin/panes/'+id+'/statut',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:getAdminPassword(),statut:'transmis'})});const data=await res.json();if(!data.ok)throw new Error(data.error||'Erreur');await chargerPanes();}catch(e){alert('Erreur : '+e.message);}
}
window.chargerPanes=chargerPanes; window.marquerPaneTransmis=marquerPaneTransmis;
