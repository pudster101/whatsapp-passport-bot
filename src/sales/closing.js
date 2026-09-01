/**
 * closing.js — the one thing every conversation must end with.
 *
 * The trainer scored call-to-action 3.8/10 across every persona, and the
 * evaluator said the same thing each time: "עו״ד יחזור אליך בהקדם" is not a
 * close, it is a slogan. A lead who is told "בהקדם" hears "sometime, maybe".
 *
 * A real close does three things:
 *   1. names the person who will call — עו״ד פודים himself, not "נציג"
 *   2. proposes a concrete time, so the lead answers a question instead of
 *      drifting away
 *   3. leaves the lead a way to take control — the office number
 *
 * Every terminal turn in the conversation runs through ensureCallClose().
 */

const OFFICE_PHONE = '03-5517801';
const HOURS = 'א׳–ה׳ 09:00–18:00';

/** Two concrete windows beat "when is convenient" — a lead picks, not invents. */
function timeOptions() {
  const now = new Date();
  // Read the hour and weekday in Israel time, not in the server's timezone —
  // Railway runs on UTC and would otherwise offer "מחר בבוקר" at 2am.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 12);
  const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = DAYS[parts.find(p => p.type === 'weekday')?.value] ?? 1;

  // Thursday afternoon → next window is Sunday. Friday/Saturday → Sunday.
  if (day === 5 || day === 6 || (day === 4 && hour >= 16)) {
    return 'ביום ראשון — בבוקר או אחר הצהריים';
  }
  if (hour < 12) return 'היום אחר הצהריים או מחר בבוקר';
  if (hour < 17) return 'היום לקראת סוף היום או מחר בבוקר';
  return 'מחר בבוקר או מחר אחר הצהריים';
}

/**
 * The closing line itself.
 *
 * @param {object} profile
 * @param {object} opts
 *   - variant: 'ask_time' | 'ask_phone' | 'departing' | 'handoff'
 *   - seed:    number — rotates phrasing so a long conversation doesn't repeat
 */
function callClose(profile = {}, opts = {}) {
  const hasPhone = !!(profile.clientPhone);
  const name = profile.name ? `${profile.name}, ` : '';
  const when = timeOptions();
  const seed = opts.seed || 0;

  const variant = opts.variant
    || (hasPhone ? 'ask_time' : 'ask_phone');

  if (variant === 'departing') {
    // The lead is walking away. Do not chase — but do not end on "מה שנוח לך".
    const lines = [
      `לפני שנסיים — ${name}שיחה קצרה עם עו״ד פודים עצמו תיתן תשובה ברורה על ` +
      `הזכאות, בלי עלות ובלי התחייבות. *${when} — מה מתאים יותר?*\n\n` +
      `ואם נוח יותר להתקשר: *${OFFICE_PHONE}* · ${HOURS}`,

      `מכבד לגמרי. 🙂 רק שיהיה ברור שהדלת פתוחה — עו״ד פודים עצמו עושה שיחת בירור ` +
      `קצרה, בלי עלות ובלי התחייבות. *נקבע ${when}?*\n\n` +
      `או פשוט טלפון מתי שנוח: *${OFFICE_PHONE}* · ${HOURS}`,
    ];
    return lines[seed % lines.length];
  }

  // We pitched a turn or two ago and the lead is now leaving. Repeating the
  // full pitch reads as not listening; leave the door open in one line.
  if (variant === 'departing_brief') {
    return `מובן. 🙂 המספר כאן אם תרצה: *${OFFICE_PHONE}* · ${HOURS} — תבקש את עו״ד פודים.`;
  }

  if (variant === 'handoff') {
    return `מעביר את הפרטים לעו״ד פודים שיחזור אליך אישית — לא נציג, הוא עצמו.\n\n` +
           `*${when} — מה נוח לך יותר?*\n` +
           `ואם נוח לך להתקשר: *${OFFICE_PHONE}* · ${HOURS}`;
  }

  if (variant === 'ask_phone') {
    const lines = [
      `אני מציע שנקבע שיחה קצרה עם עו״ד פודים עצמו — הוא יעבור על המקרה ויגיד ` +
      `בדיוק מה המצב. *מה מספר הטלפון, ומתי נוח — ${when}?*`,

      `הדבר הכי יעיל עכשיו זה שיחה קצרה עם עו״ד פודים. *אפשר מספר טלפון, ` +
      `ומתי נוח — ${when}?*`,
    ];
    return lines[seed % lines.length];
  }

  // ask_time — we already have a phone, so the only open question is when
  const lines = [
    `*מתי נוח שעו״ד פודים יתקשר — ${when}?*`,
    `נשאר רק לתאם: *${when} — מה עדיף?*`,
  ];
  return lines[seed % lines.length];
}

/** Does this text already contain a real close? */
function hasCallClose(text) {
  if (!text) return false;
  const t = String(text);
  return (
    t.includes(OFFICE_PHONE) ||
    /מתי נוח/.test(t) ||
    /מה נוח לך יותר/.test(t) ||
    /מה מתאים לך יותר/.test(t) ||
    (/מה עדיף לך\?/.test(t) && /יתקשר|שיחה/.test(t)) ||
    // A time has already been AGREED. Trainer run 4: the AI wrote
    // "מחר 09:30, מחכה לשיחה" and we appended "מתי נוח לך?" underneath it —
    // the lead replied "כבר קבעת לי מחר 9:30, עכשיו אתה שואל שוב?".
    alreadyScheduled(t)
  );
}

/** Does the text already commit to a specific time? */
function alreadyScheduled(text) {
  // Strip opening-hours ranges first — "09:00–18:00" is not an appointment,
  // and matching it made every reply containing the office hours look booked.
  const t = String(text || '').replace(/\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}/g, '');
  return (
    /\b\d{1,2}[:.]\d{2}\b/.test(t) ||          // a single clock time: 09:30
    /(?:מחכה|נתראה|נדבר|מדברים)\s+(?:ל?שיחה|מחר|ביום)/.test(t) ||
    /קבענו|סגרנו על|נקבע ל/.test(t)
  );
}

/**
 * A reply may already end with a soft ask — "רוצה שנעשה בדיקת זכאות?".
 * Appending a second question on top produces a two-question message, which
 * is exactly what the voice rules forbid and what makes a bot feel pushy.
 * So we drop the weak trailing ask and let the real close take its place.
 */
function stripTrailingAsk(body) {
  const paras = body.split(/\n{2,}/);
  if (paras.length < 2) return body;
  const last = paras[paras.length - 1].trim();
  // The ask is not always the final character — "*רוצה ש...?* ככה תדע על מה
  // אתה מחליט." is still a trailing ask. Look for a question mark anywhere
  // in a short final paragraph.
  const isShortAsk = last.includes('?') && last.length < 200;
  if (!isShortAsk) return body;
  return paras.slice(0, -1).join('\n\n').trim();
}

/**
 * Guarantee a terminal turn ends with a referral to a call.
 * Leaves the text untouched if it already closes properly.
 */
function ensureCallClose(text, profile = {}, opts = {}) {
  const body = (text || '').trim();
  if (!body) return callClose(profile, opts);
  if (hasCallClose(body)) return body;
  return `${stripTrailingAsk(body)}\n\n${callClose(profile, opts)}`;
}

/**
 * The lead has told us to stop selling. Trainer run 3 caught the bot closing on
 * 73% of all turns — including right after "תסביר לי בלי לשכנע אותי לשיחה".
 * That is not persistence, it is not listening.
 */
const NO_PUSH = [
  'בלי לשכנע', 'אל תשכנע', 'לא רוצה שיחה', 'בלי למכור', 'אל תמכור',
  'רק רוצה להבין', 'אני רק שואל', 'אני רק רוצה לדעת', 'בלי לחץ',
  'לא רוצה לתאם', 'לפני שאני מחליט', 'תפסיק לדחוף', 'די עם השיחה',
];
/** The lead has just refused to leave a phone number. */
const REFUSAL = [
  'לא רוצה להשאיר', 'לא נוח לי להשאיר', 'בלי טלפון', 'לא אתן טלפון',
  'לא אשאיר טלפון', 'לא רוצה לתת טלפון', 'מעדיף לא להשאיר',
  'מעדיפה לא להשאיר', 'לא נותן טלפון', 'לא נותנת טלפון',
];
function signalsContactRefusal(text) {
  if (!text) return false;
  const t = String(text).replace(/[״"׳'.,!?]/g, '');
  return REFUSAL.some(p => t.includes(p));
}

function signalsNoPush(text) {
  if (!text) return false;
  const t = String(text).replace(/[״"׳'.,!?]/g, '');
  return NO_PUSH.some(p => t.includes(p));
}

/**
 * When a close would be pushy but the reply still has no way forward, this is
 * what goes at the end instead: one short question, no pitch, no phone number.
 */
function softNudge(profile = {}, seed = 0) {
  const lines = [
    'יש עוד משהו שתרצה שאבהיר?',
    'רוצה שאפרט על שלב מסוים?',
    'מה עוד חשוב לך לדעת בשלב הזה?',
  ];
  return lines[seed % lines.length];
}

/** Phrases that mean "this conversation is ending" — Hebrew-prefix tolerant. */
const ENDING_PHRASES = [
  'תודה רבה', 'תודה על העזרה', 'אחשוב על זה', 'אני אחשוב', 'נחשוב על זה',
  'אחזור אליכם', 'אחזור אליך', 'ניצור קשר', 'נהיה בקשר', 'עוד נדבר',
  'נדבר בהמשך', 'אתקשר בעצמי', 'אתקשר אליכם', 'אני אתקשר',
  'ביי', 'להתראות', 'שיהיה יום טוב', 'לילה טוב',
  'לא מעוניין', 'לא רלוונטי', 'תודה בכל זאת',
  'אני צריך לחשוב', 'צריכה לחשוב', 'נחליט ונחזור',
];
//
// כאן היו קודם גם ביטויי התחמקות — "תשלחו לי", "יש לי עוד משרדים", "אבדוק עוד".
// הם הפכו כל היסוס לאירוע סגירה, והבוט התחיל לדחוף לשיחה גם באמצע בירור לגיטימי.
// לקוח שמשווה מחירים לא עוזב; הוא בודק. את זה מטפלים בתשובה טובה, לא בסגירה.

/**
 * The contact ladder. A lead who says no to a phone number has not said no to
 * everything — the trainer flagged this eight times: "לא איסף שם או דוא״ל
 * כשהליד סירב לטלפון". Each refusal steps down to a smaller ask, and the last
 * rung always hands back control with the office number.
 */
function contactLadder(profile = {}, attempt = 0) {
  const when = timeOptions();
  if (attempt <= 0) {
    return `כדי שעו״ד פודים יחזור אליך — *מה מספר הטלפון, ומתי נוח: ${when}?*`;
  }
  if (attempt === 1) {
    return `לגמרי בסדר, לא אבקש שוב. 🙂\n\n` +
           `אז בוא נעשה את זה הפוך — *רק שם פרטי*, ואשלח לך סיכום קצר של מה שבדקנו כאן ` +
           `כדי שיהיה לך במה להשוות.`;
  }
  if (attempt === 2) {
    return `אין בעיה. אם נוח לך יותר במייל — *info@pudimlaw.co.il*, ואשלח לשם את הסיכום ` +
           `ואת הכתבה על המשרד ב-TheMarker.`;
  }
  return `השליטה אצלך לגמרי. 🙂\n\n` +
         `כשתרצה — *${OFFICE_PHONE}* · ${HOURS}. תבקש את עו״ד פודים ישירות.`;
}

/** Only unambiguous goodbyes. Comparing firms is not leaving. */
const ENDING_PATTERNS = [
  /^\s*(תודה|ביי|להתראות)\s*[!.]?\s*$/,
];

function signalsEnding(text) {
  if (!text) return false;
  const t = String(text).replace(/[״"׳'.,!?]/g, '').toLowerCase();
  if (ENDING_PHRASES.some(p => t.includes(p))) return true;
  return ENDING_PATTERNS.some(re => re.test(t));
}

module.exports = {
  OFFICE_PHONE,
  HOURS,
  callClose,
  hasCallClose,
  alreadyScheduled,
  ensureCallClose,
  stripTrailingAsk,
  signalsEnding,
  contactLadder,
  signalsNoPush,
  signalsContactRefusal,
  softNudge,
  timeOptions,
};
