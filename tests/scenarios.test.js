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
const waMock = {
  sendText: async (to, text) => { sent.push({ to, type: 'text', text }); return true; },
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
