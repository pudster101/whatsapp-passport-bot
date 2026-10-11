/**
 * templates.js — the single source of truth for WhatsApp message templates.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS FILE EXISTS                                                    │
 * │                                                                          │
 * │  Free-form text may only be sent inside 24 hours of the recipient's last │
 * │  message. An APPROVED TEMPLATE may be sent at any time. Templates are    │
 * │  therefore the only permanent fix for alerts going missing overnight.    │
 * │                                                                          │
 * │  Until now the names were kept in three places that disagreed:           │
 * │    • create-templates.js submitted  pudim_lead_passport, pudim_lead_b1   │
 * │    • update-templates.js submitted  passport_lead_new, b1_lead_new       │
 * │    • the code called                passport_lead_new, b1_lead_new,      │
 * │      pudim_waiting_list, pudim_meeting_request, pudim_meetings_digest    │
 * │                                                                          │
 * │  The last three were never submitted to Meta at all, so the three most    │
 * │  valuable alerts the bot sends had no template behind them and lived or   │
 * │  died on the 24-hour window. On 10 Oct they died.                        │
 * │                                                                          │
 * │  Every template the code sends is listed below, with the exact number of  │
 * │  parameters the call site passes. sync-templates.js submits them and      │
 * │  /admin/templates shows which are approved.                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Meta's rules that these bodies obey:
 *   • no emojis, no markdown asterisks, no double spaces, no trailing newline
 *   • a {{n}} placeholder may be neither the first nor the last thing in the
 *     body — every body therefore ends in static text
 *   • placeholders must be numbered 1..n with no gaps
 *   • EVERY placeholder needs a sample value. This is what sank the previous
 *     attempts: both old scripts posted the body without `example.body_text`,
 *     Meta accepted the submission as PENDING and then rejected every single
 *     one with INVALID_FORMAT. Checked on 11 Oct — all seven submitted
 *     templates were REJECTED, which is why the 24-hour window has been the
 *     bot's only channel to you from the start. The `example` arrays below are
 *     the fix; validate() refuses to let one go missing again.
 */

const TEMPLATES = [
  {
    name: 'passport_lead_new',
    example: ['ישראל ישראלי', '0501234567', '972501234567', 'סבתא', '1927', 'יאשי'],
    category: 'UTILITY',
    language: 'he',
    params: 6,
    sentBy: 'handoff.notifyNewLead — contact details captured (passport)',
    text:
      'פנייה חדשה - דרכון רומני.\n' +
      'שם: {{1}}\n' +
      'טלפון: {{2}}\n' +
      'מספר וואטסאפ: {{3}}\n' +
      'בן משפחה: {{4}}\n' +
      'שנת לידה: {{5}}\n' +
      'עיר: {{6}}\n' +
      'נא לחזור בהקדם.',
  },
  {
    name: 'b1_lead_new',
    example: ['ישראל ישראלי', '0501234567', '972501234567'],
    category: 'UTILITY',
    language: 'he',
    params: 3,
    sentBy: 'handoff.notifyNewLead — contact details captured (B1 course)',
    text:
      'פנייה חדשה - קורס רומנית.\n' +
      'שם: {{1}}\n' +
      'טלפון: {{2}}\n' +
      'מספר וואטסאפ: {{3}}\n' +
      'נא לחזור בהקדם.',
  },
  {
    name: 'pudim_meeting_request',
    example: ['ישראל ישראלי', 'יום שני 13.10 בשעה 17:00', '0501234567'],
    category: 'UTILITY',
    language: 'he',
    params: 3,
    sentBy: 'handoff.notifyMeetingRequest — a lead asked to come into the office',
    text:
      'בקשת פגישה חדשה.\n' +
      'שם: {{1}}\n' +
      'מועד מבוקש: {{2}}\n' +
      'טלפון: {{3}}\n' +
      'הפגישה ממתינה לאישור שלך.',
  },
  {
    name: 'pudim_hot_lead',
    example: ['ישראל ישראלי', '972501234567', '85'],
    category: 'UTILITY',
    language: 'he',
    params: 3,
    sentBy: 'handoff.notifyHotLead — buying intent crossed the hot threshold',
    text:
      'ליד חם בשיחה פעילה כרגע.\n' +
      'שם: {{1}}\n' +
      'מספר וואטסאפ: {{2}}\n' +
      'ציון כוונת רכישה: {{3}}\n' +
      'שיחה עכשיו ממירה הרבה יותר טוב.',
  },
  {
    name: 'pudim_handoff',
    example: ['ישראל ישראלי', '972501234567', '0501234567'],
    category: 'UTILITY',
    language: 'he',
    params: 3,
    sentBy: 'handoff.notifyHandoff — the customer asked for a human',
    text:
      'לקוח מבקש נציג אנושי.\n' +
      'שם: {{1}}\n' +
      'מספר וואטסאפ: {{2}}\n' +
      'טלפון: {{3}}\n' +
      'אנא צור קשר בהקדם.',
  },
  {
    name: 'pudim_waiting_list',
    example: ['3'],
    category: 'UTILITY',
    language: 'he',
    params: 1,
    sentBy: 'index.js cron 08:30 — leads who left a number and are still waiting',
    text:
      'יש לידים שממתינים לשיחה ממך.\n' +
      'מספר הממתינים: {{1}}\n' +
      'הרשימה המלאה מופיעה בדף הניהול.',
  },
  {
    name: 'pudim_meetings_digest',
    example: ['2', '5'],
    category: 'UTILITY',
    language: 'he',
    params: 2,
    sentBy: 'index.js cron 08:00 — the meetings on the books',
    text:
      'סיכום פגישות.\n' +
      'ממתינות לאישור: {{1}}\n' +
      'סך הפגישות: {{2}}\n' +
      'הפרטים המלאים מופיעים בדף הניהול.',
  },
  {
    name: 'pudim_chat_start',
    example: ['972501234567', '11.10.2026 10:52'],
    category: 'UTILITY',
    language: 'he',
    params: 2,
    sentBy: 'handoff.notifyChatStart — a new conversation opened',
    text:
      'שיחה חדשה החלה.\n' +
      'מספר: {{1}}\n' +
      'שעה: {{2}}\n' +
      'אם לא תגיע הודעת ליד - הלקוח לא השלים את התהליך.',
  },
  {
    name: 'pudim_daily_status_v2',
    example: ['12', '4'],
    category: 'UTILITY',
    language: 'he',
    params: 2,
    sentBy: 'index.js cron — the daily digest',
    // _v2 because Meta locked pudim_daily_status into the MARKETING category
    // and refuses to let an approved category be changed. A new name is the
    // only way out of that; the old one stays REJECTED and unused.
    text:
      'סיכום יומי.\n' +
      'שיחות פעילות: {{1}}\n' +
      'לידים שנאספו: {{2}}\n' +
      'המערכת פעילה.',
  },
  {
    name: 'pudim_bot_startup_v2',
    example: ['11.10.2026 09:00'],
    category: 'UTILITY',
    language: 'he',
    params: 1,
    sentBy: 'index.js — the bot restarted',
    // _v2 for the same reason as pudim_daily_status_v2 above.
    text:
      'הבוט פעיל ועובד.\n' +
      'שעה: {{1}}\n' +
      'התראות על שיחות חדשות ולידים יישלחו אליך.',
  },
];

const BY_NAME = new Map(TEMPLATES.map(t => [t.name, t]));

/** Names the code actually sends, in priority order (most valuable first). */
const NAMES = TEMPLATES.map(t => t.name);

/** The ones a lead is lost without. These are the ones to chase Meta about. */
const CRITICAL = [
  'passport_lead_new',
  'b1_lead_new',
  'pudim_meeting_request',
  'pudim_hot_lead',
  'pudim_handoff',
];

function get(name) {
  return BY_NAME.get(name) || null;
}

/** Does the number of parameters at the call site match the body? */
function placeholderCount(text) {
  const found = new Set((text.match(/\{\{(\d+)\}\}/g) || []).map(m => m.replace(/\D/g, '')));
  return found.size;
}

/** Self-check, run by the test suite and by sync-templates.js. */
function validate() {
  const problems = [];
  for (const t of TEMPLATES) {
    if (placeholderCount(t.text) !== t.params) {
      problems.push(`${t.name}: body has ${placeholderCount(t.text)} placeholders, call site passes ${t.params}`);
    }
    if (/^\s*\{\{/.test(t.text)) problems.push(`${t.name}: body starts with a placeholder — Meta rejects this`);
    if (/\}\}\s*$/.test(t.text)) problems.push(`${t.name}: body ends with a placeholder — Meta rejects this`);
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t.text)) problems.push(`${t.name}: body contains an emoji`);
    if (/\*/.test(t.text)) problems.push(`${t.name}: body contains an asterisk`);
    for (let i = 1; i <= t.params; i++) {
      if (!t.text.includes(`{{${i}}}`)) problems.push(`${t.name}: {{${i}}} is missing — placeholders must run 1..n`);
    }
    // No sample values means Meta rejects it with INVALID_FORMAT. Every
    // template on this account was rejected for exactly this reason.
    if (!Array.isArray(t.example)) {
      problems.push(`${t.name}: no example values — Meta will reject it with INVALID_FORMAT`);
    } else if (t.example.length !== t.params) {
      problems.push(`${t.name}: ${t.example.length} example value(s) for ${t.params} placeholder(s)`);
    } else if (t.example.some(v => !String(v || '').trim())) {
      problems.push(`${t.name}: an example value is empty`);
    }
  }
  return problems;
}

module.exports = { TEMPLATES, NAMES, CRITICAL, get, validate, placeholderCount };
