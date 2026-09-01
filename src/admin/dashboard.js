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

  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),

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

module.exports = { funnel, hotList };
