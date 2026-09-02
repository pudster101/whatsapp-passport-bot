/**
 * flows.js — conversation engine.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  HYBRID DESIGN                                                           │
 * │                                                                          │
 * │  Deterministic rails  →  menus, buttons, lead capture, fallbacks         │
 * │  AI sales layer       →  understanding, objections, personalisation      │
 * │                                                                          │
 * │  Every inbound message runs through the same pipeline:                   │
 * │                                                                          │
 * │    message → profile load → AI analysis → profile merge → next best      │
 * │    action → response (AI or scripted) → events → agent alerts            │
 * │                                                                          │
 * │  If the AI is unavailable, unconfident, or breaches a guardrail, the     │
 * │  scripted copy takes over and the bot behaves exactly as it always has.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

const wa = require('./whatsapp');
const storage = require('./storage');
const config = require('./config');

const brain = require('./ai/brain');
const faq = require('./kb/faq');
const retrieve = require('./kb/retrieve');
const leadProfile = require('./sales/leadProfile');
const stages = require('./sales/stages');
const scoring = require('./sales/scoring');
const objections = require('./sales/objections');
const nextAction = require('./sales/nextAction');
const handoff = require('./sales/handoff');
const closing = require('./sales/closing');

const MAX_HISTORY = 20;

// ─── Rate limiting ────────────────────────────────────────────────────────────
// In-memory sliding window per phone. Protects against floods and loops.
const recentMessages = new Map(); // phone → timestamps[]

function isRateLimited(phone) {
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW_MIN * 60000;
  const stamps = (recentMessages.get(phone) || []).filter(t => now - t < windowMs);
  stamps.push(now);
  recentMessages.set(phone, stamps);

  // Housekeeping so the map can't grow without bound
  if (recentMessages.size > 500) {
    for (const [p, list] of recentMessages) {
      if (!list.length || now - list[list.length - 1] > windowMs) recentMessages.delete(p);
    }
  }
  return stamps.length > config.RATE_LIMIT_MESSAGES;
}

// ─── Trigger detection ────────────────────────────────────────────────────────

const TRIGGER_PHRASES = [
  'שלום! אפשר לקבל מידע נוסף על זה?',
  'hello! can i get more info on this?',
  'אפשר לקבל מידע נוסף על זה',
  'שלום, אפשר לקבל מידע נוסף',
];

/**
 * Normalise before comparing. The production bug on 14 May was an inbound
 * message that looked identical to the trigger phrase but did not match —
 * invisible characters and punctuation variants from the ad platform.
 */
function normalise(text = '') {
  return String(text)
    .replace(/[​-‏‪-‮﻿ ]/g, ' ') // zero-width, RTL marks, nbsp
    .replace(/[!?.,׳״'"־–—-]/g, '')                            // punctuation variants
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isTriggerMessage(text) {
  const n = normalise(text);
  if (!n) return false;
  return TRIGGER_PHRASES.some(t => {
    const nt = normalise(t);
    return n === nt || n.includes(nt) || nt.includes(n);
  });
}

const RESTART_WORDS = ['תפריט', 'menu', 'התחל', 'start', 'restart', 'התחל מחדש'];
const BACK_TO_MENU = [
  'אפשרות נוספת', 'אפשרויות נוספות', 'אפשרויות אחרות', 'חזור לתפריט',
  'תפריט ראשי', 'חזרה לתפריט', 'רוצה עוד מידע',
  'more options', 'back to menu', 'other options',
];
const OPT_OUT = ['הסר', 'הסר אותי', 'תפסיקו', 'לא מעוניין', 'stop', 'unsubscribe', 'תפסיק לשלוח'];

// ─── Session helpers ──────────────────────────────────────────────────────────

function loadSession(phone) {
  let session = storage.getConversation(phone);

  if (!session) {
    session = {
      state: 'NEW',
      data: {},
      profile: leadProfile.create(phone),
      history: [],
      startedAt: new Date().toISOString(),
      leadSaved: false,
    };
    return { session, isNew: true };
  }

  // Migrate legacy sessions (pre-upgrade shape) without losing anything
  if (!session.profile) {
    session.profile = leadProfile.fromLegacySession(phone, session);
    session.history = session.history || [];
    session.leadSaved = session.state === 'COMPLETE';
    console.log(`🔄 [${phone}] Migrated legacy session → lead profile`);
  }
  return { session, isNew: false };
}

function pushHistory(session, role, text) {
  if (!text) return;
  session.history = session.history || [];
  session.history.push({ role, text: String(text).slice(0, 500), at: new Date().toISOString() });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

function save(phone, session) {
  storage.setConversation(phone, session);
}

/** Send a reply, record it in history, and keep the profile timestamps honest. */
async function reply(phone, session, text) {
  if (!text) return false;
  const parts = wa.splitMessage(text);
  let ok = true;
  for (const [i, part] of parts.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 600));
    const sent = await wa.sendText(phone, part);
    ok = ok && sent;
  }
  pushHistory(session, 'assistant', text);
  session.profile.lastOutboundAt = new Date().toISOString();
  return ok;
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

async function showInterestButtons(phone) {
  return wa.sendList(
    phone,
    'במה תרצה שנתחיל?',
    'בחר נושא',
    [{
      title: 'נושאים',
      rows: [
        { id: 'interest_eligibility',     title: '✅ בדיקת זכאות',   description: 'בדוק אם אתה זכאי לדרכון רומני' },
        { id: 'interest_process',         title: '📋 מידע על התהליך', description: 'שלבי תהליך קבלת האזרחות' },
        { id: 'interest_cost',            title: '💰 עלויות וזמנים',  description: 'מה משפיע על העלות וכמה זמן לוקח' },
        { id: 'interest_romanian_course', title: '🎓 קורס רומנית B1', description: 'תעודת שפה — תנאי לשחזור אזרחות' },
      ],
    }]
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function handleMessage(phone, message) {
  const { session, isNew } = loadSession(phone);
  const profile = session.profile;

  // ── Extract text / button id ──────────────────────────────────────────────
  let text = '';
  let buttonId = '';
  const msgType = message.type;

  if (msgType === 'text') {
    text = message.text?.body?.trim() || '';
  } else if (msgType === 'interactive') {
    const iType = message.interactive?.type;
    if (iType === 'button_reply') {
      buttonId = message.interactive.button_reply?.id || '';
      text = message.interactive.button_reply?.title || '';
    } else if (iType === 'list_reply') {
      buttonId = message.interactive.list_reply?.id || '';
      text = message.interactive.list_reply?.title || '';
    }
  } else {
    // Media, audio, location, contacts, unsupported types
    text = `[${msgType}]`;
  }

  profile.lastInboundAt = new Date().toISOString();
  profile.messageCount = (profile.messageCount || 0) + 1;
  if (text && !buttonId) pushHistory(session, 'user', text);

  // ── Click-to-WhatsApp attribution ─────────────────────────────────────────
  // Meta attaches `referral` to the FIRST message after an ad click, and only
  // that one. It is never resent, so if it is not captured here it is lost.
  // source_id is the ad id and joins straight to the Meta Ads data;
  // ctwa_clid is the key for reporting conversions back to Meta.
  if (message.referral && !profile.attribution) {
    const r = message.referral;
    profile.attribution = {
      sourceId:   r.source_id   || null,   // ad id → joins to Meta Ads reporting
      sourceType: r.source_type || null,   // 'ad' | 'post'
      sourceUrl:  r.source_url  || null,
      headline:   r.headline    || null,   // the creative they actually clicked
      body:       r.body        || null,
      mediaType:  r.media_type  || null,
      ctwaClid:   r.ctwa_clid   || null,   // conversion-attribution key
      capturedAt: new Date().toISOString(),
    };
    profile.source   = 'meta_ad';
    profile.campaign = r.source_id || null;
    save(phone, session);
    storage.logEvent(phone, 'attribution_captured', profile.attribution);
    console.log(`🎯 [${phone}] CTWA attribution captured — ad=${r.source_id || '?'} clid=${r.ctwa_clid ? 'yes' : 'no'}`);
  }

  console.log(`📩 [${phone}] state=${session.state} stage=${profile.stage} score=${profile.buyingIntent} | "${text}" ${buttonId ? `btn=${buttonId}` : ''}`);

  // ── Burst protection ──────────────────────────────────────────────────────
  // Answer once, then stay quiet until the window clears. Never leave the
  // customer wondering, but never get dragged into a loop either.
  if (isRateLimited(phone)) {
    if (!session.rateLimitNotified) {
      session.rateLimitNotified = true;
      save(phone, session);
      storage.logEvent(phone, 'rate_limited', { messageCount: profile.messageCount });
      console.warn(`🚦 [${phone}] Rate limited`);
      await wa.sendText(phone,
        `קיבלתי את ההודעות שלך 🙏\n\nאני עונה קצת לאט כרגע — תן לי רגע ואחזור אליך.\n\n` +
        `אם זה דחוף: *03-5517801*`
      );
    }
    return;
  }
  if (session.rateLimitNotified) {
    session.rateLimitNotified = false; // window cleared
  }

  // ── Conversation length ceiling ───────────────────────────────────────────
  // Past this point it isn't a chat any more — it's a case for a human.
  if ((profile.messageCount || 0) > config.MAX_MESSAGES_PER_CONVERSATION) {
    if (profile.humanStatus !== 'notified') {
      profile.humanStatus = 'notified';
      profile.stage = 'HUMAN_HANDOFF';
      save(phone, session);
      storage.logEvent(phone, 'max_messages_reached', { messageCount: profile.messageCount });
      await reply(phone, session,
        `דיברנו כאן לא מעט, ואני חושב שהשלב הבא צריך להיות שיחה אמיתית. 🙂\n\n` +
        `מעביר את הפרטים לעו״ד פודים שיחזור אליך אישית.\n` +
        `ואם נוח לך להתקשר: *03-5517801* · א׳–ה׳ 09:00-18:00`
      );
      handoff.notifyHandoff(profile, 'שיחה ארוכה מאוד — הגיעה לתקרת ההודעות')
        .catch(e => console.warn('⚠️ handoff notify:', e.message));
      save(phone, session);
    } else if ((profile.messageCount - config.MAX_MESSAGES_PER_CONVERSATION) % 10 === 0) {
      // The customer is still writing and nobody has answered. Stay quiet to
      // them (a human owns this conversation now) but nudge the agent again,
      // so a waiting client is never silently forgotten.
      storage.logEvent(phone, 'post_handoff_still_writing', { messageCount: profile.messageCount });
      handoff.notifyHandoff(profile, 'הלקוח ממשיך לכתוב אחרי ההעברה — עדיין לא נענה')
        .catch(e => console.warn('⚠️ handoff re-notify:', e.message));
      save(phone, session);
    }
    return;
  }

  // ── Opt-out — respect immediately ─────────────────────────────────────────
  if (OPT_OUT.some(w => normalise(text) === normalise(w))) {
    profile.optedOut = true;
    profile.stage = 'LOST_NOT_NOW';
    save(phone, session);
    storage.logEvent(phone, 'opted_out', {});
    await reply(phone, session, 'הוסרת מרשימת הפניות שלנו. לא נשלח לך הודעות נוספות.\n\nאם תשנה את דעתך — אנחנו כאן. 🙏');
    save(phone, session);
    return;
  }

  // ── Trigger phrase → fresh start ──────────────────────────────────────────
  if (isTriggerMessage(text)) {
    profile.source = profile.source === 'unknown' ? 'fb_ad' : profile.source;
    await handleStart(phone, session);
    return;
  }

  // ── Explicit restart ──────────────────────────────────────────────────────
  if (RESTART_WORDS.includes(normalise(text))) {
    session.state = 'WELCOME_SENT';
    session.data = {};
    await handleStart(phone, session, { keepProfile: true });
    return;
  }

  // ── Brand-new number that did NOT send the trigger ────────────────────────
  // The old bot silently discarded these. That was the single biggest leak:
  // referrals, business cards, the website button and any ad-copy variant.
  if (isNew || session.state === 'NEW') {
    console.log(`🆕 [${phone}] Unknown number, no trigger — starting conversation anyway`);
    profile.source = profile.source === 'unknown' ? 'organic' : profile.source;
    storage.logEvent(phone, 'conversation_started', { source: profile.source, firstMessage: text });
    await handleStart(phone, session, { firstMessage: text });
    return;
  }

  // ── Back to menu ──────────────────────────────────────────────────────────
  const n = normalise(text);
  if (n === normalise('מידע נוסף') || n === normalise('עוד מידע') ||
      BACK_TO_MENU.some(p => n.includes(normalise(p)))) {
    session.state = 'WELCOME_SENT';
    profile.stage = stages.shouldAdvance(profile.stage, 'INITIAL_ENGAGEMENT');
    save(phone, session);
    await wa.sendText(phone, 'בוודאי! במה נוסף אוכל לעזור? 😊');
    await new Promise(r => setTimeout(r, 300));
    await showInterestButtons(phone);
    save(phone, session);
    return;
  }

  // ── Button presses stay fully deterministic ───────────────────────────────
  if (buttonId) {
    await handleButton(phone, session, buttonId);
    return;
  }

  // ── Free text → the sales pipeline ────────────────────────────────────────
  await handleFreeText(phone, session, text);
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function handleStart(phone, session, opts = {}) {
  const profile = session.profile;
  session.state = 'WELCOME_SENT';
  if (!opts.keepProfile) session.data = {};
  profile.stage = stages.shouldAdvance(profile.stage, 'INITIAL_ENGAGEMENT');

  save(phone, session);

  // Customer first — agent notification never blocks the reply
  const returning = (profile.messageCount || 0) > 1 && profile.name;
  const welcome = returning
    ? `היי ${profile.name}! 👋 טוב לשמוע ממך שוב.\n\nבמה אוכל לעזור הפעם?`
    : `היי! 👋 תודה שפנית אלינו למשרד עורך דין יהונתן פודים — *השער שלך לרומניה*.\n\n` +
      `אני כאן כדי לבדוק עבורך *זכאות לדרכון רומני* וללוות אותך עד שיחת ייעוץ עם עו״ד מהמשרד.\n\n` +
      `כדי להתחיל — מה גרם לך להתעניין?`;

  await reply(phone, session, welcome);
  await new Promise(r => setTimeout(r, 400));
  await showInterestButtons(phone);
  save(phone, session);

  storage.logEvent(phone, 'stage_changed', { stage: profile.stage, from: 'NEW_LEAD' });

  handoff.notifyChatStart(phone, profile)
    .catch(e => console.warn('⚠️ chat-start notify failed:', e.message));

  // If they opened with a real question rather than the trigger, answer it too
  if (opts.firstMessage && !isTriggerMessage(opts.firstMessage) && opts.firstMessage.length > 8) {
    await new Promise(r => setTimeout(r, 800));
    await handleFreeText(phone, session, opts.firstMessage, { skipHistory: true });
  }
}

// ─── Deterministic button handlers ────────────────────────────────────────────

async function handleButton(phone, session, buttonId) {
  const profile = session.profile;

  const handlers = {
    interest_eligibility:     () => handleInterestEligibility(phone, session),
    interest_process:         () => handleInterestProcess(phone, session),
    interest_cost:            () => handleInterestCost(phone, session),
    interest_romanian_course: () => handleInterestRomanianCourse(phone, session),
  };

  const fn = handlers[buttonId];
  if (fn) {
    storage.logEvent(phone, 'menu_selected', { option: buttonId });
    await fn();
    save(phone, session);
    return;
  }

  await showInterestButtons(phone);
  save(phone, session);
}

async function handleInterestEligibility(phone, session) {
  const profile = session.profile;
  session.state = 'ELIG_Q1';
  profile.interest = [...new Set([...(profile.interest || []), 'passport'])];
  profile.stage = stages.shouldAdvance(profile.stage, 'QUALIFICATION');
  profile.questionsAsked = [...new Set([...(profile.questionsAsked || []), 'eligibility'])];

  await reply(phone, session,
    `מצוין. נתחיל בבדיקה ראשונית. 🔍\n\n` +
    `הזכאות נקבעת לפי שנת ומקום הלידה של בן המשפחה שנולד ברומניה.\n\n` +
    `*מי במשפחה נולד ברומניה?*\n(הורה / סב / סבתא — ואם אפשר, מאיזה צד)`
  );
}

async function handleInterestProcess(phone, session) {
  const profile = session.profile;
  session.state = 'ELIG_Q1';
  profile.interest = [...new Set([...(profile.interest || []), 'passport'])];
  profile.stage = stages.shouldAdvance(profile.stage, 'DISCOVERY');
  profile.questionsAsked = [...new Set([...(profile.questionsAsked || []), 'process'])];

  await reply(phone, session, faq.get('process'));
  await new Promise(r => setTimeout(r, 700));
  await reply(phone, session, `כדי להבין מה נדרש *במקרה שלך* — *מי במשפחה נולד ברומניה, ובאיזו שנה בערך?*`);
}

async function handleInterestCost(phone, session) {
  const profile = session.profile;
  session.state = 'ELIG_Q1';
  profile.interest = [...new Set([...(profile.interest || []), 'passport'])];
  profile.stage = stages.shouldAdvance(profile.stage, 'DISCOVERY');
  profile.questionsAsked = [...new Set([...(profile.questionsAsked || []), 'cost'])];
  profile.buyingIntent = Math.min(100, (profile.buyingIntent || 0) + 15); // price interest is a real signal

  await reply(phone, session, faq.get('cost'));
  await new Promise(r => setTimeout(r, 700));
  await reply(phone, session, `רוצה שאעריך את זה למקרה שלך? *מי במשפחה נולד ברומניה ומה שנת הלידה שלו?*`);
}

async function handleInterestRomanianCourse(phone, session) {
  const profile = session.profile;
  session.state = 'LEAD_NAME';
  session.data.source = 'romanian_course';
  profile.interest = [...new Set([...(profile.interest || []), 'b1_course'])];
  profile.stage = stages.shouldAdvance(profile.stage, 'HIGH_INTENT');
  profile.questionsAsked = [...new Set([...(profile.questionsAsked || []), 'b1_course'])];

  if (typeof wa.sendImage === 'function') {
    const flyerUrl = `${config.PUBLIC_URL}/public/course-flyer.jpg`;
    await wa.sendImage(phone, flyerUrl).catch(e => console.warn('⚠️ Flyer not sent:', e.message));
    await new Promise(r => setTimeout(r, 500));
  }

  await reply(phone, session,
    `🎓 *קורס רומנית לתעודת B1*\n\n` +
    `במסגרת שיתוף הפעולה שלנו עם משרד עורכי דין מוביל ברומניה, אנו שמחים לבשר על הזדמנות ייחודית ללקוחות המשרד:\n\n` +
    `*קורס רומנית רשמי ומוכר לקבלת תעודת שפה ברמת B1* — תנאי הכרחי בתהליך השבת האזרחות הרומנית, בהתאם לשינויי החקיקה.\n\n` +
    `📍 הקורס מתקיים באוניברסיטת *סיביו לוציאן בלאגה*\n` +
    `✅ עומד בדרישות *חוק 21/1991*\n` +
    `📋 רישום המשתתפים מתבצע ישירות דרך משרדנו\n\n` +
    `*תשאירו פרטים ועו״ד פודים יחזור אליכם אישית.* 😊\n\nמה *שמך המלא*?`
  );
}

// ─── Free text → sales pipeline ───────────────────────────────────────────────

async function handleFreeText(phone, session, text, opts = {}) {
  const profile = session.profile;

  // 1. Understand.
  //
  //    Latency matters more than most things on WhatsApp: two sequential API
  //    calls per message put the median reply at ~13 seconds, which reads as
  //    "the bot is broken". So the AI analysis call is made only when it
  //    actually adds something the rules can't get:
  //      • the opening messages, where motivation and urgency are established
  //      • when the rules are unsure what was said
  //      • when an objection is on the table and nuance matters
  //    Otherwise the rule-based read is good enough, and we save a round trip.
  let analysis = ruleBasedAnalysis(text, profile);

  const needsDeepRead =
    (profile.messageCount || 0) <= 2 ||
    analysis.confidence < 0.6 ||
    analysis.objections.length > 0 ||
    analysis.emotion === 'frustrated';

  if (brain.isAvailable() && (config.AI_ANALYSIS_MODE === 'always' ||
      (config.AI_ANALYSIS_MODE !== 'off' && needsDeepRead))) {
    const deep = await brain.analyse(text, profile, session.history || []);
    if (deep) analysis = deep;
  }

  // 2. Merge everything we learned into the profile
  const hadContact = leadProfile.hasContactDetails(profile);
  const before = { stage: profile.stage, score: profile.buyingIntent };
  session.profile = leadProfile.merge(profile, {
    ...analysis.profileUpdates,
    stage: analysis.stage,
    buyingIntent: analysis.buyingIntent,
    objections: analysis.objections.map(t => ({ type: t })),
    questionsAsked: analysis.intent?.startsWith('ask_') ? [analysis.intent.replace('ask_', '')] : [],
    conversationSummary: analysis.summary || profile.conversationSummary,
  });
  const p = session.profile;

  if (before.stage !== p.stage) {
    storage.logEvent(phone, 'stage_changed', { from: before.stage, to: p.stage });
  }
  if (analysis.objections.length) {
    storage.logEvent(phone, 'objection_raised', { types: analysis.objections });
  }
  storage.logEvent(phone, 'message_analysed', {
    intent: analysis.intent,
    stage: p.stage,
    score: p.buyingIntent,
    confidence: analysis.confidence,
    aiUsed: brain.isAvailable(),
  });

  // 3. The scripted questionnaire runs ONLY when the AI is not composing.
  //
  //    This is the difference between an interview and a conversation. In
  //    live mode the AI asks the next question itself — in context, in its
  //    own words, referring to what the customer just said. The facts still
  //    get extracted into the profile either way; what changes is who does
  //    the talking.
  const aiWillCompose =
    brain.isAvailable() &&
    config.AI_MODE === 'live' &&
    analysis.confidence >= 0.4;

  if (!aiWillCompose && await handleScriptedState(phone, session, text, analysis)) {
    save(phone, session);
    return;
  }

  // 3b. Contact details just completed — confirm it. Anything else here
  //     (a generic "I didn't understand") would be a terrible experience
  //     right at the moment of conversion.
  if (!hadContact && leadProfile.hasContactDetails(p)) {
    p.stage = stages.shouldAdvance(p.stage, 'CONVERSION');
    session.state = 'COMPLETE';
    // Never close with a vague "we'll get back to you soon" — ask WHEN.
    // A concrete time turns a captured lead into a scheduled conversation.
    const isCourse = p.interest?.includes('b1_course');
    await reply(phone, session, isCourse
      ? `🎉 *תודה, ${p.name}!*\n\nקיבלנו את הפרטים לגבי *קורס הרומנית B1*.\n\n` +
        `*מתי נוח לך שנתקשר?* בוקר (09:00-12:00) או אחר הצהריים (14:00-18:00)?`
      : `🎉 *מצוין, ${p.name}!*\n\nהפרטים אצלנו ועו״ד פודים יחזור אליך אישית.\n\n` +
        `*מתי נוח לך?* בוקר (09:00-12:00) או אחר הצהריים (14:00-18:00)?\n\n` +
        `_השיחה ללא התחייבות — הערכת סיכוי, מה צריך לאתר, וטווחי זמן ועלות למקרה שלך._`
    );
    await maybeSaveLead(phone, session);
    await new Promise(r => setTimeout(r, 500));
    await showInterestButtons(phone);
    save(phone, session);
    return;
  }

  // 4. Decide what a good salesperson does next
  const closedRecently =
    session.lastCloseTurn !== undefined &&
    ((p.messageCount || 0) - session.lastCloseTurn) < 3;
  const decision = nextAction.decide({
    analysis, profile: p, text, recentClose: closedRecently,
  });
  p.nextAction = decision.action;
  console.log(`🎯 [${phone}] action=${decision.action} (${decision.reason})`);

  // 5. Compose the reply — AI first, scripted fallback
  let replyText = null;
  if (aiWillCompose) {
    replyText = await brain.compose(analysis, p, session.history || [], decision.directive);
  }
  if (!replyText) {
    // Actions with purpose-built copy (escalation, asking for contact details,
    // closing, objection playbooks) must keep it. Only informational turns
    // prefer a corpus-grounded answer over canned FAQ text.
    const INFORMATIONAL = [
      nextAction.ACTIONS.ANSWER_QUESTION,
      nextAction.ACTIONS.ASK_DISCOVERY,
      nextAction.ACTIONS.PRESENT_VALUE,
      nextAction.ACTIONS.OFFER_CONSULTATION,
    ];
    replyText = INFORMATIONAL.includes(decision.action)
      ? (fallbackFor(analysis, p, text, session, !!decision.appendContactAsk) || decision.fallbackText)
      : (decision.fallbackText || fallbackFor(analysis, p, text, session, !!decision.appendContactAsk));
  }

  replyText = avoidRepetition(session, replyText);

  // 5b. No conversation ends without one concrete call on the table.
  //     The AI composes freely, but on a terminal turn — the lead is leaving,
  //     asked for a human, or we just closed — the reply must name עו״ד פודים
  //     and propose a time. "בהקדם" is not a close; a time is.
  // A reply with no question in it is a dead end — the lead has nothing to
  // answer, so the conversation stops there. The trainer saw this repeatedly:
  // "תור אחרון חלש ('תודה על המידע') מאבד הזדמנות". From a few turns in,
  // every reply must carry the conversation forward or close it.
  // ── How often may we close? ───────────────────────────────────────────────
  //
  // Trainer run 3 is the cautionary tale: the close fired on 73% of all turns,
  // so the bot answered "תסביר לי בלי לשכנע אותי לשיחה" with yet another
  // "מחר בבוקר או אחר הצהריים?". Scores fell across every dimension. A close
  // repeated every turn stops being a close and becomes nagging.
  //
  // So: closing is rationed. A lead who is genuinely leaving always gets one.
  // Everyone else gets one at most every third turn, and a lead who asked us
  // to stop selling gets none at all for a while.
  const turn = p.messageCount || 0;
  const sinceClose = session.lastCloseTurn ? turn - session.lastCloseTurn : 99;

  if (closing.signalsNoPush(text)) session.noPushUntil = turn + 3;
  const pushSuppressed = turn <= (session.noPushUntil || 0);

  const departing = closing.signalsEnding(text);
  const wantsClose =
    decision.closeToCall ||
    decision.escalate ||
    decision.action === nextAction.ACTIONS.CLOSE ||
    decision.action === nextAction.ACTIONS.CLOSE_TO_CALL;

  // NOTE: there used to be a "dead end" rule here that appended the close to
  // any reply without a question mark. It fired on nearly every turn — 73% of
  // all replies carried the close — and trainer runs 3 and 4 fell from 68.9 to
  // 51.2 because of it. Closing is now driven only by an explicit signal.

  // A reply that already ends with a question is not a dead end and does not
  // need our close bolted on. Appending here is what produced the two-question
  // messages the lead pushed back on ("עכשיו אתה שואל אותי שוב מתי נוח?").
  const alreadyAsks = /\?/.test(replyText.split(/\n{2,}/).slice(-2).join(' '));

  // A departure is the exception: the lead is leaving, so a weak trailing ask
  // ("רוצה שנעשה בדיקה?") gets replaced by the real close rather than skipped.
  const terminalTurn =
    (departing && sinceClose >= 1) ||
    (!alreadyAsks && wantsClose && sinceClose >= 3 && !pushSuppressed);

  // Count contact asks so the ladder can step down instead of repeating.
  if (decision.contactAsk) p.contactAsks = (p.contactAsks || 0) + 1;
  if (decision.action === nextAction.ACTIONS.HANDLE_OBJECTION) {
    const primary = (p.objections || []).find(o => !o.resolved);
    if (primary) {
      p.objectionAnswered = p.objectionAnswered || {};
      p.objectionAnswered[primary.type] = true;
    }
  }

  if (terminalTurn) {
    const before = replyText;
    replyText = closing.ensureCallClose(replyText, p, {
      variant: decision.escalate ? 'handoff'
             // A second close hard on the heels of the first gets the short form.
             : departing ? (sinceClose <= 2 ? 'departing_brief' : 'departing')
             : undefined,
      seed: turn,
    });
    if (replyText !== before) session.lastCloseTurn = turn;
  }
  if (closing.hasCallClose(replyText)) session.lastCloseTurn = turn;

  await reply(phone, session, replyText);

  // 6. Mark objections we just answered as addressed
  if (decision.action === nextAction.ACTIONS.HANDLE_OBJECTION) {
    const primary = (p.objections || []).find(o => !o.resolved);
    if (primary) primary.resolved = true;
  }

  // 7. Capture the lead the moment we have name + phone
  await maybeSaveLead(phone, session);

  // 8. Escalate / alert
  if (decision.escalate) {
    p.humanStatus = 'notified';
    p.stage = 'HUMAN_HANDOFF';
    storage.logEvent(phone, 'human_handoff', { reason: decision.reason });
    handoff.notifyHandoff(p, decision.reason).catch(e => console.warn('⚠️ handoff notify:', e.message));
  } else if (
    scoring.isHot(p.buyingIntent, config.HOT_LEAD_THRESHOLD) &&
    !session.hotNotified
  ) {
    session.hotNotified = true;
    storage.logEvent(phone, 'hot_lead', { score: p.buyingIntent });
    handoff.notifyHotLead(p).catch(e => console.warn('⚠️ hot lead notify:', e.message));
  }

  // 9. Roll the summary forward occasionally, not every turn
  if (brain.isAvailable() && (p.messageCount % 5 === 0)) {
    brain.updateSummary(p, session.history || [])
      .then(s => { p.conversationSummary = s; save(phone, session); })
      .catch(() => {});
  }

  save(phone, session);
}

/**
 * The original questionnaire, preserved. It only runs while the FSM is in a
 * slot-filling state AND the AI hasn't already captured that fact.
 */
async function handleScriptedState(phone, session, text, analysis) {
  const p = session.profile;
  const e = p.eligibility || {};
  const state = session.state;

  switch (state) {
    case 'ELIG_Q1': {
      if (!e.ancestor) p.eligibility.ancestor = text.trim();
      session.state = 'ELIG_Q2';
      if (!e.birthYear) {
        await reply(phone, session,
          `תודה. ומה *שנת הלידה המשוערת* שלו/שלה?\n\n(אם לא יודע בדיוק — שנה משוערת מספיקה)`);
        return true;
      }
      return false;
    }

    case 'ELIG_Q2': {
      const dontKnow = ['לא יודע', 'לא יודעת', 'אין לי מושג', 'לא זוכר', 'לא בטוח'];
      if (dontKnow.some(d => text.includes(d))) {
        session.state = 'ELIG_NO_DOCS';
        p.eligibility.hasDocuments = false;
        await reply(phone, session, faq.get('no_docs'));
        return true;
      }
      const year = text.match(/\d{4}/)?.[0];
      if (year && !e.birthYear) p.eligibility.birthYear = year;
      else if (!e.birthYear) p.eligibility.birthYear = text.trim();
      session.state = 'ELIG_Q3';
      if (!e.birthPlace) {
        await reply(phone, session,
          `מצוין. ואם ידוע — *באיזו עיר או מחוז ברומניה* נולד/ה?\n\n(אם לא ידוע, כתוב "לא ידוע" ונמשיך)`);
        return true;
      }
      return false;
    }

    case 'ELIG_Q3': {
      if (!e.birthPlace) p.eligibility.birthPlace = text.trim();
      p.eligibility = leadProfile.deriveArticle(p.eligibility);
      session.state = 'ELIG_Q4';
      await reply(phone, session,
        `ועכשיו השאלה הכי חשובה — *באיזו שנה בערך עלה/תה לישראל?*\n\n` +
        `_שנת העלייה קובעת אם האזרחות נשמרה או נשללה, וזה משנה את כל התהליך._`);
      return true;
    }

    case 'ELIG_Q4': {
      const year = text.match(/\d{4}/)?.[0];
      if (year) p.eligibility.leftYear = year;
      p.eligibility = leadProfile.deriveArticle(p.eligibility);
      await showEligibilityAssessment(phone, session);
      return true;
    }

    case 'ELIG_NO_DOCS': {
      if (!e.ancestor) p.eligibility.ancestor = text.trim();
      await showEligibilityAssessment(phone, session);
      return true;
    }

    case 'LEAD_NAME': {
      if (analysis?.profileUpdates?.name) p.name = analysis.profileUpdates.name;
      else if (text.trim().length >= 2) p.name = text.trim();
      else {
        await reply(phone, session, 'אנא הזן שם מלא כדי שנוכל להמשיך. 😊');
        return true;
      }
      session.state = 'LEAD_PHONE';
      await reply(phone, session,
        `תודה *${p.name}*! 🙏\n\nומה *מספר הטלפון* שלך לחזרה?`);
      return true;
    }

    case 'LEAD_PHONE': {
      const cleaned = text.replace(/[\s\-()]/g, '');
      if (!/^[0-9+]{7,15}$/.test(cleaned)) {
        await reply(phone, session, 'אנא הזן מספר טלפון תקין (לדוגמה: 0501234567)');
        return true;
      }
      p.clientPhone = cleaned;
      session.state = 'COMPLETE';
      p.stage = 'CONVERSION';

      // A time may already have been agreed earlier in the conversation. Asking
      // "מתי נוח?" again here is what made a lead snap: "כבר קבעת לי מחר 9:30,
      // עכשיו אתה שואל אותי שוב מתי נוח לי?".
      const history = (session.history || []).map(h => h.text).join(' ');
      const timeAlreadySet = closing.alreadyScheduled(history);
      const timeAsk = timeAlreadySet
        ? `נתראה במועד שקבענו. אם משהו משתנה — *${closing.OFFICE_PHONE}*.`
        : closing.callClose(p, { variant: 'ask_time' });

      const isCourse = p.interest?.includes('b1_course');
      await reply(phone, session, isCourse
        ? `🎉 *תודה, ${p.name}!*\n\nקיבלנו את הפרטים שלך לגבי *קורס הרומנית B1*.\n\n${timeAsk}`
        : `🎉 *מצוין, ${p.name}!*\n\nקיבלנו את הפרטים.\n\n${faq.get('consultation')}\n\n${timeAsk}`
      );

      await maybeSaveLead(phone, session);
      // No menu after conversion. The lead just gave us their number — showing
      // "במה תרצה שנתחיל?" throws them back to the start of the funnel.
      return true;
    }

    default:
      return false;
  }
}

async function showEligibilityAssessment(phone, session) {
  const p = session.profile;
  const e = p.eligibility || {};
  session.state = 'LEAD_NAME';
  p.stage = stages.shouldAdvance(p.stage, 'VALUE');

  const summary = [
    e.ancestor   ? `• בן משפחה: *${e.ancestor}*` : '',
    e.birthYear  ? `• שנת לידה: *${e.birthYear}*` : '',
    e.birthPlace ? `• מקום: *${e.birthPlace}*` : '',
  ].filter(Boolean).join('\n');

  const uncertain = !e.leftYear && !e.birthPlace;

  const assessment = uncertain
    ? `לפי הנתונים שמסרת — *ייתכן שקיימת זכאות*, אך נדרשת בדיקה מעמיקה יותר. 🟡`
    : `לפי הנתונים שמסרת — *יש סיכוי ממשי לזכאות*. 🟢`;

  const route = routeSummary(session.profile);

  await reply(phone, session,
    `תודה! ${assessment}${summary ? `\n\n_מה שמסרת:_\n${summary}` : ''}\n\n${route}` +
    `כדי לאמת את זה מול הרשויות ברומניה, *עו״ד מהמשרד צריך לעבור על המקרה*.\n\n` +
    `נשמח לחזור אליך לתיאום שיחת ייעוץ — *מה שמך המלא?*`
  );
}

// ─── Lead capture ─────────────────────────────────────────────────────────────

async function maybeSaveLead(phone, session) {
  const p = session.profile;
  if (session.leadSaved) return;
  if (!leadProfile.hasContactDetails(p)) return;

  session.leadSaved = true;
  p.stage = stages.shouldAdvance(p.stage, 'CONVERSION');

  const e = p.eligibility || {};
  storage.saveLead({
    waPhone: phone,
    name: p.name,
    clientPhone: p.clientPhone,
    // `source` is WHERE the lead came from; `interest` is WHAT they want.
    // These used to be collapsed into one field, which discarded attribution.
    source: p.source || 'unknown',
    attribution: p.attribution || null,
    campaign: p.campaign || null,
    interest: p.interest,
    familyMember: e.ancestor,
    birthYear: e.birthYear,
    city: e.birthPlace,
    leftYear: e.leftYear,
    likelyArticle: e.likelyArticle,
    territory: e.territory,
    motivation: p.motivation,
    urgency: p.urgency,
    buyingIntent: p.buyingIntent,
    stage: p.stage,
    objections: (p.objections || []).map(o => o.type),
    summary: p.conversationSummary,
  });

  storage.logEvent(phone, 'lead_captured', {
    score: p.buyingIntent,
    interest: p.interest,
    article: e.likelyArticle,
  });

  console.log(`💾 [${phone}] Lead saved: ${p.name} / ${p.clientPhone} (score ${p.buyingIntent})`);
  handoff.notifyNewLead(p).catch(err => console.warn('⚠️ lead notify failed:', err.message));
}

// ─── No-AI fallback analysis ──────────────────────────────────────────────────

/**
 * Rule-based understanding. Weaker than the model, but far better than the
 * original keyword matcher: Hebrew-prefix aware, extracts years and phones,
 * and detects objections.
 */
const INTENT_PHRASES = [
  ['request_human',  ['נציג', 'אדם אמיתי', 'לדבר עם מישהו', 'לדבר עם עורך', 'עורך דין אמיתי', 'בן אדם']],
  ['ask_cost',       ['כמה עולה', 'כמה זה עולה', 'כמה יעלה', 'כמה זה', 'מחיר', 'עלות', 'עלויות', 'שכר טרחה', 'כמה כסף', 'תמחור']],
  ['ask_time',       ['כמה זמן', 'לוח זמנים', 'כמה זה לוקח', 'מתי אקבל', 'תוך כמה']],
  ['ask_b1',         ['b1', 'בי1', 'תעודת שפה', 'מבחן שפה', 'בחינת שפה', 'דרישת השפה']],
  ['ask_b1_course',  ['קורס', 'ללמוד רומנית', 'לימודי רומנית']],
  ['ask_children',   ['הילדים שלי', 'לילדים שלי', 'הבן שלי', 'הבת שלי', 'לנכדים', 'ילדיי', 'גם הילדים']],
  ['ask_documents',  ['מסמכים', 'תעודות', 'מה צריך להביא', 'איזה מסמכים', 'תעודת לידה']],
  ['ask_legality',   ['חוקי', 'לגיטימי', 'קומבינה', 'זה בסדר מבחינת החוק']],
  ['ask_eligibility',['זכאי', 'זכאות', 'מגיע לי', 'יש לי סיכוי']],
  ['ask_process',    ['תהליך', 'שלבים', 'איך זה עובד', 'מה קורה אחרי']],
  ['ask_travel',     ['לנסוע', 'טיסה', 'לטוס', 'צריך להגיע', 'נסיעה לרומניה']],
  ['ask_benefits',   ['מה זה נותן', 'יתרונות', 'למה שווה', 'מה מקבלים']],
  ['ask_trust',      ['מי אתם', 'איך אני יודע', 'אתם אמינים', 'המלצות']],
  ['ready_to_start', ['רוצה להתחיל', 'איך מתחילים', 'לקבוע פגישה', 'להיפגש', 'בואו נתחיל', 'להירשם', 'איך נרשמים']],
  ['greeting',       ['שלום', 'היי', 'הי', 'בוקר טוב', 'ערב טוב', 'מה נשמע']],
];

const ANCESTOR_RE = /(סבתא רבתא|סבא רבא|סבתא|סבתי|סבא|סבי|אמא|אימא|אבא|אבי|אמי|הורה|דודה|דוד)(\s*(?:שלי|מצד\s*(?:אמא|אבא|אמי|אבי|האם|האב)))?/;
const NAME_RE = /(?:קוראים לי|שמי|השם שלי|אני נקרא(?:ת)?)\s+([֐-׿]+(?:\s+[֐-׿]+)?)/;
const PHONE_RE = /(?:\+?972|0)5\d[\s-]?\d{3}[\s-]?\d{4}/;
const YEAR_RE = /\b(1[89]\d{2}|20[0-2]\d)\b/g;

/**
 * Rule-based understanding — the fallback the customer actually gets whenever
 * the AI is off, erroring, or unconfident. Deliberately more capable than a
 * keyword list: Hebrew-prefix aware, and it extracts real facts.
 */
function ruleBasedAnalysis(text, profile) {
  const lower = String(text).toLowerCase();
  const has = p => scoring.hasPhrase(lower, p.toLowerCase());

  let intent = 'unclear';
  for (const [key, phrases] of INTENT_PHRASES) {
    if (phrases.some(has)) { intent = key; break; }
  }

  const detected = objections.detect(text);
  const scored = scoring.score(text, profile);

  // ─── Emotion ────────────────────────────────────────────────────────────
  // A frustrated customer must never be answered with a knowledge passage.
  const FRUSTRATION = [
    'אף אחד לא', 'לא חוזר', 'לא חוזרים', 'מחכה כבר', 'לא רציני', 'לא מקצועי',
    'נמאס', 'מתסכל', 'תסכול', 'חוצפה', 'בושה', 'מזעזע', 'גרוע', 'זלזול',
    'מבטיחים ולא', 'שבועיים ואף', 'חודש ואף', 'מספיק לי',
  ];
  const emotion = FRUSTRATION.some(f => lower.includes(f)) ? 'frustrated' : 'neutral';

  // ─── Extraction ─────────────────────────────────────────────────────────
  const e = profile.eligibility || {};
  const years = [...String(text).matchAll(YEAR_RE)].map(m => m[1]);
  const place = leadProfile.detectPlace(text);
  const ancestorMatch = text.match(ANCESTOR_RE);
  const nameMatch = text.match(NAME_RE);
  const phoneMatch = text.match(PHONE_RE)?.[0] || null;

  // Deciding whether a year is a BIRTH year or an EMIGRATION year matters a
  // great deal — the emigration year is what classifies the legal route.
  const EMIGRATION_VERB = /על[התו]|עלייה|עלינו|עזב|הגיע|הגיעה|יצא|יצאה|ברח|ברחה|בא לארץ|באה לארץ|הגירה/;
  const BIRTH_VERB = /נולד|נולדה|לידה/;

  let birthYear = null, leftYear = null;
  if (years.length === 1) {
    const y = years[0];
    const emigrationAt = text.search(EMIGRATION_VERB);
    const birthAt = text.search(BIRTH_VERB);
    const yearAt = text.indexOf(y);

    if (emigrationAt >= 0 && birthAt >= 0) {
      // Both verbs present ("נולד ביאשי ועלה ב-1962") — the year belongs to
      // whichever verb it sits closest to.
      const nearerEmigration =
        Math.abs(yearAt - emigrationAt) < Math.abs(yearAt - birthAt);
      if (nearerEmigration) { if (!e.leftYear) leftYear = y; }
      else if (!e.birthYear) birthYear = y;
    } else if (emigrationAt >= 0) {
      if (!e.leftYear) leftYear = y;
    } else if (birthAt >= 0) {
      if (!e.birthYear) birthYear = y;
    } else {
      // No clue in the wording — fill whichever slot the flow is waiting for
      if (!e.birthYear) birthYear = y;
      else if (!e.leftYear) leftYear = y;
    }
  } else if (years.length >= 2) {
    // "נולדה ב-1931 ועלתה ב-1948" — earliest is birth, latest is emigration
    const sorted = [...years].sort();
    if (!e.birthYear) birthYear = sorted[0];
    if (!e.leftYear) leftYear = sorted[sorted.length - 1];
  }

  const eligibility = {
    ancestor: !e.ancestor && ancestorMatch ? ancestorMatch[0].trim() : null,
    birthYear,
    leftYear,
    birthPlace: !e.birthPlace && place ? place.place : null,
    territory: !e.territory && place ? place.territory : null,
    likelyArticle: !e.likelyArticle && place ? place.article : null,
  };

  const extractedAnything =
    Object.values(eligibility).some(Boolean) || nameMatch || phoneMatch;

  // ─── Stage ──────────────────────────────────────────────────────────────
  let stage = profile.stage;
  if (intent === 'request_human' || emotion === 'frustrated') stage = 'HUMAN_HANDOFF';
  else if (detected.length) stage = 'OBJECTION';
  else if (intent === 'ready_to_start' || scored.score >= 70) stage = 'HIGH_INTENT';
  else if (extractedAnything) stage = 'QUALIFICATION';
  else if (intent.startsWith('ask_')) stage = 'DISCOVERY';

  // Confidence: we know more when we recognised an intent AND pulled out facts
  let confidence = 0.3;
  if (intent !== 'unclear') confidence = 0.6;
  if (intent !== 'unclear' && extractedAnything) confidence = 0.7;
  if (intent === 'unclear' && extractedAnything) confidence = 0.5;

  return {
    intent,
    emotion,
    stage,
    buyingIntent: scored.score,
    buyingIntentBand: scored.band,
    matchedSignals: scored.matched,
    objections: detected,
    missingInfo: leadProfile.missingFacts(profile),
    nextBestAction: 'answer_question',
    escalate: intent === 'request_human' || emotion === 'frustrated',
    escalateReason: emotion === 'frustrated'
      ? 'customer appears frustrated'
      : (intent === 'request_human' ? 'customer asked for a human' : null),
    confidence,
    summary: profile.conversationSummary || '',
    profileUpdates: {
      name: !profile.name && nameMatch ? nameMatch[1].trim() : null,
      clientPhone: phoneMatch ? phoneMatch.replace(/[\s-]/g, '') : null,
      eligibility,
    },
  };
}

/**
 * Nothing marks a bot out faster than sending the same sentence twice.
 * If we're about to repeat ourselves, rephrase instead.
 */
const REPHRASE_PREFIXES = [
  'רק כדי שאוכל להתקדם — ',
  'אם אפשר, ',
  'שאלה אחת ואפשר להתקדם: ',
];

/**
 * When the only thing left to say is a question we already asked, say something
 * else. Each of these moves the conversation without pressing the same button.
 */
const REPEAT_ALTERNATIVES = [
  'אני שם לב ששאלתי את זה כבר — אולי אין את המידע הזה בהישג יד כרגע, וזה בסדר גמור. 🙂\n\n' +
  'אפשר גם להתחיל בלי זה: עו״ד פודים יודע לאתר את הפרטים בארכיונים ברומניה.',

  'בוא ננסה מזווית אחרת — *מה כן ידוע לך?* אפילו שם של עיר, או בערך מתי המשפחה הגיעה לארץ. ' +
  'גם פרט חלקי מכוון אותנו.',
];

/** Token overlap, 0..1. Enough to catch a rephrased version of the same ask. */
function similarity(a, b) {
  const tok = t => new Set(normalise(t).split(/\s+/).filter(w => w.length > 2));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * The question a reply ends on — that is what the customer is asked to answer.
 *
 * We prefer the *bolded* question, because the wrapper around it changes every
 * turn while the ask itself does not: "רק שאבין את המקרה שלך — *מי במשפחה נולד
 * ברומניה?*" and "כדי לבדוק את הזכאות שלך — *מי במשפחה נולד ברומניה?*" score
 * only 0.67 as whole lines, but the bold part is identical.
 */
function askOf(text) {
  const qs = String(text || '').split(/\n+/).filter(l => l.includes('?'));
  if (!qs.length) return null;
  const line = qs[qs.length - 1];
  const bold = line.match(/\*([^*]*\?[^*]*)\*/);
  return bold ? bold[1].trim() : line.trim();
}

/**
 * Trainer run 5, four personas at 42/100, same complaint each time:
 * "הבוט שאל 'מה שמך המלא?' ארבע פעמים", "חזר שלוש פעמים על אותה נוסחה",
 * and one lead said outright "אתה חוזר על אותו דבר פעם אחר פעם" — and the bot
 * did it again in the next turn.
 *
 * The old guard compared only against the PREVIOUS message and only on exact
 * equality, so a repeat two turns later, or a lightly reworded one, sailed
 * through. Now we look back over the recent bot turns and compare the ask.
 */
function avoidRepetition(session, text) {
  const history = session.history || [];
  const lastBot = [...history].reverse().find(m => m.role === 'assistant');
  if (!lastBot || !text) return text;

  // Has this same ask already been put to the customer recently?
  const ask = askOf(text);
  if (ask) {
    const recentAsks = [...history].reverse()
      .filter(m => m.role === 'assistant').slice(0, 6)
      .map(m => askOf(m.text)).filter(Boolean);
    const alreadyAsked = recentAsks.some(prev => similarity(prev, ask) >= 0.75);
    if (alreadyAsked) {
      // Drop the repeated question. Keep the substance of the answer, and let
      // the customer breathe instead of pressing the same button again.
      // askOf() returns the bolded core, so drop any line CONTAINING it —
      // filtering on equality silently kept the question in place.
      const body = text.split(/\n+/)
        .filter(l => !l.includes(ask) && similarity(l, ask) < 0.75)
        .join('\n').trim();
      session.repeatedAsk = (session.repeatedAsk || 0) + 1;

      // If the ask WAS the whole reply, removing it leaves nothing — and
      // returning the original would repeat the question we just caught.
      // Change the approach instead of pressing the same button again.
      if (!body) {
        const alt = REPEAT_ALTERNATIVES[(session.repeatedAsk - 1) % REPEAT_ALTERNATIVES.length];
        if (session.repeatedAsk >= 3) {
          session.repeatedAsk = 0;
          return closing.contactLadder(session.profile, 2);
        }
        return alt;
      }

      if (session.repeatedAsk >= 2) {
        session.repeatedAsk = 0;
        return `${body}\n\n${closing.contactLadder(session.profile, 2)}`.trim();
      }
      return body;
    }
    session.repeatedAsk = 0;
  }

  const same = normalise(lastBot.text) === normalise(text) ||
               similarity(lastBot.text, text) >= 0.85;
  if (!same) {
    session.repeatCount = 0;
    return text;
  }

  const attempts = (session.repeatCount || 0) + 1;
  session.repeatCount = attempts;

  // Twice already — stop asking and hand over rather than wear the customer down
  if (attempts >= 2) {
    session.repeatCount = 0;
    return `נראה שאני לא מצליח להתקדם כאן, ואני מעדיף לא להתיש אותך. 🙏\n\n` +
           `אעביר את הפרטים לעו״ד פודים שיחזור אליך אישית.\n\n` + closing.callClose(session.profile, { variant: 'handoff' });
  }

  const prefix = REPHRASE_PREFIXES[(attempts - 1) % REPHRASE_PREFIXES.length];
  return prefix + text.replace(/^[\s—–-]*/, '');
}

/**
 * Answer from the knowledge corpus when the AI is unavailable.
 * Better than a fixed FAQ paragraph: the passage is chosen for THIS message,
 * and we add a short lead-in so it reads like an answer, not a leaflet.
 */
const LEAD_INS = ['', 'שאלה טובה. ', 'בקצרה — ', 'נקודה חשובה כאן — ', ''];

const CONTACT_ASKS = [
  'רוצה שעו״ד מהמשרד יעבור על המקרה שלך? *מה שמך המלא?*',
  'אם תרצה שנבדוק את זה לעומק — *איך קוראים לך?*',
  'כדי שנוכל לחזור אליך עם תשובה מדויקת — *מה שמך המלא?*',
];


/**
 * Trim a knowledge passage to something a person will read on a phone, without
 * ever ending mid-sentence. Whole lines only, and the result must end on a
 * sentence, a bullet, or a closing mark.
 */
function trimToWhatsApp(text, budget = 480) {
  const lines = String(text).split('\n');
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget && out.length) break;
    out.push(line);
    used += line.length + 1;
  }
  // Walk back to the last line that closes a thought.
  while (out.length > 1) {
    const last = out[out.length - 1].trim();
    if (!last || /[.!?:•]$/.test(last) || /[.!?]["'״׳]?$/.test(last)) break;
    out.pop();
  }
  return out.join('\n').trim();
}

function answerFromCorpus(text, analysis, profile, session, forceCta = false) {
  const hits = retrieve.forIntent(analysis.intent, text, profile.recentPassages || [])
    // Some passages are coaching notes for the bot ("כשלקוח שואל פעם שנייה —
    // לחזור על X זה מה שמאבד אותו"). The AI may read them as guidance, but the
    // scripted path echoes passages verbatim, and a lead must never be shown
    // the bot's own playbook.
    .filter(h => !h.internal);
  if (!hits.length) return null;

  const top = hits[0];
  profile.recentPassages = [top.id, ...(profile.recentPassages || [])].slice(0, 6);

  // Keep it WhatsApp-sized — but never mid-sentence. Slicing a fixed number of
  // lines cut a bullet in half ("...ונדרשים בו פנייה ל-ANC, שבועת אמונים") and
  // a lead told us so: "את מבלבלת אותי". Cut on whole lines, and only where the
  // previous line actually ended something.
  const body = trimToWhatsApp(top.text, 480);
  const turn = profile.messageCount || 0;
  const leadIn = LEAD_INS[turn % LEAD_INS.length];

  // Don't end every single message with a call to action — that is exactly
  // what makes a bot feel like a bot. Ask every other turn at most, unless
  // buying intent is high, in which case it's worth pushing on every answer.
  const askedRecently = session?.lastCtaTurn && (turn - session.lastCtaTurn) < 2;
  let followOn = '';

  if (!askedRecently || forceCta) {
    if (!leadProfile.isQualified(profile)) {
      const missing = leadProfile.missingFacts(profile);
      const asks = {
        ancestor:   '\n\nרק שאבין את המקרה שלך — *מי במשפחה נולד ברומניה?*',
        birthPlace: '\n\nואיפה בערך הוא/היא נולד/ה?',
        leftYear:   '\n\nושאלה שקובעת הרבה — *באיזו שנה בערך עלה/תה לישראל?*',
        birthYear:  '\n\nומה שנת הלידה בערך?',
      };
      followOn = asks[missing[0]] || '';
    } else if (!leadProfile.hasContactDetails(profile)) {
      followOn = profile.name
        ? `\n\nרוצה שעו״ד יחזור אליך? מה *מספר הטלפון* שלך?`
        : '\n\n' + CONTACT_ASKS[turn % CONTACT_ASKS.length];
    }
    if (followOn && session) session.lastCtaTurn = turn;
  }

  return leadIn + body + followOn;
}

/**
 * A sentence about THIS customer's likely route, based on what they told us.
 * This is what makes the conversation feel like a consultation rather than a
 * form — the customer hears something about their own family, not a brochure.
 */
function routeSummary(profile) {
  const e = profile.eligibility || {};

  if (e.group === 1 || e.group === 'likely_1') {
    return `לפי שנת העלייה, נשמע שהאזרחות של ${e.ancestor || 'בן המשפחה'} *כנראה מעולם לא נשללה* — ` +
           `וזה המצב הטוב ביותר: אין מגבלת דורות, ובדרך כלל גם אין צורך בשבועה או בתעודת B1.\n` +
           `_זו הערכה ראשונית — צריך לאמת מול הרשויות ברומניה._\n\n`;
  }
  if (e.group === 2 || e.group === 3) {
    return `לפי שנת העלייה, נראה שמדובר במסלול של *השבת אזרחות* — כלומר הזכאות מגיעה עד דור הנכדים, ` +
           `ונדרשות גם שבועת אמונים ותעודת B1.\n` +
           `_זו הערכה ראשונית שצריך לאמת._\n\n`;
  }
  if (e.group === 'article_11') {
    return `${e.birthPlace || 'האזור שציינת'} הוא חבל בסרביה — ושם הזכאות *רחבה יותר, עד דור הנינים*.\n` +
           `כלומר גם הילדים והנכדים שלך עשויים להיות בתמונה.\n\n`;
  }
  if (String(e.likelyArticle) === '11') {
    return `לפי מקום הלידה, המסלול הרלוונטי הוא כנראה *סעיף 11* — שמגיע עד דור הנינים.\n\n`;
  }
  // A Romanian birthplace does not decide the route — the year of departure
  // does. Saying "כנראה סעיף 10" from a city name alone was part of the
  // inaccuracy the firm flagged.
  return '';
}

function fallbackFor(analysis, profile, text = '', session = null, forceCta = false) {
  // Prefer a corpus-grounded answer over a canned paragraph
  const fromCorpus = answerFromCorpus(text, analysis, profile, session, forceCta);
  if (fromCorpus) return fromCorpus;

  const key = faq.BY_INTENT[analysis.intent];
  if (key) return faq.get(key);

  if (analysis.intent === 'greeting') {
    return `היי! 😊 במה אוכל לעזור — בדיקת זכאות, מידע על התהליך, או קורס ה-B1?`;
  }

  // Qualified but no contact details — say something specific about THEIR
  // route, then ask for the one detail we're missing.
  if (leadProfile.isQualified(profile) && !leadProfile.hasContactDetails(profile)) {
    const route = routeSummary(profile);
    if (!profile.name) {
      return `${route}כדי שעו״ד מהמשרד יעבור על המקרה שלך ויחזור אליך — *מה שמך המלא?*`;
    }
    return `${route}מעולה, *${profile.name}*. ומה *מספר הטלפון* שלך לחזרה?`;
  }
  return `לא בטוח שהבנתי במדויק — אפשר לנסח קצת אחרת? 🙏\n\n` +
         `או שאעביר אותך לעו״ד מהמשרד שיענה לך ישירות. פשוט כתוב *נציג*.`;
}

module.exports = {
  handleMessage,
  handleStart,
  showInterestButtons,
  isTriggerMessage,
  normalise,
  ruleBasedAnalysis,
  maybeSaveLead,
};
