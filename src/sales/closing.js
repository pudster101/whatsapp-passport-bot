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
 * The lead's number is already known — it is the WhatsApp number they are
 * writing from.
 *
 * Two weeks of live conversations (15–29 Oct): 14 of 35 leads answered every
 * question, never "left details", and were never called. Every one of them had
 * written from a mobile number we were holding. Meanwhile leads who DID want a
 * call were asked "מה מספר הטלפון שלך?" — עדינה answered "אם היית מתאמץ קצת
 * היית רואה שזה הנייד", and a lead who wrote "אפשר להתקשר אליי עכשיו" was
 * asked for her number and never heard from again.
 *
 * So the ask is no longer "type your number" but "may he call you on this
 * one?" — one tap (it goes out with buttons), and a yes is a lead.
 */
function localPhone(wa) {
  const d = String(wa || '').replace(/\D/g, '');
  if (!d) return '';
  const local = d.startsWith('972') ? `0${d.slice(3)}` : d;
  return /^05\d{8}$/.test(local) ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}` : local;
}

const CONSENT_RE = /(?:יתקשר|יחזור\s+אליך|יחזור)\s+למספר\s+(?:הזה|שממנו\s+כתבת)|call\s+you\s+on\s+this\s+number/i;

function consentAsk(profile = {}) {
  const num = localPhone(profile.waPhone);
  if (profile.lang === 'en') {
    return `*May Attorney Pudim call you on this number${num ? ` (${num})` : ''}?* ` +
           `A short call, free and with no obligation. If another number is better, just write it here.`;
  }
  // Gender-neutral on purpose: it goes out before we know who we are talking to.
  return `*אפשר שעו״ד פודים יתקשר למספר הזה${num ? ` (${num})` : ''}?* ` +
         `שיחה קצרה, ללא עלות וללא התחייבות. אם נוח יותר מספר אחר — אפשר לכתוב אותו כאן.`;
}

/** Is this message a yes to the consent ask? */
const CONSENT_YES = /^(?:כן|כן\s*כן|בטח|בטוח|ודאי|בוודאי|אפשר|אפשרי|בסדר|אוקיי?|אוקי|ok|okay|yes|yep|sure|please|סבבה|יאללה|אשמח|בשמחה|מעולה|מצוין|מצויין|כמובן|תתקשר|תתקשרו|שיתקשר|שיחזור|נכון|כן\s+בבקשה|כן,.*|כן\s+.*|👍|🙏|👌)(?:[\s.!,]*(?:תודה|רבה|thanks|thank\s+you|🙂|😊|👍|🙏))*[\s.!,🙂😊👍🙏]*$/i;
function isConsentYes(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60 || /\?/.test(t)) return false;
  if (/(?:^|\s)לא(?=$|[\s,.!])/.test(t) && !/^כן/.test(t)) return false;
  return CONSENT_YES.test(t);
}

/**
 * "אפשר להתקשר אליי עכשיו" / "תחזרו אליי" — the lead asked for the call
 * outright. That IS the consent; asking for a number after it loses the lead.
 */
const ASKS_FOR_CALL = /(?:[לח]?התקשר|ל?צלצל|לחזור|תתקשרו|תתקשר|תתקשרי|תצלצלו|תחזרו|תחזור|שיתקשר|שיחזור|שיצלצל)\s+(?:אליי|אלי|לי)(?=$|[\s,.!])|call\s+me|give\s+me\s+a\s+call|(?:get|have)\s+a\s+(?:phone\s+)?call\s+from\s+you/i;
function asksForCall(text) {
  const t = String(text || '');
  if (/\?\s*$/.test(t) && /(?:האם|מתי|למה)\b/.test(t)) return false;   // "מתי יתקשר אליי?" is a question
  if (/לא\s+(?:צריך|רוצה)\s+ש/.test(t)) return false;
  return ASKS_FOR_CALL.test(t);
}

/**
 * "אבדוק ואחזור", "אחפש מסמכים", "אשאל את הדוד", "נמשיך מחר".
 *
 * The single most common way a lead disappeared in Oct: nine conversations
 * ended on a promise to go and look something up. The bot had just asked
 * four questions about years and towns, the lead concluded he needs homework
 * before anyone will talk to him, and the bot agreed ("קח את הזמן") and sent
 * him off with a shopping list. None of them came back.
 */
const HOMEWORK_RE = /(?:^|\s)(?:אני\s+)?(?:א?בדוק|אברר|אחפש|נחפש|אאסוף|ארכז|אאתר|אשאל|נשאל|לשאול|אברר\s+עם|אעדכן|נעדכן|אבדוק\s+ואחזור|אחזור\s+(?:אליכם|אלייך|אליך|עם)|נחזור\s+(?:אליכם|אלייך|אליך)|אצור\s+קשר|אפנה\s+(?:אליכם\s+)?בהמשך|אתאם\s+בהמשך|נמשיך\s+מחר|נדבר\s+מחר|צריך\s+לבדוק|צריכה\s+לבדוק|צריך\s+לחפש|צריכה\s+לחפש|צריך\s+לברר|צריכה\s+לברר|אני\s+אבדוק|רגע\s+אשאל)(?=$|[\s,.!])|i(?:'|’)ll\s+(?:check|look|find\s+out|ask|get\s+back)|will\s+(?:check|try\s+to\s+send|get\s+back)|let\s+me\s+check/i;
function signalsHomework(text) {
  const t = String(text || '');
  if (t.length > 300) return false;
  return HOMEWORK_RE.test(t);
}

function homeworkReply(profile = {}) {
  if (profile.lang === 'en') {
    return `Of course. Just so you know — you don't need any documents or exact years to talk to ` +
           `Attorney Pudim. Finding them is part of his work, and much of it can be traced without you ` +
           `searching at home.\n\n${consentAsk(profile)}`;
  }
  return `בטח. וחשוב לדעת — *לא צריך מסמכים או שנים מדויקות כדי לדבר עם עו״ד פודים.* ` +
         `לאתר אותם זה חלק מהעבודה שלו, והרבה מהמידע אפשר להשיג בלי לחפש בבית.\n\n${consentAsk(profile)}`;
}

/** "מבקש לפרוש", "לא מעוניין יותר" — a lead who asked to stop is not chased. */
const WITHDRAW_RE = /מבקש(?:ת)?\s+לפרוש|(?:אני\s+)?פורש(?:ת)?\b|לא\s+מעוניינ(?:ת|ים)?\s+(?:יותר|כרגע|בזה|בשירות)|תוריד(?:ו)?\s+אותי|תפסיק(?:ו)?\s+לכתוב|לא\s+רלוונטי\s+(?:לי|עבורי)|not\s+interested|please\s+stop/i;
function signalsWithdrawal(text) { return WITHDRAW_RE.test(String(text || '')); }

function withdrawalReply(profile = {}) {
  if (profile.lang === 'en') {
    return `Of course, thank you for getting in touch. If you'd like to pick this up again — ` +
           `just write here, or call the office: *${OFFICE_PHONE}* (Sun–Thu 09:00–18:00).`;
  }
  return `בסדר גמור, תודה שפנית. 🙏 אם זה יהיה רלוונטי בעתיד — אפשר פשוט לכתוב כאן, ` +
         `או להתקשר למשרד: *${OFFICE_PHONE}* · ${HOURS}.`;
}

/** A message that only acknowledges: "תודה", "👍", "מצוין", "לילה טוב". */
const PURE_ACK = /^(?:תודה(?:\s+רבה)?|תודה\s+לך|מצוין|מצויין|מעולה|אחלה|סבבה|בסדר|אוקיי?|אוקי|ok|okay|thanks?(?:\s+you)?|thx|great|perfect|נהדר|יופי|כן\s+תודה|לילה\s+טוב|ערב\s+טוב|יום\s+טוב|בוקר\s+טוב|שבוע\s+טוב|להתראות|ביי|נדבר|קיבלתי|הבנתי|ברור|👍|🙏|👌|🙂|😊|❤️|\[sticker\]|\[reaction\])(?:[\s.!,]*(?:תודה|רבה|לך|לכם|👍|🙏|🙂|😊|👌))*[\s.!,🙂😊👍🙏👌❤️]*$/i;
function isPureAck(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\s‍️.!]+$/u.test(t)) return true;
  return t.length <= 30 && PURE_ACK.test(t);
}


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
         `טווח המחירים שלנו נע בין *8,000 ל-14,000 ₪ לאדם*, והוא כולל את תרגומי המסמכים, הכנת תיק הבקשה והגשתו לרשויות הרלוונטיות. ` +
         `חשוב לי להדגיש: כל מקרה נבחן לגופו, והמחיר תלוי בתיק עצמו — למשל אילו מסמכים כבר קיימים ומה צריך לאתר.\n\n` +
         `כדי לקבל מחיר נכון ומותאם אישית — פגישה עם עו״ד פודים או שיחת ייעוץ קצרה, ללא עלות וללא התחייבות.`;
}

/** After the range was given: remind, don't retreat to "אי אפשר לתת מספר". */
function priceRangeReminder(profile = {}) {
  return `כמו שכתבתי — הטווח הכללי הוא *8,000 ל-14,000 ₪ לאדם* (כולל תרגומים, הכנת התיק והגשתו), וכל מקרה נבחן לגופו. ` +
         `לצמצם אותו או לומר איפה בתוכו המקרה שלך אני לא יכול — זה תלוי במסמכים עצמם, ` +
         `ואת המחיר המדויק נותן עו״ד פודים אחרי שהוא רואה אותם, בפגישה או בשיחת ייעוץ קצרה, ללא עלות.`;
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
      && ((profile.messageCount || 0) - ((profile.meeting || {}).lastOfferTurn ?? -99)) >= 3
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
    return `אשמח שעו״ד פודים עצמו יחזור אליך — לא נציג, הוא עצמו.\n\n${consentAsk(profile)}\n\n` +
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
      `אני מציע שיחה קצרה עם עו״ד פודים עצמו — הוא יעבור על המקרה ויגיד בדיוק מה המצב.\n\n${consentAsk(profile)}`,
      `הדבר הכי יעיל עכשיו זה שיחה קצרה עם עו״ד פודים.\n\n${consentAsk(profile)}`,
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
const ASKS_FOR_PHONE = /(מספר\s+ה?טלפון|מה\s+המספר|טלפון\s+לחזרה|לאיזה\s+מספר|אפשר\s+מספר|phone\s+number|best\s+number|number\s+to\s+reach)/i;

function needsPhoneAsk(profile = {}) {
  return !profile.clientPhone && !(profile.contactRefusals > 0);
}

function withPhoneAsk(text, profile = {}) {
  if (!text || !needsPhoneAsk(profile)) return text;
  if (ASKS_FOR_PHONE.test(text)) return text;
  if (CONSENT_RE.test(text)) return text;
  return `${text}\n\n${consentAsk(profile)}`;
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
// What leads actually wrote in the trainer (Oct): "אני לא נותן מספר טלפון",
// "לא נותנת טלפון לפני שיש לי תשובות", "אני לא ממלא פרטים", "לא צריך שהוא
// יתקשר", "אין לי זמן לשיחות". The fixed phrase list caught none of them, and
// contactRefusals was never counted — so דנה was asked for her number 5 times.
const REFUSAL_RE = /לא\s+(?:נותן|נותנת|אתן|אמסור|מוסר|מוסרת|ממלא|ממלאה|משאיר|משאירה|רוצה\s+(?:לתת|להשאיר|למסור))\s+(?:לך\s+)?(?:את\s+)?(?:ה)?(?:מספר|טלפון|פרטים|נייד)|(?:בלי|לפני)\s+(?:לתת|שאתן|שאני\s+נותן|שאני\s+נותנת)\s+(?:מספר|טלפון|פרטים)|לא\s+צריך\s+(?:שהוא|שתתקשרו|שיתקשר)|אין\s+לי\s+זמן\s+ל(?:שיחות|שיחה|פגישות)|לא\s+(?:רוצה|מעוניין|מעוניינת)\s+(?:ב)?(?:שיחה|שיחות|פגישה)|אני\s+אתקשר\s+(?:אם|כש)/;
function signalsContactRefusal(text) {
  if (!text) return false;
  const t = String(text).replace(/[״"׳'.,!?]/g, '');
  return REFUSAL.some(p => t.includes(p)) || REFUSAL_RE.test(t);
}

/** Remove sentences asking for a phone number — for leads who refused. */
function asksForPhone(text) {
  const t = String(text || '');
  return ASKS_FOR_PHONE.test(t) || /(?:תשאיר|תשאירי|השאר|השאירי)\s+(?:לי\s+)?(?:מספר|פרטים)|לאיזה\s+מספר|מה\s+(?:ה)?מספר\s+שלך/.test(t);
}

function stripPhoneAsks(text) {
  const pre = String(text || '').split('\n').filter(l => !CONSENT_RE.test(l)).join('\n');
  const parts = pre.split(/(?<=[.!?])\s+|\n+/);
  const kept = parts.filter(s => !(ASKS_FOR_PHONE.test(s) || /(?:תשאיר|תשאירי|השאר|השאירי)\s+(?:לי\s+)?(?:מספר|פרטים)|לאיזה\s+מספר|מה\s+(?:ה)?מספר\s+שלך/.test(s)));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
    return consentAsk(profile);
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
  p => consentAsk(p),
  p => `${p.name ? `${p.name}, ` : ''}הכי מהיר לסגור את זה בשיחה קצרה. ${consentAsk(p)}`,
  p => `אני יכול להעביר את מה שסיכמנו כאן לעו״ד פודים. ${consentAsk(p)}`,
];

function nextContactAsk(profile = {}, opts = {}) {
  const refusals = profile.contactRefusals || 0;
  // Only a real refusal steps the ladder down.
  if (refusals > 0) return contactLadder(profile, refusals);
  if (profile.clientPhone) return callClose(profile, { variant: 'ask_time', seed: opts.seed || 0 });
  if (profile.lang === 'en') return consentAsk(profile);
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
  // 27 Oct, צביה: "הוא לא צלצל כנקבע" — answered "רשום. אם משהו משתנה".
  /(?:לא|טרם)\s+(?:צלצל|צילצל|התקשר|חזר|דיבר)(?:ו)?\s*(?:אליי?|איתי)?\s*(?:כנקבע|כמו\s+שקבענו|כפי\s+שסוכם|כפי\s+שנקבע|עד\s+עכשיו|היום)?/,
  /(?:didn(?:'|’)t|did\s+not|never)\s+call/i,
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
  localPhone,
  consentAsk,
  CONSENT_RE,
  isConsentYes,
  asksForCall,
  signalsHomework,
  homeworkReply,
  signalsWithdrawal,
  withdrawalReply,
  isPureAck,
  asksForPhone,
  priceRangeAnswer,
  priceRangeReminder,
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
  stripPhoneAsks,
  softNudge,
  timeOptions,
};
