/**
 * scoring.js — buying-intent score, 0–100.
 *
 * Two inputs are combined:
 *   • deterministic Hebrew signal matching (works with no AI, morphology-aware)
 *   • the AI's own read of intent, when available
 *
 * The score is internal. It is never shown to the customer.
 */

const BANDS = [
  { max: 20,  key: 'cold',      label: 'קר' },
  { max: 40,  key: 'low',       label: 'עניין נמוך' },
  { max: 60,  key: 'interested',label: 'מתעניין' },
  { max: 80,  key: 'qualified', label: 'ליד מוסמך' },
  { max: 100, key: 'hot',       label: 'ליד חם' },
];

/**
 * Hebrew-morphology-aware matching.
 * Hebrew glues prefixes (ה ו ב ל מ ש כ) onto words, so the old
 * word-boundary regex missed "העלות" while matching "עלות". We allow an
 * optional prefix cluster before the keyword instead.
 */
function hasPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Optional Hebrew prefix letters, then the phrase, then a non-letter boundary
  const re = new RegExp(`(^|[\\s,.:;!?"'״׳()\\-])[הובלמשכ]{0,2}${escaped}`, 'i');
  return re.test(text);
}

const SIGNALS = [
  // ─── Strong buying signals ───────────────────────────────────────────────
  { key: 'ask_meeting',   points: 25, phrases: ['לקבוע פגישה', 'מתי אפשר להיפגש', 'פגישה', 'שיחת ייעוץ', 'תור', 'להיפגש'] },
  { key: 'ask_start',     points: 20, phrases: ['איך מתחילים', 'רוצה להתחיל', 'להתחיל בתהליך', 'מתחילים', 'איך נרשמים', 'להירשם'] },
  { key: 'gave_phone',    points: 20, phrases: [] }, // set programmatically
  { key: 'ask_price',     points: 15, phrases: ['כמה עולה', 'מחיר', 'עלות', 'עלויות', 'תשלום', 'שכר טרחה', 'כמה זה'] },
  { key: 'urgency',       points: 15, phrases: ['דחוף', 'בהקדם', 'מהר', 'דדליין', 'תאריך אחרון', 'נגמר הזמן', 'עד מתי'] },
  { key: 'full_details',  points: 15, phrases: [] }, // set programmatically

  // ─── Moderate interest ───────────────────────────────────────────────────
  { key: 'ask_documents', points: 10, phrases: ['יש לי תעודה', 'יש לי מסמך', 'יש לי תעודת לידה', 'המסמכים שלי', 'מה צריך להביא'] },
  { key: 'ask_children',  points: 10, phrases: ['הילדים שלי', 'לילדים שלי', 'הבן שלי', 'הבת שלי', 'לנכדים'] },
  { key: 'ask_time',      points: 8,  phrases: ['כמה זמן', 'כמה זה לוקח', 'לוח זמנים', 'מתי אקבל'] },
  { key: 'ask_process',   points: 5,  phrases: ['איך התהליך', 'מה השלבים', 'התהליך'] },
  { key: 'ask_b1',        points: 8,  phrases: ['b1', 'בי1', 'תעודת שפה', 'מבחן שפה', 'קורס רומנית'] },

  // ─── Comparison / objection (also flagged as objections) ─────────────────
  { key: 'comparing',     points: 10, phrases: ['מצאתי', 'משרד אחר', 'יותר זול', 'הצעה אחרת', 'משווה'] },

  // ─── Negative signals ────────────────────────────────────────────────────
  { key: 'thinking',      points: -10, phrases: ['אחשוב', 'לחשוב על זה', 'נחשוב', 'אחזור אליכם', 'בהמשך', 'לא עכשיו'] },
  { key: 'just_info',     points: -5,  phrases: ['רק מידע', 'רק בודק', 'סתם שאלה', 'רק רציתי לדעת'] },
];

const PHONE_RE = /(?:\+?972|0)5\d[\s-]?\d{3}[\s-]?\d{4}/;

/**
 * @param {string} text          customer message
 * @param {object} profile       current lead profile
 * @param {object} [aiSignals]   optional AI output { buyingIntent, signals: [] }
 * @returns {{score:number, band:string, matched:string[], delta:number}}
 */
function score(text = '', profile = {}, aiSignals = null) {
  const lower = String(text).toLowerCase();
  const matched = [];
  let delta = 0;

  for (const sig of SIGNALS) {
    if (!sig.phrases.length) continue;
    if (sig.phrases.some(p => hasPhrase(lower, p.toLowerCase()))) {
      matched.push(sig.key);
      delta += sig.points;
    }
  }

  // Programmatic signals
  if (PHONE_RE.test(text)) {
    matched.push('gave_phone');
    delta += 20;
  }
  const e = profile.eligibility || {};
  if (e.ancestor && e.birthYear && e.birthPlace) {
    matched.push('full_details');
    delta += 15;
  }

  let base = typeof profile.buyingIntent === 'number' ? profile.buyingIntent : 0;

  // Time decay — interest cools while a lead is silent
  if (profile.lastInboundAt) {
    const idleDays = (Date.now() - new Date(profile.lastInboundAt).getTime()) / 86400000;
    if (idleDays > 2) base = Math.max(0, base - Math.floor(idleDays - 2) * 5);
  }

  let next = base + delta;

  // Blend the AI's independent read, when we have one
  if (aiSignals && typeof aiSignals.buyingIntent === 'number') {
    next = Math.round(next * 0.6 + aiSignals.buyingIntent * 0.4);
  }

  next = Math.max(0, Math.min(100, next));
  return { score: next, band: bandOf(next), matched, delta };
}

function bandOf(n) {
  return (BANDS.find(b => n <= b.max) || BANDS[BANDS.length - 1]).key;
}

function bandLabel(n) {
  return (BANDS.find(b => n <= b.max) || BANDS[BANDS.length - 1]).label;
}

function isHot(n, threshold = 70) {
  return n >= threshold;
}

module.exports = { score, bandOf, bandLabel, isHot, hasPhrase, BANDS, SIGNALS };
