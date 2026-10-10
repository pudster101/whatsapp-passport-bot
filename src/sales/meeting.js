/**
 * meeting.js — the office meeting.
 *
 * Why this exists: a phone call is cheap for the customer to agree to and
 * cheap to drift away from. Coming to the office is not. Someone who puts an
 * evening aside, drives to Ashkenazi 21 and brings a folder of documents has
 * already decided to take the case seriously — and in that room the lawyer can
 * actually look at what exists, say what is missing, and close.
 *
 * So the meeting, not the call, is the goal of the conversation. The call
 * remains the soft landing for whoever is not ready, and a video meeting is a
 * FULL substitute for whoever cannot physically come: same length, same
 * agenda, same documents, just on a screen.
 *
 * What this module will never do: invent an address, a price, a slot outside
 * the owner's windows, or a confirmation. The bot requests; the office
 * confirms.
 */
const TZ = 'Asia/Jerusalem';

// ─── The office ───────────────────────────────────────────────────────────────

const OFFICE = {
  address: 'אשכנזי 21, תל אביב',
  area: 'צפון תל אביב — שיכון דן / רמת החייל',
  phone: '03-5517801',
};

const MAPS_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('אשכנזי 21 תל אביב')}`;
const WAZE_URL = `https://waze.com/ul?q=${encodeURIComponent('אשכנזי 21 תל אביב')}&navigate=yes`;

/** The owner's standing availability: Sunday–Thursday, 17:00 and 18:00. */
const MEETING_DAYS = [0, 1, 2, 3, 4];        // Sun–Thu, JS getDay()
const MEETING_HOURS = [17, 18];
const MEETING_MINUTES = 45;

// A slot has to be far enough out that the office can confirm it first.
const LEAD_TIME_MS = 3 * 3600000;
// How far ahead we are willing to offer.
const HORIZON_DAYS = 14;

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ─── Slots ────────────────────────────────────────────────────────────────────

/** Israel's UTC offset in minutes at a given instant (handles DST). */
function offsetMinutesAt(ms) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value;
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name || '');
    if (!m) return 180;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return 180;                                   // Israel standard time
  }
}

/** The epoch milliseconds of a wall-clock time in Israel. */
function israelWallToEpoch(y, mo, d, hour) {
  const guess = Date.UTC(y, mo - 1, d, hour, 0, 0);
  return guess - offsetMinutesAt(guess) * 60000;
}

/** Today's date as Israel sees it. */
function israelToday(now) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  const [y, mo, d] = s.split('-').map(Number);
  return { y, mo, d };
}

function slotLabel(date, hour) {
  const day = DAY_NAMES[date.getUTCDay()];
  const d = date.getUTCDate();
  const m = date.getUTCMonth() + 1;
  return `יום ${day}, ${d}.${m} בשעה ${hour}:00`;
}

/**
 * The next free slots, oldest first.
 *
 * Two options on two different evenings beat two options on the same evening:
 * "Monday or Tuesday?" is a question about the week, "17:00 or 18:00?" is a
 * question about one evening the customer may not have free at all. So by
 * default we take one slot per day and only double up once the days run out.
 *
 * @param {object} opts
 *   - count:  how many to return (default 2 — a choice, not a menu)
 *   - taken:  ISO strings already requested or confirmed by anyone
 *   - spread: one slot per day (default true)
 *   - now:    override for tests
 */
function nextSlots({ count = 2, taken = [], spread = true, now = Date.now() } = {}) {
  const busy = new Set(taken.filter(Boolean));
  const { y, mo, d } = israelToday(now);
  const free = [];

  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = new Date(Date.UTC(y, mo - 1, d + i));
    if (!MEETING_DAYS.includes(day.getUTCDay())) continue;

    for (const hour of MEETING_HOURS) {
      const at = israelWallToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour);
      if (at - now < LEAD_TIME_MS) continue;
      const iso = new Date(at).toISOString();
      if (busy.has(iso)) continue;
      free.push({ iso, at, hour, dayKey: i, label: slotLabel(day, hour) });
    }
  }

  if (!spread) return free.slice(0, count);

  const out = [];
  const usedDays = new Set();
  for (const slot of free) {
    if (out.length >= count) break;
    if (usedDays.has(slot.dayKey)) continue;
    usedDays.add(slot.dayKey);
    out.push(slot);
  }
  // Not enough distinct days in the horizon — fall back to filling evenings.
  for (const slot of free) {
    if (out.length >= count) break;
    if (!out.includes(slot)) out.push(slot);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Slots other leads have already asked for, so two people are never offered one chair. */
function takenSlots(conversations = {}) {
  const taken = [];
  for (const session of Object.values(conversations)) {
    const m = session?.profile?.meeting;
    if (!m?.slotIso) continue;
    if (m.status === 'requested' || m.status === 'confirmed') taken.push(m.slotIso);
  }
  return taken;
}

// ─── Reading the customer ─────────────────────────────────────────────────────

const AGREES = /(כן|בסדר|אשמח|מעוניין|מעוניינת|מתאים|בוא נקבע|נקבע|אפשר|בשמחה|יאללה|סבבה|מצוין|מעולה|למה לא)/;
const DECLINES_MEETING = /(לא נוח לי להגיע|לא רוצה להגיע|לא מתאים לי להגיע|אין לי זמן להגיע|עדיף(?: לי)? טלפון|רק טלפון|בטלפון עדיף|לא צריך פגישה)/;
const CANNOT_COME = /(בחו״ל|בחו"ל|בחול\b|לא בארץ|מחוץ לארץ|ברומניה|באירופה|רחוק מדי|גר רחוק|גרה רחוק|בצפון|בדרום|באילת|קשה לי להגיע|אין לי איך להגיע|לא יכול להגיע|לא יכולה להגיע|מרותק|מאושפז|זום|וידאו)/;

function signalsMeetingInterest(text) {
  const t = String(text || '');
  if (DECLINES_MEETING.test(t)) return false;
  return AGREES.test(t);
}

function signalsMeetingRefusal(text) {
  return DECLINES_MEETING.test(String(text || ''));
}

/** Physically cannot come — gets the video meeting, not a lesser offer. */
function signalsCannotCome(text) {
  return CANNOT_COME.test(String(text || ''));
}

/**
 * Which of the offered slots did they pick?
 *
 * Day names are matched first, because "ראשון" in a list that contains Sunday
 * means Sunday, not "the first one". Ordinals and bare hours come after.
 */
function parseSlotChoice(text, slots = []) {
  const t = String(text || '');
  if (!slots.length) return null;

  // The label reads "יום ראשון, 11.10 …" — the day name, without the comma.
  const dayOf = (slot) => /יום ([^\s,]+)/.exec(slot.label)?.[1] || null;

  // 1. "יום שני" is unambiguous: it is a day.
  for (const slot of slots) {
    const day = dayOf(slot);
    if (day && new RegExp(`יום\\s*${day}`).test(t)) return slot;
  }

  // 1b. They named a day we did not offer ("יום שלישי" when only Sunday and
  //     Monday are on the table). Booking the nearest hour instead would put
  //     them in a chair on the wrong evening — better to say nothing here and
  //     let the conversation carry on.
  const namedDay = /יום\s*(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/.exec(t);
  if (namedDay && !slots.some(s => dayOf(s) === namedDay[1])) return null;

  // 2. Ordinals, before bare day names — because "השני" means "the second
  //    one", not Monday, and Monday ("שני") is a substring of it.
  if (/(הראשון|הראשונה|אופציה 1|המוקדם|המוקדמת)/.test(t)) return slots[0] || null;
  if (/(השני|השנייה|השניה|אופציה 2|המאוחר|המאוחרת)/.test(t)) return slots[1] || null;

  // 3. A bare day name — but not when it carries the definite article, which
  //    would have been caught as an ordinal above.
  for (const slot of slots) {
    const day = dayOf(slot);
    if (!day) continue;
    const i = t.indexOf(day);
    if (i < 0) continue;
    if (i > 0 && t[i - 1] === 'ה') continue;
    return slot;
  }

  // 4. An hour, when the two slots sit on different hours.
  for (const slot of slots) {
    if (new RegExp(`(^|\\D)${slot.hour}(:00)?(\\D|$)`).test(t)) return slot;
  }
  return null;
}

// ─── What the bot says ────────────────────────────────────────────────────────

const WHAT_TO_BRING = [
  'תעודות לידה — שלך ושל בן המשפחה שנולד ברומניה',
  'תעודת נישואין (שלך ושל ההורים, אם יש)',
  'תעודת עולה או דרכון ישן',
  'כל מסמך רומני אחר שנמצא בבית',
];

function bringList() {
  return WHAT_TO_BRING.map(l => `• ${l}`).join('\n');
}

/** The pitch. Said once the eligibility picture is complete. */
function offerText(profile = {}, mode = 'office') {
  const name = profile.name ? `${profile.name}, ` : '';
  if (mode === 'video') {
    return `${name}הצעד הכי יעיל מכאן הוא *פגישת וידאו של ${MEETING_MINUTES} דקות עם עו״ד פודים* — ` +
           `עוברים יחד על המסמכים שיש לך, והוא אומר בדיוק מה חסר ומאיפה מאתרים אותו.\n\n` +
           `ללא עלות וללא התחייבות. *רוצה שנקבע?*`;
  }
  return `${name}הצעד הכי יעיל מכאן הוא *פגישה של ${MEETING_MINUTES} דקות במשרד עם עו״ד פודים* — ` +
         `מביאים את המסמכים שיש, עוברים עליהם יחד, והוא אומר בדיוק מה חסר, מאיפה מאתרים אותו ` +
         `וכמה זמן זה לוקח במקרה שלך.\n\n` +
         `${OFFICE.address} · ללא עלות וללא התחייבות. *רוצה שנקבע?*`;
}

/** Two concrete times. A choice beats "when suits you". */
function slotPrompt(slots = [], mode = 'office') {
  if (!slots.length) {
    return `אשמח לתאם — *מתי נוח לך בשבוע הקרוב, בין 17:00 ל-19:00?*`;
  }
  const where = mode === 'video' ? 'פגישת וידאו' : `פגישה במשרד (${OFFICE.address})`;
  const options = slots.map(s => `*${s.label}*`).join('  או  ');
  // No greeting of its own: callers that need one add it, and two in a row
  // ("מצוין… מעולה…") reads like two bots talking.
  return `יש לי ${where} ב${options} — מה מתאים לך יותר?`;
}

/** After they pick. Nothing is promised: the office confirms. */
function pendingText(profile = {}, slot, mode = 'office') {
  const head = mode === 'video'
    ? `רשמתי — *פגישת וידאו ב${slot.label}*.`
    : `רשמתי — *${slot.label}*, במשרד ב${OFFICE.address}.`;

  const link = mode === 'video'
    ? `קישור לפגישה יישלח לך לפני המועד.`
    : `📍 ${OFFICE.area}\n🗺️ ${MAPS_URL}\n🚗 ${WAZE_URL}`;

  return `${head}\n\n` +
         `אעביר לעו״ד פודים לאישור, ותקבל ממני הודעה כשזה סגור.\n\n` +
         `${link}\n\n` +
         `*מה כדאי להביא:*\n${bringList()}\n\n` +
         `_גם אם אין לך כלום ביד — בוא בכל זאת. חלק גדול מהעבודה הוא בדיוק לאתר את מה שחסר._`;
}

/** Sent when the office confirms the slot. */
function confirmedText(profile = {}, slot, mode = 'office') {
  const name = profile.name ? ` ${profile.name}` : '';
  if (mode === 'video') {
    return `✅ מאושר${name} — *פגישת וידאו ב${slot.label}*, כ-${MEETING_MINUTES} דקות עם עו״ד פודים.\n\n` +
           `קישור יישלח לך לפני הפגישה.\n\n*מה להכין:*\n${bringList()}\n\n` +
           `אם משהו משתנה — *${OFFICE.phone}*.`;
  }
  return `✅ מאושר${name} — *${slot.label}*, כ-${MEETING_MINUTES} דקות עם עו״ד פודים.\n\n` +
         `📍 ${OFFICE.address} · ${OFFICE.area}\n🗺️ ${MAPS_URL}\n🚗 ${WAZE_URL}\n\n` +
         `*מה להביא:*\n${bringList()}\n\n` +
         `אם משהו משתנה — *${OFFICE.phone}*.`;
}

/** The day before. This is what stops a no-show. */
function reminderText(profile = {}, slot, mode = 'office') {
  const name = profile.name ? ` ${profile.name}` : '';
  const when = /בשעה (\d{1,2}:00)/.exec(slot.label)?.[1] || '';
  if (mode === 'video') {
    return `תזכורת${name} 🗓️ — פגישת הווידאו שלנו *מחר ב-${when}*.\n\n` +
           `הקישור יישלח לפני. שווה להכין את המסמכים שיש בבית:\n${bringList()}`;
  }
  return `תזכורת${name} 🗓️ — נפגשים *מחר ב-${when}* במשרד.\n\n` +
         `📍 ${OFFICE.address} · ${OFFICE.area}\n🗺️ ${MAPS_URL}\n🚗 ${WAZE_URL}\n\n` +
         `*מה להביא:*\n${bringList()}\n\n` +
         `_גם אם חסר — בוא עם מה שיש._`;
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Is this lead ready to be offered a meeting?
 *
 * Stricter than leadProfile.isQualified, deliberately: an office meeting costs
 * the owner an evening, so the route has to be worth sitting down over. That
 * means we know WHO was born in Romania, WHERE, and WHEN they left — the three
 * facts that decide the route.
 */
function isReadyForMeeting(profile = {}) {
  const e = profile.eligibility || {};
  if (profile.optedOut) return false;
  if (!e.ancestor || !e.birthPlace || !e.leftYear) return false;
  const m = profile.meeting || {};
  if (m.status === 'requested' || m.status === 'confirmed') return false;
  if ((m.declines || 0) >= 1) return false;          // asked once, said no — let it go
  return true;
}

module.exports = {
  OFFICE, MAPS_URL, WAZE_URL,
  MEETING_DAYS, MEETING_HOURS, MEETING_MINUTES, WHAT_TO_BRING,
  nextSlots, takenSlots, slotLabel,
  signalsMeetingInterest, signalsMeetingRefusal, signalsCannotCome, parseSlotChoice,
  offerText, slotPrompt, pendingText, confirmedText, reminderText, bringList,
  isReadyForMeeting,
};
