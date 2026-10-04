/**
 * stats.js — aggregate-only lead statistics for the marketing system.
 *
 * Served at /stats/summary behind STATS_TOKEN, a token that opens THIS
 * endpoint and nothing else. It never returns a name, a phone number, a
 * message or any per-person row — only counts and averages per ad. That is the
 * point: the marketing agents can measure lead quality every week without
 * holding a key that could read client conversations (ADMIN_TOKEN can).
 *
 * Internal conversations (the owner's own number, the agent phones) are left
 * out, so a keep-alive message to the bot is never counted as a lead.
 */
const storage = require('../storage');
const config = require('../config');

// The owner's personal number — keep-alive messages from it are not leads.
const DEFAULT_INTERNAL = ['972547787804'];

const BANDS = [
  { key: 'b00_15', label: '0-15', min: 0, max: 15 },
  { key: 'b16_35', label: '16-35', min: 16, max: 35 },
  { key: 'b36_55', label: '36-55', min: 36, max: 55 },
  { key: 'b56_75', label: '56-75', min: 56, max: 75 },
  { key: 'b76_100', label: '76-100', min: 76, max: 100 },
];

const tail9 = (p) => String(p || '').replace(/\D/g, '').slice(-9);

function internalTails() {
  const extra = (process.env.STATS_EXCLUDE_PHONES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_INTERNAL, ...(config.AGENT_PHONES || []), ...extra]
    .map(tail9).filter(Boolean));
}

function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * @param {{since?: string, until?: string, days?: number}} opts
 *   since/until are ISO dates (YYYY-MM-DD or full ISO). With neither, the last
 *   `days` days (default 30) are used.
 */
function summary(opts = {}) {
  const now = Date.now();
  const days = Number.isFinite(opts.days) ? Math.min(365, Math.max(1, opts.days)) : 30;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : now - days * 86400000;
  const untilMs = opts.until ? new Date(opts.until).getTime() : now;
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    const err = new Error('Invalid since/until date');
    err.status = 400;
    throw err;
  }
  const threshold = config.HOT_LEAD_THRESHOLD || 70;
  const internal = internalTails();

  const conversations = storage.getAllConversations();
  const arms = {};
  const totals = { conversations: 0, leadsCaptured: 0, scoreSum: 0, qualified: 0, withClid: 0, singleMessage: 0 };
  const bands = Object.fromEntries(BANDS.map(b => [b.key, 0]));
  const daily = {};
  let excludedInternal = 0;
  let outsideWindow = 0;

  for (const [phone, session] of Object.entries(conversations)) {
    const p = session && session.profile;
    if (!p) continue;
    if (internal.has(tail9(phone))) { excludedInternal++; continue; }

    const startedAt = session.startedAt || p.firstSeenAt || session.updatedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    if (Number.isNaN(startedMs) || startedMs < sinceMs || startedMs >= untilMs) { outsideWindow++; continue; }

    const score = Number(p.buyingIntent) || 0;
    const adId = (p.attribution && p.attribution.sourceId) || 'unattributed';
    const arm = arms[adId] || (arms[adId] = {
      adId,
      headline: (p.attribution && p.attribution.headline) || null,
      conversations: 0, leadsCaptured: 0, scoreSum: 0, qualified: 0, withClid: 0,
      bands: Object.fromEntries(BANDS.map(b => [b.key, 0])),
    });

    arm.conversations++; totals.conversations++;
    arm.scoreSum += score; totals.scoreSum += score;
    if (score >= threshold) { arm.qualified++; totals.qualified++; }
    if (p.attribution && p.attribution.ctwaClid) { arm.withClid++; totals.withClid++; }
    if (session.leadSaved) { arm.leadsCaptured++; totals.leadsCaptured++; }
    const band = BANDS.find(b => score >= b.min && score <= b.max) || BANDS[BANDS.length - 1];
    arm.bands[band.key]++; bands[band.key]++;

    const day = new Date(startedMs).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE || 'Asia/Jerusalem' });
    daily[day] = (daily[day] || 0) + 1;
  }

  const shape = (a) => ({
    conversations: a.conversations,
    leadsCaptured: a.leadsCaptured,
    averageBuyingIntent: a.conversations ? round(a.scoreSum / a.conversations) : null,
    qualified: a.qualified,
    qualifiedShare: a.conversations ? round(a.qualified / a.conversations, 3) : null,
    ctwaClidCoverage: a.conversations ? round(a.withClid / a.conversations, 3) : null,
  });

  return {
    schema: 'pudim-bot-stats/1',
    generatedAt: new Date().toISOString(),
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    qualifiedThreshold: threshold,
    scoreSource: 'machine (buyingIntent 0-100, not human-validated)',
    excluded: { internalConversations: excludedInternal, outsideWindow },
    totals: { ...shape(totals), bands },
    byAd: Object.values(arms)
      .map(a => ({ adId: a.adId, headline: a.headline, ...shape(a), bands: a.bands }))
      .sort((x, y) => y.conversations - x.conversations),
    daily: Object.entries(daily).sort().map(([date, conversations]) => ({ date, conversations })),
    note: 'Aggregate only. No names, phone numbers or message content.',
  };
}

module.exports = { summary };
