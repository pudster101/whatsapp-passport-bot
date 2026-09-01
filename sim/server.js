/**
 * sim/server.js — local test console.
 *
 * Runs the REAL conversation engine (flows.js, the sales layer, the AI if you
 * have a key) against a mocked WhatsApp API, and serves a chat UI at
 * http://localhost:3010
 *
 * Nothing is sent to WhatsApp. No customer can be reached. No deploy needed.
 *
 * Run:  npm run sim
 */
const path = require('path');
const Module = require('module');
const express = require('express');

// ─── Mock the WhatsApp adapter BEFORE anything requires it ───────────────────
let outbox = [];

const waMock = {
  sendText: async (to, text) => {
    outbox.push({ to, kind: 'text', text });
    return true;
  },
  sendButtons: async (to, body, buttons) => {
    outbox.push({
      to,
      kind: 'buttons',
      text: body,
      options: (buttons || []).map(b => ({ id: b.id, title: b.title })),
    });
    return true;
  },
  sendList: async (to, body, buttonLabel, sections) => {
    const options = [];
    for (const s of sections || []) {
      for (const r of s.rows || []) {
        options.push({ id: r.id, title: r.title, description: r.description });
      }
    }
    outbox.push({ to, kind: 'list', text: body, buttonLabel, options });
    return true;
  },
  sendImage: async (to, url, caption) => {
    outbox.push({ to, kind: 'image', text: caption || '', url });
    return true;
  },
  sendTemplate: async () => false,
  markRead: async () => {},
  loadApprovedTemplates: async () => new Set(),
  approvedTemplates: () => new Set(),
  splitMessage: (t) => {
    // mirror the real splitter so message chunking is visible in the sim
    if (t.length <= 900) return [t];
    const paragraphs = t.split('\n\n');
    const parts = [];
    let cur = '';
    for (const p of paragraphs) {
      if ((cur + '\n\n' + p).length > 900 && cur) { parts.push(cur.trim()); cur = p; }
      else cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.slice(0, 2);
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === './whatsapp' || request === '../whatsapp') return waMock;
  return originalLoad.apply(this, arguments);
};

// ─── Now load the real engine ────────────────────────────────────────────────
const config = require('../src/config');
const storage = require('../src/storage');
const brain = require('../src/ai/brain');
const flows = require('../src/flows');
const leadProfile = require('../src/sales/leadProfile');
const stages = require('../src/sales/stages');
const scoring = require('../src/sales/scoring');
const objectionsLib = require('../src/sales/objections');
const followup = require('../src/followup/scheduler');

// Simulated numbers are prefixed so they never collide with real conversations
const SIM_PREFIX = '99900000';

// Capture console output per turn so the UI can show the internal trace
let trace = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args) => { trace.push(args.join(' ')); realLog(...args); };
console.warn = (...args) => { trace.push(args.join(' ')); realWarn(...args); };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function snapshot(phone) {
  const session = storage.getConversation(phone);
  if (!session) return null;
  const p = session.profile || {};
  return {
    state: session.state,
    stage: p.stage,
    stageLabel: stages.label(p.stage),
    score: p.buyingIntent || 0,
    band: scoring.bandLabel(p.buyingIntent || 0),
    name: p.name,
    clientPhone: p.clientPhone,
    interest: p.interest || [],
    motivation: p.motivation,
    urgency: p.urgency,
    eligibility: p.eligibility || {},
    objections: (p.objections || []).map(o => ({
      type: o.type, label: objectionsLib.label(o.type), resolved: !!o.resolved,
    })),
    nextAction: p.nextAction,
    messageCount: p.messageCount || 0,
    summary: p.conversationSummary,
    missing: leadProfile.missingFacts(p),
    leadSaved: !!session.leadSaved,
    humanStatus: p.humanStatus,
    optedOut: !!p.optedOut,
    followUpsSent: p.followUpsSent || 0,
    followUpDue: !!followup.evaluate(p),
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────

app.post('/api/message', async (req, res) => {
  const { phone, text, buttonId, title } = req.body;
  const target = phone || `${SIM_PREFIX}01`;

  outbox = [];
  trace = [];
  brain.clearLastCompose();
  const started = Date.now();

  const message = buttonId
    ? {
        type: 'interactive',
        id: `sim_${Date.now()}`,
        interactive: { type: 'list_reply', list_reply: { id: buttonId, title: title || '' } },
      }
    : { type: 'text', id: `sim_${Date.now()}`, text: { body: text || '' } };

  try {
    await flows.handleMessage(target, message);

    // Agent notifications go to a different number — show them separately
    // instead of letting them pollute the customer's chat window.
    const captured = [...outbox];
    const toCustomer = captured.filter(m => m.to === target);
    const toAgents = captured.filter(m => m.to !== target);

    const ai = brain.getLastCompose();

    res.json({
      ok: true,
      messages: toCustomer,
      agentAlerts: toAgents.map(m => ({ to: m.to, text: m.text })),
      profile: snapshot(target),
      ms: Date.now() - started,
      // Who actually wrote this reply, and what it cost
      ai: ai || {
        usedAI: false,
        reason: !brain.isAvailable()
          ? 'אין מפתח API — מצב תסריט'
          : config.AI_MODE !== 'live'
            ? `AI_MODE=${config.AI_MODE} — ה-AI מנתח אך לא מנסח`
            : 'התשובה נבחרה מהתסריט (כפתור, בקשת נציג או ביטחון נמוך)',
      },
      trace: trace.filter(l => /📩|🎯|🧠|🛑|💾|🆕|🔄|⚠️|🕐|📚/.test(l)),
    });
  } catch (err) {
    console.error('Sim error:', err);
    res.status(500).json({ ok: false, error: err.message, stack: err.stack, trace });
  }
});

/**
 * Endpoint for the Python training agent (trainer/bot_connector.py).
 *
 * Simple contract: one message in, one reply string out. All the bot's
 * customer-facing messages for that turn are joined, so the trainer sees
 * exactly what a WhatsApp user would see.
 */
app.post('/api/bot', async (req, res) => {
  const { session_id, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  // Deterministic phone per training session so each run is isolated
  const id = String(session_id || 'default');
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const phone = `9997${String(hash).padStart(9, '0').slice(0, 9)}`;

  outbox = [];
  brain.clearLastCompose();
  const started = Date.now();

  try {
    await flows.handleMessage(phone, {
      type: 'text',
      id: `train_${Date.now()}_${Math.random()}`,
      text: { body: String(message) },
    });

    const toCustomer = outbox.filter(m => m.to === phone);
    const reply = toCustomer.map(m => {
      if (m.kind === 'list' && m.options?.length) {
        return `${m.text}\n[אפשרויות: ${m.options.map(o => o.title).join(' | ')}]`;
      }
      return m.text;
    }).filter(Boolean).join('\n\n');

    const ai = brain.getLastCompose();
    res.json({
      reply: reply || '(הבוט לא החזיר טקסט)',
      phone,
      ms: Date.now() - started,
      ai_used: !!(ai && ai.usedAI),
      ai_error: ai && ai.error ? ai.error : null,
      profile: snapshot(phone),
    });
  } catch (err) {
    console.error('Trainer endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** Reset by training session id (mirrors the hashing above). */
app.post('/api/bot/reset', (req, res) => {
  const id = String(req.body?.session_id || 'default');
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const phone = `9997${String(hash).padStart(9, '0').slice(0, 9)}`;
  storage.deleteConversation(phone);
  res.json({ ok: true, phone });
});

app.post('/api/reset', (req, res) => {
  const target = req.body.phone || `${SIM_PREFIX}01`;
  storage.deleteConversation(target);
  res.json({ ok: true });
});

app.post('/api/mode', (req, res) => {
  const mode = req.body.mode;
  if (!['off', 'shadow', 'live'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'invalid mode' });
  }
  config.AI_MODE = mode; // config object is live, so this takes effect immediately
  res.json({ ok: true, mode, aiAvailable: brain.isAvailable() });
});

/** Fast-forward the clock so follow-up timing can be tested without waiting. */
app.post('/api/timetravel', (req, res) => {
  const hours = parseInt(req.body.hours || '24', 10);
  const target = req.body.phone || `${SIM_PREFIX}01`;
  const session = storage.getConversation(target);
  if (!session?.profile) return res.status(404).json({ ok: false, error: 'no conversation' });

  const shift = hours * 3600000;
  const p = session.profile;
  if (p.lastInboundAt)  p.lastInboundAt  = new Date(new Date(p.lastInboundAt).getTime() - shift).toISOString();
  if (p.lastOutboundAt) p.lastOutboundAt = new Date(new Date(p.lastOutboundAt).getTime() - shift).toISOString();
  if (p.lastFollowUpAt) p.lastFollowUpAt = new Date(new Date(p.lastFollowUpAt).getTime() - shift).toISOString();
  storage.setConversation(target, session);

  const due = followup.evaluate(p);
  res.json({
    ok: true,
    hours,
    followUpDue: !!due,
    preview: due
      ? (typeof due.step.message === 'function' ? due.step.message(p) : due.step.message)
      : null,
    reason: due ? null : 'no follow-up scheduled for this stage/timing',
    profile: snapshot(target),
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    aiMode: config.AI_MODE,
    aiAvailable: brain.isAvailable(),
    hasKey: !!config.ANTHROPIC_API_KEY,
    storage: storage.isPostgres() ? 'postgres' : 'file',
    quoteFees: config.QUOTE_FEES,
    hotThreshold: config.HOT_LEAD_THRESHOLD,
    aiBudget: brain.budgetStatus(),
    maxMessages: config.MAX_MESSAGES_PER_CONVERSATION,
    rules: require('../src/sales/leadProfile').rulesSignature(),
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.SIM_PORT || 3010;

(async () => {
  await storage.init();
  brain.init();

  app.listen(PORT, () => {
    realLog(`\n${'═'.repeat(58)}`);
    realLog(`  🧪  SIMULATOR READY`);
    realLog(`${'═'.repeat(58)}`);
    realLog(`  Open:     http://localhost:${PORT}`);
    realLog(`  AI mode:  ${brain.isAvailable() ? config.AI_MODE : 'disabled (no API key — scripted mode)'}`);
    realLog(`  Storage:  ${storage.isPostgres() ? 'postgres' : 'local file'}`);
    realLog(`  Rules:    ${require('../src/sales/leadProfile').rulesSignature()}`);
    realLog(`\n  Nothing here reaches WhatsApp. Safe to experiment.`);
    realLog(`${'═'.repeat(58)}\n`);
  });
})();
