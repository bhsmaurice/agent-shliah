// ═══════════════════════════════════════════════════════════════════════════
// PANES - Demandes de Prière au Rabbi
// ═══════════════════════════════════════════════════════════════════════════

const panesQuestions = {
  nom: { cle: 'nom', question: 'Quel est votre nom ?' },
  prenom: { cle: 'prenom', question: 'Et votre prenom ?' },
  mere: { cle: 'mere', question: 'Quel est le nom et prenom de votre mere ?' },
  demande: { cle: 'demande', question: 'Quelle est votre demande de priere ?' }
};

module.exports = {
  detecterPane: (msg) => {
    const lower = msg.toLowerCase();
    return ['pane', 'demande au rabbi', 'demande rabbi'].some(m => lower.includes(m));
  },
  
  questionsPane: Object.values(panesQuestions),
  
  messageDebutPane: () => `Chalom\n\nJe vais noter votre pane (demande de priere).\n\nQuel est votre nom ?`,
  
  messageConfirmationPane: () => `Merci, votre pane sera remis a l'Ohel du Rabbi.\n\nBeth Habad Saint-Maurice`
};
