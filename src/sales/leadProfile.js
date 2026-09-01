/**
 * leadProfile.js — the evolving picture of a customer.
 *
 * Replaces the six flat fields the old bot collected. Merging is additive and
 * conflict-aware: a newer explicit value overwrites an older one, but a null
 * or empty value never erases something we already know.
 */
const stages = require('./stages');

function create(phone, extra = {}) {
  return {
    waPhone: phone,
    name: null,
    clientPhone: null,
    language: 'he',
    source: extra.source || 'unknown',
    campaign: extra.campaign || null,

    interest: [],                 // 'passport' | 'b1_course'

    eligibility: {
      ancestor: null,             // e.g. 'סבתא מצד אמא'
      birthYear: null,
      birthPlace: null,
      leftYear: null,
      territory: null,            // romania_proper | bessarabia | bukovina | transylvania | maramures | banat
      likelyArticle: null,        // '10' | '11' | 'הסדרה'
      generation: null,           // 1 = child, 2 = grandchild, 3 = great-grandchild
      hasDocuments: null,         // true | false | 'partial'
      b1Status: null,             // none | studying | certified | exempt
      b1ExemptReason: null,       // age_65 | minor | medical | former_citizen
    },

    motivation: null,             // children_future | eu_work | studies | business | security | curiosity
    urgency: null,                // high | medium | low
    decisionMaker: null,          // self | with_spouse | for_parent | for_child

    objections: [],               // [{ type, raisedAt, resolved, note }]

    stage: 'NEW_LEAD',
    buyingIntent: 0,
    conversationSummary: '',
    questionsAsked: [],           // topics the customer raised — never re-ask

    firstSeenAt: new Date().toISOString(),
    lastInboundAt: null,
    lastOutboundAt: null,
    messageCount: 0,

    followUpsSent: 0,
    lastFollowUpAt: null,
    optedOut: false,

    nextAction: null,
    humanStatus: 'none',          // none | requested | notified | handled
    ...extra,
  };
}

/** Deep, non-destructive merge of newly extracted facts. */
function merge(profile, updates = {}) {
  if (!updates || typeof updates !== 'object') return profile;
  const out = { ...profile };

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') continue;

    if (key === 'eligibility' && typeof value === 'object') {
      out.eligibility = { ...out.eligibility };
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined && v !== '') out.eligibility[k] = v;
      }
      continue;
    }

    if (key === 'interest' && Array.isArray(value)) {
      out.interest = [...new Set([...(out.interest || []), ...value])];
      continue;
    }

    if (key === 'questionsAsked' && Array.isArray(value)) {
      out.questionsAsked = [...new Set([...(out.questionsAsked || []), ...value])];
      continue;
    }

    if (key === 'objections' && Array.isArray(value)) {
      out.objections = mergeObjections(out.objections || [], value);
      continue;
    }

    if (key === 'stage') {
      out.stage = stages.shouldAdvance(out.stage, value);
      continue;
    }

    out[key] = value;
  }

  out.eligibility = deriveArticle(out.eligibility);
  return out;
}

function mergeObjections(existing, incoming) {
  const out = [...existing];
  for (const obj of incoming) {
    const type = typeof obj === 'string' ? obj : obj.type;
    if (!type) continue;
    const found = out.find(o => o.type === type);
    if (found) {
      if (obj.resolved) found.resolved = true;
      if (obj.note) found.note = obj.note;
    } else {
      out.push({
        type,
        raisedAt: new Date().toISOString(),
        resolved: !!obj.resolved,
        note: obj.note || null,
      });
    }
  }
  return out;
}

/**
 * Infer the likely legal route from the birthplace.
 * Territories that were part of "Greater Romania" but are outside today's
 * borders point to Article 11 (4 generations); today's Romania points to
 * Article 10 (3 generations). This is a working hypothesis for the lawyer
 * to confirm — never presented to the customer as a determination.
 */
const TERRITORY_HINTS = [
  // Article 11 belongs ONLY to territory that left Romania after WWII and is
  // today Ukraine or Moldova. Transylvania, Maramureș and Banat were part of
  // Greater Romania too, but they are inside Romania today — so a birth there
  // is an ordinary case, decided by the YEAR OF DEPARTURE like any other.
  // A Romanian birthplace therefore sets no article at all.
  { match: /בסרביה|כישינב|קישינב|מולדובה|chisinau|basarabia/i,          territory: 'bessarabia',     article: '11' },
  { match: /בוקובינה|צ׳רנוביץ|צרנוביץ|צ'רנוביץ|chernivtsi|bukovina/i,  territory: 'bukovina',       article: '11' },
  { match: /טרנסילבניה|קלוז|ברשוב|סיביו|transylvania|cluj|brasov/i,     territory: 'transylvania',   article: null },
  { match: /מרמורש|maramures|סיגט|sighet/i,                            territory: 'maramures',      article: null },
  { match: /באנאט|banat|טימישוארה|timisoara/i,                         territory: 'banat',          article: null },
  { match: /בוקרשט|יאשי|יאסי|גלאץ|קונסטנצה|bucharest|iasi|galati/i,     territory: 'romania_proper', article: null },
];

function deriveArticle(elig) {
  if (!elig) return elig;
  let out = elig;

  if (!out.likelyArticle && out.birthPlace) {
    for (const hint of TERRITORY_HINTS) {
      if (hint.match.test(out.birthPlace)) {
        out = { ...out, territory: out.territory || hint.territory, likelyArticle: hint.article };
        break;
      }
    }
  }
  return deriveGroup(out);
}

/**
 * Classify the ancestor into one of the three emigration groups.
 *
 * This is the single most consequential inference the bot makes: the group
 * determines the generation limit, whether an oath is required, and whether
 * B1 applies. It is a working hypothesis for the lawyer to confirm — never
 * presented to the customer as a determination.
 *
 * THE RULE, as corrected by the firm:
 *
 *   As a rule, everyone who left Romania was required to give up their Romanian
 *   citizenship. The exceptions are departures in 1950-1952 and 1964-1967 —
 *   and, from 1988 onward, the practice had stopped, so those who left then
 *   most likely kept their citizenship too.
 *
 *   1. הסדרה (short track) — the ancestor left in 1950-1952, 1964-1967, or
 *      from 1988 onward. Citizenship was never lost, so this is a registration
 *      of an existing status rather than a restoration. No B1, no oath.
 *      Post-1988 is flagged as needing verification: it is the firm's working
 *      assumption, not a documented rule like the two earlier windows.
 *   2. Article 10 — the ancestor was born in Romania and left in ANY other
 *      year. Citizenship was lost, so it must be restored. B1 required.
 *   3. Article 11 — the ancestor was born in territory that was under Romanian
 *      control ("Greater Romania") and passed after WWII to Ukraine or Moldova
 *      (Bessarabia, northern Bukovina, Herța). B1 required.
 *
 *   B1 exemption at the GROUP level belongs to הסדרה alone. Individual
 *   exemptions (65+, minors, applications filed before 15.03.2025) still exist
 *   inside Articles 10 and 11 — they exempt a person, not a route.
 */

/** Windows in which Romanian citizenship was not surrendered on departure. */
const KEPT_CITIZENSHIP_WINDOWS = [[1950, 1952], [1964, 1967]];
/** From 1988 the practice had stopped — very likely kept, still worth verifying. */
const KEPT_FROM_YEAR = 1988;

/**
 * A one-line statement of the rules this build actually believes.
 * Printed at startup so a stale server can never be mistaken for a fresh one —
 * the trainer was once run against code that had already been fixed on disk.
 */
function rulesSignature() {
  const windows = KEPT_CITIZENSHIP_WINDOWS.map(([a, b]) => `${a}-${b}`).join(', ');
  return `הסדרה: ${windows}, ${KEPT_FROM_YEAR}+ · סעיף 10: כל השאר · סעיף 11: בסרביה/בוקובינה/הרצה`;
}

function keptCitizenship(leftYear) {
  return KEPT_CITIZENSHIP_WINDOWS.some(([a, b]) => leftYear >= a && leftYear <= b)
      || leftYear >= KEPT_FROM_YEAR;
}

function deriveGroup(elig) {
  if (!elig || elig.group) return elig;

  // Article 11 — born in a territory that is today Ukraine or Moldova.
  // This is decided by PLACE, so it is checked first and does not depend on
  // the year of departure.
  const lostTerritory = ['bessarabia', 'bukovina'].includes(elig.territory);
  const birthYear = parseInt(elig.birthYear, 10);
  if (lostTerritory && (!birthYear || (birthYear >= 1918 && birthYear <= 1940))) {
    return {
      ...elig,
      group: 'article_11',
      likelyArticle: '11',
      generationLimit: 'נינים',
      needsOath: true,
      needsB1: true,
    };
  }

  const leftYear = parseInt(elig.leftYear, 10);
  // Without the year of departure we cannot classify. Saying "probably the
  // short track" here is exactly the error the firm caught in live chats.
  if (!leftYear) return elig;

  if (keptCitizenship(leftYear)) {
    return {
      ...elig,
      group: 'hesder',
      likelyArticle: 'הסדרה',
      generationLimit: 'ללא מגבלה',
      needsOath: false,
      needsB1: false,
      // The two mid-century windows are established; post-1988 is an inference.
      needsVerification: leftYear >= KEPT_FROM_YEAR,
    };
  }

  // Every other year of departure means the citizenship was surrendered.
  return {
    ...elig,
    group: 'article_10',
    likelyArticle: '10',
    generationLimit: 'נכדים',
    needsOath: true,
    needsB1: true,
  };
}

/** Plain-language description of the route, for the agent and the lawyer. */
function describeGroup(elig = {}) {
  switch (elig.group) {
    case 'hesder':
      return elig.needsVerification
        ? 'הסדרת רישום — יציאה מ-1988 והלאה, ולכן ככל הנראה האזרחות לא אבדה. ' +
          'ללא מגבלת דורות, ללא שבועה וללא B1. ⚠️ טעון אימות מיוחד מול הרשויות.'
        : 'הסדרת רישום — האזרחות לא אבדה (יציאה ב-1950-1952 או 1964-1967). ' +
          'ללא מגבלת דורות, ללא שבועה וללא B1. טעון אימות מול הרשויות.';
    case 'article_10':
      return 'סעיף 10 — השבת אזרחות שאבדה ביציאה מרומניה. עד דור הנכדים, ' +
             'נדרשת שבועה ותעודת B1 (אלא אם חל פטור אישי).';
    case 'article_11':
      return 'סעיף 11 — יליד שטח שהיה בשליטת רומניה ועבר לאוקראינה/מולדובה. ' +
             'עד דור הנינים, נדרשת שבועה ותעודת B1.';
    default:
      return null;
  }
}

/** Which qualification facts are still missing, in the order worth asking. */
/**
 * What we still need, in the order worth asking.
 *
 * Note the ordering: leftYear comes before birthYear because the year the
 * ancestor left Romania is what classifies the route (group 1/2/3), and the
 * route determines the generation limit, the oath and the B1 requirement.
 * It is the highest-information question in the whole conversation.
 */
function missingFacts(profile) {
  const e = profile.eligibility || {};
  const missing = [];
  if (!e.ancestor)   missing.push('ancestor');
  if (!e.birthPlace) missing.push('birthPlace');
  if (!e.leftYear)   missing.push('leftYear');
  if (!e.birthYear)  missing.push('birthYear');
  if (!profile.name) missing.push('name');
  if (!profile.clientPhone) missing.push('clientPhone');
  return missing;
}

function isQualified(profile) {
  const e = profile.eligibility || {};
  return !!(e.ancestor && (e.birthPlace || e.leftYear || e.birthYear));
}

function hasContactDetails(profile) {
  return !!(profile.name && profile.clientPhone);
}

/** Compact context string handed to the model and to the human agent. */
function summarise(profile) {
  const e = profile.eligibility || {};
  const bits = [];
  if (profile.name) bits.push(`שם: ${profile.name}`);
  if (profile.clientPhone) bits.push(`טלפון: ${profile.clientPhone}`);
  if (profile.interest?.length) bits.push(`עניין: ${profile.interest.join(', ')}`);
  if (e.ancestor) bits.push(`בן משפחה: ${e.ancestor}`);
  if (e.birthYear) bits.push(`שנת לידה: ${e.birthYear}`);
  if (e.birthPlace) bits.push(`מקום: ${e.birthPlace}`);
  if (e.leftYear) bits.push(`עזב: ${e.leftYear}`);
  if (e.territory) bits.push(`אזור: ${e.territory}`);
  if (e.likelyArticle) bits.push(`מסלול משוער: סעיף ${e.likelyArticle}`);
  const groupDesc = describeGroup(e);
  if (groupDesc) bits.push(`הערכת מסלול: ${groupDesc}`);
  if (e.hasDocuments !== null && e.hasDocuments !== undefined) {
    bits.push(`מסמכים: ${e.hasDocuments === true ? 'יש' : e.hasDocuments === false ? 'אין' : 'חלקי'}`);
  }
  if (e.b1Status) bits.push(`B1: ${e.b1Status}`);
  if (profile.motivation) bits.push(`מוטיבציה: ${profile.motivation}`);
  if (profile.urgency) bits.push(`דחיפות: ${profile.urgency}`);
  if (profile.decisionMaker) bits.push(`מקבל החלטה: ${profile.decisionMaker}`);
  const open = (profile.objections || []).filter(o => !o.resolved).map(o => o.type);
  if (open.length) bits.push(`התנגדויות פתוחות: ${open.join(', ')}`);
  return bits.join(' | ') || 'אין עדיין מידע';
}

/** Migrate a legacy session (old six-field shape) into a full profile. */
function fromLegacySession(phone, session) {
  if (!session) return create(phone);
  const d = session.data || {};
  const profile = create(phone, {
    name: d.name || null,
    clientPhone: d.clientPhone || null,
    source: d.source === 'romanian_course' ? 'fb_ad' : (d.source || 'unknown'),
    interest: d.source === 'romanian_course' ? ['b1_course'] : ['passport'],
    stage: stages.fromFsmState(session.state),
    firstSeenAt: session.startedAt || new Date().toISOString(),
  });
  return merge(profile, {
    eligibility: {
      ancestor: d.familyMember || d.partialInfo || null,
      birthYear: d.birthYear || null,
      birthPlace: d.city || null,
      leftYear: d.leftYear || null,
    },
  });
}

/** Find a Romanian/Greater-Romania place name mentioned in free text. */
function detectPlace(text = '') {
  for (const hint of TERRITORY_HINTS) {
    const m = String(text).match(hint.match);
    if (m) return { place: m[0], territory: hint.territory, article: hint.article };
  }
  return null;
}

module.exports = {
  create,
  merge,
  missingFacts,
  isQualified,
  hasContactDetails,
  summarise,
  fromLegacySession,
  deriveArticle,
  deriveGroup,
  rulesSignature,
  describeGroup,
  detectPlace,
  TERRITORY_HINTS,
};
