/**
 * scenarios.test.js — offline sales behaviour suite.
 *
 * Runs the full conversation engine against a mocked WhatsApp API and an
 * in-memory store. No network, no API key, no cost. Exercises the rule-based
 * path, which is the fallback the customer actually gets when the AI is
 * unavailable — so this is the floor of quality, not the ceiling.
 *
 * Run:  node tests/scenarios.test.js
 */
process.env.AI_MODE = 'off';
process.env.DATABASE_URL = '';
process.env.AGENT_PHONE = '';
process.env.ADMIN_TOKEN = 'test';

const path = require('path');
const Module = require('module');

// ─── Mock the WhatsApp adapter before anything requires it ───────────────────
const sent = [];

// Numbers whose 24-hour window is "closed" for the duration of a test. A send
// to one of these fails exactly the way Meta fails it: code 131047.
const windowClosedFor = new Set();

const waMock = {
  sendTextResult: async (to, text) => {
    if (windowClosedFor.has(to)) return { ok: false, code: 131047, windowClosed: true };
    sent.push({ to, type: 'text', text });
    return { ok: true, id: 'mock' };
  },
  sendText: async (to, text) => (await waMock.sendTextResult(to, text)).ok,
  sendButtons: async (to, body) => { sent.push({ to, type: 'buttons', text: body }); return true; },
  sendList: async (to, body) => { sent.push({ to, type: 'list', text: body }); return true; },
  sendImage: async (to, url) => { sent.push({ to, type: 'image', text: url }); return true; },
  sendTemplate: async () => false,
  markRead: async () => {},
  loadApprovedTemplates: async () => new Set(),
  approvedTemplates: () => new Set(),
  splitMessage: (t) => [t],
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './whatsapp' || request === '../whatsapp') return waMock;
  return originalLoad.apply(this, arguments);
};

const storage = require('../src/storage');
const flows = require('../src/flows');
const leadProfile = require('../src/sales/leadProfile');
const scoring = require('../src/sales/scoring');
const objections = require('../src/sales/objections');
const stages = require('../src/sales/stages');
const brain = require('../src/ai/brain');
const closing = require('../src/sales/closing');
const nextAction = require('../src/sales/nextAction');
const dashboard = require('../src/admin/dashboard');
const prompts = require('../src/ai/prompts');

// ─── Tiny test harness ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Unique per run so a previous run's persisted sessions can never leak in.
const RUN_ID = String(Date.now()).slice(-7);
let phoneCounter = 0;
const created = [];
function newPhone() {
  const p = `972${RUN_ID}${String(++phoneCounter).padStart(2, '0')}`;
  created.push(p);
  return p;
}

async function say(phone, text) {
  sent.length = 0;
  await flows.handleMessage(phone, { type: 'text', id: `m${Date.now()}${Math.random()}`, text: { body: text } });
  return sent.map(s => s.text).join('\n---\n');
}

async function tap(phone, buttonId, title = '') {
  sent.length = 0;
  await flows.handleMessage(phone, {
    type: 'interactive',
    id: `b${Date.now()}${Math.random()}`,
    interactive: { type: 'list_reply', list_reply: { id: buttonId, title } },
  });
  return sent.map(s => s.text).join('\n---\n');
}

function profileOf(phone) {
  return storage.getConversation(phone)?.profile;
}

const TRIGGER = 'שלום! אפשר לקבל מידע נוסף על זה?';

// ─── Suite ────────────────────────────────────────────────────────────────────

async function run() {
  await storage.init();
  console.log('\n\x1b[1m═══ WhatsApp Sales Agent — Scenario Suite ═══\x1b[0m');
  console.log(`AI mode: ${brain.isAvailable() ? 'live' : 'off (rule-based fallback under test)'}`);

  // ── 0. Regression: the production bug from 14 May ──────────────────────────
  section('0. Trigger normalisation (the 14 May dropped-lead bug)');
  {
    check('exact trigger matches', flows.isTriggerMessage(TRIGGER));
    check('trailing whitespace matches', flows.isTriggerMessage(TRIGGER + '  '));
    check('zero-width char matches', flows.isTriggerMessage('שלום!‏ אפשר לקבל מידע נוסף על זה?'));
    check('non-breaking space matches', flows.isTriggerMessage('שלום! אפשר לקבל מידע נוסף על זה?'));
    check('missing question mark matches', flows.isTriggerMessage('שלום! אפשר לקבל מידע נוסף על זה'));
    check('English variant matches', flows.isTriggerMessage('Hello! Can I get more info on this?'));
    check('unrelated text does not match', !flows.isTriggerMessage('כמה עולה דרכון רומני'));
  }

  // ── 1. Unknown number, no trigger — was silently dropped ───────────────────
  section('1. Cold inbound from an unknown number');
  {
    const phone = newPhone();
    const out = await say(phone, 'שלום, ראיתי אתכם בגוגל. אפשר לקבל פרטים?');
    check('bot responds instead of ignoring', out.length > 0, 'no reply sent');
    check('conversation was created', !!profileOf(phone));
    check('source marked organic', profileOf(phone)?.source === 'organic');
  }

  // ── 2. Hot lead ────────────────────────────────────────────────────────────
  section('2. Hot lead — "I want to start, how much?"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אני רוצה להתחיל בתהליך, כמה זה עולה?');
    const p = profileOf(phone);
    check('buying intent rose sharply', p.buyingIntent >= 30, `score=${p.buyingIntent}`);
    check('no fee was quoted', !/\d{3,}\s*(₪|ש"ח|שקל)/.test(out));
    check('explains what drives cost', /מורכבות|משפיע|תיק/.test(out));
  }

  // ── 3. Price objection ─────────────────────────────────────────────────────
  section('3. Price objection — "that\'s too expensive"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבתא שלי נולדה ביאשי');
    const out = await say(phone, 'זה נשמע יקר מדי בשבילי');
    const p = profileOf(phone);
    check('objection detected', (p.objections || []).some(o => o.type === 'price_too_high'),
      JSON.stringify(p.objections));
    check('acknowledges before answering', /מבין|הוגן|נכונה/.test(out));
    check('does not argue or pressure', !/אבל אתה חייב|טעות שלך/.test(out));
    check('still no number quoted', !/\d{3,}\s*(₪|ש"ח|שקל)/.test(out));
  }

  // ── 4. Cheaper competitor ──────────────────────────────────────────────────
  section('4. Competitor — "I found someone cheaper"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'מצאתי משרד אחר שמציע יותר זול');
    const p = profileOf(phone);
    check('objection detected', (p.objections || []).some(o => o.type === 'cheaper_competitor'));
    check('does not disparage the competitor', !/נוכל|רמאי|גרוע/.test(out));
    check('reframes on substance', /בדיקת זכאות|ארכיון|ANC|נדחה/.test(out));
  }

  // ── 5. Information seeker ──────────────────────────────────────────────────
  section('5. Information seeker — "send me more information"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אפשר לקבל מידע על התהליך?');
    check('answers substantively', out.length > 80);
    check('mentions real process stages', /ארכיון|ANC|אפוסטיל|קונסולי/.test(out));
  }

  // ── 6. Skeptical customer ──────────────────────────────────────────────────
  section('6. Sceptic — "how do I know you\'re legitimate?"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'איך אני יודע שאתם לא נוכלים?');
    const p = profileOf(phone);
    check('distrust detected', (p.objections || []).some(o => o.type === 'distrust'));
    check('offers verifiable proof', /03-5517801|02-6249286|pudimlaw|TheMarker/.test(out));
  }

  // ── 7. Not ready ───────────────────────────────────────────────────────────
  section('7. Not ready — "I\'ll think about it"');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אני צריך לחשוב על זה');
    const p = profileOf(phone);
    check('objection detected', (p.objections || []).some(o => o.type === 'think_about_it'));
    // Note: "התחייבות" legitimately contains the substring "חייב", so match
    // actual pressure phrases rather than the bare root.
    check('gives space, no pressure',
      !/אתה חייב|חייב להחליט|עכשיו או לעולם|הצעה מוגבלת|מבצע מוגבל|רק היום/.test(out));
    // Hebrew final-letter trap: /ארכיון/ does NOT match "בארכיונים" (ן vs נ).
    // Match the root instead, and accept the newer "בלי התחייבות" phrasing.
    check('leaves a reason to return',
      /בדיקת זכאות|ללא התחייבות|בלי התחייבות|ארכיו/.test(out));
    // Every departing turn must put one concrete call on the table.
    check('closes to a call with the lawyer',
      /עו״ד פודים/.test(out) && /03-5517801|מה מתאים יותר|מה נוח|מתי נוח/.test(out));
  }

  // ── 7b. Regressions from trainer run 2026-08-28 14:39 ──────────────────────
  section('7b. Trainer regressions — CTA, repetition, leaks');
  {
    // avi scored 45/100: the bot gave the same "no price" reason twice and the
    // lead left for a competitor without leaving any contact detail.
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'כמה עולה?');
    await say(phone, 'אני רק רוצה טווח');
    const out = await say(phone, 'יש לי עוד 2 משרדים שכן ענו');
    // Deliberately NOT a close. Comparing firms is due diligence, not leaving —
    // pushing a meeting here is what cost run 3 and 4. Give value instead.
    check('competitor mention is answered, not closed on',
      out.length > 40 && !/מתי נוח שעו״ד פודים יתקשר/.test(out));
  }
  {
    // dana / yossi: refusing a phone must not end the conversation.
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'מעניין אותי דרכון רומני');
    const out = await say(phone, 'לא נוח לי להשאיר טלפון');
    check('phone refusal still offers a route',
      /03-5517801|info@pudimlaw|שם פרטי/.test(out));
  }
  {
    // Coaching passages are written as instructions to the bot. A customer
    // must never be shown the playbook itself.
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'ספר לי על סעיף 11');
    check('never quotes internal coaching notes',
      !/כשלקוח שואל|זה מה שמאבד אותו|אל תחזור על|לעולם לא לבקש/.test(out));
    check('answers the article question', /סעיף 1[01]|בסרביה|השבת אזרחות/.test(out));
  }

  // ── 7c. Route classification — corrected by the firm 31.08 ────────────────
  //
  // Live chats showed the bot promising the short "הסדרה" track for a departure
  // "sometime in the 50s", and once because the ancestor was BORN in 1955.
  // The short track exists only for departures in 1950-1952 and 1964-1967.
  section('7c. Route classification');
  {
    const cases = [
      { left: '1950', group: 'hesder',     b1: false },
      { left: '1951', group: 'hesder',     b1: false },
      { left: '1952', group: 'hesder',     b1: false },
      { left: '1964', group: 'hesder',     b1: false },
      { left: '1967', group: 'hesder',     b1: false },
      { left: '1953', group: 'article_10', b1: true },
      { left: '1955', group: 'article_10', b1: true },
      { left: '1957', group: 'article_10', b1: true },
      { left: '1963', group: 'article_10', b1: true },
      { left: '1968', group: 'article_10', b1: true },
      { left: '1987', group: 'article_10', b1: true },
      { left: '1948', group: 'article_10', b1: true },
      // From 1988 the practice had stopped — treated as the short track.
      { left: '1988', group: 'hesder',     b1: false },
      { left: '1990', group: 'hesder',     b1: false },
      { left: '2001', group: 'hesder',     b1: false },
    ];
    for (const c of cases) {
      const r = leadProfile.deriveGroup({ leftYear: c.left });
      check(`left ${c.left} → ${c.group}`, r.group === c.group, `got ${r.group}`);
      check(`left ${c.left} → B1 ${c.b1 ? 'required' : 'exempt'}`, !!r.needsB1 === c.b1);
    }

    // Place decides Article 11, and only for territory now in Ukraine/Moldova.
    const cz = leadProfile.deriveGroup({ territory: 'bukovina', birthYear: '1938' });
    check('Chernivtsi → Article 11', cz.group === 'article_11');
    check('Article 11 requires B1', cz.needsB1 === true);
    check('Article 11 reaches great-grandchildren', cz.generationLimit === 'נינים');

    // Post-1988 is an inference, not a documented rule — flag it for the lawyer.
    const late = leadProfile.deriveGroup({ leftYear: '1990' });
    check('post-1988 flagged for verification', late.needsVerification === true);
    const mid = leadProfile.deriveGroup({ leftYear: '1951' });
    check('1951 needs no special verification flag', !mid.needsVerification);

    // No year of departure means no route. Guessing here is the original bug.
    const unknown = leadProfile.deriveGroup({ ancestor: 'סבא', birthPlace: 'בוקרשט' });
    check('no departure year → no route claimed', !unknown.group);

    // A birth year is not a departure year.
    const bornOnly = leadProfile.deriveGroup({ birthYear: '1955' });
    check('birth year alone → no route claimed', !bornOnly.group);
  }
  {
    // The composer may explain the rule, but may not apply the short track to
    // a customer whose departure year does not qualify.
    const blocked = brain.enforceGuardrails(
      'סבא שלך לא ויתר על האזרחות, אז אתה במסלול הקצר בלי B1',
      { eligibility: { leftYear: '1955' } });
    check('short-track claim blocked for 1955', blocked === null);

    const allowed = brain.enforceGuardrails(
      'סבא שלך לא ויתר על האזרחות, אז אתה במסלול הקצר בלי B1',
      { eligibility: { leftYear: '1951' } });
    check('same claim allowed for 1951', allowed !== null);

    const noYear = brain.enforceGuardrails(
      'אתה כנראה במסלול הקצר',
      { eligibility: {} });
    check('short-track claim blocked with no year', noYear === null);

    const general = brain.enforceGuardrails(
      'ככלל, מי שעזב ב-1950-1952 או ב-1964-1967 לא נדרש לוותר על האזרחות',
      { eligibility: { leftYear: '1955' } });
    check('general explanation of the rule allowed', general !== null);
  }

  // ── 7d. From the first live conversation, 2 Sep ───────────────────────────
  section('7d. Live conversation findings');
  {
    const retrieve = require('../src/kb/retrieve');
    // The customer answered "נולדה בשנת 1923 ביאשי" and got a lecture on the
    // structure of the B1 exam. That passage shared no word with the message.
    const noise = retrieve.forIntent('unclear', 'נולדה בשנת 1923 ביאשי', []);
    check('a bare fact retrieves nothing irrelevant',
      !noise.some(p => p.id.startsWith('b1_')), noise.map(p => p.id).join(','));

    // But deliberate context rules must still work.
    const year = retrieve.forIntent('ask_eligibility', 'סבא עזב ב-1951', []);
    check('a departure year still finds the route passage',
      year.some(p => p.id === 'group_1_no_limit'), year.map(p => p.id).join(','));

    const b1 = retrieve.forIntent('ask_b1', 'מה זה B1?', []);
    check('a real B1 question still finds B1 passages',
      b1.some(p => p.id.startsWith('b1_')), b1.map(p => p.id).join(','));
  }
  {
    // The route is a strong likelihood, never a determination.
    const stated = brain.enforceGuardrails(
      'עלייה ב-1961 פירושה שהאזרחות של סבתא אבדה — מסלול השבת אזרחות',
      { eligibility: { leftYear: '1961', birthPlace: 'יאשי' } });
    check('route stated as fact is blocked', stated === null);

    const hedged = brain.enforceGuardrails(
      'לפי שנת העלייה, בסבירות גבוהה מדובר בהשבת אזרחות — אבל זה דורש בדיקה מעמיקה כי יש חריגים',
      { eligibility: { leftYear: '1961', birthPlace: 'יאשי' } });
    check('the same route, hedged, is allowed', hedged !== null);

    const direct = brain.enforceGuardrails(
      'אתה במסלול סעיף 10',
      { eligibility: { leftYear: '1961', birthPlace: 'יאשי' } });
    check('"you are on Article 10" is blocked', direct === null);
  }

  // ── 7e. From the live conversation of 5 Sep ───────────────────────────────
  section('7e. Live conversation, 5 Sep');
  {
    // "בתחילת שנות ה-50" was turned into 1950 and the lead was told, as fact,
    // that citizenship was kept and no B1 was needed. It could have been 1953.
    const approx = leadProfile.deriveGroup({ leftYear: '1951', leftYearApprox: true });
    check('an approximate year classifies nothing', !approx.group);
    check('and asks for the exact year', approx.needsExactLeftYear === true);

    const exact = leadProfile.deriveGroup({ leftYear: '1951' });
    check('an exact year still classifies', exact.group === 'hesder');

    const claim = 'בשנים האלה האזרחות לא אבדה, ההורים שלך נשארו אזרחים ולא תצטרך B1';
    check('short-track claim blocked on an approximate year',
      brain.enforceGuardrails(claim, { eligibility: { leftYear: '1951', leftYearApprox: true } }) === null);
    check('same claim allowed on an exact 1951',
      brain.enforceGuardrails(claim, { eligibility: { leftYear: '1951' } }) !== null);
  }
  {
    const closing = require('../src/sales/closing');
    // The lead said "יום ראשון בבוקר" and was asked "מתי נוח לך?" three more times.
    check('a spoken time counts as scheduled', closing.alreadyScheduled('יום ראשון בבוקר'));
    check('so does a bare "בבוקר"', closing.alreadyScheduled('בבוקר'));
    check('office hours are not an appointment',
      !closing.alreadyScheduled('התקשר 03-5517801 · א׳–ה׳ 09:00–18:00'));
  }

  // ── 8. Angry customer ──────────────────────────────────────────────────────
  section('8. Angry customer');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אני מחכה כבר שבועיים ואף אחד לא חוזר אלי! זה לא רציני');
    check('responds without selling', out.length > 0);
    check('offers escalation path', /נציג|עו״ד|עורך דין|נחזור/.test(out));
  }

  // ── 9. Confused customer ───────────────────────────────────────────────────
  section('9. Confused / unparseable message');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אהה אני לא בטוח מה');
    check('does not crash or go silent', out.length > 0);
    check('offers a way forward', /נציג|לנסח|לעזור|אוכל/.test(out));
  }

  // ── 10. Partial information + context retention ────────────────────────────
  section('10. Context retention — never re-ask a known fact');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await tap(phone, 'interest_eligibility', 'בדיקת זכאות');
    await say(phone, 'סבתא שלי מצד אמא');
    await say(phone, '1931');
    const out = await say(phone, 'צ׳רנוביץ');
    const p = profileOf(phone);

    check('ancestor remembered', !!p.eligibility.ancestor, JSON.stringify(p.eligibility));
    check('birth year remembered', p.eligibility.birthYear === '1931', p.eligibility.birthYear);
    check('birth place remembered', !!p.eligibility.birthPlace);
    check('did not re-ask the birth year', !/שנת הלידה המשוערת/.test(out));
    check('inferred Article 11 from Chernivtsi', p.eligibility.likelyArticle === '11',
      `article=${p.eligibility.likelyArticle} territory=${p.eligibility.territory}`);
  }

  // ── 11. Multiple questions at once ─────────────────────────────────────────
  section('11. Multiple questions in one message');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'כמה זמן זה לוקח וכמה זה עולה ואיפה אתם נמצאים?');
    check('answers rather than deflecting', out.length > 60);
    check('no fee quoted even when asked directly', !/\d{3,}\s*(₪|ש"ח|שקל)/.test(out));
  }

  // ── 12. Returning customer after days ──────────────────────────────────────
  section('12. Customer returns days later');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await tap(phone, 'interest_eligibility', 'בדיקת זכאות');
    await say(phone, 'סבא שלי נולד בבוקרשט');

    // Simulate a 3-day gap
    const session = storage.getConversation(phone);
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    session.profile.lastInboundAt = threeDaysAgo;
    storage.setConversation(phone, session);

    const out = await say(phone, 'היי, חזרתי');
    const p = profileOf(phone);
    check('session survived the gap', !!p.eligibility.ancestor);
    check('responds to the returning customer', out.length > 0);
    check('score decayed while idle', p.buyingIntent < 100);
  }

  // ── 13. Explicit human request ─────────────────────────────────────────────
  section('13. Customer asks for a human');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אני רוצה לדבר עם נציג אנושי');
    const p = profileOf(phone);
    check('escalated to handoff', p.stage === 'HUMAN_HANDOFF', p.stage);
    check('tells the customer naturally', /עו״ד|עורך דין|נציג|נחזור/.test(out));
    check('shares business hours', /09:00|שעות פעילות/.test(out));
  }

  // ── 14. High-value customer, full journey to lead ──────────────────────────
  section('14. High-value lead — full journey');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await tap(phone, 'interest_eligibility', 'בדיקת זכאות');
    await say(phone, 'סבתא מצד אבא');
    await say(phone, '1927');
    await say(phone, 'יאשי');
    await say(phone, '1950');
    await say(phone, 'דוד כהן');
    const out = await say(phone, '0541234567');
    const p = profileOf(phone);

    check('name captured', p.name === 'דוד כהן', p.name);
    check('phone captured', p.clientPhone === '0541234567', p.clientPhone);
    check('stage reached CONVERSION', p.stage === 'CONVERSION', p.stage);
    check('lead marked saved', storage.getConversation(phone).leadSaved === true);
    check('confirmation sent to customer', /תודה|מצוין|קיבלנו/.test(out));

    const leads = await storage.getAllLeads();
    const mine = leads.find(l => l.waPhone === phone);
    check('lead persisted with eligibility data', !!mine && mine.birthYear === '1927',
      JSON.stringify(mine && { y: mine.birthYear, c: mine.city }));
    check('lead carries a buying-intent score', typeof mine?.buyingIntent === 'number');
  }

  // ── 15. B1 course path ─────────────────────────────────────────────────────
  section('15. B1 course enquiry');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await tap(phone, 'interest_romanian_course', 'קורס רומנית B1');
    const p = profileOf(phone);
    check('interest recorded as b1_course', p.interest.includes('b1_course'));
    check('mentions Sibiu university', /סיביו/.test(out));
    check('asks for the name', /שמך המלא/.test(out));
    check('bot is not stuck', storage.getConversation(phone).state === 'LEAD_NAME');
  }

  // ── 16. Spam / irrelevant ──────────────────────────────────────────────────
  section('16. Spam and irrelevant messages');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'BUY CHEAP CRYPTO NOW http://spam.example');
    check('does not crash', typeof out === 'string');
    check('does not follow the link or engage', !/crypto/i.test(out));
  }

  // ── 17. Opt-out ────────────────────────────────────────────────────────────
  section('17. Opt-out is honoured');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'הסר');
    const p = profileOf(phone);
    check('marked opted out', p.optedOut === true);
    check('confirms removal', /הוסרת|לא נשלח/.test(out));
    check('stage set to lost', p.stage === 'LOST_NOT_NOW');
  }

  // ── 18. Guardrails (unit level) ────────────────────────────────────────────
  section('18. Guardrails');
  {
    check('blocks shekel amounts', brain.enforceGuardrails('העלות היא 15,000 ₪ בלבד') === null);
    check('blocks "ש״ח" amounts', brain.enforceGuardrails('זה יעלה 8000 ש"ח') === null);
    check('blocks euro amounts', brain.enforceGuardrails('המחיר 3000 יורו') === null);
    check('blocks outcome promises', brain.enforceGuardrails('אני מבטיח שהבקשה תאושר') === null);
    check('blocks 100% claims', brain.enforceGuardrails('100% הצלחה מובטח') === null);
    check('blocks internal state leaks', brain.enforceGuardrails('הניקוד שלך buyingIntent 85') === null);
    check('allows the €50 B1 exam fee', brain.enforceGuardrails('דמי הרישום לבחינה כ-50 יורו') !== null);
    check('allows the 220 ₪ consulate renewal fee',
      brain.enforceGuardrails('אגרת חידוש הדרכון בקונסוליה היא 220 ₪ במזומן') !== null);
    check('allows the 250 ₪ child passport fee',
      brain.enforceGuardrails('אגרת דרכון לילד 250 ₪ במזומן') !== null);
    check('allows the 40 ₪ apostille fee',
      brain.enforceGuardrails('אגרת אפוסטיל עומדת על 40 ₪') !== null);
    check('still blocks an unlisted shekel amount',
      brain.enforceGuardrails('שכר הטרחה שלנו 9,500 ₪') === null);
    check('allows normal copy', brain.enforceGuardrails('נשמח לחזור אליך לשיחת ייעוץ') !== null);

    // Response-time promises — Tal Yehoshua, 9 Sep: promised "דקות ספורות",
    // waited 35 minutes, deadline passed.
    check('blocks "דקות ספורות"',
      brain.enforceGuardrails('עו״ד פודים יחזור אליך תוך דקות ספורות') === null);
    check('blocks "בשעה הקרובה"',
      brain.enforceGuardrails('מישהו מהמשרד יתקשר אליך בשעה הקרובה') === null);
    check('blocks "מיד" + callback',
      brain.enforceGuardrails('אני מעביר את זה עכשיו ומיד נחזור אליך') === null);
    check('blocks "תוך שעה"',
      brain.enforceGuardrails('תקבל תשובה תוך שעה') === null);
    check('allows offering time slots as a question',
      brain.enforceGuardrails('מתי נוח שעו״ד פודים יחזור אליך — היום אחר הצהריים או מחר בבוקר?') !== null);
    check('allows the length of the consultation itself',
      brain.enforceGuardrails('שיחת הייעוץ אורכת כ-15 דקות, ללא עלות') !== null);
    check('allows the office number without a clock',
      brain.enforceGuardrails('אפשר גם להתקשר ישירות: 03-5517801 · א׳–ה׳ 09:00–18:00') !== null);
  }

  // ── 19. Hebrew morphology (the old matcher\'s blind spot) ──────────────────
  section('19. Hebrew prefix handling');
  {
    check('matches bare "עלות"', scoring.hasPhrase('כמה עלות התהליך', 'עלות'));
    check('matches prefixed "העלות"', scoring.hasPhrase('מה העלות של זה', 'עלות'));
    check('matches prefixed "בעלות"', scoring.hasPhrase('מדובר בעלות גבוהה', 'עלות'));
    check('matches prefixed "שהמחיר"', scoring.hasPhrase('שמעתי שהמחיר גבוה', 'מחיר'));

    // The old matcher fired "children" on "בן משפחה" — verify we no longer do
    const p = leadProfile.create('972500000000');
    const a = flows.ruleBasedAnalysis('מי בן משפחה שנולד ברומניה', p);
    check('does not misfire children on "בן משפחה"', a.intent !== 'ask_children', a.intent);
  }

  // ── 20. Scoring behaviour ──────────────────────────────────────────────────
  section('20. Buying-intent scoring');
  {
    const base = leadProfile.create('972500000001');
    const meeting = scoring.score('מתי אפשר להיפגש?', base);
    const idle = scoring.score('אחשוב על זה', { ...base, buyingIntent: 50 });
    const phoneGiven = scoring.score('הטלפון שלי 0541234567', base);

    check('meeting request scores high', meeting.score >= 25, `score=${meeting.score}`);
    check('"think about it" reduces score', idle.score < 50, `score=${idle.score}`);
    check('volunteering a phone number scores', phoneGiven.matched.includes('gave_phone'));
    check('score is clamped to 0-100', scoring.score('מתי אפשר להיפגש? כמה עולה? רוצה להתחיל!',
      { ...base, buyingIntent: 95 }).score <= 100);
  }

  // ── 21. Stage machine ──────────────────────────────────────────────────────
  section('21. Funnel stage transitions');
  {
    check('advances forward', stages.shouldAdvance('DISCOVERY', 'QUALIFICATION') === 'QUALIFICATION');
    check('does not regress', stages.shouldAdvance('HIGH_INTENT', 'DISCOVERY') === 'HIGH_INTENT');
    check('objection can interrupt', stages.shouldAdvance('HIGH_INTENT', 'OBJECTION') === 'OBJECTION');
    check('allows skipping ahead', stages.shouldAdvance('NEW_LEAD', 'HIGH_INTENT') === 'HIGH_INTENT');
    check('converted stays converted', stages.shouldAdvance('CONVERSION', 'DISCOVERY') === 'CONVERSION');
  }

  // ── 22. Profile merge safety ───────────────────────────────────────────────
  section('22. Lead profile merging');
  {
    let p = leadProfile.create('972500000002');
    p = leadProfile.merge(p, { eligibility: { ancestor: 'סבתא', birthYear: '1927' } });
    p = leadProfile.merge(p, { eligibility: { ancestor: null, birthPlace: 'יאשי' } });

    check('null never erases a known value', p.eligibility.ancestor === 'סבתא');
    check('new facts are added', p.eligibility.birthPlace === 'יאשי');
    // A Romanian birthplace records the territory but must NOT pick a route —
    // the year of departure decides between הסדרה and Article 10.
    check('Iași records territory, not an article',
      ['romania_proper', 'moldavia_ro'].includes(p.eligibility.territory) && !p.eligibility.likelyArticle,
      `article=${p.eligibility.likelyArticle} territory=${p.eligibility.territory}`);

    p = leadProfile.merge(p, { objections: [{ type: 'price_too_high' }] });
    p = leadProfile.merge(p, { objections: [{ type: 'price_too_high', resolved: true }] });
    check('objections deduplicate', p.objections.length === 1);
    check('objection resolution is recorded', p.objections[0].resolved === true);
  }

  // ── 23. A name is not a contact detail ─────────────────────────────────────
  //     8 Sep: שמשון לזר and מרקוביץ ליאת each gave a name, were never asked
  //     for a number, and were never reachable again.
  section('23. Phone collection when only a name is known');
  {
    const named = () => {
      const p = leadProfile.create('972500000003');
      p.name = 'שמשון לזר';
      p.messageCount = 4;
      p.motivation = 'דרכון לילדים';
      return p;
    };

    const d = nextAction.decide({
      analysis: { intent: 'unclear' }, profile: named(), text: 'שמשון לזר',
    });
    check('a name with no number triggers a contact request',
      d.action === 'request_contact', `action=${d.action}`);
    check('and the ask is for a phone number, not "פרטים"',
      /טלפון|מספר/.test(d.fallbackText || ''), d.fallbackText);

    // A cold score must not suppress it — this is the exact hole the two lost
    // leads fell through: score 0, threshold 70, nobody ever asked.
    const cold = named();
    cold.buyingIntent = 0;
    check('a cold score does not suppress the ask',
      nextAction.decide({ analysis: { intent: 'unclear' }, profile: cold, text: 'אוקיי' })
        .action === 'request_contact');

    // A direct question is still answered — with the phone ask appended.
    const asked = nextAction.decide({
      analysis: { intent: 'ask_cost' }, profile: named(), text: 'כמה זה עולה?',
    });
    check('a direct question is still answered first',
      asked.action === 'answer_question', `action=${asked.action}`);
    check('and the phone ask rides along with the answer',
      asked.appendContactAsk === true);

    // Once we have the number, stop asking.
    const withPhone = named();
    withPhone.clientPhone = '0521234567';
    check('having the number ends the asking',
      nextAction.decide({ analysis: { intent: 'unclear' }, profile: withPhone, text: 'תודה רבה' })
        .action !== 'request_contact');

    // A bare name, typed as the answer to "מה שמך המלא?", must be recognised —
    // otherwise the bot asks for the name again and never reaches the number.
    const asked_name = { history: [{ role: 'assistant', text: 'כדי שנחזור אליך — *מה שמך המלא?*' }] };
    const blank = () => leadProfile.create('972500000004');
    check('a bare name after a name question is captured',
      flows.ruleBasedAnalysis('שמשון לזר', blank(), asked_name).profileUpdates.name === 'שמשון לזר');
    check('a one-word name is captured too',
      flows.ruleBasedAnalysis('ליאת', blank(), asked_name).profileUpdates.name === 'ליאת');
    check('"כן" is not a name',
      !flows.ruleBasedAnalysis('כן', blank(), asked_name).profileUpdates.name);
    check('a phone number is not a name',
      !flows.ruleBasedAnalysis('0521234567', blank(), asked_name).profileUpdates.name);
    check('a bare word with no name question is not a name',
      !flows.ruleBasedAnalysis('שמשון לזר', blank(),
        { history: [{ role: 'assistant', text: 'באיזו שנה עלתה סבתא לישראל?' }] })
        .profileUpdates.name);
    check('a known name is never overwritten', (() => {
      const p = blank(); p.name = 'דנה';
      return !flows.ruleBasedAnalysis('משהו אחר', p, asked_name).profileUpdates.name;
    })());

    // The ladder steps down only after a real refusal — never because a
    // question was reworded. The 100-score four-person file on 7 Sep was
    // handed an email address without ever being asked for a number.
    const fresh = named();
    check('no refusal → still the phone ask',
      /טלפון|מספר/.test(closing.nextContactAsk(fresh, { seed: 1 })));
    check('no refusal → not an email offer',
      !/מייל|info@/.test(closing.nextContactAsk(fresh, { seed: 1 })));
    const refused = named();
    refused.contactRefusals = 2;
    check('after refusals the ladder does step down',
      /מייל|info@/.test(closing.nextContactAsk(refused)));
    check('phone-ask wording varies between turns',
      closing.nextContactAsk(fresh, { seed: 0 }) !== closing.nextContactAsk(fresh, { seed: 1 }));
  }

  // ── 24. The weekly page ────────────────────────────────────────────────────
  section('24. Weekly summary');
  {
    const w = await dashboard.weekly(7);
    check('returns one row per day', w.days.length === 7, `days=${w.days.length}`);
    check('the last row is today', w.days[6].date ===
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()), w.days[6].date);
    check('every day is labelled and counted',
      w.days.every(d => d.label && Number.isInteger(d.started) && Number.isInteger(d.captured)
                        && Number.isInteger(d.died)));
    check('totals add up to the daily rows',
      w.totals.started === w.days.reduce((n, d) => n + d.started, 0)
      && w.totals.captured === w.days.reduce((n, d) => n + d.captured, 0));
    check('a day with no conversations has no conversion rate',
      w.days.every(d => d.started > 0 ? typeof d.conversionRate === 'number' : d.conversionRate === null));
    check('unhandled hot leads come back as a list', Array.isArray(w.unhandledHot));
    check('idle time is never negative',
      w.unhandledHot.every(l => l.hoursIdle === null || l.hoursIdle >= 0));
    check('questions and objections are ranked',
      Array.isArray(w.topQuestions) && Array.isArray(w.topObjections)
      && w.topQuestions.every((q, i, a) => i === 0 || a[i - 1].count >= q.count));

    // A one-message lead is exactly what the page exists to count.
    const dead = '972500000099';
    await say(dead, 'היי, ראיתי מודעה על דרכון רומני');
    const w2 = await dashboard.weekly(7);
    check('a lead who wrote once is not yet counted as dead (2h grace)',
      w2.totals.diedAtFirstMessage === w.totals.diedAtFirstMessage,
      `${w.totals.diedAtFirstMessage} → ${w2.totals.diedAtFirstMessage}`);
  }

  // ── 25. The opening-message experiment ─────────────────────────────────────
  section('25. Opening-message A/B');
  {
    const experiment = require('../src/sales/experiment');

    check('assignment is stable for the same number',
      experiment.assign('972501111111') === experiment.assign('972501111111'));
    check('assignment only ever returns a known variant',
      ['A', 'B'].includes(experiment.assign('972502222222')));
    check('a missing number does not throw and falls back to control',
      experiment.assign(undefined) === 'A' && experiment.assign('') === 'A');

    // Uniformity: a 45/55 split over 10k numbers would still be fine, but a
    // hash that leans harder than that would quietly bias the experiment.
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 10000; i++) counts[experiment.assign('97250' + i)]++;
    const share = counts.A / (counts.A + counts.B);
    check('the split is even to within 2 points', Math.abs(share - 0.5) < 0.02,
      `A=${counts.A} B=${counts.B}`);

    check('both variants have an opening and they differ',
      experiment.opening('A') && experiment.opening('B')
      && experiment.opening('A') !== experiment.opening('B'));
    check('an unknown variant falls back to the control copy',
      experiment.opening('Z') === experiment.opening('A'));

    // Compliance — CL-004 is a possibility, never a determination, and no
    // response time may be promised.
    const b = experiment.opening('B');
    check('the challenger hedges eligibility', b.includes('עשוי'));
    check('the challenger includes the third degree', b.includes('סבא-רבא'));
    check('the challenger offers a safe answer', b.includes('לא בטוח'));
    check('no variant promises a response time',
      !/דקות ספורות|תוך .* דקות|מיד חוזר/.test(experiment.opening('A') + b));

    // A greeted lead carries its variant, and the variant matches the pure
    // function — this is what the rollup groups by.
    const phone = '972500000077';
    await say(phone, 'היי');
    const prof = require('../src/storage').getConversation(phone)?.profile;
    check('a greeted lead is stamped with a variant',
      prof && ['A', 'B'].includes(prof.openingVariant), String(prof?.openingVariant));
    check('the stamp matches the pure assignment',
      prof?.openingVariant === experiment.assign(phone));

    const w = await dashboard.weekly(7);
    check('the weekly page reports the experiment', Array.isArray(w.byVariant));
    check('every variant row is internally consistent',
      w.byVariant.every(v => v.died <= v.mature && v.mature <= v.conversations
                             && v.leadsCaptured <= v.conversations));
  }

  // ── 26. The 24 Sep review of two weeks of live conversations ───────────────
  section('26. Counting every conversation');
  {
    // Every ad lead sends the trigger phrase, and that path never logged the
    // event — so the weekly page read started=0 on all 14 days of September.
    const phone = newPhone();
    await say(phone, TRIGGER);
    const events = await storage.getEvents({ since: new Date(Date.now() - 60000).toISOString(), limit: 500 });
    const started = events.filter(e => e.type === 'conversation_started' && e.waPhone === phone);
    check('a lead arriving through the ad trigger is counted', started.length === 1,
      `${started.length} events`);
    check('the event carries the variant it was greeted with',
      ['A', 'B'].includes(started[0]?.data?.variant), String(started[0]?.data?.variant));

    // A restart must not count the same lead twice.
    await say(phone, 'תפריט');
    const again = (await storage.getEvents({ since: new Date(Date.now() - 60000).toISOString(), limit: 500 }))
      .filter(e => e.type === 'conversation_started' && e.waPhone === phone);
    check('a restart does not count the lead again', again.length === 1, `${again.length} events`);

    const organic = newPhone();
    await say(organic, 'שלום, ראיתי אתכם בגוגל');
    const o = (await storage.getEvents({ since: new Date(Date.now() - 60000).toISOString(), limit: 500 }))
      .filter(e => e.type === 'conversation_started' && e.waPhone === organic);
    check('an organic lead is still counted exactly once', o.length === 1, `${o.length} events`);
  }

  section('27. A single character is not a new lead');
  {
    // 0547787804 got the opening message 22 mornings in a row, because a
    // single letter is a substring of the trigger phrase.
    check('"י" is not the trigger', !flows.isTriggerMessage('י'));
    check('"ח" is not the trigger', !flows.isTriggerMessage('ח'));
    check('"h" is not the trigger', !flows.isTriggerMessage('h'));
    check('"שלום" alone is not the trigger', !flows.isTriggerMessage('שלום'));
    check('a truncated trigger still matches',
      flows.isTriggerMessage('שלום! אפשר לקבל מידע נוסף'));
    check('the full trigger still matches', flows.isTriggerMessage(TRIGGER));

    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'ח');
    check('a one-letter message gets a nudge, not the opening',
      !out.includes('מי במשפחה נולד ברומניה'), out.slice(0, 60));
    check('and the nudge invites a real message', /לשאול|לכתוב/.test(out));

    // A lead already handed to the office is greeted as a returning client.
    const known = newPhone();
    await say(known, TRIGGER);
    const p = profileOf(known);
    p.name = 'דנה'; p.clientPhone = '0521234567'; p.stage = 'HUMAN_HANDOFF';
    const back = await say(known, TRIGGER);
    check('a handed-over lead is not put back through the opening',
      back.includes('טוב לשמוע ממך שוב'), back.slice(0, 60));
  }

  section('28. A number is not optional');
  {
    // אורלי, קרן and ליאורה each agreed a time and were never asked.
    const named = () => {
      const p = leadProfile.create('972500000201');
      p.name = 'קרן שרייבר'; p.messageCount = 6; p.motivation = 'דרכון לילדים';
      p.buyingIntent = 65;
      return p;
    };

    const closingTurn = nextAction.decide({
      analysis: { intent: 'unclear' }, profile: named(),
      text: 'מתי שנוח אני אתפנה לשיחה תודה', recentClose: true,
    });
    check('a recent close no longer silences the phone ask',
      /טלפון|מספר/.test(closingTurn.fallbackText || '') ||
      /מספר טלפון/.test(closingTurn.directive || ''), closingTurn.action);

    const handover = nextAction.decide({
      analysis: { intent: 'request_human' }, profile: named(), text: 'אשמח שתצרו איתי קשר',
    });
    check('a handover asks for the number too',
      /מספר/.test(handover.fallbackText || ''), handover.fallbackText);

    const ready = nextAction.decide({
      analysis: { intent: 'ready_to_start' }, profile: named(), text: 'בוקר 11 מתאים לי',
    });
    check('agreeing a time asks for the number too',
      /מספר/.test(ready.fallbackText || ''), ready.fallbackText);

    // With a number in the file, nothing is appended.
    const withPhone = named();
    withPhone.clientPhone = '0544355222';
    const done = nextAction.decide({
      analysis: { intent: 'ready_to_start' }, profile: withPhone, text: 'בוקר מצוין',
    });
    check('a lead with a number is not asked again',
      !/ולאיזה מספר/.test(done.fallbackText || ''));
    // And a refusal is still respected.
    const refused = named();
    refused.contactRefusals = 1;
    check('a refusal is still respected',
      !/ולאיזה מספר/.test(closing.withPhoneAsk('נדבר בקרוב.', refused)));
  }

  section('29. "You never called me back"');
  {
    check('detects the complaint', closing.signalsMissedCallback('שלום לא חזרתם אלי'));
    check('detects it in the other wording', closing.signalsMissedCallback('עדיין לא דיברנו'));
    check('detects "nobody called"', closing.signalsMissedCallback('אף אחד לא התקשר אליי'));
    check('an ordinary message is not a complaint',
      !closing.signalsMissedCallback('מתי נוח לכם לחזור אליי?'));

    const p = leadProfile.create('972500000202');
    p.name = 'יוסי'; p.clientPhone = '0506204180'; p.buyingIntent = 100;
    const d = nextAction.decide({ analysis: { intent: 'unclear' }, profile: p, text: 'שלום לא חזרתם אלי' });
    check('it escalates', d.escalate === true && d.action === 'escalate_human');
    check('it is marked urgent', d.urgent === true);
    check('it apologises and does not re-pitch',
      /מתנצל/.test(d.fallbackText) && !/מתי נוח/.test(d.fallbackText), d.fallbackText);

    // "We already spoke" is the opposite instruction.
    check('detects "we already spoke"', closing.signalsAlreadySpoke('היי. שוחחנו אתמול. הכול בסדר. תודה'));
    check('"we have NOT spoken yet" is not that',
      !closing.signalsAlreadySpoke('עדיין לא דיברנו'));
    const d2 = nextAction.decide({
      analysis: { intent: 'unclear' }, profile: p, text: 'אין צורך שיתקשר, שוחחנו אתמול',
    });
    check('it stops instead of re-coordinating',
      d2.suppressFollowUp === true && !/מתי נוח/.test(d2.fallbackText || ''));
  }

  section('30. Follow-ups, files, language and gender');
  {
    const followup = require('../src/followup/scheduler');

    // 0526604546 had a call booked and was asked for his details again.
    const booked = leadProfile.create('972500000203');
    booked.stage = 'HIGH_INTENT';
    booked.clientPhone = '0526604546';
    booked.lastInboundAt = new Date(Date.now() - 48 * 3600000).toISOString();
    check('a lead whose number we already have is never chased',
      followup.evaluate(booked) === null);

    const noNumber = leadProfile.create('972500000204');
    noNumber.stage = 'QUALIFICATION';
    noNumber.lastInboundAt = new Date(Date.now() - 48 * 3600000).toISOString();
    check('a lead with no number can still be followed up',
      followup.evaluate(noNumber) !== null);

    const stopped = leadProfile.create('972500000205');
    stopped.stage = 'QUALIFICATION';
    stopped.followUpsSuppressed = true;
    stopped.lastInboundAt = new Date(Date.now() - 48 * 3600000).toISOString();
    check('a lead who said "we already spoke" is never chased again',
      followup.evaluate(stopped) === null);

    // The English arm of the ad.
    const en = newPhone();
    const enOut = await say(en, 'Hello! Can I get more info on this?');
    check('an English opener is answered in English',
      /Hi!|Hello/.test(enOut) && !/הגעת למשרד/.test(enOut), enOut.slice(0, 70));
    check('and the language is recorded', profileOf(en)?.lang === 'en');

    const he = newPhone();
    await say(he, TRIGGER);
    check('a Hebrew opener is still Hebrew', profileOf(he)?.lang === 'he');

    // Grammatical gender, read off the customer's own verbs.
    const she = newPhone();
    await say(she, TRIGGER);
    await say(she, 'אני מעוניינת להוציא דרכון לילדיי');
    check('a woman writing in the feminine is recorded as such',
      profileOf(she)?.gender === 'f', String(profileOf(she)?.gender));
    check('the prompt tells the model to use the feminine',
      /בלשון נקבה/.test(prompts.composeSystem(profileOf(she), [], [])));

    // A file that arrives is acknowledged as arrived.
    const withFile = newPhone();
    await say(withFile, TRIGGER);
    sent.length = 0;
    await flows.handleMessage(withFile, {
      type: 'image', id: `img${Date.now()}`, image: { id: 'media-1', mime_type: 'image/jpeg' },
    });
    const ack = sent.map(s => s.text).join('\n');
    check('a document is acknowledged as received', /קיבלתי/.test(ack), ack.slice(0, 60));
    check('and never reported as failed to upload',
      !/לא רואה|לא עלתה|לא הגיע/.test(ack), ack.slice(0, 80));
  }

  section('31. Route attributes, certainty and truncation');
  {
    check('blocks "no generation limit" on a restoration route',
      brain.enforceGuardrails('האזרחות חוזרת בשיקום, ללא מגבלה לדורות') === null);
    check('blocks it when the route is Article 10',
      brain.enforceGuardrails('המסלול שלך הוא סעיף 10, והזכות עוברת ללא מגבלת דורות') === null);
    check('allows it for הסדרת רישום, where it is true',
      brain.enforceGuardrails('במסלול של הסדרת רישום אין מגבלת דורות — האזרחות לא אבדה') !== null);
    check('blocks certainty about this family',
      brain.enforceGuardrails('הסבא שלך נולד ברומניה ולכן הילדים שלך בוודאות זכאים') === null);
    check('allows a hedged assessment',
      brain.enforceGuardrails('לפי מה שסיפרת זה נראה כמו מסלול הסדרת רישום, אבל צריך לאמת מול הרשויות') !== null);

    check('a truncated reply is cut back to a whole sentence',
      brain.trimToWholeSentence(
        'שאלה טובה. התשובה תלויה בשנת העזיבה, וזה מה שקובע את המסלול. יש לך דרך לברר את השנה מהמסמ'
      ) === 'שאלה טובה. התשובה תלויה בשנת העזיבה, וזה מה שקובע את המסלול.');
    check('a promise of a list that never came is dropped',
      brain.trimToWholeSentence('מכאן שלושה מסלולים:') === '');
  }

  section('32. A passage is not an answer');
  {
    const retrieve = require('../src/kb/retrieve');
    // ליבי asked what the process is and what it costs, and was handed the
    // three-year passport deadline.
    const q = 'אבי עלה ב-1951 ואני רוצה להוציא דרכון רומני לי ולילדיי. מה ההליך וכמה זה עולה?';
    const cost = retrieve.forIntent('ask_cost', q, []);
    check('a cost question retrieves cost material',
      cost.every(h => (h.topics || []).some(t => /מחיר|עלות/.test(t))),
      cost.map(h => h.id).join(','));
    check('and not the passport deadline',
      !cost.some(h => h.id === 'passport_3_year_deadline'), cost.map(h => h.id).join(','));
    check('an off-topic intent returns nothing rather than something wrong',
      retrieve.forIntent('ask_b1', 'מי במשפחה נולד ברומניה')
        .every(h => (h.topics || []).some(t => /b1|שפה|בחינה|פטור|דדליין/i.test(t))));
  }

  section('33. The waiting list');
  {
    const waiting = leadProfile.create('972500000206');
    waiting.name = 'פנינה'; waiting.clientPhone = '0523364545';
    waiting.buyingIntent = 100; waiting.stage = 'HUMAN_HANDOFF';
    waiting.humanStatus = 'notified';
    waiting.lastInboundAt = new Date(Date.now() - 200 * 3600000).toISOString();
    storage.setConversation('972500000206', { profile: waiting, history: [], startedAt: waiting.firstSeenAt });

    const list = dashboard.waitingForCallback({ minHours: 12 });
    const row = list.find(l => l.phone === '972500000206');
    check('a lead waiting days appears on the list', !!row);
    check('with the hours it has been waiting', row && row.hoursWaiting >= 199, String(row?.hoursWaiting));

    waiting.humanStatus = 'handled';
    storage.setConversation('972500000206', { profile: waiting, history: [], startedAt: waiting.firstSeenAt });
    check('marking it handled takes it off the list',
      !dashboard.waitingForCallback({ minHours: 12 }).some(l => l.phone === '972500000206'));

    const fresh = leadProfile.create('972500000207');
    fresh.name = 'חדש'; fresh.clientPhone = '0500000000';
    fresh.buyingIntent = 100; fresh.stage = 'HUMAN_HANDOFF'; fresh.humanStatus = 'notified';
    fresh.lastInboundAt = new Date().toISOString();
    storage.setConversation('972500000207', { profile: fresh, history: [], startedAt: fresh.firstSeenAt });
    check('a lead from an hour ago is not nagged about yet',
      !dashboard.waitingForCallback({ minHours: 12 }).some(l => l.phone === '972500000207'));
  }

  // ── Aggregate stats for the marketing system ───────────────────────────────
  {
    const statsApi = require('../src/admin/stats');
    const mk = (phone, intent, adId, saved) => {
      const pr = leadProfile.create(phone);
      pr.name = 'שם פרטי ' + phone; pr.clientPhone = '0500000999';
      pr.buyingIntent = intent;
      pr.attribution = adId ? { sourceId: adId, headline: 'H-' + adId, ctwaClid: 'clid-' + phone } : undefined;
      storage.setConversation(phone, { profile: pr, history: [], startedAt: new Date().toISOString(), leadSaved: !!saved });
      created.push(phone);
    };
    mk('972500000301', 80, 'AD1', true);
    mk('972500000302', 20, 'AD1', false);
    mk('972500000303', 90, 'AD2', true);
    mk('972547787804', 100, 'AD1', true); // the owner's own number: never a lead
    const s = statsApi.summary({ days: 1 });
    const ad1 = s.byAd.find(a => a.adId === 'AD1');
    const ad2 = s.byAd.find(a => a.adId === 'AD2');
    check('stats: per-ad conversation counts', ad1 && ad1.conversations === 2 && ad2 && ad2.conversations === 1);
    check('stats: the owner\'s own number is excluded', s.excluded.internalConversations >= 1 && ad1.conversations === 2);
    check('stats: qualified share uses the hot-lead threshold', ad1.qualified === 1 && ad1.qualifiedShare === 0.5);
    check('stats: average buying intent per ad', ad1.averageBuyingIntent === 50);
    const raw = JSON.stringify(s);
    check('stats: no names, phone numbers or clids leak into the output',
      !raw.includes('שם פרטי') && !raw.includes('0500000999') && !raw.includes('97250000030') && !raw.includes('clid-'));
    let threw = false;
    try { statsApi.summary({ since: 'not-a-date' }); } catch { threw = true; }
    check('stats: a bad date is rejected, not guessed', threw);
  }

  // ── 34. The office meeting ─────────────────────────────────────────────────
  section('34. Meeting slots');
  {
    const meeting = require('../src/sales/meeting');
    const SUN_MORNING = Date.parse('2026-10-11T06:00:00Z');   // Sunday 09:00 Israel
    const THU_EVENING = Date.parse('2026-10-08T15:00:00Z');   // Thursday 18:00 Israel

    const slots = meeting.nextSlots({ now: SUN_MORNING });
    check('two slots are offered', slots.length === 2);
    check('the first is today, 17:00', /ראשון.*17:00/.test(slots[0].label), slots[0].label);
    check('the second is a different day',
      slots[0].label.slice(0, 10) !== slots[1].label.slice(0, 10), slots.map(s => s.label).join(' | '));
    check('no slot is in the past',
      slots.every(s => s.at > SUN_MORNING));
    check('every slot is inside the 17:00–19:00 window',
      meeting.nextSlots({ count: 8, now: SUN_MORNING })
        .every(s => meeting.MEETING_HOURS.includes(s.hour)));
    check('no slot falls on Friday or Saturday',
      meeting.nextSlots({ count: 10, now: THU_EVENING })
        .every(s => ![5, 6].includes(new Date(s.at).getUTCDay()) || s.hour >= 14),
      'weekend slot offered');
    check('Thursday evening rolls over to Sunday',
      /ראשון/.test(meeting.nextSlots({ now: THU_EVENING })[0].label),
      meeting.nextSlots({ now: THU_EVENING })[0].label);
    check('a slot needs lead time — 17:00 is not offered at 16:00',
      !meeting.nextSlots({ now: Date.parse('2026-10-11T13:00:00Z') })
        .some(s => /11\.10/.test(s.label)));
    check('a slot another lead holds is not offered twice', (() => {
      const taken = meeting.nextSlots({ now: SUN_MORNING })[0].iso;
      return !meeting.nextSlots({ now: SUN_MORNING, taken: [taken] })
        .some(s => s.iso === taken);
    })());

    // Reading the answer.
    check('"יום שני" picks Monday',
      meeting.parseSlotChoice('יום שני מתאים לי', slots)?.label === slots[1].label);
    check('"השני" means the second option, not Monday',
      meeting.parseSlotChoice('השני', slots)?.label === slots[1].label);
    check('"הראשון" means the first option',
      meeting.parseSlotChoice('הראשון בבקשה', slots)?.label === slots[0].label);
    check('a day we never offered books nothing',
      meeting.parseSlotChoice('יום רביעי ב-17:00', slots) === null);
    check('an unrelated message books nothing',
      meeting.parseSlotChoice('אני עוד אחשוב על זה', slots) === null);

    // The gate: a Romanian-born relative is required, plus ONE route fact.
    // The three-fact version shut the gate on exactly the readiest leads —
    // שופט מלי (born there herself, left 1960, documents in hand, score 96),
    // אבי רבינוביץ (both parents, left 1964) and מרדכי כהן (left 1948,
    // certificate in hand, score 100) were never asked which city, so none of
    // them was ever offered a meeting.
    check('a relative alone is not enough to spend an evening on', (() => {
      const p = leadProfile.create('972500000301');
      p.eligibility = { ancestor: 'סבתא' };
      return !meeting.isReadyForMeeting(p);
    })());
    check('relative plus the place they were born opens the gate', (() => {
      const p = leadProfile.create('972500000311');
      p.eligibility = { ancestor: 'סבתא', birthPlace: 'יאשי' };
      return meeting.isReadyForMeeting(p);
    })());
    check('relative plus the year they left opens it too — אבי רבינוביץ', (() => {
      const p = leadProfile.create('972500000312');
      p.eligibility = { ancestor: 'הורים', leftYear: '1964' };
      return meeting.isReadyForMeeting(p);
    })());
    check('documents already in hand open it — מרדכי כהן', (() => {
      const p = leadProfile.create('972500000313');
      p.eligibility = { ancestor: 'עצמי', hasDocuments: true };
      return meeting.isReadyForMeeting(p);
    })());
    check('and no relative at all keeps it shut', (() => {
      const p = leadProfile.create('972500000314');
      p.eligibility = { birthPlace: 'יאשי', leftYear: '1961', hasDocuments: true };
      return !meeting.isReadyForMeeting(p);
    })());
    check('someone who already said no is not asked again', (() => {
      const p = leadProfile.create('972500000302');
      p.eligibility = { ancestor: 'סבא', birthPlace: 'בוקרשט', leftYear: '1950' };
      p.meeting = { ...p.meeting, declines: 1 };
      return !meeting.isReadyForMeeting(p);
    })());

    check('every message carries the office address and both map links', (() => {
      const p = leadProfile.create('972500000303');
      const t = meeting.pendingText(p, slots[0]) + meeting.confirmedText(p, slots[0]) +
                meeting.reminderText(p, slots[0]);
      return t.includes('אשכנזי 21') && t.includes('google.com/maps') && t.includes('waze.com');
    })());
    check('a video meeting offers no street address', (() => {
      const p = leadProfile.create('972500000304');
      return !meeting.confirmedText(p, slots[0], 'video').includes('אשכנזי 21');
    })());
    check('no message promises a price or a response time', (() => {
      const p = leadProfile.create('972500000305');
      const t = meeting.offerText(p) + meeting.pendingText(p, slots[0]) +
                meeting.slotPrompt(slots) + meeting.confirmedText(p, slots[0]);
      return !/\d{3,}\s*(₪|ש"ח|שקל)/.test(t) && !/דקות ספורות|תוך .{0,6}דקות/.test(t);
    })());
    check('the bot never calls an unconfirmed slot final',
      !/מאושר|סגור סופית/.test(meeting.pendingText(leadProfile.create('972500000306'), slots[0])));
  }

  section('35. Booking a meeting end to end');
  {
    const meeting = require('../src/sales/meeting');
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבתא שלי');
    // The gate opens as soon as the route is clear enough to be worth an
    // evening — a relative plus ONE of place / year / documents. It used to
    // demand all three, and in two weeks of live traffic that produced zero
    // offers against 34 leads whose route was clear.
    const offer = await say(phone, 'היא נולדה ביאשי');

    check('a clear route triggers the meeting offer',
      /פגישה/.test(offer) && /אשכנזי 21/.test(offer), offer.slice(0, 80));
    check('the offer says it costs nothing', /ללא עלות/.test(offer));
    // Since 16 Oct the offer carries two real evenings straight away instead of
    // "רוצה שנקבע?" followed by a second round-trip.
    check('and the meeting is recorded as offered',
      ['offered', 'slots_proposed'].includes(profileOf(phone)?.meeting?.status));
    check('the offer already carries two real evenings',
      /בשעה 1[78]:00/.test(offer), offer.slice(0, 200));

    // The year still gets asked for — the offer does not swallow qualification.
    await say(phone, 'עלתה ב-1961');

    const afterYes = await say(phone, 'כן בשמחה');
    check('saying yes asks for the details to hold the slot',
      /שם|טלפון/.test(afterYes) && /לשריין/.test(afterYes), afterYes.slice(0, 70));

    await say(phone, 'דנה לוי');
    const withSlots = await say(phone, '0541234567');
    check('once reachable, real times are offered',
      /בשעה 1[78]:00/.test(withSlots), withSlots.slice(0, 100));
    check('the slots came from the 17:00–19:00 window',
      (profileOf(phone)?.meeting?.offered || []).every(s => [17, 18].includes(s.hour)));

    const booked = await say(phone, 'הראשון');
    check('picking one records the request',
      profileOf(phone)?.meeting?.status === 'requested');
    check('and the reply carries the address and navigation',
      /אשכנזי 21/.test(booked) && /waze\.com/.test(booked));
    check('and the document list', /תעודות לידה/.test(booked));
    check('nothing was promised as confirmed',
      /לאישור|אעביר/.test(booked) && !/^✅/.test(booked));
    check('the lead was still captured as a lead',
      !!profileOf(phone)?.name && !!profileOf(phone)?.clientPhone);

    // The whole point of the feature, as a number.
    const w = await dashboard.weekly(7);
    check('the weekly page counts meetings',
      typeof w.totals.meetingsOffered === 'number'
      && typeof w.totals.meetingsRequested === 'number'
      && w.totals.meetingsRequested >= 1, JSON.stringify(w.totals.meetingsRequested));
    check('and lists them with the slot',
      dashboard.meetings().some(m => m.phone === phone && m.status === 'requested'));
  }

  section('36. When the customer cannot come in');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבא שלי');
    await say(phone, 'נולד בבוקרשט');
    await say(phone, 'עזב ב-1950');
    const abroad = await say(phone, 'אני בחו״ל עד סוף החודש');
    check('being abroad turns it into a video meeting, not a lesser offer',
      profileOf(phone)?.meeting?.mode === 'video' || /וידאו/.test(abroad),
      abroad.slice(0, 70));

    await say(phone, 'יעל ברק');
    const slots = await say(phone, '0537654321');
    check('a video meeting still offers real times', /בשעה 1[78]:00/.test(slots));
    check('and does not send anyone to an address',
      !/אשכנזי/.test(slots) || /וידאו/.test(slots), slots.slice(0, 80));
    check('the mode stuck across turns', profileOf(phone)?.meeting?.mode === 'video');
  }

  section('37. Declining the meeting');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'אמא שלי');
    await say(phone, 'נולדה בקלוז');
    await say(phone, 'עזבה ב-1964');
    const no = await say(phone, 'לא נוח לי להגיע, עדיף טלפון');

    check('a refusal is accepted and turned into a call',
      /שיחה|יחזור|טלפון|03-5517801/.test(no), no.slice(0, 80));
    check('it is recorded as declined',
      profileOf(phone)?.meeting?.status === 'declined');
    check('and the bot does not ask a second time', (() => {
      const meeting = require('../src/sales/meeting');
      return !meeting.isReadyForMeeting(profileOf(phone));
    })());
    check('the phone number is still pursued',
      /מספר|טלפון/.test(no), no.slice(0, 80));
  }

  section('38. The owner is not a lead');
  {
    const config = require('../src/config');
    const agent = config.OWNER_PHONE;

    // An earlier section seeded his number to prove /stats excludes it. Clear
    // it so this section measures only what handleMessage does.
    storage.deleteConversation(agent);
    await storage.flush();

    sent.length = 0;
    await flows.handleMessage(agent, {
      type: 'text', id: `agent-${RUN_ID}-1`, text: { body: TRIGGER },
    });
    const reply = sent.filter(s => s.to === agent).map(s => s.text).join('\n');

    check('the trigger phrase from his own number opens no conversation',
      !storage.getConversation(agent));
    check('he is not asked about his grandmother',
      !/בן משפחה|סבת|זכאות שלך/.test(reply), reply.slice(0, 100));
    check('he gets a status reply instead',
      /החלון פתוח/.test(reply), reply.slice(0, 100));

    // Three more messages: under the old code these counted toward the
    // 60-message ceiling that eventually made the bot stop answering him.
    for (let i = 2; i <= 4; i++) {
      await flows.handleMessage(agent, {
        type: 'text', id: `agent-${RUN_ID}-${i}`, text: { body: 'מה המצב' },
      });
    }
    check('and no session is built up however much he writes',
      !storage.getConversation(agent));
    check('so the message ceiling can never hand him over to himself',
      !storage.getConversation(agent)?.profile?.humanStatus);
  }

  section('39. An alert the closed window would have eaten');
  {
    const config = require('../src/config');
    const handoff = require('../src/sales/handoff');
    const alertQueue = require('../src/sales/alertQueue');
    const agent = config.OWNER_PHONE;
    const marker = `אבי-${RUN_ID}`;

    config.AGENT_PHONES.push(agent);
    windowClosedFor.add(agent);
    sent.length = 0;

    const res = await handoff.notifyAgents(`🔔 ליד חדש — ${marker}`);
    check('a send into a closed window is not counted as delivered', res.sent === 0);
    check('and it is held instead of dropped', res.queued === 1, JSON.stringify(res));
    check('nothing reached the agent', !sent.some(s => s.to === agent));

    await storage.flush();
    const waiting = await alertQueue.pending(agent);
    check('the alert is in the queue', waiting.length >= 1, `${waiting.length}`);
    check('with its text intact',
      waiting.some(w => w.data.text.includes(marker)));

    // He writes to the bot. That single message reopens the window.
    windowClosedFor.delete(agent);
    sent.length = 0;
    await flows.handleMessage(agent, {
      type: 'text', id: `agent-${RUN_ID}-flush`, text: { body: 'בוקר טוב' },
    });
    const delivered = sent.filter(s => s.to === agent).map(s => s.text).join('\n');

    check('the held alert goes out the moment he writes',
      delivered.includes(marker), delivered.slice(0, 120));
    check('with the time it was created',
      /התראה מ-/.test(delivered), delivered.slice(0, 120));

    await storage.flush();
    const after = await alertQueue.pending(agent);
    check('and the queue is empty afterwards', after.length === 0, `${after.length}`);

    // A failure that is NOT the window must not be queued — retrying it
    // forever would just repeat a broken send.
    const realSend = waMock.sendTextResult;
    waMock.sendTextResult = async () => ({ ok: false, code: 131026, detail: 'undeliverable' });
    const hard = await handoff.notifyAgents('🔔 ליד חדש — לא ניתן למסירה');
    waMock.sendTextResult = realSend;
    check('a non-window failure is reported, not queued',
      hard.failed === 1 && hard.queued === 0, JSON.stringify(hard));

    config.AGENT_PHONES.length = 0;
  }

  section('40. Internal numbers are off every count');
  {
    const config = require('../src/config');
    const agent = config.OWNER_PHONE;

    // Exactly the state his number was actually in on 11 Oct: score 100,
    // handed over, a phone number on file, waiting 40 hours.
    storage.setConversation(agent, {
      state: 'DONE',
      startedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
      history: [],
      profile: {
        waPhone: agent,
        name: 'יהונתן',
        clientPhone: '0547787804',
        buyingIntent: 100,
        stage: 'HUMAN_HANDOFF',
        humanStatus: 'notified',
        messageCount: 63,
        firstSeenAt: new Date(Date.now() - 20 * 86400000).toISOString(),
        lastInboundAt: new Date(Date.now() - 40 * 3600000).toISOString(),
        eligibility: { ancestor: 'סבתא', birthPlace: 'יאשי', leftYear: 1950 },
        meeting: { status: 'requested', slotIso: new Date(Date.now() + 86400000).toISOString(), slotLabel: 'מחר' },
      },
    });
    await storage.flush();

    const hot = await dashboard.hotList(50);
    check('he is not at the top of the hot list',
      !hot.some(r => r.phone === agent), JSON.stringify(hot.slice(0, 1)));

    check('he is not on the waiting-for-a-callback list',
      !dashboard.waitingForCallback().some(r => r.phone === agent));

    check('he is not booked into a meeting with himself',
      !dashboard.meetings({ includePast: true }).some(r => r.phone === agent));

    const week = await dashboard.weekly(30);
    check('he is not an unhandled hot lead on the weekly page',
      !week.unhandledHot.some(r => r.phone === agent));

    const f = await dashboard.funnel(30);
    const clientCount = Object.keys(storage.getAllConversations())
      .filter(p => !config.isAgentPhone(p)).length;
    check('and he is not counted as an active conversation',
      f.overview.activeConversations === clientCount,
      `${f.overview.activeConversations} vs ${clientCount}`);

    storage.deleteConversation(agent);
    await storage.flush();
  }

  section('42. The office meeting is the close, not a phone call at 09:00');
  {
    // אבי רבינוביץ's file as it actually stood on 10 Oct: both parents born in
    // Romania, left in 1964, name taken, number about to arrive. He was never
    // asked which city, so under the old gate the meeting was unreachable —
    // and the close he got was "בוקר (09:00-12:00) או אחר הצהריים".
    const phone = newPhone();
    const seeded = leadProfile.create(phone);
    seeded.name = 'אבי רבינוביץ';
    seeded.eligibility = { ...seeded.eligibility, ancestor: 'ההורים', leftYear: '1964' };
    seeded.stage = 'QUALIFICATION';
    storage.setConversation(phone, {
      state: 'WELCOME_SENT', startedAt: new Date().toISOString(),
      history: [{ role: 'assistant', text: 'ומה מספר הטלפון שלך?', at: new Date().toISOString() }],
      profile: seeded,
    });

    const close = await say(phone, '052-2688218');

    check('a captured lead is offered a real slot, not a morning window',
      /בשעה 1[78]:00/.test(close), close.slice(0, 120));
    check('the old "בוקר 09:00-12:00" close is gone for good',
      !/09:00-12:00|14:00-18:00/.test(close), close.slice(0, 120));
    check('the slot is in the office, with an address',
      /אשכנזי 21/.test(close) || /משרד/.test(close), close.slice(0, 120));
    check('and it is recorded as a meeting on the table',
      profileOf(phone)?.meeting?.status === 'slots_proposed',
      String(profileOf(phone)?.meeting?.status));
    check('the lead itself was still captured',
      !!profileOf(phone)?.name && !!profileOf(phone)?.clientPhone);

    const w = await dashboard.weekly(7);
    check('and the weekly page stops reporting zero meetings offered',
      w.totals.meetingsOffered >= 1, String(w.totals.meetingsOffered));

    // The old copy must not survive anywhere the model can copy it from.
    const fs = require('fs');
    const examples = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'examples.js'), 'utf8');
    check('no example teaches the model the morning/afternoon phone close',
      !/09:00-12:00|14:00-18:00/.test(examples));
  }

  section('43. A time given once is not asked for twice');
  {
    const closing = require('../src/sales/closing');

    // Every one of these is a real answer a lead typed, and every one of them
    // was followed by the identical question a minute later.
    check('"אחהצ בסביבות 18" counts as a time — פרץ רוב, 4 Oct',
      closing.alreadyScheduled('אחהצ בסביבות 18'));
    check('"מ9 עד 12" counts as a time — שופט מלי, 13 Oct',
      closing.alreadyScheduled('מ9 עד 12'));
    check('"שעות אחה״צ." counts as a time — מרדכי כהן, 5 Oct',
      closing.alreadyScheduled('שעות אחה״צ.'));
    check('but "איתור לוקח 2-6 חודשים" is not an appointment',
      !closing.alreadyScheduled('איתור המסמכים בארכיונים לוקח 2-6 חודשים'));
    check('and neither is "אצור קשר מחר"',
      !closing.alreadyScheduled('אצור קשר מחר'));
    check('nor an age or a birth year',
      !closing.alreadyScheduled('בן 80') &&
      !closing.alreadyScheduled('נולדה ב-1916 ועזבה ב-1948'));

    check('a handed-off lead who named a time is confirmed, not re-asked', (() => {
      const p = leadProfile.create('972500000401');
      p.name = 'מלי'; p.clientPhone = '0542403011';
      const t = closing.callClose(p, { variant: 'handoff_confirmed' });
      return /מועד שסיכמנו/.test(t) && !/מה נוח לך יותר|מתי נוח/.test(t);
    })());

    // End to end: the lead gives a time, and the whole turn asks nothing.
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבא שלי נולד בבוקרשט');
    await say(phone, 'עזב ב-1961');
    await say(phone, 'יוסי לוי');
    await say(phone, '0541112222');
    const after = await say(phone, 'אחהצ בסביבות 18');
    const timeQuestions = (after.match(/מתי נוח|מה נוח לך יותר|בוקר או אחר הצהריים/g) || []).length;
    check('no time question comes back after the lead named one',
      timeQuestions === 0, after.slice(0, 140));
  }

  section('44. Nobody in the family is Romanian');
  {
    const scheduler = require('../src/followup/scheduler');
    const ASK = '*מי במשפחה נולד ברומניה?* (הורה / סב / סבתא)';

    check('"אין לנו רומנים בדורות הקודמים" is heard — 8 Oct',
      leadProfile.signalsNoRomanianRelative('עד כמה שידוע לי, אין לנו רומנים בדורות הקודמים.'));
    check('a bare "אף אחד." is heard, in answer to that question',
      leadProfile.signalsNoRomanianRelative('אף אחד.', ASK));
    check('but not in answer to a different question',
      !leadProfile.signalsNoRomanianRelative('אף אחד.', 'יש לך תעודות של סבא?'));
    check('"אין לי מסמכים" is the opposite of this and must not match',
      !leadProfile.signalsNoRomanianRelative('אין לי מסמכים', ASK)
      && !leadProfile.signalsNoRomanianRelative('אין לי תעודת לידה של אמא'));
    check('"אין לי אם כך לא רלוונטי העניין עבורי" is heard — 4 Oct',
      leadProfile.signalsNoRomanianRelative('אין לי אם כך לא רלוונטי העניין עבורי'));

    const phone = newPhone();
    await say(phone, TRIGGER);
    const out = await say(phone, 'אין לנו רומנים במשפחה');

    check('the bot says so plainly',
      /אין בסיס|אין זכאות/.test(out), out.slice(0, 90));
    check('and does not hand a non-lead to the lawyer',
      !/מעביר את הפרטים|יחזור אליך אישית/.test(out), out.slice(0, 120));
    check('and asks for no time and no number',
      !/מתי נוח|מספר הטלפון|מה נוח לך יותר/.test(out), out.slice(0, 120));
    check('the stage is "אין זכאות", not "הועבר לנציג"',
      profileOf(phone)?.stage === 'NOT_ELIGIBLE', String(profileOf(phone)?.stage));
    check('the door is left open',
      /תכתוב לי|נבדוק שוב|בהצלחה/.test(out));

    check('the follow-up engine will never write to them',
      scheduler.evaluate(profileOf(phone)) === null);

    // 8 Oct: told there was no basis, then chased on the 11th to ask which
    // Romanian city the relative was born in, and again on the 12th.
    const aged = profileOf(phone);
    aged.lastInboundAt = new Date(Date.now() - 10 * 86400000).toISOString();
    aged.stage = 'QUALIFICATION';           // even if the stage moved on
    check('not even ten days later, whatever the stage says',
      scheduler.evaluate(aged) === null);

    check('and they are not counted as a human handoff',
      !/HUMAN_HANDOFF/.test(String(profileOf(phone)?.stage)));
  }

  section('45. כן and לא are answers');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבא שלי נולד בבוקרשט');
    // מרדכי כהן answered "כן" to "יש לך נכדים מתחת לגיל 18?" and was told his
    // message had arrived incomplete.
    const yes = await say(phone, 'כן');
    check('"כן" is not treated as a truncated message',
      !/לא הגיע לי טקסט מלא|נשלחה חלקית/.test(yes), yes.slice(0, 80));

    const phone2 = newPhone();
    await say(phone2, TRIGGER);
    const no = await say(phone2, 'לא');
    check('"לא" is not either',
      !/לא הגיע לי טקסט מלא|נשלחה חלקית/.test(no), no.slice(0, 80));

    // A genuinely truncated message still gets the nudge.
    const phone3 = newPhone();
    await say(phone3, TRIGGER);
    const junk = await say(phone3, 'ש');
    check('but a stray single letter still does',
      /לא הגיע לי טקסט מלא|נשלחה חלקית/.test(junk), junk.slice(0, 80));
  }

  section('46. Who was born in Romania — the phrasings leads actually use');
  {
    const read = (t) => {
      const p = leadProfile.create(newPhone());
      return flows.ruleBasedAnalysis(t, p).profileUpdates.eligibility;
    };
    // Four leads in two weeks said they were born in Romania themselves —
    // פאני, מרדכי, שופט מלי and the lead of 3 Oct. None of them set `ancestor`,
    // so every gate that needs to know who was born there stayed shut.
    check('"אני ילידת רומניה" names the relative — פאני זילברמן',
      !!read('אני ילידת רומניה אזרחית מעוניינת בדרכון לבני ונכדיי').ancestor);
    check('"אני נולדתי ברומניה ועליתי ב-1948" gives relative and year — מרדכי כהן',
      (() => { const e = read('אני נולדתי ברומניה ועליתי עם הורי ארצה ב 1948');
               return !!e.ancestor && e.leftYear === '1948'; })());
    check('"ההורים" counts as a relative — אבי רבינוביץ',
      !!read('ההורים').ancestor);
    check('"אבא ואמא" too — פרץ רוב',
      !!read('אבא ואמא').ancestor);
    check('"עליתי לישראל ב1960" is an emigration year, not a birth year — שופט מלי',
      read('עליתי לישראל ב1960 בהיותי בת 3').leftYear === '1960');
    check('a name answer is not mistaken for a relative — אבי רבינוביץ',
      (() => {
        const p = leadProfile.create(newPhone());
        const s = { history: [{ role: 'assistant', text: 'מה שמך המלא?' }] };
        const u = flows.ruleBasedAnalysis('אבי רבינוביץ', p, s).profileUpdates;
        return u.name === 'אבי רבינוביץ' && !u.eligibility.ancestor;
      })());
  }

  section('47. Language and gender stick to the customer');
  {
    const scheduler = require('../src/followup/scheduler');

    check('Hebrew is detected', flows.detectLang('שלום, מה המצב') === 'he');
    check('English is detected', flows.detectLang('Hello, can I get more info') === 'en');

    // 8 Oct: opened in English, wrote Hebrew, and the replies alternated
    // English / Hebrew / English across three consecutive turns.
    const phone = newPhone();
    await say(phone, 'Hello! Can I get more info on this?');
    check('an English opener is recorded as English',
      profileOf(phone)?.lang === 'en');
    await say(phone, 'עד כמה שידוע לי, סבתא שלי נולדה ברומניה');
    check('a switch to Hebrew sticks',
      profileOf(phone)?.lang === 'he', String(profileOf(phone)?.lang));
    await say(phone, 'ביאשי');
    check('and it stays Hebrew on the next turn too',
      profileOf(phone)?.lang === 'he', String(profileOf(phone)?.lang));

    check('every follow-up step has English copy', (() => {
      const steps = Object.values(scheduler.SEQUENCES).flat();
      return steps.length > 0 && steps.every(s => typeof s.messageEn !== 'undefined');
    })());
    check('and no Hebrew leaks into it', (() => {
      const p = { name: 'Dana', lang: 'en' };
      return Object.values(scheduler.SEQUENCES).flat().every(s => {
        const t = typeof s.messageEn === 'function' ? s.messageEn(p) : s.messageEn;
        return !/[֐-׿]/.test(String(t));
      });
    })());

    // שופט מלי, 13 Oct — called "אתה" four times.
    check('"אני ילידת רומניה" reads as feminine — פאני, שופט מלי',
      flows.detectGender('אני ילידת רומניה אזרחית') === 'f');
    check('"בהיותי בת 3" reads as feminine — שופט מלי',
      flows.detectGender('עליתי לישראל ב1960 בהיותי בת 3') === 'f');
    check('"צריכה" reads as feminine',
      flows.detectGender('אמרתי שצריכה דרכון') === 'f');
    check('"יליד רומניה" reads as masculine',
      flows.detectGender('אני יליד רומניה') === 'm');
    check('"רוצה" is the same word in both genders and must not decide',
      flows.detectGender('אני רוצה דרכון') === null);
    check('neither does a sentence about a grandmother',
      flows.detectGender('סבתא שלי נולדה ביאשי') === null);

    check('the prompt forbids mixing genders in one message',
      /אסור לערבב זכר ונקבה/.test(prompts.composePrompt
        ? prompts.composePrompt({ profile: { gender: 'f' } }) || ''
        : '') || /אסור לערבב/.test(require('fs')
        .readFileSync(path.join(__dirname, '..', 'src', 'ai', 'prompts.js'), 'utf8')));
  }

  section('48. The prompt\'s furniture never reaches a customer');
  {
    // Word for word what יצחק פוקס received on 5 Oct at 17:42.
    const real = 'מדבר: עוזר משרד פודים\n\n---\n\nמצוין! 🙂 אמא שלך נולדה במוינשט ב-1925 ועלתה ב-1948.';

    check('a role header is detected as scaffolding',
      brain.leaksScaffold(real));
    check('and stripped, keeping the answer underneath',
      (() => {
        const out = brain.stripScaffold(real);
        return out.startsWith('מצוין!') && !/מדבר:/.test(out) && !/---/.test(out);
      })(), brain.stripScaffold(real).slice(0, 40));
    check('a stripped reply then passes the guardrails',
      brain.enforceGuardrails(brain.stripScaffold(real), { eligibility: {} }) !== null);

    check('a bare divider line fails the reply over to the script',
      brain.leaksScaffold('מעולה 🙂\n\n---\n\nמה שמך?'));
    check('a transcript label does too',
      brain.leaksScaffold('לקוח: אני מעוניין\nאנחנו: מצוין'));
    check('and so does the internal analysis block',
      brain.leaksScaffold('ניתוח פנימי: כוונה ask_cost') &&
      brain.leaksScaffold('ההודעה האחרונה של הלקוח: שלום'));
    check('guardrails reject it outright',
      brain.enforceGuardrails('מעולה 🙂\n\n---\n\nמה שמך?', { eligibility: {} }) === null);

    // Ordinary Hebrew that happens to contain a colon must survive untouched.
    const fine = 'שלושה שלבים: הסדרת האזרחות, הוצאת המסמכים, ובקשה לדרכון.';
    check('an ordinary sentence with a colon is left alone',
      !brain.leaksScaffold(fine) && brain.stripScaffold(fine) === fine);
    const alsoFine = 'מה שמך המלא? ואם נוח לך להתקשר: 03-5517801';
    check('and so is a phone number after a colon',
      !brain.leaksScaffold(alsoFine) && brain.stripScaffold(alsoFine) === alsoFine);
  }

  section('49. Twenty documents is not a 7/100 lead');
  {
    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'סבא וסבתא');

    const sendFile = async (name, type = 'document') => {
      sent.length = 0;
      await flows.handleMessage(phone, {
        type, id: `f${Math.random()}`,
        [type]: { id: `media${Math.random()}`, filename: name, mime_type: 'application/pdf' },
      });
      return sent.map(s => s.text).join('\n');
    };

    const first = await sendFile('Birth Certificate Or Harel HD.pdf');
    check('the file is acknowledged', /קיבלתי/.test(first), first.slice(0, 60));
    check('and the name is asked for in the same breath',
      /מה שמך המלא/.test(first), first.slice(0, 160));
    check('documents are recorded as being in hand',
      profileOf(phone)?.eligibility?.hasDocuments === true);

    const p1 = profileOf(phone);
    check('one file already makes this a lead worth calling',
      (p1?.buyingIntent || 0) >= 70, String(p1?.buyingIntent));
    check('and the stage moves to high intent',
      p1?.stage === 'HIGH_INTENT', String(p1?.stage));

    // The burst window suppresses the chatter but must still record and score.
    await sendFile('photo1.jpg', 'image');
    await sendFile('photo2.jpg', 'image');
    const p2 = profileOf(phone);
    check('a pile of files scores higher than one',
      (p2?.buyingIntent || 0) >= 85, String(p2?.buyingIntent));
    check('every file is kept, not just the first',
      (p2?.documents || []).length === 3, String((p2?.documents || []).length));

    check('the scorer counts files in the file, not talk about files', (() => {
      const withTalk = scoring.score('יש לי תעודת לידה', leadProfile.create(newPhone()));
      const withFiles = scoring.score('', { ...leadProfile.create(newPhone()), documents: [1, 2, 3] });
      return withFiles.score > withTalk.score;
    })());

    const hot = await dashboard.hotList(50);
    check('the lead is on the hot list now',
      hot.some(r => r.phone === phone && r.score >= 70),
      JSON.stringify(hot.find(r => r.phone === phone)?.score));
  }

  section('50. The weekly page and the waiting list tell the same story');
  {
    const phone = newPhone();
    // גנץ פנינה's file as it stood on 13 Oct: score 100, handed over, a number
    // on file, idle 289 hours — and marked handled.
    storage.setConversation(phone, {
      state: 'COMPLETE',
      startedAt: new Date(Date.now() - 12 * 86400000).toISOString(),
      history: [],
      profile: {
        ...leadProfile.create(phone),
        name: 'גנץ פנינה',
        clientPhone: '0523364545',
        buyingIntent: 100,
        stage: 'HUMAN_HANDOFF',
        humanStatus: 'handled',
        messageCount: 25,
        firstSeenAt: new Date(Date.now() - 12 * 86400000).toISOString(),
        lastInboundAt: new Date(Date.now() - 289 * 3600000).toISOString(),
      },
    });
    await storage.flush();

    const week = await dashboard.weekly(14);
    const waiting = dashboard.waitingForCallback();

    check('a handled lead is off the waiting list',
      !waiting.some(r => r.phone === phone));
    check('and off the weekly "nobody called them" list too',
      !week.unhandledHot.some(r => r.phone === phone),
      JSON.stringify(week.unhandledHot.find(r => r.phone === phone)));
    check('the two lists agree about her', (() => {
      const onWeekly = week.unhandledHot.some(r => r.phone === phone);
      const onWaiting = waiting.some(r => r.phone === phone);
      return onWeekly === onWaiting;
    })());

    // Un-handle her and both lists must pick her up again.
    const back = storage.getConversation(phone);
    back.profile.humanStatus = 'notified';
    storage.setConversation(phone, back);
    await storage.flush();

    const week2 = await dashboard.weekly(14);
    check('un-marking her puts her back on both',
      week2.unhandledHot.some(r => r.phone === phone)
      && dashboard.waitingForCallback().some(r => r.phone === phone));

    const hot = await dashboard.hotList(100);
    check('the hot list reports handled status and document count per row',
      hot.length > 0 && hot.every(r =>
        typeof r.handled === 'boolean' && typeof r.documents === 'number'));

    check('the weekly page counts leads with no Romanian relative',
      typeof week2.totals.notEligible === 'number');
    check('and counts documents received',
      typeof week2.totals.documentsReceived === 'number');

    storage.deleteConversation(phone);
    await storage.flush();
  }

  section('51. No conversion without a name and a number');
  {
    check('the stage cannot be set to CONVERSION on an empty file', (() => {
      let p = leadProfile.create(newPhone());
      p.stage = 'DISCOVERY';
      p = leadProfile.merge(p, { stage: 'CONVERSION' });
      return p.stage === 'HIGH_INTENT';
    })());
    check('but it can once the details are there', (() => {
      let p = leadProfile.create(newPhone());
      p.name = 'דנה לוי'; p.clientPhone = '0541234567';
      p = leadProfile.merge(p, { stage: 'CONVERSION' });
      return p.stage === 'CONVERSION';
    })());
    check('a name with no number is still not a conversion', (() => {
      let p = leadProfile.create(newPhone());
      p.name = 'דנה לוי';
      p = leadProfile.merge(p, { stage: 'CONVERSION' });
      return p.stage !== 'CONVERSION';
    })());

    // "אצור קשר מחר" is the customer saying SHE will call US.
    check('"אצור קשר מחר" is not an appointment we made',
      !closing.alreadyScheduled('אצור קשר מחר'));

    const phone = newPhone();
    await say(phone, TRIGGER);
    await say(phone, 'הורים של בעלי');
    await say(phone, 'צריך לבדוק נראה לי 1943');
    await say(phone, 'אצור קשר מחר');
    const p = profileOf(phone);
    check('and the file does not claim a conversion — 12 Oct',
      p?.stage !== 'CONVERSION', String(p?.stage));
    check('nor is a lead saved for someone we cannot reach',
      !p?.name || !p?.clientPhone);
  }

  section('52. The lead who never answered the welcome');
  {
    const scheduler = require('../src/followup/scheduler');
    const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
    const silent = (extra = {}) => ({
      ...leadProfile.create(newPhone()),
      stage: 'INITIAL_ENGAGEMENT',
      messageCount: 1,
      ...extra,
    });

    check('half an hour is too soon',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(0.5) })) === null);
    check('about an hour later, one nudge is due',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(1.5) }))?.stage === 'FIRST_TOUCH');
    check('two days later the moment has gone and nothing is sent',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(48) })) === null);
    check('and it is only ever sent once',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2), followUpsSent: 1 })) === null);
    check('a lead who did reply gets the normal sequences, not this',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2), messageCount: 4 })) === null);
    check('someone with no Romanian relative is never nudged',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2), notEligible: true })) === null);
    check('neither is someone who already left a number',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2), clientPhone: '0541234567' })) === null);
    check('nor someone who opted out',
      scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2), optedOut: true })) === null);

    const due = scheduler.evaluate(silent({ lastInboundAt: hoursAgo(2) }));
    const copy = due.step.message({});
    check('the nudge asks one question and makes no pitch',
      (copy.match(/\?/g) || []).length === 1 && !/עלות|מחיר|פגישה|שיחה עם/.test(copy), copy);
    check('it gives them a way out',
      /אין בעיה|לא הזמן/.test(copy));
    check('and it has English copy for the English arm',
      typeof due.step.messageEn === 'function'
      && !/[֐-׿]/.test(due.step.messageEn({})));
  }

  section('53. The transcript is what was actually sent');
  {
    // Three replies in the 8–10 Oct transcripts end mid-word. The messages went
    // out whole; it was the stored history that was cut at 500 characters — so
    // the owner could not audit what was said, and the model was shown its own
    // last turn truncated and repeated whole passages it had already sent.
    const phone = newPhone();
    // Push through the real path so the limit under test is the real one.
    await say(phone, TRIGGER);
    const hist = storage.getConversation(phone)?.history || [];
    check('a stored message is no longer clipped at 500 characters',
      hist.every(h => h.text.length <= 2000)
      && hist.some(h => h.role === 'assistant'),
      String(hist.length));

    const flowsSrc = require('fs')
      .readFileSync(path.join(__dirname, '..', 'src', 'flows.js'), 'utf8');
    check('and the limit is wide enough for a full legal passage',
      /MAX_HISTORY_TEXT = 2000/.test(flowsSrc));
    check('nothing still slices history at 500',
      !/text: String\(text\)\.slice\(0, 500\)/.test(flowsSrc));
  }

  section('54. The city spellings leads actually type');
  {
    // Both of these were missed, so neither file ever recorded a birthplace —
    // and the birthplace is what decides the route.
    check('"ביאש" is Iași — פאני זילברמן, 8 Oct',
      leadProfile.detectPlace('נולדתי ביאש')?.territory === 'moldavia_ro');
    check('"מוינשט" is Moinești — יצחק פוקס, 5 Oct',
      leadProfile.detectPlace('אמא נולדה במוינשט')?.territory === 'moldavia_ro');
    check('"בוטושן" is Botoșani — עמית אהרונוביץ׳, 4 Oct',
      leadProfile.detectPlace('אבא נולד בבוטושן')?.territory === 'moldavia_ro');
    check('"נסאוד" is in Transylvania, not Moldavia — עופר, 10 Oct',
      leadProfile.detectPlace('נסאוד 1948')?.territory === 'transylvania');
    check('and Herța still points at Article 11',
      leadProfile.detectPlace('בהרצה')?.article === '11');
    check('while a Romanian birthplace still sets no article',
      leadProfile.detectPlace('ביאש')?.article === null);
  }

  section('55. Trainer findings, 1 Sep — fixed 14 Oct');
  {
    // A list heading with the list cut off ("מכאן שלושה מסלולים:")
    const passage = require('../src/kb/corpus').PASSAGES
      ?.find(p => p.id === 'groups_overview')?.text || '';
    const trimmed = flows.trimToWhatsApp(passage, 480);
    check('a trimmed passage never ends on a heading that promises a list',
      trimmed.length > 0 && !/:\s*$/.test(trimmed), trimmed.slice(-60));
    check('and the groups passage no longer stops at "מכאן שלושה מסלולים:"',
      !/מכאן שלושה מסלולים:\s*$/.test(trimmed));

    // "מעביר את הפרטים" with no details to pass
    const noPhone = closing.callClose({ name: 'שירה' }, { variant: 'handoff' });
    check('a handoff with no phone on file does not claim to pass details on',
      !noPhone.includes('מעביר את הפרטים'), noPhone);
    check('and asks for the number instead',
      /מספר/.test(noPhone) && noPhone.includes(closing.OFFICE_PHONE));
    const withPhone = closing.callClose({ name: 'שירה', clientPhone: '0527364829' }, { variant: 'handoff' });
    check('with a phone on file the handoff is unchanged',
      withPhone.includes('מעביר את הפרטים'));

    // A price anchored on a number the lead brought
    check('"10,000 זה לא הגיוני" is blocked — it tells her we are under 10,000',
      brain.enforceGuardrails('10,000 זה לא הגיוני, ולא הייתי רוצה שתלכי עם ההנחה הזו.') === null);
    check('"7000 זה מחיר סביר" is blocked',
      brain.enforceGuardrails('7000 זה מחיר סביר') === null);
    check('"פחות מ-10 אלף" is blocked',
      brain.enforceGuardrails('זה יוצא פחות מ-10 אלף') === null);
    check('but departure years in a money sentence still pass',
      brain.enforceGuardrails('מי שעזב בשנים 1964-1967 לא איבד את האזרחות, והעלות נגזרת מהתיק.') !== null);
    check('and the office phone number is not an amount',
      brain.enforceGuardrails('אם נוח לך להתקשר לגבי העלות: 03-5517801.') !== null);
    check('the prompt forbids reacting to a quoted amount',
      /אל תגיב לסכום שהלקוח הביא/.test(prompts.composeSystem({}, [], [])));

    // One name for the lawyer
    const fs = require('fs');
    const srcDir = path.join(__dirname, '..', 'src');
    const offenders = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (f.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('עו״ד מהמשרד')) offenders.push(f);
      }
    })(srcDir);
    check('nothing the bot sends says "עו״ד מהמשרד" any more', offenders.length === 0, offenders.join(', '));

    // A first message that is already a question
    const avi = newPhone();
    const first = await say(avi, 'היי, אני זכאי לרומני אם הסבתא שלי נולדה בבוקרשט ב-39?');
    const greeting = sent[0]?.text || '';
    check('a lead who opens with a question is not asked "מי במשפחה נולד ברומניה?" first',
      !/מי במשפחה נולד ברומניה/.test(greeting), greeting);
    check('and still gets a greeting from the office', /עו״ד יהונתן פודים/.test(greeting));
    check('and no menu is pushed at them', !sent.some(m => m.type === 'list'));
    const trig = newPhone();
    const trigReply = await say(trig, TRIGGER);
    check('the ad trigger still gets the full opening with its question', /\?/.test(trigReply));
  }

  section('56. Trainer run 14 Oct — fixed 15 Oct');
  {
    const faq = require('../src/kb/faq');
    const elig = faq.get ? faq.get('eligibility') : '';
    check('the eligibility FAQ no longer puts Transylvania under Article 11',
      !/סעיף 11[^\n]*טרנסילבניה/.test(elig), elig.slice(0, 200));
    const allTemplates = Object.values(require('../src/sales/objections').OBJECTIONS || {})
      .map(o => o.response).join('\n');
    check('objection templates exist to check', allTemplates.length > 200);
    check('no objection template claims "no generation limit" for everyone',
      !/בלי מגבלת דורות|ללא מגבלת דורות/.test(allTemplates));
    check('no objection template puts Transylvania/Maramureș/Banat in Article 11',
      !/סעיף 11[^\n]*(?:טרנסילבניה|מרמורש|באנאט)/.test(allTemplates) &&
      !/בסרביה, צפון בוקובינה, טרנסילבניה/.test(allTemplates));
    check('no objection template says children are automatically eligible',
      !/זכאים אוטומטית ברגע/.test(allTemplates));

    const retrieve = require('../src/kb/retrieve');
    const hits = retrieve.forIntent('ask_eligibility', 'סבתא שלי נולדה בקלוז׳ ב-1930 ועלתה ב-1960', []);
    check('a Transylvanian birthplace no longer pulls the Article 11 passages to the top',
      hits.length && !['article_11', 'bessarabia_group'].includes(hits[0].id), hits.map(h => h.id).join(','));
    const hits11 = retrieve.forIntent('ask_eligibility', 'סבתא שלי נולדה בצ׳רנוביץ ב-1930', []);
    check('while Czernowitz still does',
      hits11.some(h => ['article_11', 'bessarabia_group', 'territory_matters'].includes(h.id)), hits11.map(h => h.id).join(','));

    check('"בגורם של 3-4" is blocked as a price comparison',
      brain.enforceGuardrails('זה יכול להשתנות בגורם של 3-4.') === null);
    check('"בחצי מהמחיר האמיתי" is blocked',
      brain.enforceGuardrails('אם אגיד טווח הוא יהיה בערך בחצי מהמחיר האמיתי.') === null);
    check('"את בהחלט זכאית" is blocked as certainty',
      brain.enforceGuardrails('כן, את בהחלט זכאית — סבתא שלך נולדה ברומניה.', {}) === null);
    check('"הילדים אוטומטית זכאים דרך בעלך" is blocked',
      brain.enforceGuardrails('הם אוטומטית זכאים לאזרחות רומנית דרך בעלך.', {}) === null);

    // The orphan "ואם נוח לך יותר להתקשר בעצמך" line
    const ask = closing.callClose({}, { variant: 'handoff' });
    const session = { profile: {}, history: [
      { role: 'assistant', text: ask }, { role: 'user', text: 'אני לא מתקשרת' },
    ] };
    const again = flows.avoidRepetition(session, ask);
    check('removing a repeated phone ask never leaves only its "ואם…" tail',
      !/^\s*(?:ואם|או\s)/.test(again.trim()), again);

    // A template is never sent twice in one conversation
    const tpl = objections.respond('need_price_first');
    const s2 = { profile: {}, history: [
      { role: 'assistant', text: tpl }, { role: 'user', text: 'נו אז כמה' },
      { role: 'assistant', text: 'משהו אחר' }, { role: 'user', text: 'תן טווח' },
    ] };
    const second = flows.avoidTemplateRepeat(s2, tpl);
    check('the same scripted template is not sent twice in one conversation',
      second !== tpl && second.length > 20, second);

    check('a duplicate hello is stripped',
      flows.stripLeadingGreeting('היי רותם! 👋\n\nכן, נשמע שיש כיוון — חשוב לדעת את שנת העלייה.')
        .startsWith('כן'));

    // The documents path
    const rung = closing.contactLadder({}, 1);
    check('a lead who refuses to leave a number is offered to send documents here',
      /צילום של המסמכים/.test(rung));
    check('the prompt tells the bot about the documents path',
      /צילומי מסמכים/.test(prompts.composeSystem({}, [], [])));
    check('and about children born before the parent became a citizen',
      /לפני\* שההורה קיבל אזרחות/.test(prompts.composeSystem({}, [], [])));
  }

  section('57. Trainer run 15 Oct + meeting-first close — fixed 16 Oct');
  {
    check('"15-20K" is blocked as a price', brain.enforceGuardrails('אם זה 1989 — מסלול אחד, כ-15-20K עבור ארבעתכם.') === null);
    check('"15 אלף" is blocked as a price', brain.enforceGuardrails('זה בערך 15 אלף לכל המשפחה.') === null);
    check('"בקצה הזול יחסית" is blocked', brain.enforceGuardrails('אתה בקצה הזול יחסית של הטווחים במשרד.') === null);
    check('"ויקר יותר" is blocked', brain.enforceGuardrails('זה תהליך מורכב ויקר יותר מהמסלול הפשוט.') === null);
    check('the bot can never claim to be human',
      brain.enforceGuardrails('אני בן אדם, לא בוט — ואני מבין את התסכול שלך.') === null);
    check('but it may say it is the office\'s digital assistant',
      brain.enforceGuardrails('אני עוזר דיגיטלי של המשרד, ועו״ד פודים יחזור אליך.') !== null);
    check('a price in writing is never promised',
      brain.enforceGuardrails('עו״ד פודים יגיד לך מספר אמיתי — בלי טלפון, ישירות כאן בכתב.') === null);
    check('an assessment in writing is fine',
      brain.enforceGuardrails('שלח צילום, ועו״ד פודים יגיד לך בכתב מה יש ומה חסר.') !== null);
    check('"אתה בהחלט יכול" is blocked as certainty',
      brain.enforceGuardrails('כן, אתה בהחלט יכול! 🙂', {}) === null);
    check('no route is named for a birth in Czernowitz after 1940',
      brain.enforceGuardrails('1952 נראה כמו מסלול של הסדרת רישום אצלך.',
        { eligibility: { territory: 'bukovina', birthYear: '1948' } }) === null);
    const sys = prompts.composeSystem({}, [], []);
    check('the prompt refers investment questions to the lawyer', /השקעות נדל״ן מניבות ברומניה/.test(sys));
    check('the prompt gives the meeting schedule', /א׳–ה׳, בשעות 17:00 או 18:00/.test(sys));
    check('the prompt orders meeting → Zoom → phone', /פגישה במשרד[\s\S]{0,200}בזום[\s\S]{0,200}שיחת טלפון/.test(sys));
    check('the bot requests, the office confirms', /אתה מבקש — המשרד מאשר/.test(sys));
    const retrieve = require('../src/kb/retrieve');
    check('an investment question retrieves the investments passage',
      retrieve.retrieve('אתם מלווים גם השקעות נדל״ן ברומניה?')[0]?.id === 'romania_investments');

    // Meeting-first close
    const meeting = require('../src/sales/meeting');
    const ready = { messageCount: 3, eligibility: { ancestor: 'אבא', birthPlace: 'יאשי', leftYear: '1971' } };
    const close = closing.callClose(ready, {});
    check('a meeting-ready lead is closed on the office meeting, not a call',
      /פגישה של 45 דקות/.test(close) && close.includes(closing.SLOTS_TOKEN));
    check('with Zoom and a phone call as the fallbacks', /בזום/.test(close) && close.includes(closing.OFFICE_PHONE));
    check('a lead who declined the meeting gets a phone close',
      !/פגישה של 45/.test(closing.callClose({ ...ready, meeting: { declines: 1 } }, {})));
    check('a human handoff stays a callback',
      !/פגישה של 45/.test(closing.callClose(ready, { variant: 'handoff' })));
    check('a lead with no Romanian-born relative is not offered a meeting',
      !/פגישה של 45/.test(closing.callClose({}, {})));
    check('"יום שני" in answer to an offer counts as a yes', meeting.signalsMeetingInterest('יום שני'));

    const ron = newPhone();
    await say(ron, 'היי, אבא שלי נולד ביאשי ועזב ב-1971. אני זכאי?');
    const priced = await say(ron, 'תן טווח, סדר גודל');
    check('a price objection from a ready lead is answered with two real evenings',
      /בשעה 1[78]:00/.test(priced), priced.slice(-200));
    check('and the placeholder never reaches the customer', !priced.includes('{{'));
    check('the slots are recorded', profileOf(ron)?.meeting?.status === 'slots_proposed');
    // Pick whichever evening was actually offered. On a machine whose database
    // already holds requests (trainer runs book slots too), Monday may be
    // taken and the offer is Sunday + Tuesday — "יום שני" would match nothing.
    const offeredDay = /יום ([^\s,]+)/.exec(profileOf(ron)?.meeting?.offered?.[1]?.label || 'יום שני')[1];
    const picked = await say(ron, `יום ${offeredDay}`);
    check('picking a day requests that meeting', profileOf(ron)?.meeting?.status === 'requested');
    check('and asks for name and phone to confirm it', /השם המלא ומספר הטלפון/.test(picked));
    const done = await say(ron, 'רון כהן 0521234567');
    check('name and number in one message are both captured',
      profileOf(ron)?.name === 'רון כהן' && profileOf(ron)?.clientPhone === '0521234567');
    check('and the request is confirmed, not re-asked',
      /הבקשה לפגישה/.test(done) && !/מתי נוח/.test(done), done.slice(0, 120));
  }

  section('58. Trainer run 16 Oct — fixed 16 Oct');
  {
    const meeting = require('../src/sales/meeting');
    const slots = meeting.nextSlots({ count: 2 });
    check('"תני לי שני מספרים…?" is not a booking for Monday',
      meeting.parseExplicitSlotChoice('תני לי שני מספרים: אם 1950 כמה, אם 1952 כמה?', slots) === null);
    check('a message full of questions is not a booking',
      meeting.parseExplicitSlotChoice('אתה אמרת 03-5517801 נכון? בממוצע כמה זמן? שנה? שנתיים?', slots) === null);
    check('"רגע, לא אמרתי שאני מגיע ביום שני" is not a booking',
      meeting.parseExplicitSlotChoice('רגע, לא אמרתי שאני מגיע ביום שני', slots) === null);
    check('"יום שני" still books Monday', !!meeting.parseExplicitSlotChoice(`יום ${/יום ([^\s,]+)/.exec(slots[1].label)[1]}`, slots));
    check('"השני" still books the second slot', meeting.parseExplicitSlotChoice('השני', slots) === slots[1]);

    // The placeholder leak: model offer + scripted close in one message
    const ph = newPhone();
    await say(ph, 'היי, אבא שלי נולד ביאשי ועזב ב-1971. אני זכאי?');
    sent.length = 0;
    const session = storage.getConversation(ph);
    session.profile.messageCount = 3;
    const both = `תשובה לעניין.\n\n${closing.SLOTS_TOKEN}\n\n${closing.meetingClose(session.profile)}`;
    const out = flows.prepareMeetingOffer(ph, session, both);
    check('the slot placeholder never reaches a customer', !out.includes('{{'), out);
    check('and one message carries one meeting offer', (out.match(/יש לי פגישה/g) || []).length === 1, out);
    check('a stray Chinese character is removed',
      !/不/.test(flows.prepareMeetingOffer(ph, session, '不לגבי השאלה — כן.')));

    check('"עורך דין אחר שדיברתי איתו" is not "we already spoke"',
      !closing.signalsAlreadySpoke('כל עורך דין אחר שדיברתי איתו נתן לי טווח'));
    check('while "שוחחנו אתמול" still is', closing.signalsAlreadySpoke('היי. שוחחנו אתמול. הכול בסדר. תודה'));

    const first = newPhone();
    const firstReply = await say(first, 'היי, סבתא שלי נולדה בבוקרשט ועזבה ב-1952. כמה זה עולה?');
    check('the first reply answers, it does not book a meeting', !/בשעה 1[78]:00/.test(firstReply), firstReply.slice(-160));
    check('the prompt forbids inventing a refund policy', /מדיניות החזרים, ביטוח, מספר רישיון/.test(prompts.composeSystem({}, [], [])));
  }

  section('59. Price range on insistence; trainer run 16 Oct 15:17 — fixed 16 Oct');
  {
    const RANGE = 'טווח המחירים שלנו נע בין 8,000 ל-14,000 ₪. כל מקרה נבחן לגופו והמחיר תלוי בתיק עצמו — ' +
                  'כדי לקבל מחיר מותאם אישית, פגישה עם עו״ד פודים או שיחת ייעוץ.';
    check('the range is blocked before the lead insisted',
      brain.enforceGuardrails(RANGE, { priceRangeAllowed: false }) === null);
    check('the range passes, unchanged, once the lead insisted',
      brain.enforceGuardrails(RANGE, { priceRangeAllowed: true }) === RANGE);
    check('the range without "נבחן לגופו" is blocked',
      brain.enforceGuardrails('טווח המחירים שלנו נע בין 8,000 ל-14,000 ₪. נשמח לפגישה.', { priceRangeAllowed: true }) === null);
    check('the range without a meeting/consultation referral is blocked',
      brain.enforceGuardrails('המחיר נע בין 8,000 ל-14,000 ₪, כל מקרה נבחן לגופו.', { priceRangeAllowed: true }) === null);
    check('a narrower range is still blocked, even after insisting',
      brain.enforceGuardrails('אצלך זה יהיה 9,000 עד 11,000 ₪. כל מקרה נבחן לגופו, נשמח לפגישה.', { priceRangeAllowed: true }) === null);
    check('the range plus "you will be at the low end" is blocked',
      brain.enforceGuardrails(RANGE + ' אצלך זה כנראה בקצה התחתון.', { priceRangeAllowed: true }) === null);
    check('"ההפרש בין 6,000 ל-12,000" is blocked without any money word',
      brain.enforceGuardrails('ההפרש בין 6,000 ל-12,000 תלוי במסמכים שלך.', {}) === null);
    check('"התעריף יהיה הרבה יותר נמוך" is blocked',
      brain.enforceGuardrails('במקרה שלך התעריף יהיה הרבה יותר נמוך.', {}) === null);

    // Insistence opens the range — through the whole flow, scripted.
    const ph = newPhone();
    await say(ph, 'היי, סבא שלי נולד בבוקרשט ועזב ב-1960. כמה זה עולה?');
    const r1 = await say(ph, 'אני שואל שוב — כמה זה עולה? תן לי סדר גודל');
    const pr = profileOf(ph);
    check('the second price ask opens the range', pr.priceRangeAllowed === true, JSON.stringify(pr.priceAsks));
    check('and the reply gives 8,000–14,000', /8,000 ל-14,000/.test(r1), r1.slice(0, 200));
    check('with the caveat that every case is examined on its merits', /לגופו/.test(r1) && /תלוי בתיק/.test(r1));
    check('and a referral to a meeting or consultation', /פגישה|שיחת ייעוץ/.test(r1));
    check('the range is remembered as given', profileOf(ph).priceRangeGiven === true);
    const once = newPhone();
    const o1 = await say(once, 'היי, אמא שלי נולדה ביאשי ועזבה ב-1975. כמה זה עולה?');
    check('a first price ask gets no figure', !/\d{1,3},\d{3}/.test(o1), o1.slice(0, 200));

    // claimsShortTrack: a conditional explanation is the law, not a promise
    const ron = { eligibility: { birthPlace: 'בוקרשט' } };
    check('"אם הסבא שלך עזב ב-1950–1952, האזרחות לא אבדה" passes',
      brain.enforceGuardrails('אם הסבא שלך עזב ב-1950–1952, האזרחות לא אבדה. לכן השנה חשובה.', ron) !== null);
    check('"אצלך האזרחות לא אבדה" with no year is still blocked',
      brain.enforceGuardrails('אצלך האזרחות לא אבדה.', ron) === null);

    // Soviet-era birth described as "born in Romania"
    check('"נולדה ברומניה, בצ׳רנוביץ ב-1948" is blocked',
      brain.enforceGuardrails('היא נולדה ברומניה, בצ׳רנוביץ ב-1948, ולכן יש בסיס.', {}) === null);
    check('"כן, בהחלט" as an eligibility answer is blocked',
      brain.enforceGuardrails('כן, בהחלט! לפי סעיף 11 זה עובד.', {}) === null);
    check('a meeting "בבוקר" is blocked',
      brain.enforceGuardrails('אפשר לקבוע פגישה ביום שני בבוקר.', {}) === null);

    const sys = prompts.composeSystem({}, [], []);
    check('the prompt carries the approved range and its conditions',
      /8,000 ל-14,000/.test(sys) && /נבחן לגופו/.test(sys));
    check('the prompt forbids inventing payment terms', /תנאי תשלום/.test(sys));
    check('the prompt explains generation counting', /הילדים שלכם הם \*נינים\*/.test(sys));

    const flowsSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'flows.js'), 'utf8');
    check('no meeting pitch under a reply that already said goodbye', /alreadySignedOff/.test(flowsSrc));
  }

  section('41. The template catalog matches the code');
  {
    const fs = require('fs');
    const catalog = require('../src/templates');

    const problems = catalog.validate();
    check('every template body is one Meta will accept',
      problems.length === 0, problems.join(' | '));

    // The root cause of every rejection on this account: no sample values.
    const noExample = catalog.TEMPLATES.filter(
      t => t.params > 0 && (!Array.isArray(t.example) || t.example.length !== t.params));
    check('every placeholder has a sample value for Meta',
      noExample.length === 0, noExample.map(t => t.name).join(', '));

    // Every template name quoted anywhere in src must exist in the catalog.
    // This is the drift that caused the outage: the code called three names
    // that no script ever submitted to Meta.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(d => d.isDirectory()
        ? walk(path.join(dir, d.name))
        : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

    const srcDir = path.join(__dirname, '..', 'src');
    const used = new Set();
    for (const file of walk(srcDir)) {
      if (file.endsWith(path.join('src', 'templates.js'))) continue;
      const body = fs.readFileSync(file, 'utf8');
      for (const m of body.matchAll(/'(pudim_[a-z0-9_]+|passport_lead_new|b1_lead_new)'/g)) {
        used.add(m[1]);
      }
    }

    const unknown = [...used].filter(n => !catalog.NAMES.includes(n));
    check('no template name in the code is missing from the catalog',
      unknown.length === 0, unknown.join(', '));
    check('the code really does send templates', used.size >= 7, `${used.size}`);

    const criticalPresent = catalog.CRITICAL.every(n => catalog.NAMES.includes(n));
    check('every critical template is in the catalog', criticalPresent);

    // The parameter counts the call sites actually pass.
    const expected = {
      passport_lead_new: 6, b1_lead_new: 3, pudim_meeting_request: 3,
      pudim_hot_lead: 3, pudim_handoff: 3, pudim_waiting_list: 1,
      pudim_meetings_digest: 2, pudim_chat_start: 2, pudim_daily_status_v2: 2,
      pudim_bot_startup_v2: 1,
    };
    const mismatched = Object.entries(expected)
      .filter(([n, p]) => catalog.get(n)?.params !== p)
      .map(([n, p]) => `${n} expected ${p} got ${catalog.get(n)?.params}`);
    check('each body has exactly as many placeholders as the call site fills',
      mismatched.length === 0, mismatched.join(' | '));

    // The hot-lead alert used to pass null — the single most valuable alert the
    // bot sends had no way through a closed window.
    const handoffSrc = fs.readFileSync(path.join(srcDir, 'sales', 'handoff.js'), 'utf8');
    check('the hot-lead alert now goes out on a template',
      /notifyHotLead[\s\S]{0,600}pudim_hot_lead/.test(handoffSrc));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  • ${f}`));
  }
  console.log('═'.repeat(52) + '\n');

  // Clean up every conversation this run created
  for (const p of created) storage.deleteConversation(p);
  await storage.flush();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\n❌ Suite crashed:', err);
  process.exit(1);
});
