/**
 * whatsapp.js — WhatsApp Business Cloud API adapter.
 *
 * Improvements over the original:
 *   • every sender returns a real boolean (was: undefined on failure)
 *   • transient failures are retried with backoff
 *   • approved-template list is fetched once at boot, so rejected templates
 *     are never attempted (previously 2 guaranteed-failing calls per event)
 *   • 24-hour-window errors are identified explicitly and logged as such
 */
const axios = require('axios');
const config = require('./config');

const BASE_URL = `https://graph.facebook.com/v18.0/${config.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

// Meta error codes that are worth retrying
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131048, 131056]);
// 131047 = re-engagement required (outside the 24-hour window)
const WINDOW_CLOSED = 131047;

let approvedTemplates = new Set();
let templatesLoaded = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST to the messages endpoint with retry/backoff.
 * @returns {{ok: boolean, id?: string, code?: number, detail?: string, windowClosed?: boolean}}
 */
async function post(payload, label, attempt = 1) {
  try {
    const res = await axios.post(BASE_URL, payload, { headers: headers(), timeout: 15000 });
    return { ok: true, id: res.data?.messages?.[0]?.id || 'no-id' };
  } catch (err) {
    const errData = err.response?.data?.error;
    const code = errData?.code;
    const detail = errData?.error_data?.details || errData?.message || err.message;
    const isTimeout = err.code === 'ECONNABORTED' || !err.response;

    if ((isTimeout || RETRYABLE.has(code)) && attempt < 3) {
      const wait = attempt * 800;
      console.warn(`↻ ${label} attempt ${attempt} failed (${code || err.code}) — retrying in ${wait}ms`);
      await sleep(wait);
      return post(payload, label, attempt + 1);
    }

    if (code === WINDOW_CLOSED) {
      console.warn(`🕐 ${label}: 24-hour window closed for ${payload.to} — free-form message not delivered`);
      return { ok: false, code, detail, windowClosed: true };
    }

    console.error(`❌ ${label} failed | code=${code} | ${detail}`);
    return { ok: false, code, detail };
  }
}

// ─── Senders ──────────────────────────────────────────────────────────────────

async function sendText(to, text) {
  const r = await post(
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    `sendText → ${to}`
  );
  if (r.ok) console.log(`✅ Sent text to ${to} | msg_id=${r.id}`);
  return r.ok;
}

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

  const r = await post(payload, `sendButtons → ${to}`);
  if (r.ok) console.log(`✅ Sent buttons to ${to}`);
  return r.ok;
}

async function sendList(to, bodyText, buttonLabel, sections) {
  const r = await post({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  }, `sendList → ${to}`);
  if (r.ok) console.log(`✅ Sent list to ${to}`);
  return r.ok;
}

async function sendImage(to, imageUrl, caption = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl },
  };
  if (caption) payload.image.caption = caption;

  const r = await post(payload, `sendImage → ${to}`);
  if (r.ok) console.log(`✅ Sent image to ${to} | msg_id=${r.id}`);
  return r.ok;
}

// ─── Templates ────────────────────────────────────────────────────────────────

/**
 * Fetch approved template names once at boot. Any template not in this set is
 * skipped entirely, so we never burn API calls on rejected templates.
 */
async function loadApprovedTemplates() {
  if (!config.WHATSAPP_TOKEN || !config.WABA_ID) {
    templatesLoaded = true;
    return approvedTemplates;
  }
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v18.0/${config.WABA_ID}/message_templates?fields=name,status&limit=100`,
      { headers: headers(), timeout: 10000 }
    );
    approvedTemplates = new Set(
      (res.data?.data || []).filter(t => t.status === 'APPROVED').map(t => t.name)
    );
    templatesLoaded = true;
    if (approvedTemplates.size) {
      console.log(`✅ Approved templates: ${[...approvedTemplates].join(', ')}`);
    } else {
      console.warn('⚠️  No APPROVED templates — agent alerts rely on the 24-hour window.');
      console.warn('    Send any message to the bot once a day to keep it open.');
    }
  } catch (err) {
    console.error('⚠️  Could not list templates:', err.response?.data?.error?.message || err.message);
    templatesLoaded = true;
  }
  return approvedTemplates;
}

async function sendTemplate(to, templateName, params = []) {
  if (!templatesLoaded) await loadApprovedTemplates();
  if (!approvedTemplates.has(templateName)) return false; // silent skip — not an error

  const components = params.length > 0 ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: String(p || '—') })),
  }] : [];

  const r = await post({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: 'he' }, components },
  }, `sendTemplate "${templateName}" → ${to}`);

  if (r.ok) console.log(`✅ Sent template "${templateName}" to ${to} | msg_id=${r.id}`);
  return r.ok;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

async function markRead(messageId) {
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, { headers: headers(), timeout: 8000 });
  } catch {
    // Non-critical — never block the flow on a read receipt
  }
}

/** Split a long reply into natural WhatsApp-sized messages (max 2 by policy). */
function splitMessage(text, maxLen = 900) {
  if (text.length <= maxLen) return [text];
  const paragraphs = text.split('\n\n');
  const parts = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxLen && current) {
      parts.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.slice(0, 2);
}

module.exports = {
  sendText,
  sendButtons,
  sendList,
  sendImage,
  sendTemplate,
  markRead,
  loadApprovedTemplates,
  approvedTemplates: () => approvedTemplates,
  splitMessage,
};
