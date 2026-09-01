/**
 * handoff.js — agent notifications with real context.
 *
 * The old bot sent the agent a name and a phone number. The customer then had
 * to repeat everything to the lawyer. This module hands over the full picture
 * so the human can open with "I saw your grandmother was born in Iași in 1927".
 */
const config = require('../config');
const wa = require('../whatsapp');
const leadProfile = require('./leadProfile');
const objections = require('./objections');
const stages = require('./stages');
const scoring = require('./scoring');

/** Send to every configured agent phone. Template first, free text fallback. */
async function notifyAgents(text, templateName = null, params = []) {
  if (!config.AGENT_PHONES.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;

  await Promise.all(config.AGENT_PHONES.map(async (phone) => {
    try {
      if (templateName) {
        const ok = await wa.sendTemplate(phone, templateName, params);
        if (ok) { sent++; return; }
      }
      const ok = await wa.sendText(phone, text);
      ok ? sent++ : failed++;
    } catch (err) {
      failed++;
      console.warn(`⚠️  Agent notify failed for ${phone}: ${err.message}`);
    }
  }));

  return { sent, failed };
}

const URGENCY_ICON = { high: '🔥', medium: '⏳', low: '🕐' };
const URGENCY_HE  = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };

/** Full lead card — used for new leads and for handoffs. */
function leadCard(profile, opts = {}) {
  const e = profile.eligibility || {};
  const score = profile.buyingIntent || 0;
  const band = scoring.bandLabel(score);
  const heat = score >= 80 ? '🔥🔥' : score >= 70 ? '🔥' : score >= 50 ? '🟢' : '⚪';

  const lines = [];
  lines.push(opts.title || `${heat} *ליד חדש*`);
  lines.push('');

  if (profile.name) lines.push(`👤 *${profile.name}*`);
  if (profile.clientPhone) lines.push(`📞 ${profile.clientPhone}`);
  lines.push(`📱 וואטסאפ: +${profile.waPhone}`);
  lines.push('');

  lines.push(`📊 כוונת רכישה: *${score}/100* (${band})`);
  lines.push(`📍 שלב: ${stages.label(profile.stage)}`);
  if (profile.urgency) lines.push(`${URGENCY_ICON[profile.urgency] || '🕐'} דחיפות: ${URGENCY_HE[profile.urgency] || profile.urgency}`);
  if (profile.interest?.length) {
    const names = { passport: 'דרכון רומני', b1_course: 'קורס B1' };
    lines.push(`🎯 עניין: ${profile.interest.map(i => names[i] || i).join(', ')}`);
  }
  lines.push('');

  // Eligibility block
  const elig = [];
  if (e.ancestor)   elig.push(`👴 בן משפחה: ${e.ancestor}`);
  if (e.birthYear)  elig.push(`📅 שנת לידה: ${e.birthYear}`);
  if (e.birthPlace) elig.push(`📍 מקום: ${e.birthPlace}`);
  if (e.leftYear)   elig.push(`🛫 עזב: ${e.leftYear}`);
  if (e.likelyArticle) {
    elig.push(`⚖️ מסלול משוער: *סעיף ${e.likelyArticle}*${e.territory ? ` (${e.territory})` : ''}`);
  }
  if (e.hasDocuments !== null && e.hasDocuments !== undefined) {
    elig.push(`📂 מסמכים: ${e.hasDocuments === true ? 'יש' : e.hasDocuments === false ? 'אין' : 'חלקי'}`);
  }
  if (e.b1Status) elig.push(`🎓 B1: ${e.b1Status}`);
  if (elig.length) { lines.push(...elig); lines.push(''); }

  if (profile.motivation) {
    const motives = {
      children_future: 'עתיד הילדים',
      eu_work: 'עבודה/מגורים באירופה',
      studies: 'לימודים',
      business: 'עסקים',
      security: 'ביטחון',
      curiosity: 'סקרנות',
    };
    lines.push(`💡 מניע: ${motives[profile.motivation] || profile.motivation}`);
  }

  const open = (profile.objections || []).filter(o => !o.resolved);
  if (open.length) {
    lines.push(`⚠️ התנגדויות: ${open.map(o => objections.label(o.type)).join(', ')}`);
  }

  if (profile.conversationSummary) {
    lines.push('', `📝 *סיכום:* ${profile.conversationSummary}`);
  }

  if (opts.recommendation) {
    lines.push('', `👉 *מומלץ:* ${opts.recommendation}`);
  }

  return lines.join('\n');
}

/** New conversation started. */
async function notifyChatStart(phone, profile) {
  const now = new Date().toLocaleString('he-IL', { timeZone: config.TIMEZONE });
  const text =
    `👁️ *התחלת שיחה חדשה*\n\n` +
    `📱 מספר: +${phone}\n` +
    `🕐 שעה: ${now}\n` +
    (profile?.source && profile.source !== 'unknown' ? `📣 מקור: ${profile.source}\n` : '') +
    `\n_אם לא תגיע הודעת ליד בהמשך — הלקוח לא השלים את התהליך._`;
  return notifyAgents(text, 'pudim_chat_start', [phone, now]);
}

/** Contact details captured. */
async function notifyNewLead(profile) {
  const isCourse = profile.interest?.includes('b1_course');
  const recommendation = recommendFor(profile);
  const text = leadCard(profile, {
    title: isCourse ? '🎓 *ליד חדש — קורס רומנית B1*' : '🔔 *ליד חדש — דרכון רומני*',
    recommendation,
  });

  const e = profile.eligibility || {};
  return notifyAgents(
    text,
    isCourse ? 'b1_lead_new' : 'passport_lead_new',
    isCourse
      ? [profile.name, profile.clientPhone, profile.waPhone]
      : [profile.name, profile.clientPhone, profile.waPhone,
         e.ancestor || '—', e.birthYear || '—', e.birthPlace || '—']
  );
}

/** Buying intent crossed the hot threshold mid-conversation. */
async function notifyHotLead(profile) {
  const text = leadCard(profile, {
    title: '🔥 *ליד חם — כדאי להתערב עכשיו*',
    recommendation: 'הלקוח בשיחה פעילה ומגלה כוונת רכישה גבוהה. שיחה עכשיו תמיר הרבה יותר טוב.',
  });
  return notifyAgents(text, null, []);
}

/** Customer asked for a human, or the system decided one is needed. */
async function notifyHandoff(profile, reason) {
  const text = leadCard(profile, {
    title: '🆘 *נדרש נציג אנושי*',
    recommendation: reason || 'הלקוח ביקש לדבר עם נציג.',
  });
  return notifyAgents(
    text,
    'pudim_handoff',
    [profile.name || 'לא נאסף', profile.waPhone, profile.clientPhone || '—']
  );
}

function recommendFor(profile) {
  const score = profile.buyingIntent || 0;
  const e = profile.eligibility || {};
  if (score >= 80) return 'חייג היום — הלקוח חם.';
  if (score >= 70) return 'חייג בתוך 24 שעות.';
  if ((profile.objections || []).some(o => !o.resolved)) {
    return 'יש התנגדות פתוחה — שיחה אישית תפתור אותה טוב יותר מהבוט.';
  }
  if (!e.ancestor) return 'פרטי זכאות חסרים — כדאי לברר בשיחה.';
  return 'חזור אליו במהלך יום העסקים הקרוב.';
}

module.exports = {
  notifyAgents,
  notifyChatStart,
  notifyNewLead,
  notifyHotLead,
  notifyHandoff,
  leadCard,
};
