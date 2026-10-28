'use strict';
// Inscription rapide d'enfants dans les Lettres Séfer Torah par WhatsApp.
// Réservé aux numéros admin : Levi TRANSFÈRE au bot le message d'un parent
// (prénom, âge, prénom de la maman). Le bot demande le nom de famille
// (+ téléphone et e-mail facultatifs, une info par ligne), puis enregistre
// l'inscription dans lettres_orders avec le statut « En attente » (non payé).
const crypto = require('node:crypto');

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes pour répondre
const ENTETE = '📜 *Lettre dans le Séfer Torah*';

function estTransfere(message) {
  return Boolean(message && message.context && (message.context.forwarded || message.context.frequently_forwarded));
}

// Message tapé directement (non transféré) : « Israël, 10 ans, mère Sarah »
function ressembleInscription(texte) {
  const t = String(texte || '');
  return /\d{1,3}\s*ans?\b/i.test(t) && /(m[eè]re|maman)/i.test(t) && t.length < 1500;
}

function nettoyer(v, max = 60) {
  return String(v == null ? '' : v).replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function genreDepuis(v) {
  const s = String(v || '').toLowerCase();
  if (/fille|girl/.test(s)) return 'Fille';
  if (/gar[cç]on|boy/.test(s)) return 'Garçon';
  return '';
}

function normaliserEnfants(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.slice(0, 30).map(c => {
    const age = parseInt(c && c.age, 10);
    return {
      name: nettoyer(c && c.name),
      mother: nettoyer(c && c.mother),
      age: Number.isInteger(age) && age >= 0 && age <= 120 ? age : null,
      gender: genreDepuis(c && c.gender)
    };
  }).filter(c => c.name);
}

// Lecture simple sans IA : "Moché, 6 ans, mère Sarah" (une ligne par enfant)
function lectureSimple(texte) {
  const enfants = [];
  for (const ligne of String(texte).split(/\n+/)) {
    const l = ligne.trim();
    if (!l) continue;
    const age = (l.match(/(\d{1,3})\s*(ans?|an\b)/i) || l.match(/\b(\d{1,2})\b/) || [])[1];
    const mere = (l.match(/(?:m[eè]re|maman|ben|bat|fils de|fille de)\s*:?\s*([^\s,;.]+(?:\s[^\s,;.\d]+)?)/i) || [])[1];
    let nom = l.replace(/(?:m[eè]re|maman|ben|bat|fils de|fille de)\s*:?\s*[^,;.]*/ig, '')
      .replace(/\d{1,3}\s*(ans?|an\b)?/ig, '').replace(/(gar[cç]on|fille)/ig, '')
      .replace(/^(pr[ée]nom)\s*:?/i, '').split(/[,;.\-:]/).map(s => s.trim()).filter(Boolean)[0] || '';
    if (nom) enfants.push({ name: nom, age, mother: mere || '', gender: (l.match(/gar[cç]on|fille/i) || [''])[0] });
  }
  return normaliserEnfants(enfants);
}

async function lectureIA(texte, apiKey) {
  if (!apiKey) return null;
  const consigne = `Tu lis un message WhatsApp envoyé par un parent pour inscrire un ou plusieurs enfants à une lettre dans le Séfer Torah.
Extrais chaque enfant : prénom, âge (nombre), prénom (hébraïque si donné) de la mère, genre ("Garçon" ou "Fille" UNIQUEMENT si c'est écrit dans le message, sinon "" — ne le devine jamais d'après le prénom).
Si un même prénom de mère vaut pour plusieurs enfants, répète-le.
Réponds UNIQUEMENT en JSON : {"enfants":[{"name":"","age":0,"mother":"","gender":""}]}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: consigne, messages: [{ role: 'user', content: String(texte).slice(0, 3000) }] }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    const brut = (data.content || []).map(b => b.text || '').join('');
    const json = brut.slice(brut.indexOf('{'), brut.lastIndexOf('}') + 1);
    const enfants = normaliserEnfants(JSON.parse(json).enfants);
    return enfants.length ? enfants : null;
  } catch (e) {
    console.error('Lettres WhatsApp IA:', e.message);
    return null;
  }
}

// Réponse de Levi : ligne 1 = nom de famille, puis téléphone / e-mail (facultatifs, dans n'importe quel ordre)
function lireReponse(texte) {
  const lignes = String(texte).split(/\n+/).map(l => l.trim()).filter(Boolean);
  let nom = '', phone = '', email = '';
  for (const l of lignes) {
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l)) { email = l.toLowerCase().slice(0, 160); continue; }
    const chiffres = l.replace(/[^\d]/g, '');
    if (!phone && chiffres.length >= 8 && chiffres.length <= 15 && /^[+\d\s.()-]+$/.test(l)) {
      phone = chiffres.startsWith('0') && chiffres.length === 10 ? '33' + chiffres.slice(1) : chiffres.replace(/^00/, '');
      continue;
    }
    if (!nom) nom = nettoyer(l);
  }
  return { nom, phone, email };
}

function ligneEnfant(c, nom) {
  const morceaux = [c.name + (nom ? ' ' + nom : '')];
  if (c.age != null) morceaux.push(c.age + ' ans');
  if (c.mother) morceaux.push('mère ' + c.mother);
  if (c.gender) morceaux.push(c.gender);
  return '• ' + morceaux.join(', ');
}

function init({ pool, sendWhatsApp, sendWhatsAppButtons, isAdmin, ensureDB, anthropicKey, lienPaiement, envoyerLienPaiement }) {
  const sessions = {};

  async function demarrer(from, texte) {
    const enfants = (await lectureIA(texte, anthropicKey)) || lectureSimple(texte);
    if (!enfants.length) {
      await sendWhatsApp(from, `${ENTETE}\n\nJe n'ai pas trouvé de prénom d'enfant dans ce message. 🤔\nTransfère un message qui contient au moins le prénom de l'enfant.`);
      return;
    }
    sessions[from] = { enfants, depuis: Date.now() };
    await etapeSuivante(from);
  }

  // Pose « garçon ou fille ? » pour chaque enfant, puis demande le nom de famille.
  async function etapeSuivante(from) {
    const session = sessions[from];
    const i = session.enfants.findIndex(c => !c.gender);
    if (i >= 0) {
      session.etape = 'genre'; session.index = i;
      const c = session.enfants[i];
      const corps = `${ENTETE}\n\n${ligneEnfant(c)}\n\n*${c.name} : garçon ou fille ?*`;
      if (sendWhatsAppButtons) {
        await sendWhatsAppButtons(from, corps, [
          { id: 'lstg_garcon', title: 'Garçon' }, { id: 'lstg_fille', title: 'Fille' }, { id: 'lstg_annuler', title: 'Annuler' }
        ]);
      } else {
        await sendWhatsApp(from, corps + `\n\nRéponds « garçon » ou « fille ».\n_Écris « annuler » pour annuler._`);
      }
      return;
    }
    session.etape = 'nom';
    await sendWhatsApp(from,
      `${ENTETE}\n\n${session.enfants.map(c => ligneEnfant(c)).join('\n')}\n\n` +
      `*Quel est le nom de famille ?*\n\n` +
      `Réponds une info par ligne :\n1️⃣ Nom de famille\n2️⃣ Téléphone (facultatif)\n3️⃣ E-mail (facultatif)\n\n` +
      `_Écris « annuler » pour annuler._`);
  }

  async function repondreGenre(from, texte) {
    const session = sessions[from];
    const t = String(texte).trim().toLowerCase();
    const genre = /^(g|gar[cç]on|garcon|boy|m|masculin)\b/.test(t) ? 'Garçon' : /^(f|fille|girl|féminin|feminin)\b/.test(t) ? 'Fille' : '';
    if (!genre) {
      const c = session.enfants[session.index];
      await sendWhatsApp(from, `${ENTETE}\n\nJe n'ai pas compris. *${c.name} : garçon ou fille ?*\n_Écris « annuler » pour annuler._`);
      return;
    }
    session.enfants[session.index].gender = genre;
    session.depuis = Date.now();
    await etapeSuivante(from);
  }

  async function annuler(from) {
    delete sessions[from];
    await sendWhatsApp(from, `${ENTETE}\n\n❌ Inscription annulée.`);
  }

  async function terminer(from, texte) {
    const session = sessions[from];
    const { nom, phone, email } = lireReponse(texte);
    if (!nom) {
      await sendWhatsApp(from, `${ENTETE}\n\nIl me faut au moins le *nom de famille* sur la première ligne.\n_Écris « annuler » pour annuler._`);
      return;
    }
    const children = session.enfants.map(c => ({
      name: c.name, surname: nom, mother: c.mother || '—', gender: c.gender || '—', age: c.age == null ? '?' : c.age
    }));
    const id = crypto.randomUUID();
    try {
      if (ensureDB) await ensureDB();
      await pool.query(
        `INSERT INTO lettres_orders(id,request_id,children,phone,total_cents,donation_cents,email,payment_status)
         VALUES($1,$2,$3,$4,$5,0,$6,'pending')`,
        [id, crypto.randomUUID(), JSON.stringify(children), phone, children.length * 100, email || null]
      );
    } catch (e) {
      console.error('Lettres WhatsApp enregistrement:', e.message);
      await sendWhatsApp(from, `${ENTETE}\n\n⚠️ Erreur, l'inscription n'a pas été enregistrée. Renvoie ta réponse dans un instant.`);
      return;
    }
    delete sessions[from];
    const lignes = session.enfants.map(c => ligneEnfant(c, nom)).join('\n');
    const extra = [phone ? '📞 +' + phone : '', email ? '✉️ ' + email : ''].filter(Boolean).join('\n');
    let infoEmail = '';
    if (email && envoyerLienPaiement) {
      try {
        const r = await envoyerLienPaiement({ id, children, email, total_cents: children.length * 100 });
        infoEmail = r && r.ok ? `\n\n✉️ Email avec le lien de paiement envoyé à ${email}` : `\n\n⚠️ L'email n'a pas pu partir (${(r && r.error) || 'erreur'}).`;
      } catch (e) { infoEmail = `\n\n⚠️ L'email n'a pas pu partir.`; }
    }
    const lien = lienPaiement ? lienPaiement(id) : null;
    await sendWhatsApp(from,
      `${ENTETE}\n\n✅ Inscrit${children.length > 1 ? 's' : ''} :\n${lignes}${extra ? '\n' + extra : ''}\n\n` +
      `⏳ *En attente de paiement* (${children.length} €)` + infoEmail +
      (lien ? `\n\n🔗 Lien de paiement (à transférer au parent si besoin) :\n${lien}` : ''));
  }

  // Renvoie true si le message a été traité ici.
  async function handle(from, texte, message) {
    if (!isAdmin(from)) return false;
    const session = sessions[from];
    if (session && Date.now() - session.depuis > SESSION_TTL) delete sessions[from];
    if (!sessions[from] && (estTransfere(message) || ressembleInscription(texte))) { await demarrer(from, texte); return true; }
    if (sessions[from]) {
      if (/^\s*annu/i.test(texte)) await annuler(from);
      else if (sessions[from].etape === 'genre') await repondreGenre(from, texte);
      else await terminer(from, texte);
      return true;
    }
    return false;
  }

  // Boutons Garçon / Fille / Annuler
  async function handleBouton(from, buttonId) {
    if (!isAdmin(from) || !sessions[from]) return;
    if (buttonId === 'lstg_annuler') return annuler(from);
    if (sessions[from].etape !== 'genre') return;
    await repondreGenre(from, buttonId === 'lstg_fille' ? 'fille' : 'garçon');
  }

  return { handle, handleBouton };
}

module.exports = { init, ressembleInscription, lireReponse, lectureSimple, estTransfere, normaliserEnfants };
