/**
 * dashboard.js — sales analytics.
 *
 * Answers the questions the old system could not: where do people drop off,
 * which objections come up most, and what is actually converting.
 */
const storage = require('../storage');
const stages = require('../sales/stages');
const objectionsLib = require('../sales/objections');
const scoring = require('../sales/scoring');
const config = require('../config');

async function funnel(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const events = await storage.getEvents({ since, limit: 10000 });
  const conversations = storage.getAllConversations();

  // ─── Stage distribution of live conversations ───────────────────────────
  const byStage = {};
  for (const key of Object.keys(stages.STAGES)) byStage[key] = 0;
  let totalActive = 0;
  const scores = [];

  for (const session of Object.values(conversations)) {
    const p = session?.profile;
    if (!p) continue;
    totalActive++;
    byStage[p.stage] = (byStage[p.stage] || 0) + 1;
    scores.push(p.buyingIntent || 0);
  }

  // ─── Event roll-up ──────────────────────────────────────────────────────
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

  const started = counts.conversation_started || 0;
  const captured = counts.lead_captured || 0;
  const handoffs = counts.human_handoff || 0;
  const hot = counts.hot_lead || 0;

  // ─── Objection frequency ────────────────────────────────────────────────
  const objectionCounts = {};
  for (const e of events.filter(x => x.type === 'objection_raised')) {
    for (const t of e.data?.types || []) {
      objectionCounts[t] = (objectionCounts[t] || 0) + 1;
    }
  }

  // ─── Question frequency ─────────────────────────────────────────────────
  const intentCounts = {};
  for (const e of events.filter(x => x.type === 'message_analysed')) {
    const i = e.data?.intent;
    if (i) intentCounts[i] = (intentCounts[i] || 0) + 1;
  }

  // ─── Drop-off: where conversations sit and go quiet ──────────────────────
  const dropOff = {};
  const now = Date.now();
  for (const session of Object.values(conversations)) {
    const p = session?.profile;
    if (!p || stages.TERMINAL.includes(p.stage)) continue;
    const idleH = p.lastInboundAt ? (now - new Date(p.lastInboundAt).getTime()) / 3600000 : Infinity;
    if (idleH > 48) dropOff[p.stage] = (dropOff[p.stage] || 0) + 1;
  }

  // ─── Per-arm rollup — joins straight to Meta Ads by ad id ───────────────
  // Aggregate only: no names, no phone numbers, no message content.
  const byArm = {};
  for (const session of Object.values(conversations)) {
    const p = session?.profile;
    if (!p) continue;
    const adId = p.attribution?.sourceId || 'unattributed';
    const a = byArm[adId] || (byArm[adId] = {
      adId,
      headline: p.attribution?.headline || null,
      conversations: 0,
      scores: [],
      withClid: 0,
      leadsCaptured: 0,
    });
    a.conversations++;
    a.scores.push(p.buyingIntent || 0);
    if (p.attribution?.ctwaClid) a.withClid++;
    if (session.leadSaved) a.leadsCaptured++;
  }

  const arms = Object.values(byArm).map(a => ({
    adId: a.adId,
    headline: a.headline,
    conversations: a.conversations,
    leadsCaptured: a.leadsCaptured,
    averageBuyingIntent: a.scores.length
      ? Math.round(a.scores.reduce((x, y) => x + y, 0) / a.scores.length) : 0,
    // 70 is HOT_LEAD_THRESHOLD in config.js — same bar the bot already alerts on
    qualifiedShare: a.scores.length
      ? `${((a.scores.filter(s => s >= 70).length / a.scores.length) * 100).toFixed(0)}%`
      : 'n/a',
    ctwaClidCoverage: a.conversations
      ? `${((a.withClid / a.conversations) * 100).toFixed(0)}%` : 'n/a',
  })).sort((x, y) => y.conversations - x.conversations);

  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),

    byArm: arms,

    overview: {
      activeConversations: totalActive,
      conversationsStarted: started,
      leadsCaptured: captured,
      conversionRate: started ? `${((captured / started) * 100).toFixed(1)}%` : 'n/a',
      hotLeads: hot,
      humanHandoffs: handoffs,
      handoffRate: started ? `${((handoffs / started) * 100).toFixed(1)}%` : 'n/a',
      followUpsSent: counts.followup_sent || 0,
      optOuts: counts.opted_out || 0,
      averageBuyingIntent: avgScore,
      averageBand: scoring.bandLabel(avgScore),
    },

    funnelByStage: Object.entries(byStage)
      .filter(([, n]) => n > 0)
      .map(([stage, count]) => ({
        stage,
        label: stages.label(stage),
        order: stages.STAGES[stage]?.order,
        count,
      }))
      .sort((a, b) => a.order - b.order),

    dropOffPoints: Object.entries(dropOff)
      .map(([stage, count]) => ({ stage, label: stages.label(stage), count }))
      .sort((a, b) => b.count - a.count),

    topObjections: Object.entries(objectionCounts)
      .map(([type, count]) => ({ type, label: objectionsLib.label(type), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),

    topQuestions: Object.entries(intentCounts)
      .map(([intent, count]) => ({ intent, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),

    eventCounts: counts,
  };
}

/**
 * The week, day by day.
 *
 * The owner asked to see the flow of conversations across the week, and the
 * one number the 7 Sep review turned up that nothing on the dashboard shows:
 * 10 of 31 conversations died on the FIRST message — the lead tapped the ad,
 * got the opening question, and never wrote again. A third of the ad budget
 * stops there, so it gets its own column.
 */
function localDate(value, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(value));
  } catch { return null; }
}

function dayLabel(isoDate, timeZone) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone, weekday: 'short', day: 'numeric', month: 'numeric',
    }).format(new Date(`${isoDate}T12:00:00Z`));
  } catch { return isoDate; }
}

async function weekly(days = 7) {
  const tz = config.TIMEZONE;
  const sinceMs = Date.now() - days * 86400000;
  const since = new Date(sinceMs).toISOString();
  const events = await storage.getEvents({ since, limit: 20000 });
  const conversations = storage.getAllConversations();

  // ─── The day buckets, oldest first, including days with nothing on them ──
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const key = localDate(Date.now() - i * 86400000, tz);
    buckets.set(key, { date: key, label: dayLabel(key, tz), started: 0, captured: 0, died: 0 });
  }
  const bump = (value, field) => {
    const b = buckets.get(localDate(value, tz));
    if (b) b[field]++;
  };

  for (const e of events) {
    if (e.type === 'conversation_started') bump(e.createdAt, 'started');
    else if (e.type === 'lead_captured') bump(e.createdAt, 'captured');
  }

  // ─── Died on the first message ───────────────────────────────────────────
  // One inbound message, ever. Counted on the day the conversation opened,
  // and only once the lead has had a fair chance to answer (2h).
  const graceMs = 2 * 3600000;
  let diedTotal = 0;
  for (const session of Object.values(conversations)) {
    const p = session?.profile;
    if (!p || (p.messageCount || 0) > 1) continue;
    const opened = new Date(p.firstSeenAt || session.startedAt || 0).getTime();
    if (!opened || opened < sinceMs) continue;
    if (Date.now() - opened < graceMs) continue;
    bump(opened, 'died');
    diedTotal++;
  }

  const rows = [...buckets.values()].map(b => ({
    ...b,
    conversionRate: b.started ? Math.round((b.captured / b.started) * 100) : null,
  }));

  const started = rows.reduce((n, r) => n + r.started, 0);
  const captured = rows.reduce((n, r) => n + r.captured, 0);

  // ─── Hot leads nobody has picked up ──────────────────────────────────────
  const handedOff = new Set(
    events.filter(e => e.type === 'human_handoff').map(e => e.waPhone));

  const unhandled = [];
  for (const [phone, session] of Object.entries(conversations)) {
    const p = session?.profile;
    if (!p || p.optedOut) continue;
    if ((p.buyingIntent || 0) < config.HOT_LEAD_THRESHOLD) continue;
    if (p.stage === 'CONVERSION' || handedOff.has(phone)) continue;
    const last = p.lastInboundAt ? new Date(p.lastInboundAt).getTime() : 0;
    if (last < sinceMs) continue;
    unhandled.push({
      phone,
      name: p.name || null,
      clientPhone: p.clientPhone || null,
      score: p.buyingIntent || 0,
      stage: stages.label(p.stage),
      lastInboundAt: p.lastInboundAt,
      hoursIdle: last ? Math.max(0, Math.round((Date.now() - last) / 3600000)) : null,
      summary: p.conversationSummary || null,
    });
  }
  unhandled.sort((a, b) => b.score - a.score);

  // ─── What they asked, and what they pushed back on ───────────────────────
  const intentCounts = {};
  for (const e of events.filter(x => x.type === 'message_analysed')) {
    const i = e.data?.intent;
    if (i && i !== 'unclear') intentCounts[i] = (intentCounts[i] || 0) + 1;
  }
  const objectionCounts = {};
  for (const e of events.filter(x => x.type === 'objection_raised')) {
    for (const t of e.data?.types || []) {
      objectionCounts[t] = (objectionCounts[t] || 0) + 1;
    }
  }

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    days: rows,
    totals: {
      started,
      captured,
      conversionRate: started ? Math.round((captured / started) * 100) : null,
      diedAtFirstMessage: diedTotal,
      diedShare: started ? Math.round((diedTotal / started) * 100) : null,
      unhandledHot: unhandled.length,
    },
    unhandledHot: unhandled.slice(0, 25),
    topQuestions: Object.entries(intentCounts)
      .map(([intent, count]) => ({ intent, count }))
      .sort((a, b) => b.count - a.count).slice(0, 8),
    topObjections: Object.entries(objectionCounts)
      .map(([type, count]) => ({ type, label: objectionsLib.label(type), count }))
      .sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/** Leads ranked by how worth calling they are right now. */
async function hotList(limit = 20) {
  const conversations = storage.getAllConversations();
  const rows = [];

  for (const [phone, session] of Object.entries(conversations)) {
    const p = session?.profile;
    if (!p || p.optedOut) continue;
    if (stages.TERMINAL.includes(p.stage) && p.stage !== 'CONVERSION') continue;

    rows.push({
      phone,
      name: p.name,
      clientPhone: p.clientPhone,
      score: p.buyingIntent || 0,
      band: scoring.bandLabel(p.buyingIntent || 0),
      stage: stages.label(p.stage),
      interest: p.interest,
      ancestor: p.eligibility?.ancestor,
      birthPlace: p.eligibility?.birthPlace,
      likelyArticle: p.eligibility?.likelyArticle,
      openObjections: (p.objections || []).filter(o => !o.resolved).map(o => objectionsLib.label(o.type)),
      summary: p.conversationSummary,
      lastInboundAt: p.lastInboundAt,
      messageCount: p.messageCount,
    });
  }

  return rows.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { funnel, hotList, weekly };
