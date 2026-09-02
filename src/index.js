require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');

const config = require('./config');
const storage = require('./storage');
const wa = require('./whatsapp');
const brain = require('./ai/brain');
const { handleMessage } = require('./flows');
const handoff = require('./sales/handoff');
const followup = require('./followup/scheduler');
const dashboard = require('./admin/dashboard');

const app = express();

// Raw body is required for HMAC signature verification, so capture it here.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// ─── Webhook signature verification ───────────────────────────────────────────
// Without this, anyone who knows the URL can POST forged messages and make the
// bot send WhatsApp messages on the firm's account.
function verifySignature(req) {
  if (!config.APP_SECRET) return true; // not configured — warned at boot
  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', config.APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Message deduplication ────────────────────────────────────────────────────
// Meta retries webhook deliveries. Without this, a retry re-runs the flow.
const seenMessages = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function alreadyProcessed(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (seenMessages.size > 2000) {
    for (const [id, ts] of seenMessages) {
      if (now - ts > DEDUPE_TTL_MS) seenMessages.delete(id);
    }
  }
  if (seenMessages.has(msgId)) return true;
  seenMessages.set(msgId, now);
  return false;
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!config.ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'Admin API disabled. Set ADMIN_TOKEN in the environment to enable it.',
    });
  }
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.query.token;
  if (token !== config.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Webhook verification (GET) ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Webhook verification failed');
  res.sendStatus(403);
});

// ─── Incoming messages (POST) ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('🛑 Rejected webhook with invalid signature');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // acknowledge immediately so Meta does not retry

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        // Delivery/read status callbacks — useful signal, not a conversation
        if (value?.statuses?.length && !value?.messages) {
          for (const s of value.statuses) {
            if (s.status === 'failed') {
              console.warn(`⚠️  Message to ${s.recipient_id} failed: ${JSON.stringify(s.errors || [])}`);
            }
          }
          continue;
        }

        if (!value?.messages) continue;

        for (const message of value.messages) {
          const phone = message.from;
          const msgId = message.id;

          if (alreadyProcessed(msgId)) {
            console.log(`🔁 Duplicate webhook for ${msgId} — ignored`);
            continue;
          }

          console.log(`\n📨 New message from ${phone} [${message.type}]`);
          wa.markRead(msgId).catch(() => {});

          try {
            await handleMessage(phone, message);
          } catch (err) {
            console.error(`❌ Flow error for ${phone}:`, err);
            // Never leave a customer hanging because of our bug
            await wa.sendText(phone,
              'סליחה, נתקלתי בתקלה רגעית. 🙏\nאפשר לנסות שוב, או לכתוב *נציג* ואעביר אותך לעו״ד מהמשרד.'
            ).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.get('/admin/leads', requireAdmin, async (req, res) => {
  try {
    res.json(await storage.getAllLeads(parseInt(req.query.limit || '200', 10)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    res.json(await dashboard.funnel(parseInt(req.query.days || '30', 10)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/hot', requireAdmin, async (req, res) => {
  try {
    res.json(await dashboard.hotList(parseInt(req.query.limit || '20', 10)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/conversations', requireAdmin, (req, res) => {
  const all = storage.getAllConversations();
  res.json(Object.entries(all).map(([phone, s]) => ({
    phone,
    state: s.state,
    stage: s.profile?.stage,
    score: s.profile?.buyingIntent,
    name: s.profile?.name,
    messages: s.profile?.messageCount,
    lastInboundAt: s.profile?.lastInboundAt,
  })));
});

/**
 * A live view of conversations happening right now.
 *
 * The transcripts endpoint is for reading afterwards; this one is for watching
 * while it happens. It refreshes itself, newest conversation first, so it can
 * be left open on a second screen during the day.
 */
app.get('/admin/live', requireAdmin, (req, res) => {
  const every = Math.max(3, parseInt(req.query.refresh || '8', 10));
  const token = req.query.token || '';
  const all = storage.getAllConversations();

  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const time = (d) => {
    try {
      return new Date(d).toLocaleTimeString('he-IL', {
        timeZone: config.TIMEZONE, hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  };

  const entries = Object.entries(all)
    .sort((a, b) =>
      new Date(b[1].profile?.lastInboundAt || 0) - new Date(a[1].profile?.lastInboundAt || 0))
    .slice(0, 20);

  const cards = entries.map(([phone, s]) => {
    const p = s.profile || {};
    const mins = p.lastInboundAt
      ? Math.round((Date.now() - new Date(p.lastInboundAt).getTime()) / 60000)
      : null;
    const live = mins !== null && mins < 5;
    const msgs = (s.history || []).slice(-8).map(m => `
      <div class="m ${m.role === 'user' ? 'u' : 'b'}">
        <span class="t">${time(m.at)}</span>${esc(m.text)}
      </div>`).join('');

    return `
    <div class="c ${live ? 'on' : ''}">
      <div class="h">
        <b>${esc(p.name || '+' + phone)}</b>
        ${p.clientPhone ? `<span class="p">${esc(p.clientPhone)}</span>` : ''}
        <span class="s">${p.buyingIntent || 0}/100</span>
        ${live ? '<span class="dot">● פעיל עכשיו</span>'
               : `<span class="ago">לפני ${mins === null ? '?' : mins} דק׳</span>`}
      </div>
      ${msgs || '<div class="e">אין הודעות</div>'}
      <a class="full" href="/admin/transcripts?token=${encodeURIComponent(token)}&phone=${encodeURIComponent(phone)}">התמליל המלא ←</a>
    </div>`;
  }).join('');

  res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="${every}">
<title>שיחות עכשיו</title><style>
body{font-family:system-ui,'Segoe UI',Arial;background:#0e1113;color:#e6e8ea;margin:0;padding:16px}
h1{font-size:17px;margin:0 0 4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:16px}
.c{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px;margin-bottom:12px}
.c.on{border-color:#2ea043}
.h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px}
.p{color:#8b949e}.s{background:#21262d;padding:2px 8px;border-radius:20px;font-size:11px}
.dot{color:#3fb950;font-size:11px}.ago{color:#8b949e;font-size:11px}
.m{padding:6px 10px;border-radius:8px;margin:4px 0;font-size:13px;line-height:1.5;white-space:pre-wrap}
.m.u{background:#1f6feb22;border-right:2px solid #1f6feb}
.m.b{background:#21262d;border-right:2px solid #484f58}
.t{color:#6e7681;font-size:10px;margin-left:8px}
.e{color:#6e7681;font-size:12px}
.full{color:#58a6ff;font-size:11px;text-decoration:none}
</style></head><body>
<h1>שיחות עכשיו</h1>
<div class="sub">מתרענן כל ${every} שניות · ${entries.length} שיחות אחרונות · ירוק = פעיל בחמש הדקות האחרונות</div>
${cards || '<div class="e">אין שיחות עדיין.</div>'}
</body></html>`);
});

/**
 * Read one conversation, or all of them, as plain text.
 *
 *   /admin/transcripts?token=...              → every conversation, readable
 *   /admin/transcripts?token=...&phone=9725.. → just that one
 *   /admin/transcripts?token=...&format=json  → structured, for tooling
 *
 * Only the last 20 messages per conversation are kept (MAX_HISTORY), so a very
 * long conversation shows its recent part, not its whole life.
 */
app.get('/admin/transcripts', requireAdmin, (req, res) => {
  const all = storage.getAllConversations();
  const wanted = req.query.phone;
  const entries = Object.entries(all)
    .filter(([phone]) => !wanted || phone === wanted || phone.endsWith(wanted))
    .sort((a, b) =>
      new Date(b[1].profile?.lastInboundAt || 0) - new Date(a[1].profile?.lastInboundAt || 0));

  if (req.query.format === 'json') {
    return res.json(entries.map(([phone, s]) => ({
      phone,
      name: s.profile?.name || null,
      clientPhone: s.profile?.clientPhone || null,
      score: s.profile?.buyingIntent || 0,
      stage: s.profile?.stage,
      messages: s.profile?.messageCount || 0,
      lastInboundAt: s.profile?.lastInboundAt || null,
      summary: s.profile?.conversationSummary || null,
      history: s.history || [],
    })));
  }

  const fmt = (d) => {
    try {
      return new Date(d).toLocaleString('he-IL', { timeZone: config.TIMEZONE });
    } catch { return String(d || ''); }
  };

  const out = entries.map(([phone, s]) => {
    const p = s.profile || {};
    const head =
      `${'='.repeat(60)}\n` +
      `+${phone}${p.name ? ` — ${p.name}` : ''}${p.clientPhone ? ` (${p.clientPhone})` : ''}\n` +
      `שלב: ${p.stage || '—'} · ניקוד: ${p.buyingIntent || 0} · הודעות: ${p.messageCount || 0}\n` +
      `פנייה אחרונה: ${fmt(p.lastInboundAt)}\n` +
      (p.conversationSummary ? `סיכום: ${p.conversationSummary}\n` : '') +
      `${'='.repeat(60)}`;
    const body = (s.history || [])
      .map(m => `[${fmt(m.at)}] ${m.role === 'user' ? 'לקוח' : 'בוט '}: ${m.text}`)
      .join('\n');
    return `${head}\n${body || '(אין היסטוריה שמורה)'}`;
  }).join('\n\n\n');

  res.type('text/plain; charset=utf-8');
  if (req.query.download === '1') {
    res.set('Content-Disposition',
      `attachment; filename="conversations-${new Date().toISOString().slice(0, 10)}.txt"`);
  }
  res.send(out || 'אין שיחות שמורות.');
});

app.get('/admin/events', requireAdmin, async (req, res) => {
  try {
    res.json(await storage.getEvents({
      since: req.query.since,
      type: req.query.type,
      phone: req.query.phone,
      limit: parseInt(req.query.limit || '200', 10),
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/followup/run', requireAdmin, async (_req, res) => {
  try {
    res.json(await followup.runSweep());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    storage: storage.isPostgres() ? 'postgres' : 'file (EPHEMERAL)',
    ai: brain.isAvailable() ? config.AI_MODE : 'disabled',
    agents: config.AGENT_PHONES.length,
    templates: [...wa.approvedTemplates()],
    aiBudget: brain.budgetStatus(),
    limits: {
      maxMessagesPerConversation: config.MAX_MESSAGES_PER_CONVERSATION,
      rateLimit: `${config.RATE_LIMIT_MESSAGES}/${config.RATE_LIMIT_WINDOW_MIN}min`,
      sessionTtlDays: config.SESSION_TTL_DAYS,
    },
  });
});

// ─── Cron ─────────────────────────────────────────────────────────────────────

function scheduleJobs() {
  // Follow-up sweep — hourly during Israeli business hours
  if (config.FOLLOWUP_ENABLED) {
    cron.schedule('0 6-15 * * 0-4', async () => {
      try { await followup.runSweep(); }
      catch (err) { console.error('❌ Follow-up sweep error:', err.message); }
    }, { timezone: 'UTC' });
    console.log('⏰ Follow-up sweep scheduled (hourly, Sun–Thu business hours)');
  }

  // Daily agent digest — 08:00 Israel time (05:00 UTC)
  if (config.AGENT_PHONES.length) {
    cron.schedule('0 5 * * *', async () => {
      try {
        const today = new Date().toLocaleDateString('he-IL', {
          timeZone: config.TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
        const stats = await dashboard.funnel(1);
        const hot = await dashboard.hotList(3);

        const hotLines = hot.length
          ? '\n\n🔥 *הכי שווה להתקשר היום:*\n' + hot.map((h, i) =>
              `${i + 1}. ${h.name || h.phone} — ${h.score}/100${h.clientPhone ? ` · ${h.clientPhone}` : ''}`
            ).join('\n')
          : '';

        const text =
          `🌅 *בוקר טוב! סיכום יומי* ✅\n\n` +
          `📅 ${today}\n` +
          `💬 שיחות פעילות: *${stats.overview.activeConversations}*\n` +
          `🆕 שיחות שהתחילו אתמול: *${stats.overview.conversationsStarted}*\n` +
          `📋 לידים שנאספו: *${stats.overview.leadsCaptured}*\n` +
          `🔥 לידים חמים: *${stats.overview.hotLeads}*` +
          hotLines;

        await handoff.notifyAgents(text, 'pudim_daily_status', [
          String(stats.overview.activeConversations),
          String(stats.overview.leadsCaptured),
        ]);
        console.log('✅ Daily digest sent');
      } catch (err) {
        console.error('❌ Daily digest error:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log(`⏰ Daily digest scheduled → ${config.AGENT_PHONES.join(', ')}`);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  console.log('\n🚀 Starting WhatsApp sales agent...\n');

  await storage.init();          // must finish before we serve traffic
  brain.init();
  await wa.loadApprovedTemplates();

  if (!config.APP_SECRET) {
    console.warn('⚠️  APP_SECRET not set — webhook signature verification is OFF.');
    console.warn('    Anyone who knows the URL can post forged messages. Set it in Railway.');
  }
  if (!config.ADMIN_TOKEN) {
    console.warn('⚠️  ADMIN_TOKEN not set — admin endpoints are disabled (safe default).');
  }

  scheduleJobs();

  app.listen(config.PORT, async () => {
    console.log(`\n🤖 Running on port ${config.PORT}`);
    console.log(`📡 Webhook:   ${config.PUBLIC_URL}/webhook`);
    console.log(`📊 Dashboard: ${config.PUBLIC_URL}/admin/dashboard?token=***`);
    console.log(`💾 Storage:   ${storage.isPostgres() ? 'Postgres ✅' : 'file ⚠️  EPHEMERAL'}`);
    console.log(`🧠 AI:        ${brain.isAvailable() ? config.AI_MODE : 'disabled (scripted mode)'}`);
    console.log(`⚖️  כללים:     ${require('./sales/leadProfile').rulesSignature()}\n`);

    if (config.AGENT_PHONES.length) {
      const startupTime = new Date().toLocaleString('he-IL', { timeZone: config.TIMEZONE });
      handoff.notifyAgents(
        `🤖 *הבוט הופעל מחדש ופעיל* ✅\n\n🕐 ${startupTime}\n` +
        `💾 אחסון: ${storage.isPostgres() ? 'Postgres' : 'קובץ מקומי ⚠️'}\n` +
        `🧠 מנוע מכירות: ${brain.isAvailable() ? config.AI_MODE : 'כבוי'}`,
        'pudim_bot_startup',
        [startupTime]
      ).catch(err => console.error('❌ Startup notification error:', err.message));
    }
  });
}

// Flush pending writes on shutdown so no lead is lost mid-flight
async function shutdown(signal) {
  console.log(`\n${signal} received — flushing pending writes...`);
  try { await storage.flush(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('❌ Uncaught exception:', err));

start().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
