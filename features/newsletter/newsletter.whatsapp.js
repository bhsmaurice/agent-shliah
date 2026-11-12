'use strict';

function createWhatsApp({ token, phoneNumberId, adminPhone, fetcher = fetch, now = Date.now }) {
  let lastInteraction = 0;
  const templateName = () => process.env.NEWSLETTER_WHATSAPP_TEMPLATE || 'shliah_newsletter_admin';
  const template = body => ({ type: 'template', template: { name: templateName(), language: { code: 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.replace(/\s+/g, ' ').trim().slice(0, 900) }] }] } });
  async function post(payload) {
    const response = await fetcher(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: adminPhone, ...payload }), signal: AbortSignal.timeout(15000) });
    return { response, data: await response.json().catch(() => ({})) };
  }
  async function send(body, buttons, { forceTemplate = false } = {}) {
    // Unsolicited jobs use the approved template directly: window errors may
    // arrive asynchronously, after an ordinary message was initially accepted.
    const useTemplate = forceTemplate || !lastInteraction || now() - lastInteraction >= 23 * 3600000;
    const payload = useTemplate ? template(body) : buttons ? { type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: b })) } } } : { type: 'text', text: { body } };
    let result = await post(payload);
    if (!useTemplate && result.data.error?.code === 131047) result = await post(template(body));
    if (!result.response.ok || !result.data.messages?.[0]?.id) throw new Error('WhatsApp : notification non acceptée (code ' + String(result.data.error?.code || result.response.status) + '). Réponds « newsletter » au bot.');
    return result.data.messages[0].id;
  }
  async function check() {
    const account = process.env.NEWSLETTER_WHATSAPP_ACCOUNT_ID || '1012876561295832';
    const get = async path => {
      const response = await fetcher('https://graph.facebook.com/v25.0/' + path, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error('Vérification WhatsApp indisponible');
      return data;
    };
    const numbers = await get(account + '/phone_numbers?fields=id&limit=100');
    const sameAccount = numbers.data?.some(p => String(p.id) === String(phoneNumberId)) === true;
    if (!sameAccount) return { sameAccount: false, approved: false };
    const models = await get(account + '/message_templates?name=' + encodeURIComponent(templateName()) + '&fields=name,status,language,category&limit=100');
    const model = models.data?.find(t => t.name === templateName() && t.language === 'fr');
    return { sameAccount: true, name: templateName(), status: model?.status || 'MISSING', category: model?.category || null, approved: model?.status === 'APPROVED' };
  }
  return { send, check, markInteraction() { lastInteraction = now(); } };
}

module.exports = { createWhatsApp };
