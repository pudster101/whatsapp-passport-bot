/**
 * retrieve.js — pick the knowledge passages relevant to what was just said.
 *
 * No embeddings, no vector DB, no extra API call. A BM25-flavoured scorer
 * tuned for Hebrew: prefix-stripping, topic boosting, and conversation
 * context. Fast enough to run on every message.
 */
const { PASSAGES, SOURCES } = require('./corpus');

// Hebrew prefix letters that attach directly to words (ה, ו, ב, ל, מ, ש, כ)
const PREFIXES = /^[הובלמשכ]{1,2}/;

const STOPWORDS = new Set([
  'של', 'עם', 'על', 'את', 'זה', 'זו', 'הוא', 'היא', 'אני', 'אתה', 'את',
  'מה', 'מי', 'איך', 'למה', 'כמה', 'האם', 'יש', 'אין', 'לא', 'כן',
  'גם', 'רק', 'אבל', 'או', 'אם', 'כי', 'עוד', 'כל', 'יותר', 'צריך',
  'אפשר', 'רוצה', 'הייתי', 'שלי', 'שלך', 'להיות', 'כדי', 'אחרי', 'לפני',
]);

/** Normalise a token: strip prefixes, final letters, punctuation. */
function stem(word) {
  let w = String(word)
    .replace(/[.,!?;:"'״׳()\-–—]/g, '')
    .trim()
    .toLowerCase();
  if (w.length > 3) w = w.replace(PREFIXES, '');
  // Normalise Hebrew final forms so "מסמכים"/"מסמך" family matches better
  w = w.replace(/ם$/, 'מ').replace(/ן$/, 'נ').replace(/ך$/, 'כ')
       .replace(/ף$/, 'פ').replace(/ץ$/, 'צ');
  return w;
}

function tokenize(text) {
  return String(text)
    .split(/\s+/)
    .map(stem)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

// Pre-compute the token index once at load
const INDEX = PASSAGES.map(p => {
  const bodyTokens = tokenize(p.text);
  const topicTokens = p.topics.flatMap(t => tokenize(t));
  const freq = {};
  for (const t of bodyTokens) freq[t] = (freq[t] || 0) + 1;
  return {
    passage: p,
    freq,
    topicSet: new Set(topicTokens),
    topicPhrases: p.topics.map(t => t.toLowerCase()),
    length: bodyTokens.length || 1,
  };
});

// Document frequency for IDF
const DF = {};
for (const entry of INDEX) {
  for (const term of new Set(Object.keys(entry.freq))) {
    DF[term] = (DF[term] || 0) + 1;
  }
}
const N = INDEX.length;

function idf(term) {
  const df = DF[term] || 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * Retrieve relevant passages.
 *
 * @param {string} query        what the customer just said
 * @param {object} opts
 * @param {number} opts.limit   how many passages to return (default 3)
 * @param {string[]} opts.boostTopics  extra topics to favour (e.g. from intent)
 * @param {string[]} opts.exclude      passage ids already used recently
 * @returns {Array<{id, text, topics, source, score}>}
 */
function retrieve(query, opts = {}) {
  const { limit = 3, boostTopics = [], exclude = [] } = opts;
  const qLower = String(query).toLowerCase();
  const qTokens = tokenize(query);
  if (!qTokens.length && !boostTopics.length) return [];

  const boostTokens = new Set(boostTopics.flatMap(t => tokenize(t)));
  const k1 = 1.4, b = 0.6;
  const avgLen = INDEX.reduce((s, e) => s + e.length, 0) / N;

  const scored = INDEX.map(entry => {
    let score = 0;

    // BM25 over the passage body
    for (const term of qTokens) {
      const f = entry.freq[term] || 0;
      if (!f) continue;
      const denom = f + k1 * (1 - b + b * (entry.length / avgLen));
      score += idf(term) * ((f * (k1 + 1)) / denom);
    }

    // Topic hits are a much stronger signal than body word overlap
    for (const term of qTokens) {
      if (entry.topicSet.has(term)) score += 3.5;
    }
    for (const term of boostTokens) {
      if (entry.topicSet.has(term)) score += 2.5;
    }

    // Exact topic phrase appearing in the message ("תעודת שפה", "כמה זמן")
    for (const phrase of entry.topicPhrases) {
      if (phrase.length >= 4 && qLower.includes(phrase)) score += 4;
    }

    // Semantic boosts — meaning a keyword scorer alone would miss
    score += contextBoost(query, qLower, entry.passage.id);

    return { entry, score };
  });

  return scored
    .filter(s => s.score > 0.8 && !exclude.includes(s.entry.passage.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({
      id: s.entry.passage.id,
      text: s.entry.passage.text,
      topics: s.entry.passage.topics,
      // Coaching notes for the bot. Safe to feed the model as guidance,
      // never safe to echo verbatim to a customer.
      internal: !!s.entry.passage.internal,
      source: SOURCES[s.entry.passage.src],
      score: Math.round(s.score * 100) / 100,
    }));
}

/**
 * Semantic boosts. These encode things a bag-of-words scorer cannot infer:
 * an age of 70 means the B1 exemption, "יקר" means the pricing conversation,
 * and a Romanian place name means the eligibility route.
 */
const PLACES_ART11 = /צ׳רנוביץ|צרנוביץ|צ'רנוביץ|בוקובינה|בסרביה|כישינב|קישינב|מולדובה|אוקראינה|טרנסילבניה|קלוז|ברשוב|סיביו|מרמורש|סיגט|באנאט|טימישוארה/i;
const PLACES_ART10 = /בוקרשט|יאשי|יאסי|גלאץ|קונסטנצה|בקאו|בראילה/i;
const MONEY_WORDS  = /יקר|זול|תקציב|כסף|לשלם|עלות|מחיר|שכר טרחה|כמה זה|כמה עולה/i;
const AGE_RE       = /(?:בן|בת|גיל)\s*(\d{2})|(\d{2})\s*(?:שנה|שנים)/;

function contextBoost(rawQuery, qLower, passageId) {
  let boost = 0;
  const q = String(rawQuery);

  // A Romanian place name is the single strongest eligibility signal
  const saysBorn = /נולד|נולדה|לידתה|לידתו|מוצא/.test(q);
  const asksDocuments = /מסמכ|תעוד|מה צריך להביא|רשימה/.test(q);

  if (PLACES_ART11.test(q)) {
    if (passageId === 'article_11') boost += 8;
    if (passageId === 'territory_matters') boost += 5;
    if (saysBorn && passageId === 'bessarabia_group') boost += 10;
  }
  if (PLACES_ART10.test(q)) {
    if (passageId === 'article_10') boost += 8;
    if (passageId === 'territory_matters') boost += 4;
  }

  // "My grandmother was born in X" is a question about eligibility, not about
  // paperwork — document checklists should not win that turn.
  if (saysBorn && !asksDocuments && passageId.startsWith('documents_')) {
    boost -= 7;
  }

  // Age 65+ mentioned anywhere → the B1 exemption is the relevant fact
  const ageMatch = q.match(AGE_RE);
  if (ageMatch) {
    const age = parseInt(ageMatch[1] || ageMatch[2], 10);
    if (age >= 65 && passageId === 'b1_exemptions') boost += 10;
    if (age < 18 && passageId === 'b1_exemptions') boost += 8;
  }

  // Money talk → the cost conversation, never a random passage
  if (MONEY_WORDS.test(q)) {
    if (passageId === 'pricing_drivers') boost += 7;
    if (passageId === 'why_lawyer_risk') boost += 2;
  }

  // "I'll do it myself" / rejection worry → the risk passage
  if (/לבד|בעצמי|למה צריך עורך|נדח|דחי|דוח[יו]|לדחות|סירוב|מסרב|טעות במסמכ/i.test(q)) {
    if (passageId === 'why_lawyer_risk') boost += 6;
  }

  // Deadline pressure
  if (/עד מתי|דדליין|תאריך אחרון|נגמר הזמן|2027/i.test(q)) {
    if (passageId === 'b1_deadline') boost += 6;
  }

  // An emigration year is the strongest routing signal there is — it decides
  // which of the three groups the ancestor belongs to.
  const yearMatch = q.match(/\b(19[0-9]{2})\b/g);
  if (yearMatch && /על[הת]|עזב|הגיע|יצא|ברח|בא לארץ|עלייה/i.test(q)) {
    const years = yearMatch.map(Number);
    const inRange = (a, b) => years.some(y => y >= a && y <= b);

    if (passageId === 'groups_overview') boost += 6;
    // Windows in which citizenship was not surrendered (1988+ included).
    if (inRange(1950, 1952) || inRange(1964, 1967) || inRange(1988, 2030)) {
      if (passageId === 'group_1_no_limit') boost += 14;
    } else {
      // Every other year of departure is Article 10 — restoration.
      if (passageId === 'group_2_3_limit') boost += 14;
      if (passageId === 'oath_who_needs') boost += 3;
      if (passageId === 'b1_requirement') boost += 3;
    }
    // A document checklist is rarely the right answer to "when did they leave"
    if (passageId === 'documents_example_family') boost -= 6;
  }

  // Bessarabia birth in the 1918-1940 window → the wider generation limit
  if (PLACES_ART11.test(q)) {
    const birthYears = (q.match(/\b(19[0-4][0-9])\b/g) || []).map(Number);
    if (birthYears.some(y => y >= 1918 && y <= 1940) && passageId === 'bessarabia_group') {
      boost += 12;
    }
  }

  // "Who actually needs the language exam" is about the 2025 amendment —
  // not about the spouse interview, which is a different exam entirely.
  const spouseContext = /בן זוג|בת זוג|אשתי|בעלי|נשוי ל/i.test(q);
  if (/מי חייב|מי צריך|מי פטור|חייב.*שפה|חייב.*מבחן|צריך ללמוד/i.test(q) && !spouseContext) {
    if (passageId === 'amendment_2025') boost += 9;
    if (passageId === 'b1_requirement') boost += 6;
    if (passageId === 'b1_exemptions') boost += 5;
    if (passageId === 'spouse_interview') boost -= 8;
  }

  // Document shelf-life (2 years) vs the passport deadline (3 years) — easy
  // to confuse, so route each explicitly.
  if (/תוקף.*מסמכ|מסמכ.*תקפ|מסמכ.*ישנ|מסמכ.*מלפני|כמה זמן תקף|עדיין טוב/i.test(q)) {
    if (passageId === 'amendment_2025_procedures') boost += 9;
    if (passageId === 'passport_3_year_deadline') boost -= 5;
  }
  if (/קיבלתי אזרחות|יש לי כבר אזרחות|זמן לדרכון|חייב להוציא דרכון/i.test(q)) {
    if (passageId === 'passport_3_year_deadline') boost += 9;
  }

  // Israeli lawyer vs Romanian lawyer — this is about working on both sides
  if (/ישראלי או רומני|רומני או ישראלי|עורך דין ברומניה|עדיף עורך דין/i.test(q)) {
    if (passageId === 'firm_connections') boost += 15;
    if (passageId === 'firm_notary') boost += 5;
    if (passageId === 'why_lawyer_risk') boost -= 4;
  }

  // "Who will actually handle my case" — the answer must be the real one
  if (/מי (?:עורך הדין|יטפל|מטפל|ילווה|מלווה)|עורך הדין ש|שיבוץ|מי בצוות/i.test(q)) {
    if (passageId === 'firm_personal_service') boost += 10;
    if (passageId === 'firm_credibility') boost += 3;
  }

  // "What do I have to do" — reassurance about the workload
  if (/מה נדרש ממני|מה אני צריך לעשות|אתם עושים הכל|כמה עבודה|מה עלי/i.test(q)) {
    if (passageId === 'what_client_needs_to_do') boost += 9;
  }

  // Marriage registration after the fact
  if (/התחתנתי|נישאתי|רישום נישואין|לרשום.*נישואין|שיניתי סטטוס/i.test(q)) {
    if (passageId === 'marriage_registration') boost += 8;
    if (passageId === 'romanian_marriage_cert') boost += 5;
  }

  // "How long does it take" is about the three stages, not a single number
  if (/כמה זמן|כמה לוקח|מתי אקבל|לוח זמנים/i.test(q)) {
    if (passageId === 'three_stages_to_passport') boost += 6;
    if (passageId === 'timeline_2026') boost += 5;
  }

  // Work / study / living abroad — the concrete rights, not generic benefits
  if (/לעבוד|עבודה|קריירה|משרה|להתגורר|לגור ב/i.test(q)) {
    if (passageId === 'benefit_work_rights') boost += 7;
  }
  if (/רופא|בריאות|רפואי|ביטוח בריאות/i.test(q)) {
    if (passageId === 'benefit_healthcare') boost += 7;
  }
  if (/נדל|דירה|נכס|משכנתא|להשקיע/i.test(q)) {
    if (passageId === 'benefit_realestate') boost += 7;
  }

  // "Why you / who are you / what makes you different" — the differentiators
  if (/למה אתכם|למה דווקא אתם|מה מיוחד|במה אתם שונים|מי אתם|יש לכם ניסיון|כמה שנים אתם|היתרון של|מה היתרון|למה לבחור|מה מבדיל/i.test(q)) {
    if (passageId === 'firm_credibility') boost += 7;
    if (passageId === 'firm_romanian_citizen') boost += 6;
    if (passageId === 'firm_connections') boost += 5;
    if (passageId === 'firm_results_not_slogans') boost += 4;
  }
  // WHO does the translating → the notary advantage (not the how-to passage)
  if (/מי (?:עושה|מבצע|מתרגם|אחראי)/i.test(q) && /תרגום|מתרגם|נוטריון/i.test(q)) {
    if (passageId === 'firm_notary') boost += 9;
    if (passageId === 'translation_is_legal') boost += 4;
  } else if (/תרגום נוטריוני|מתרגם|נוטריון/i.test(q)) {
    if (passageId === 'firm_notary') boost += 4;
    if (passageId === 'translation_is_legal') boost += 4;
  }

  // Name mismatches — the single most common cause of rejection
  if (/שינוי שם|שם אחר|לא תואם|שם שונה|שינו את השם|בתעודה.*כתוב|כתוב.*ואצלנו|שם לועזי|leib|leon|שם באנגלית/i.test(q)) {
    if (passageId === 'names_landmine') boost += 10;
    if (passageId === 'name_change_registration') boost += 3;
  }

  // "What's in it for me" → the benefits, framed as an asset
  if (/שווה לי|למה כדאי|מה יוצא לי|מה זה נותן|למה בכלל|מה היתרון/i.test(q)) {
    if (passageId === 'passport_as_asset') boost += 8;
    if (passageId === 'benefit_eu_status') boost += 6;
    if (passageId === 'benefit_children') boost += 3;
  }

  // Spouse questions are their own world — never answer them with the
  // descent-by-blood material
  if (/בן זוג|בת זוג|אשתי|בעלי|לאישה שלי|לבעל שלי|נשוי ל/i.test(q)) {
    if (passageId === 'spouse_reality') boost += 9;
    if (passageId === 'spouse_family_reunification') boost += 4;
    if (passageId === 'spouse_interview') boost += 3;
  }

  return boost;
}

/** Retrieve by explicit topic keywords — used when intent is known but wording isn't. */
function byTopics(topics, limit = 2, exclude = []) {
  return retrieve(topics.join(' '), { limit, boostTopics: topics, exclude });
}

/** Get a specific passage by id. */
function byId(id) {
  const p = PASSAGES.find(x => x.id === id);
  return p ? { id: p.id, text: p.text, topics: p.topics, source: SOURCES[p.src] } : null;
}

/** Map an analysis intent onto the topics worth retrieving. */
const INTENT_TOPICS = {
  ask_eligibility: ['זכאות', 'סעיף 10', 'סעיף 11', 'דורות'],
  ask_process:     ['שלבים', 'הגשה', 'תעתוק', 'קונסוליה'],
  ask_time:        ['כמה זמן', 'לוח זמנים'],
  ask_cost:        ['מחיר', 'עלות'],
  ask_documents:   ['מסמכים', 'ארכיון', 'אין מסמכים'],
  ask_legality:    ['חוק', 'חוקי', 'בסיס משפטי'],
  ask_benefits:    ['יתרונות', 'אירופה', 'לימודים', 'עסקים'],
  ask_children:    ['ילדים', 'נכדים', 'צאצאים'],
  ask_travel:      ['לנסוע', 'מרחוק', 'ייפוי כוח'],
  ask_b1:          ['b1', 'שפה', 'בחינה', 'פטור', 'דדליין'],
  ask_b1_course:   ['קורס', 'סיביו'],
  ask_trust:       ['מי אתם', 'אמינות', 'משרד'],
  ready_to_start:  ['שלבים', 'מסמכים', 'זכאות'],
};

function forIntent(intent, query, exclude = []) {
  const topics = INTENT_TOPICS[intent] || [];
  return retrieve(query, { limit: 3, boostTopics: topics, exclude });
}

module.exports = { retrieve, byTopics, byId, forIntent, tokenize, stem, INTENT_TOPICS };
