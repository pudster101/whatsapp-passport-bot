/**
 * alertQueue.js — agent alerts that the 24-hour window swallowed.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS FIXES                                                         │
 * │                                                                          │
 * │  WhatsApp lets a business send free-form text to a person only inside 24  │
 * │  hours of that person's last message. Outside it, Meta rejects the send   │
 * │  with code 131047 and the message is gone — not queued, not retried,      │
 * │  gone.                                                                   │
 * │                                                                          │
 * │  Friday 9 Oct, 08:38 Israel — the owner's last keep-alive message.        │
 * │  Saturday 10 Oct, 08:38 — the window closed.                             │
 * │    • 10:19  אבי   — new lead alert   → dropped                           │
 * │    • 10:52  עופר  — new lead alert   → dropped                           │
 * │  He heard nothing until he asked why on the 11th.                         │
 * │                                                                          │
 * │  The permanent fix is an approved Meta template, which may be sent at     │
 * │  any time. Until one is approved — and for whenever a template send       │
 * │  fails too — an alert that cannot be delivered is STORED here and sent    │
 * │  the moment the agent writes to the bot and reopens the window.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Storage: the events table, so there is no migration and the queue survives
 * a redeploy exactly as the leads do. `agent_alert_queued` holds the text;
 * `agent_alert_delivered` cancels it by id.
 */
const storage = require('../storage');
const wa = require('../whatsapp');

const QUEUED = 'agent_alert_queued';
const DELIVERED = 'agent_alert_delivered';

// An alert older than this is history, not news. It stays in the events table
// for the record but is no longer re-sent.
const LOOKBACK_DAYS = 14;

// A long silence must not turn into a wall of 40 messages. The newest are the
// ones worth reading; the rest are named and left on the dashboard.
const MAX_FLUSH = 10;

/** Hold an alert that could not be delivered. Returns its queue id. */
function enqueue(agentPhone, text, meta = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  storage.logEvent(agentPhone, QUEUED, { id, text, ...meta });
  console.warn(`📥 Agent alert held for ${agentPhone} — window closed (queue id ${id})`);
  return id;
}

/** Everything still waiting for this agent, oldest first. */
async function pending(agentPhone) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const [queued, delivered] = await Promise.all([
    storage.getEvents({ since, type: QUEUED, phone: agentPhone, limit: 500 }),
    storage.getEvents({ since, type: DELIVERED, phone: agentPhone, limit: 500 }),
  ]);

  const done = new Set(delivered.map(e => e.data?.id).filter(Boolean));
  return queued
    .filter(e => e.data?.id && e.data?.text && !done.has(e.data.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function queuedAt(item, timeZone = 'Asia/Jerusalem') {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone, weekday: 'short', day: 'numeric', month: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(item.createdAt));
  } catch { return ''; }
}

/**
 * The window just reopened — deliver what was held.
 *
 * Called when an agent writes to the bot. Each alert is marked delivered only
 * once it is actually accepted, so a send that fails leaves the queue intact
 * and the next message tries again.
 */
async function flush(agentPhone) {
  if (!agentPhone) return { sent: 0, held: 0, skipped: 0 };

  let items;
  try {
    items = await pending(agentPhone);
  } catch (err) {
    console.warn(`⚠️  Could not read the alert queue for ${agentPhone}: ${err.message}`);
    return { sent: 0, held: 0, skipped: 0 };
  }
  if (!items.length) return { sent: 0, held: 0, skipped: 0 };

  const batch = items.slice(-MAX_FLUSH);
  const older = items.slice(0, items.length - batch.length);

  await wa.sendText(agentPhone,
    `📬 *${items.length} התראות חיכו לך* — חלון 24 השעות היה סגור, ועכשיו הוא נפתח.\n\n` +
    (older.length
      ? `שולח את ${batch.length} האחרונות. ${older.length} ישנות יותר מופיעות בדף השבועי.\n\n`
      : '') +
    `_כל אחת מהן נשלחת כפי שנכתבה, עם השעה שבה נוצרה._`
  );

  let sent = 0;
  for (const item of batch) {
    const at = queuedAt(item);
    const ok = await wa.sendText(agentPhone,
      (at ? `🕐 _התראה מ-${at}_\n\n` : '') + item.data.text);
    if (!ok) {
      // The window closed again, or the send is broken. Stop; the rest stay
      // queued and go out on his next message.
      console.warn(`⚠️  Flush stopped after ${sent} alert(s) — ${agentPhone} not reachable`);
      break;
    }
    storage.logEvent(agentPhone, DELIVERED, { id: item.data.id });
    sent++;
  }

  // The ones we deliberately did not send are closed out, so the same backlog
  // is not re-announced every single morning.
  if (sent === batch.length) {
    for (const item of older) {
      storage.logEvent(agentPhone, DELIVERED, { id: item.data.id, skipped: true });
    }
  }

  return { sent, held: batch.length - sent, skipped: sent === batch.length ? older.length : 0 };
}

module.exports = { enqueue, pending, flush, QUEUED, DELIVERED, MAX_FLUSH };
