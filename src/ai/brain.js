/**
 * brain.js — the sales intelligence layer.
 *
 * One structured call per inbound message produces everything the sales logic
 * needs: intent, extracted facts, funnel stage, buying intent, objections,
 * next best action, and an escalation flag.
 *
 * Fails safe: if the API key is missing, the call errors, or the response is
 * malformed, we return null and the caller falls back to the scripted flow.
 */
const config = require('../config');
const prompts = require('./prompts');
const retrieve = require('../kb/retrieve');
const scoring = require('../sales/scoring');
const objectionsLib = require('../sales/objections');

let client = null;
let available = false;

/**
 * Telemetry for the last compose() call — surfaced by the local simulator so
 * you can see, per message, whether the AI wrote it and what it cost.
 */
let lastCompose = null;
function getLastCompose() { return lastCompose; }
function clearLastCompose() { lastCompose = null; }

function init() {
  if (!config.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — AI sales layer disabled, running scripted mode.');
    return false;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    available = true;
    console.log(`✅ AI sales brain ready (mode: ${config.AI_MODE}, model: ${config.AI_MODEL_FAST})`);
    return true;
  } catch (err) {
    console.error('❌ Could not initialise Anthropic SDK:', err.message);
    return false;
  }
}

// ─── Daily budget ─────────────────────────────────────────────────────────────
// A hard ceiling on API calls per day. When it's hit the bot does NOT go
// silent — it falls back to scripted mode, which still answers every customer.
let callsToday = 0;
let budgetDay = new Date().toDateString();
let budgetWarned = false;

function countCall() {
  const today = new Date().toDateString();
  if (today !== budgetDay) {
    budgetDay = today;
    callsToday = 0;
    budgetWarned = false;
  }
  callsToday++;
}

function budgetExceeded() {
  const today = new Date().toDateString();
  if (today !== budgetDay) return false; // new day, counter resets on next call
  return callsToday >= config.DAILY_AI_CALL_BUDGET;
}

function budgetStatus() {
  return { callsToday, budget: config.DAILY_AI_CALL_BUDGET, exceeded: budgetExceeded() };
}

function isAvailable() {
  if (!available || config.AI_MODE === 'off') return false;
  if (budgetExceeded()) {
    if (!budgetWarned) {
      budgetWarned = true;
      console.warn(
        `💸 תקרת קריאות ה-AI היומית (${config.DAILY_AI_CALL_BUDGET}) הושגה — ` +
        `הבוט ממשיך לענות במצב תסריט. להעלאה: DAILY_AI_CALL_BUDGET ב-.env`
      );
    }
    return false;
  }
  return true;
}

/** Strip markdown fences and parse the first JSON object in a string. */
function parseJson(text) {
  if (!text) return null;
  let clean = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Analyse one inbound message.
 * @returns {object|null} analysis, or null if unavailable/failed
 */
async function analyse(text, profile, history = []) {
  if (!isAvailable()) return null;

  const started = Date.now();
  try {
    countCall();
    const res = await client.messages.create({
      model: config.AI_MODEL_FAST,
      max_tokens: 900,
      system: prompts.analysisSystem(),
      messages: [{
        role: 'user',
        content: `הקשר על הלקוח:\n${require('../sales/leadProfile').summarise(profile)}\n` +
                 `שלב נוכחי: ${profile.stage}\n` +
                 `ניקוד כוונת רכישה נוכחי: ${profile.buyingIntent || 0}\n\n` +
                 (history.length
                   ? `היסטוריה אחרונה:\n${history.slice(-6).map(m => `${m.role === 'user' ? 'לקוח' : 'אנחנו'}: ${m.text}`).join('\n')}\n\n`
                   : '') +
                 `ההודעה החדשה של הלקוח:\n"${text}"\n\nנתח והחזר JSON בלבד.`,
      }],
    });

    const raw = res.content?.[0]?.text || '';
    const parsed = parseJson(raw);
    if (!parsed) {
      console.warn('⚠️  AI analysis returned unparseable output');
      return null;
    }

    const ms = Date.now() - started;
    const usage = res.usage || {};
    console.log(
      `🧠 AI analysis ${ms}ms | intent=${parsed.intent} stage=${parsed.stage} ` +
      `intent_score=${parsed.buyingIntent} conf=${parsed.confidence} ` +
      `tokens=${usage.input_tokens || 0}/${usage.output_tokens || 0}`
    );

    return normalise(parsed, text, profile);
  } catch (err) {
    console.error('❌ AI analysis failed:', err.message);
    return null;
  }
}

/** Reconcile the model's judgement with deterministic Hebrew matching. */
function normalise(parsed, text, profile) {
  // Union of AI-detected and rule-detected objections — rules catch what the
  // model misses, the model catches phrasing the rules don't cover.
  const ruleObjections = objectionsLib.detect(text);
  const aiObjections = Array.isArray(parsed.objections) ? parsed.objections : [];
  const allObjections = [...new Set([...ruleObjections, ...aiObjections])]
    .filter(o => objectionsLib.list().includes(o));

  // Blend scores
  const scored = scoring.score(text, profile, { buyingIntent: parsed.buyingIntent });

  const entities = parsed.entities || {};
  const eligibility = {
    ancestor: entities.ancestor || null,
    birthYear: entities.birthYear ? String(entities.birthYear).match(/\d{4}/)?.[0] || null : null,
    birthPlace: entities.birthPlace || null,
    leftYear: entities.leftYear ? String(entities.leftYear).match(/\d{4}/)?.[0] || null : null,
    hasDocuments: entities.hasDocuments ?? null,
    b1Status: entities.b1Status || null,
  };

  return {
    intent: parsed.intent || 'unclear',
    emotion: parsed.emotion || 'neutral',
    stage: parsed.stage || profile.stage,
    buyingIntent: scored.score,
    buyingIntentBand: scored.band,
    matchedSignals: scored.matched,
    objections: allObjections,
    missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo : [],
    nextBestAction: parsed.nextBestAction || 'answer_question',
    escalate: !!parsed.escalate,
    escalateReason: parsed.escalateReason || null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    summary: parsed.summary || '',
    profileUpdates: {
      name: entities.name || null,
      clientPhone: entities.clientPhone || null,
      motivation: entities.motivation || null,
      urgency: entities.urgency || null,
      decisionMaker: entities.decisionMaker || null,
      eligibility,
    },
  };
}

/**
 * Compose the customer-facing reply.
 * @returns {string|null} message text, or null to fall back to scripted copy
 */
async function compose(analysis, profile, history = [], directive = null) {
  lastCompose = null;
  if (!isAvailable() || config.AI_MODE !== 'live') return null;

  const startedAt = Date.now();
  try {
    const instruction = directive
      ? `\n\n*הנחיה לתשובה הזו:* ${directive}`
      : '';

    // Pull the facts that are actually relevant to this specific message
    const lastUser = history.filter(h => h.role === 'user').slice(-1)[0]?.text || '';
    const passages = retrieve.forIntent(
      analysis.intent,
      lastUser,
      profile.recentPassages || []
    );
    if (passages.length) {
      console.log(`📚 Retrieved: ${passages.map(p => `${p.id}(${p.score})`).join(', ')}`);
    }

    countCall();
    const res = await client.messages.create({
      model: pickModel(analysis),
      // WhatsApp replies should be short anyway — a smaller cap is both
      // faster and a useful nudge against wall-of-text answers.
      max_tokens: 450,
      system: prompts.composeSystem(profile, history, passages),
      messages: [{
        role: 'user',
        content:
          `*ההודעה האחרונה של הלקוח:*\n"${lastUser}"\n\n` +
          `ניתוח פנימי (לשימושך בלבד — אסור לחשוף):\n` +
          `כוונה: ${analysis.intent} | רגש: ${analysis.emotion} | שלב: ${analysis.stage}\n` +
          `כוונת רכישה: ${analysis.buyingIntent}/100\n` +
          `התנגדויות: ${analysis.objections.join(', ') || 'אין'}\n` +
          `הפעולה הנכונה עכשיו: ${analysis.nextBestAction}${instruction}\n\n` +
          `*סדר הכתיבה — בדיוק בסדר הזה:*\n` +
          `1. ענה קודם כל על מה שהלקוח *באמת שאל*. אם הוא שאל שאלה — המשפט הראשון שלך עונה עליה.\n` +
          `2. אם יש משהו במה שהוא סיפר שרלוונטי דווקא לו — התייחס אליו בשמו ` +
          `(עיר, שנה, בן משפחה), לא במונחים כלליים.\n` +
          `3. רק אחר כך, ורק אם זה מתאים לרגע, הוסף שאלה אחת שמקדמת.\n\n` +
          `אם השאלה שלו לא קשורה למה שרצית לשאול — עזוב את מה שרצית. הלקוח קובע את הנושא.\n\n` +
          `כתוב את ההודעה.`,
      }],
    });

    const text = (res.content?.[0]?.text || '').trim();
    if (!text) return null;

    const model = pickModel(analysis);
    lastCompose = {
      usedAI: true,
      model,
      ms: Date.now() - startedAt,
      inputTokens: res.usage?.input_tokens || 0,
      outputTokens: res.usage?.output_tokens || 0,
      passages: passages.map(p => ({ id: p.id, score: p.score })),
      blocked: false,
    };

    const safe = enforceGuardrails(text, profile);
    if (!safe) {
      console.warn('🛑 AI reply blocked by guardrails — falling back to scripted copy');
      lastCompose.blocked = true;
      lastCompose.usedAI = false;
      return null;
    }

    // Remember which passages we just used so we don't repeat the same
    // material two turns running
    profile.recentPassages = [
      ...passages.map(p => p.id),
      ...(profile.recentPassages || []),
    ].slice(0, 6);

    return safe;
  } catch (err) {
    const detail = err?.error?.error?.message || err.message;
    console.error('❌ AI compose failed:', detail);

    // Record WHY, so the simulator can show it instead of silently
    // pretending the scripted answer was a choice.
    lastCompose = {
      usedAI: false,
      error: detail,
      hint: diagnose(detail),
      ms: Date.now() - startedAt,
    };
    return null;
  }
}

/** Turn an API error into something actionable. */
function diagnose(msg = '') {
  const m = String(msg).toLowerCase();
  if (m.includes('connection') || m.includes('econn') || m.includes('fetch failed') || m.includes('network')) {
    return 'אין חיבור ל-api.anthropic.com — בדוק אינטרנט, חומת אש או פרוקסי';
  }
  if (m.includes('credit') || m.includes('balance') || m.includes('quota') || m.includes('insufficient')) {
    return 'אין יתרת אשראי בחשבון — הוסף ב-console.anthropic.com → Billing';
  }
  if (m.includes('authentication') || m.includes('api key') || m.includes('401') || m.includes('invalid x-api-key')) {
    return 'המפתח נדחה — ודא שהועתק במלואו לקובץ .env';
  }
  if (m.includes('rate') || m.includes('429')) {
    return 'חריגה ממגבלת קצב — נסה שוב בעוד רגע';
  }
  if (m.includes('deprecated') || m.includes('unexpected') || m.includes('unsupported parameter')) {
    return 'פרמטר בקריאה אינו נתמך במודל הזה — צריך עדכון קוד, שלח לי את השגיאה';
  }
  if (m.includes('not_found') || m.includes('404') ||
      (m.includes('model') && m.includes('does not exist'))) {
    return 'שם המודל אינו זמין לחשבון הזה — בדוק AI_MODEL_FAST / AI_MODEL_SMART';
  }
  if (m.includes('overloaded') || m.includes('529')) {
    return 'השרת עמוס כרגע — זמני, נסה שוב';
  }
  return 'שגיאה לא מזוהה — ראה את החלון של CMD לפרטים';
}

/**
 * Use the stronger (slower) model only where it genuinely pays: a live
 * objection, or a lead hot enough that the reply decides the deal.
 * Everything else gets the fast model — on WhatsApp, speed is quality.
 */
function pickModel(analysis) {
  const highStakes =
    analysis.objections.length > 0 ||
    analysis.stage === 'OBJECTION' ||
    analysis.buyingIntent >= config.HOT_LEAD_THRESHOLD;
  return highStakes ? config.AI_MODEL_SMART : config.AI_MODEL_FAST;
}

/**
 * Last line of defence, enforced in code rather than trusted to the model.
 * Returns the (possibly cleaned) text, or null if it must be discarded.
 */
// Note: \b is an ASCII word boundary and does NOT work after Hebrew letters,
// so trailing boundaries are omitted on Hebrew currency words.
const FEE_PATTERNS = [
  /(\d[\d,.]{2,})\s*(?:₪|ש"ח|ש״ח|שקל|שח)/i,
  /(?:₪|\$)\s*\d[\d,.]{2,}/,
  /\d[\d,.]{2,}\s*(?:יורו|אירו|euro|eur)/i,
  /שכר\s*טרחה\s*(?:הוא|של|יעמוד|מתחיל|בסך)/i,
];

/**
 * Timelines the bot applied to a specific customer's case. The evaluator
 * flagged "בתיק שלך זה בדרך כלל קרוב לשנה עד שנה וחצי" as a high-severity
 * hallucination: the knowledge base says the average is two to three years and
 * explicitly permits saying one track is shorter — but never by how much.
 *
 * We only block a duration when it is attached to THIS lead's case. General
 * statements that are in the corpus ("איתור מסמכים לוקח 2-6 חודשים") pass.
 */
const CASE_SCOPED = /(?:בתיק שלך|במקרה שלך|אצלך|התיק שלך|בשבילך|לך זה)/;
const DURATION = /(?:חצי שנה|שנה וחצי|שנה עד|כשנה|שנתיים|שלוש שנים|\d+\s*[-–]\s*\d+\s*(?:חודשים|שנים)|\d+\s*(?:חודשים|שנים))/;

/** Claiming revoked/not-revoked status as established fact rather than a guess. */
// NOTE: \w is ASCII-only in JS and does NOT match Hebrew letters, so
// "של\w*" silently fails on "של אמא". Match any non-space run instead.
const STATUS_CERTAINTY = [
  /(?:מכיוון ש|כיוון ש|היות ו)ה?אזרחות(?:\s+\S+){0,3}?\s+(?:לא\s+)?נשללה/,
  /ה?אזרחות(?:\s+\S+){0,3}?\s+(?:לא\s+)?נשללה\s*[,،.]/,
  /ברור ש(?:ה)?אזרחות/,
];
const HEDGED = /(?:נראה|כנראה|לפי מה שסיפרת|צריך לאמת|השערה|לבדוק מול|יש לאמת|לכאורה|ככל הנראה|סבירות גבוהה|בדיקה מעמיקה|יש חריגים|טעון בדיקה|צריך לבדוק)/;

/**
 * A route stated as settled fact. The firm's rule: the classification is
 * highly likely, never certain — there are always exceptions, and only a
 * proper review settles it. "עלייה ב-1961 פירושה שהאזרחות אבדה" reads as a
 * determination, and a determination is what we must not make.
 */
const ROUTE_AS_FACT = [
  /\d{4}\s+(?:פירוש[הו]|אומרת?|משמעות[הו])\s+ש/,
  /(?:אתה|את)\s+במסלול\s+(?:של\s+)?סעיף/,
  /(?:המסלול|התיק)\s+שלך\s+הוא\s+סעיף/,
];

/**
 * Comparative price claims. The fee guard catches numbers, but "ההבדל הוא
 * כפולים ומשולשים" quantifies the fee just as effectively without one.
 */
const COMPARATIVE_FEE = [
  /כפול(?:ים)?\s+ומשולש/,
  /פי\s+(?:שניים|שלושה|\d+)\s+(?:יותר|פחות)?/,
  /(?:יקר|זול)\s+(?:בהרבה|פי|משמעותית)/,
];

const PROMISE_PATTERNS = [
  /מבטיח(?:ים)?\s+(?:ש|לך|לכם)?\s*(?:הבקשה|האזרחות|שתקבל|אישור)/i,
  /100%\s*(?:הצלחה|אישור|מובטח)/i,
  /בטוח\s+שתקבל/i,
  /ערבים\s+להצלחה/i,
];

/**
 * Official, published third-party charges the bot MAY state. These are
 * government and institution fees, not the firm's professional fees.
 * Anything not on this list is treated as a fee quote and blocked.
 */
const ALLOWED_FEES = [
  /(?:^|[^\d])40\s*₪/,                       // apostille, MFA / court
  /(?:^|[^\d])220\s*₪/,                      // passport renewal at the consulate
  /(?:^|[^\d])250\s*₪/,                      // child passport at the consulate
  /(?:^|[^\d])50\s*(?:יורו|אירו|euro)/i,     // B1 exam registration
];

function isAllowedFee(match) {
  return ALLOWED_FEES.some(re => re.test(match));
}

/**
 * The route claim guard.
 *
 * The firm reviewed live chats and found the bot telling people they were on
 * the short "הסדרה" track because the ancestor left "sometime in the 50s", and
 * once because the ancestor was BORN in 1955. Both are wrong: the short track
 * exists only for departures in 1950-1952 and 1964-1967, and a birth year says
 * nothing about the route.
 *
 * A reply may explain the rule in general. It may not tell THIS customer they
 * are on the short track unless the year of departure we hold says so.
 */
// Hebrew prefixes (ב, ה, ל, ו) attach to the word, so anchor on the noun
// itself: "במסלול הקצר" must match just as "המסלול הקצר" does.
const SHORT_TRACK_CLAIM = [
  /מסלול\s+ה?קצר/,
  /הסדרת\s+רישום|הליך\s+ה?הסדרה|מסלול\s+ה?הסדרה/,
  /לא\s+(?:נשללה|אבדה|ויתר|ויתרה|איבד|איבדה)/,
  /אין\s+מגבלת\s+דורות/,
  /(?:אין|ללא|לא נדרש[ת]?)\s+(?:דרישת\s+)?(?:B1|בחינת שפה|מבחן שפה)/i,
];
/** Second person or possessive — the claim is about this lead, not the law. */
const ABOUT_THIS_LEAD =
  /(?:שלך|שלכם|במקרה שלך|בתיק שלך|אצלך|אתה|את\s|תצטרך|תצטרכי|לך זה|עבורך)/;

/**
 * Asserting Article 10 vs Article 11 without knowing WHERE the ancestor was
 * born. Trainer run 6, high severity: "שנת 1947 של סבתא שלך היא מקרה שנשמע
 * מבטיח — מסלול שדורש שבועה ו-B1". A 1947 departure is Article 10 if she was
 * born inside Romania, but Article 11 if she was born in Bessarabia or northern
 * Bukovina — and nobody had asked. The year alone does not settle it.
 */
const ROUTE_CLAIM = [
  /סעיף\s*1[01]/,
  /השבת\s+אזרחות/,
  /מסלול\s+ש?דורש/,
  /(?:נדרשת|תידרש|תצטרך)\s+שבועה/,
];

function claimsRouteWithoutPlace(text, profile) {
  if (!ABOUT_THIS_LEAD.test(text)) return false;
  if (!ROUTE_CLAIM.some(re => re.test(text))) return false;
  const e = profile?.eligibility || {};
  // Place is what separates Article 10 from Article 11.
  return !e.territory && !e.birthPlace;
}

function claimsShortTrack(text, profile) {
  if (!ABOUT_THIS_LEAD.test(text)) return false;      // general explanation — fine
  if (!SHORT_TRACK_CLAIM.some(re => re.test(text))) return false;

  const leftYear = parseInt(profile?.eligibility?.leftYear, 10);
  if (!leftYear) return true;                          // no year → no claim allowed
  const kept = (leftYear >= 1950 && leftYear <= 1952) ||
               (leftYear >= 1964 && leftYear <= 1967) ||
               leftYear >= 1988;
  return !kept;
}

function enforceGuardrails(text, profile = null) {
  if (profile && claimsRouteWithoutPlace(text, profile)) {
    console.warn('🛑 Guardrail: route asserted without a birthplace — 10 vs 11 is undecided');
    return null;
  }
  if (profile && claimsShortTrack(text, profile)) {
    const y = profile?.eligibility?.leftYear || 'לא ידועה';
    console.warn(`🛑 Guardrail: short-track claim with leftYear=${y} — only 1950-52 / 1964-67 / 1988+ qualify`);
    return null;
  }

  for (const re of FEE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      if (isAllowedFee(m[0])) continue;
      console.warn(`🛑 Guardrail: fee quoted in AI reply → "${m[0]}"`);
      return null;
    }
  }
  if (COMPARATIVE_FEE.some(re => re.test(text))) {
    console.warn('🛑 Guardrail: comparative fee claim');
    return null;
  }
  for (const re of PROMISE_PATTERNS) {
    if (re.test(text)) {
      console.warn('🛑 Guardrail: outcome promise in AI reply');
      return null;
    }
  }
  // A duration attached to this lead's own case — not a general corpus fact.
  if (CASE_SCOPED.test(text) && DURATION.test(text)) {
    console.warn(`🛑 Guardrail: case-specific timeline → "${text.match(DURATION)[0]}"`);
    return null;
  }
  // A route presented as a determination rather than a strong likelihood.
  if (ROUTE_AS_FACT.some(re => re.test(text)) && !HEDGED.test(text)) {
    console.warn('🛑 Guardrail: route stated as settled fact without hedging');
    return null;
  }
  // Revocation status stated as settled fact, with no hedge anywhere in the reply.
  if (STATUS_CERTAINTY.some(re => re.test(text)) && !HEDGED.test(text)) {
    console.warn('🛑 Guardrail: revocation status asserted without hedging');
    return null;
  }
  // Never leak internals
  if (/buyingIntent|nextBestAction|HIGH_INTENT|QUALIFICATION|ניקוד פנימי/i.test(text)) {
    console.warn('🛑 Guardrail: internal state leaked in AI reply');
    return null;
  }
  return text;
}

/** Roll the conversation summary forward without reprocessing full history. */
async function updateSummary(profile, history) {
  if (!isAvailable() || history.length < 6) return profile.conversationSummary || '';
  try {
    const res = await client.messages.create({
      model: config.AI_MODEL_FAST,
      max_tokens: 200,
      system: 'סכם שיחת מכירה בעברית במשפט או שניים. עובדתי, קצר, בלי פרשנות. החזר רק את הסיכום.',
      messages: [{
        role: 'user',
        content:
          `סיכום קודם: ${profile.conversationSummary || 'אין'}\n\n` +
          `הודעות אחרונות:\n${history.slice(-8).map(m => `${m.role === 'user' ? 'לקוח' : 'אנחנו'}: ${m.text}`).join('\n')}\n\n` +
          `כתוב סיכום מעודכן.`,
      }],
    });
    return (res.content?.[0]?.text || '').trim() || profile.conversationSummary || '';
  } catch {
    return profile.conversationSummary || '';
  }
}

module.exports = {
  init,
  isAvailable,
  analyse,
  compose,
  updateSummary,
  enforceGuardrails,
  parseJson,
  getLastCompose,
  clearLastCompose,
  budgetStatus,
};
