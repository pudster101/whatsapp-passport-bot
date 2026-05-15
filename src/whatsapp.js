const axios = require('axios');
const config = require('./config');

const BASE_URL = `https://graph.facebook.com/v18.0/${config.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

/**
 * Send a plain text message
 */
async function sendText(to, text) {
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }, { headers: headers() });
    const msgId = res.data?.messages?.[0]?.id || 'no-id';
    console.log(`✅ Sent text to ${to} | msg_id=${msgId}`);
    return res.data;
  } catch (err) {
    const errData = err.response?.data;
    const code = errData?.error?.code;
    const subcode = errData?.error?.error_subcode;
    const detail = errData?.error?.error_data?.details || errData?.error?.message || err.message;
    console.error(`❌ sendText error to ${to} | code=${code} subcode=${subcode} | ${detail}`);
    console.error('   Full error:', JSON.stringify(errData || err.message));
  }
}

/**
 * Send an interactive button message (up to 3 buttons)
 */
async function sendButtons(to, bodyText, buttons, headerText = null, footerText = null) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b, i) => ({
          type: 'reply',
          reply: { id: b.id || `btn_${i}`, title: b.title.substring(0, 20) },
        })),
      },
    },
  };

  if (headerText) payload.interactive.header = { type: 'text', text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };

  try {
    const res = await axios.post(BASE_URL, payload, { headers: headers() });
    console.log(`✅ Sent buttons to ${to}`);
    return res.data;
  } catch (err) {
    console.error('❌ sendButtons error:', err.response?.data || err.message);
  }
}

/**
 * Send an interactive list message (up to 10 items)
 */
async function sendList(to, bodyText, buttonLabel, sections) {
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections,
        },
      },
    }, { headers: headers() });
    console.log(`✅ Sent list to ${to}`);
    return res.data;
  } catch (err) {
    console.error('❌ sendList error:', err.response?.data || err.message);
  }
}

/**
 * Send an image message (by public URL)
 */
async function sendImage(to, imageUrl, caption = '') {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl },
    };
    if (caption) payload.image.caption = caption;
    const res = await axios.post(BASE_URL, payload, { headers: headers() });
    const msgId = res.data?.messages?.[0]?.id || 'no-id';
    console.log(`✅ Sent image to ${to} | msg_id=${msgId}`);
    return res.data;
  } catch (err) {
    const errData = err.response?.data;
    const detail = errData?.error?.message || err.message;
    console.error(`❌ sendImage error to ${to}: ${detail}`);
    console.error('   Full error:', JSON.stringify(errData || err.message));
  }
}

/**
 * Send a pre-approved WhatsApp template message.
 * Works 24/7 with no session window restriction.
 * @param {string} to - recipient phone
 * @param {string} templateName - e.g. 'pudim_lead_passport'
 * @param {string[]} params - array of variable values for {{1}}, {{2}}, ...
 * @returns {boolean} true if sent successfully
 */
async function sendTemplate(to, templateName, params = []) {
  const components = params.length > 0 ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: String(p || '—') })),
  }] : [];

  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'he' },
        components,
      },
    }, { headers: headers() });
    const msgId = res.data?.messages?.[0]?.id || 'no-id';
    console.log(`✅ Sent template "${templateName}" to ${to} | msg_id=${msgId}`);
    return true;
  } catch (err) {
    const errData = err.response?.data;
    const detail = errData?.error?.message || err.message;
    console.error(`❌ Template "${templateName}" to ${to} failed: ${detail}`);
    return false;
  }
}

/**
 * Mark a message as read
 */
async function markRead(messageId) {
  try {
    await axios.post(BASE_URL.replace('/messages', '/messages'), {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, { headers: headers() });
  } catch (err) {
    // Non-critical
  }
}

module.exports = { sendText, sendButtons, sendList, sendImage, sendTemplate, markRead };
