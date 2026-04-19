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
    console.log(`✅ Sent text to ${to}`);
    return res.data;
  } catch (err) {
    console.error('❌ sendText error:', err.response?.data || err.message);
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

module.exports = { sendText, sendButtons, sendList, markRead };
