// ═══════════════════════════════════════════════════════════════════════════
// ÉCRIRE AU RABBI — PAN (Pidyon Nefesh)
// Parcours conversationnel WhatsApp
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES_BRAHA = [
  'Santé',
  'Parnassa',
  'Chidoukh / Mariage',
  'Enfants',
  'Chalom Bayit',
  'Réussite',
  'Autre'
];

const panesQuestions = [
  {
    cle: 'prenom_hebreu',
    question: `Quel est votre *prénom hébraïque* ?\n\nExemple : Menahem Mendel`
  },
  {
    cle: 'mere_hebreu',
    question: `Quel est le *prénom hébraïque de votre maman* ?\n\nExemple : Sarah`
  },
  {
    cle: 'categorie',
    question: `Pour quoi souhaitez-vous demander une bra'ha ? 🙏\n\n1️⃣ Santé\n2️⃣ Parnassa\n3️⃣ Chidoukh / Mariage\n4️⃣ Enfants\n5️⃣ Chalom Bayit\n6️⃣ Réussite\n7️⃣ Autre\n\nRépondez avec le numéro ou écrivez directement votre choix.`
  },
  {
    cle: 'demande',
    question: `Écrivez maintenant votre demande avec vos propres mots.\n\nVous pouvez écrire simplement ce que vous avez sur le cœur. Il n'est pas nécessaire de savoir comment rédiger un PAN.`
  }
];

function normaliserTexte(value = '') {
  return String(value).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detecterPane(msg = '') {
  const texte = normaliserTexte(msg);
  const expressions = [
    'ecrire au rabbi',
    'ecrire une lettre au rabbi',
    'lettre au rabbi',
    'faire un pan',
    'faire un pane',
    'envoyer un pan',
    'envoyer une lettre au rabbi',
    'demande au rabbi',
    'demande rabbi',
    'pidyon nefesh',
    'pan au rabbi',
    'ohel du rabbi'
  ];
  return expressions.some(expression => texte.includes(expression));
}

function normaliserCategorie(reponse = '') {
  const texte = normaliserTexte(reponse);
  const numeros = {
    '1': 'Santé',
    '2': 'Parnassa',
    '3': 'Chidoukh / Mariage',
    '4': 'Enfants',
    '5': 'Chalom Bayit',
    '6': 'Réussite',
    '7': 'Autre'
  };
  if (numeros[texte]) return numeros[texte];
  if (texte.includes('sante')) return 'Santé';
  if (texte.includes('parnassa')) return 'Parnassa';
  if (texte.includes('chidoukh') || texte.includes('mariage')) return 'Chidoukh / Mariage';
  if (texte.includes('enfant')) return 'Enfants';
  if (texte.includes('chalom') || texte.includes('bayit')) return 'Chalom Bayit';
  if (texte.includes('reuss')) return 'Réussite';
  return 'Autre';
}

function messageDebutPane() {
  return `✉️ *Écrire au Rabbi*\n\nAvec plaisir 🙏\n\nJe vais vous accompagner étape par étape pour préparer votre *PAN (Pidyon Nefesh)*, une lettre de demande de bénédiction au Rabbi.\n\nVous pourrez relire et confirmer votre demande avant qu'elle soit enregistrée.\n\n${panesQuestions[0].question}`;
}

function construireRecapitulatifPane(data = {}) {
  const prenom = data.prenom_hebreu || '—';
  const mere = data.mere_hebreu || '—';
  const categorie = normaliserCategorie(data.categorie || '');
  const demande = data.demande || '—';

  return `✉️ *Votre lettre au Rabbi*\n\n*Nom hébraïque :* ${prenom} ben/bat ${mere}\n*Demande :* ${categorie}\n\n${demande}\n\n────────────────\nMerci de relire attentivement.\n\nRépondez *CONFIRMER* pour enregistrer votre PAN, ou *MODIFIER* pour le corriger.`;
}

function messageConfirmationPane(reference) {
  const ref = reference ? `\n*Référence :* ${reference}` : '';
  return `✅ *Votre lettre au Rabbi a bien été enregistrée.*${ref}\n\nVotre PAN est maintenant en attente de transmission. Vous pourrez être informé lorsqu'il aura été transmis à l'Ohel du Rabbi. 🙏\n\n*Beth Habad S. Maurice*`;
}

module.exports = {
  CATEGORIES_BRAHA,
  questionsPane: panesQuestions,
  detecterPane,
  normaliserCategorie,
  messageDebutPane,
  construireRecapitulatifPane,
  messageConfirmationPane
};
