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

const meeting = require('./meeting');
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
/**
 * Where real meeting slots go. flows.reply() swaps this for two concrete
 * evenings from meeting.nextSlots() — the slots have to come from the real
 * calendar (and from what other leads already asked for), which this module
 * cannot see. Anything that slips through unswapped is replaced there with a
 * plain question, so the token itself can never reach a customer.
 */
const SLOTS_TOKEN = '{{MEETING_SLOTS}}';

/**
 * The office meeting is the goal; the phone call is the fallback.
 *
 * The 15 Oct trainer run had eight leads and zero meeting offers: every close
 * was "מחר בבוקר או אחר הצהריים?" for a phone call, because the meeting
 * branch sat below the objection, question and departure branches, and leads
 * who ask about price hit those first every single turn. Routing the close
 * itself through here means every terminal turn offers the meeting whenever
 * the case is ready for one — whichever branch produced it.
 */
function meetingClose(profile = {}, variant = 'ask_phone') {
  const name = profile.name ? `${profile.name}, ` : '';
  const video = (profile.meeting || {}).mode === 'video';
  const what = video
    ? `*פגישת וידאו של ${meeting.MEETING_MINUTES} דקות עם עו״ד פודים*`
    : `*פגישה של ${meeting.MEETING_MINUTES} דקות עם עו״ד פודים במשרד*`;
  const lead = variant === 'departing'
    ? `לפני שנסיים — ${name}הדרך הכי מהירה לתשובה ברורה היא ${what}`
    : `${name}הצעד הכי יעיל מכאן הוא ${what}`;
  const alt = video
    ? `ואם נוח יותר — שיחת טלפון קצרה: *${OFFICE_PHONE}*.`
    : `לא נוח להגיע? אותה פגישה אפשרית גם בזום, או בשיחת טלפון קצרה: *${OFFICE_PHONE}*.`;
  return `${lead} — מביאים את המסמכים שיש, והוא אומר בדיוק מה המצב ומה חסר. ` +
         `ללא עלות וללא התחייבות.\n\n${SLOTS_TOKEN}\n\n${alt}`;
}

/**
 * The approved fee range, for a lead who keeps asking. Owner's wording rules
 * (16 Oct): the range, then that every case is examined on its merits and
 * depends on the file, then the meeting / consultation for the real price.
 */
function priceRangeAnswer(profile = {}) {
  const name = profile.name ? `${profile.name}, ` : '';
  return `${name}מבין שחשוב לך סדר גודל לפני שמשקיעים זמן. 🙂\n\n` +
         `טווח המחירים שלנו נע בין *8,000 ל-14,000 ₪*. ` +
         `חשוב לי להדגיש: כל מקרה נבחן לגופו, והמחיר תלוי בתיק עצמו — אילו מסמכים כבר קיימים, ` +
         `מה צריך לאתר וכמה בני משפחה נכנסים לתיק.\n\n` +
         `כדי לקבל מחיר נכון ומותאם אישית — פגישה עם עו״ד פודים או שיחת ייעוץ קצרה, ללא עלות וללא התחייבות.`;
}

function callClose(profile = {}, opts = {}) {
  const hasPhone = !!(profile.clientPhone);
  const name = profile.name ? `${profile.name}, ` : '';
  const when = timeOptions();
  const seed = opts.seed || 0;

  const variant = opts.variant
    || (hasPhone ? 'ask_time' : 'ask_phone');

  // Meeting first. A human callback (handoff), a lead on the way out who was
  // just pitched (departing_brief), or an explicit phone close stays a call.
  // Offered twice already and not taken up — stop pushing the meeting and let
  // the phone close do its job.
  if (!opts.phoneOnly && ['ask_phone', 'ask_time', 'departing'].includes(variant)
      && meeting.isReadyForMeeting(profile)
      && ((profile.meeting || {}).closeOffers || 0) < 2
      && (profile.messageCount || 0) >= 2) {
    return meetingClose(profile, variant);
  }

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
    return `מובן. 🙂 אם תרצה בהמשך — אפשר לשלוח כאן צילומי מסמכים לעו״ד פודים ולקבל תשובה בכתב, ` +
           `או להתקשר: *${OFFICE_PHONE}* · ${HOURS}.`;
  }

  // "מעביר את הפרטים" is only true when there ARE details to pass. On 1 Sep
  // the trainer's שירה was told it twice in a row before she had given a
  // number — a promise of a call that could not happen. Without a phone, the
  // handoff has to ask for one (or leave the office number), not claim it.
  if ((variant === 'handoff' || variant === 'handoff_confirmed') && !hasPhone) {
    return `אשמח שעו״ד פודים עצמו יחזור אליך — לא נציג, הוא עצמו. ` +
           `*לאיזה מספר הוא יכול להתקשר?*\n\n` +
           `לא נוח לך לדבר? אפשר לשלוח כאן צילומי מסמכים, והוא יענה לך בכתב. ` +
           `או להתקשר בעצמך: *${OFFICE_PHONE}* · ${HOURS}`;
  }

  if (variant === 'handoff') {
    return `מעביר את הפרטים לעו״ד פודים שיחזור אליך אישית — לא נציג, הוא עצמו.\n\n` +
           `*${when} — מה נוח לך יותר?*\n` +
           `ואם נוח לך להתקשר: *${OFFICE_PHONE}* · ${HOURS}`;
  }

  // The customer has ALREADY told us when. Asking again in the same breath is
  // what happened to שופט מלי on 13 Oct: she answered "מ9 עד 12", the bot
  // confirmed "רשמתי — בוקר, 9 עד 12 · להתראות בקרוב!" and then, in the very
  // same message, asked "היום לקראת סוף היום או מחר בבוקר — מה נוח לך יותר?".
  // פאני got three different time questions in three consecutive messages.
  if (variant === 'handoff_confirmed') {
    return `מעביר את הפרטים לעו״ד פודים שיחזור אליך אישית — לא נציג, הוא עצמו, ` +
           `במועד שסיכמנו.\n\n` +
           `ואם משהו משתנה: *${OFFICE_PHONE}* · ${HOURS}`;
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

/**
 * A number is not optional.
 *
 * On 14–17 Sep three leads went the whole way — אורלי רוחם, קרן שרייבר and
 * ליאורה מניס each gave a name, heard which route they were likely on, and
 * picked a time — and not one of them was ever asked for a phone number. The
 * ask was suppressed by the "we closed recently, don't nag" rule, which fired
 * exactly when the lead was warmest. An agreed time with no number is not an
 * appointment; it is a lead we cannot reach.
 *
 * So every closing line passes through here: if the file has no number and the
 * lead has not refused to give one, the line carries the request.
 */
const ASKS_FOR_PHONE = /(מספר\s+ה?טלפון|מה\s+המספר|טלפון\s+לחזרה|לאיזה\s+מספר|אפשר\s+מספר)/;

function needsPhoneAsk(profile = {}) {
  return !profile.clientPhone && !(profile.contactRefusals > 0);
}

function withPhoneAsk(text, profile = {}) {
  if (!text || !needsPhoneAsk(profile)) return text;
  if (ASKS_FOR_PHONE.test(text)) return text;
  return `${text}\n\n*ולאיזה מספר שיחזור אליך?*`;
}

/** Does this text already contain a real close? */
function hasCallClose(text) {
  if (!text) return false;
  const t = String(text);
  return (
    t.includes(SLOTS_TOKEN) ||
    /יש לי (?:פגישה|פגישת)/.test(t) ||
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
    // People answer with bare hours, and three live leads were asked the same
    // question twice because none of these matched:
    //   פרץ רוב, 4 Oct    "אחהצ בסביבות 18"
    //   שופט מלי, 13 Oct  "מ9 עד 12"  →  and the bot asked again in the same breath
    //   מרדכי כהן, 5 Oct  "שעות אחה\"צ."
    // "מ9 עד 12" / "בין 17 ל-19". Bounded to real hours and blocked before a
    // duration unit, because "איתור לוקח 2-6 חודשים" is not an appointment —
    // matching it suppressed the closing line on every objection turn.
    /(?:מ-?\s*)?\b(?:[7-9]|1\d|2[0-3])\s*עד\s*(?:[7-9]|1\d|2[0-3])\b(?!\s*(?:חודשים|חודש|שנים|שנה|שבועות|שבוע|ימים|יום|דורות))/.test(t) ||
    /בין\s*(?:[7-9]|1\d|2[0-3])\s*(?:ל-?|[-–—])\s*(?:[7-9]|1\d|2[0-3])\b(?!\s*(?:חודשים|חודש|שנים|שנה|שבועות|שבוע|ימים|יום))/.test(t) ||
    // "אחהצ בסביבות 18" — an hour with a clock preposition in front of it.
    /(?:בסביבות|בשעה|מהשעה|אחרי|לפני)\s*(?:[7-9]|1\d|2[0-3])\b(?!\s*(?:חודשים|חודש|שנים|שנה|ימים|יום|דורות))/.test(t) ||
    // "שעות אחה״צ" — but NOT a bare "בבוקר", which appears in the bot's own
    // two-window question and would make every close look already-booked.
    /ב?שעות\s+(?:ה?בוקר|ה?צהריים|ה?ערב|אחה[״"']?צ)/.test(t) ||
    /(?:מחכה|נתראה|נדבר|מדברים)\s+(?:ל?שיחה|מחר|ביום)/.test(t) ||
    /קבענו|סגרנו על|נקבע ל/.test(t) ||
    // A customer who answers "יום ראשון בבוקר" or "מחר אחר הצהריים" HAS chosen
    // a time. On 5 Sep the bot asked "מתי נוח לך?" three more times after
    // exactly that, and the lead had to repeat himself twice.
    /(?:היום|מחר|ביום\s+\S+|יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי))\s*,?\s*(?:ב?בוקר|אחר\s+הצהריים|בערב)/.test(t) ||
    // Bare answers to "בוקר או אחר הצהריים?" — including the way people
    // actually type them. "אחהצ" and "בקר" both appeared in live chats.
    /^\s*(?:ב?בוקר|בקר|אחר\s+הצהריים|אחה[״"']?צ|צהריים|בערב|ערב)\s*[.!]?\s*$/.test(t.trim()) ||
    // "במשך היום", "מתי שנוח לך", "כל שעה" — a time WAS given, loosely.
    // On 10 Sep a lead answered "במשך היום" and was asked twice more.
    /(?:במשך|במהלך)\s+היום|כל\s+היום|כל\s+שעה|מתי\s+שנוח|לא\s+משנה\s+לי/.test(t) ||
    /עדיפות\s+(?:ל?בוקר|ל?ערב|ל?צהריים)/.test(t)
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
  // A lead who will not give a number and will not take a call still has a way
  // forward: the documents. On 14 Oct מיכל asked for exactly this ("אני שולחת
  // לכם תמונות של המסמכים בווטסאפ ואתם אומרים לי מה צריך?") and was sent to
  // the office instead. Documents that arrive here are stored and the office
  // is alerted with a download link (see flows.js, document_received).
  if (attempt === 1) {
    return `לגמרי בסדר, לא אבקש שוב. 🙂\n\n` +
           `אפשר גם בלי טלפון ובלי שיחה: *שלח כאן צילום של המסמכים שיש לך* — תעודת לידה, ` +
           `תעודת עלייה, כל מסמך ישן — ועו״ד פודים יעבור עליהם ויענה לך כאן בכתב מה יש ומה חסר.\n\n` +
           `ואם תעדיף להתקשר בעצמך: *${OFFICE_PHONE}* · ${HOURS}.`;
  }
  if (attempt === 2) {
    return `אין בעיה. אם נוח לך יותר במייל — *info@pudimlaw.co.il*, ואשלח לשם את הסיכום ` +
           `ואת הכתבה על המשרד ב-TheMarker.`;
  }
  return `השליטה אצלך לגמרי. 🙂\n\n` +
         `כשתרצה — *${OFFICE_PHONE}* · ${HOURS}. תבקש את עו״ד פודים ישירות.`;
}

/**
 * The next contact ask, chosen by what the lead actually did.
 *
 * contactLadder() steps down the ask on every call, which is right after a
 * REFUSAL and wrong everywhere else. The repetition guard in flows.js used to
 * call it with attempt=2 — the email rung — whenever a question was reworded
 * twice. That is how a 100-score lead on 7 Sep (a four-person file, asked what
 * it costs) was answered and then handed an email address out of nowhere, with
 * nobody ever asking for his number. Four people, no phone, gone.
 *
 * A lead who has not refused anything is still owed the phone ask — worded
 * differently each time, never the same sentence twice.
 */
const PHONE_ASK_VARIANTS = [
  p => `כדי שעו״ד פודים יחזור אליך — *מה מספר הטלפון, ומתי נוח: ${timeOptions()}?*`,
  p => `${p.name ? `${p.name}, ` : ''}הכי מהיר לסגור את זה בשיחה קצרה. ` +
       `*תשאיר מספר ועו״ד פודים יחזור אליך*, או תתקשר ישירות: *${OFFICE_PHONE}* · ${HOURS}.`,
  p => `אני יכול להעביר את מה שסיכמנו כאן לעו״ד פודים — *לאיזה מספר שיחזור אליך?*`,
];

function nextContactAsk(profile = {}, opts = {}) {
  const refusals = profile.contactRefusals || 0;
  // Only a real refusal steps the ladder down.
  if (refusals > 0) return contactLadder(profile, refusals);
  if (profile.clientPhone) return callClose(profile, { variant: 'ask_time', seed: opts.seed || 0 });
  const i = (opts.seed || 0) % PHONE_ASK_VARIANTS.length;
  return PHONE_ASK_VARIANTS[i](profile);
}

/**
 * "Nobody called me back."
 *
 * יוסי wrote "שלום לא חזרתם אלי" on 13 Sep, seven days after leaving his
 * number. פנינה wrote "עדיין לא דיברנו" on 15 Sep and the bot answered
 * "רשום. אם משהו משתנה — 03-5517801". Both were scored 100. A customer saying
 * this is the most expensive sentence in the transcript, and it must stop the
 * sales script and reach a human the same minute.
 */
const MISSED_CALLBACK = [
  /לא\s+חזר(?:תם|ו|ת)\s*(?:אליי?|אלינו)?/,
  /אף\s+אחד\s+לא\s+(?:התקשר|חזר|ענה|יצר\s+קשר)/,
  /עדיין\s+לא\s+(?:חזרו|חזרתם|דיברנו|התקשרתם|שוחחנו)/,
  /מחכה\s+(?:כבר\s+)?(?:לשיחה|שיחזרו|שיתקשרו)/,
  /לא\s+(?:התקשרתם|התקשרו)\s*(?:אליי?)?/,
];

function signalsMissedCallback(text) {
  const t = String(text || '');
  return MISSED_CALLBACK.some(re => re.test(t));
}

/**
 * "We already spoke." Not a complaint — an instruction to stop.
 *
 * 0526604546 had a call booked for 16:30 when a follow-up asked him again for
 * his name and number. He answered "היי. שוחחנו אתמול. הכול בסדר. תודה", the
 * bot kept coordinating, and he ended with
 * "למה שיתקשר אלי היום אחרי 16:30 אם אתמול שוחחנו?!?!?!?!".
 */
const ALREADY_SPOKE = [
  /(?:כבר\s+)?(?:שוחחנו|דיברנו|דיברתי\s+איתו|התקשרו\s+אליי?)\s*(?:אתמול|היום|קודם|בבוקר|כבר)?/,
  /אין\s+צורך\s+ש?(?:יתקשר|תתקשרו|יחזור)/,
  /כבר\s+טופלתי/,
];

function signalsAlreadySpoke(text) {
  const t = String(text || '');
  if (signalsMissedCallback(t)) return false;     // "עדיין לא דיברנו" is the opposite
  // "כל עורך דין אחר שדיברתי איתו" (דנה, 16 Oct) is about OTHER firms — she
  // was told "רשמתי שכבר דיברתם" and the conversation went sideways.
  if (/(?:אחר|אחרים|אחרת|אחרות|במשרד|משרדים|עורכי\s+דין)[^.?!\n]{0,25}(?:שדיברתי|דיברתי|שוחחתי)|(?:שדיברתי|דיברתי|שוחחתי)[^.?!\n]{0,25}(?:אחר|אחרים|משרד|עורך\s+דין|עורכי\s+דין)/.test(t)) return false;
  return ALREADY_SPOKE.some(re => re.test(t));
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
  priceRangeAnswer,
  SLOTS_TOKEN,
  meetingClose,
  OFFICE_PHONE,
  HOURS,
  callClose,
  hasCallClose,
  alreadyScheduled,
  ensureCallClose,
  stripTrailingAsk,
  signalsEnding,
  contactLadder,
  nextContactAsk,
  needsPhoneAsk,
  withPhoneAsk,
  signalsMissedCallback,
  signalsAlreadySpoke,
  signalsNoPush,
  signalsContactRefusal,
  softNudge,
  timeOptions,
};
