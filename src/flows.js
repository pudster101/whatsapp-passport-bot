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
const experiment = require('./sales/experiment');
const meeting = require('./sales/meeting');
const scoring = require('./sales/scoring');
const objections = require('./sales/objections');
const nextAction = require('./sales/nextAction');
const handoff = require('./sales/handoff');
const closing = require('./sales/closing');
const dashboard = require('./admin/dashboard');

// A real conversation on 5 Sep ran past this and the transcript looked as if
// it had been chopped into pieces. Postgres stores the session as JSONB, so a
// longer history costs almost nothing and keeps the record whole.
const MAX_HISTORY = 100;

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
    if (n === nt) return true;
    if (n.includes(nt)) return true;          // the trigger plus the lead's own words
    // The reverse direction catches a trigger the ad platform truncated — but
    // it used to accept ANY substring, and a single letter is a substring of
    // the trigger phrase. That is why 0547787804 got the opening message 22
    // mornings in a row: "י", "ח", "ע", even the English "h" and "n", each
    // counted as a fresh click on the ad and restarted his conversation.
    return n.length >= 12 && nt.startsWith(n);
  });
}

/**
 * Which language did they write in? Hebrew wins whenever any Hebrew appears —
 * a lead who mixes "B1" or a city name into a Hebrew sentence is writing
 * Hebrew. Latin-only text with a few letters in it is English.
 */
function detectLang(text) {
  const t = String(text || '');
  if (/[֐-׿]/.test(t)) return 'he';
  if ((t.match(/[A-Za-z]/g) || []).length >= 3) return 'en';
  return null;
}

/**
 * Which grammatical gender to address them in.
 *
 * Four women in the 10–24 Sep window were addressed in the masculine for whole
 * conversations — עדנה לאופר, 68, was asked "בן כמה אתה?" while explaining that
 * her daughter and grandchildren might also be eligible. Hebrew makes this
 * visible in every second word, and a law firm that gets it wrong reads as a
 * form letter.
 *
 * Read it off the customer's own verbs, which is where it is unambiguous.
 * Names are not used: ישראלי names split badly by gender and a wrong guess is
 * worse than no guess.
 */
// No \b anywhere: JavaScript word boundaries are ASCII-only and never match
// next to a Hebrew letter. And every masculine form here is a prefix of its
// feminine counterpart ("מעוניין" inside "מעוניינת"), so each one carries a
// lookahead that refuses the feminine ending.
//
// Added after 13 Oct: שופט מלי wrote "נולדתי", "עליתי לישראל ב1960 בהיותי בת 3",
// "אני נישבעתי כבר מזמן בקונסוליה" and "שאלתי, כמה יעלה לי" — and was called
// "אתה" four times before the bot switched. None of the patterns above covered
// the way she actually wrote. "ילידת/יליד" and "בהיותי בת/בן" are unambiguous
// and both appeared verbatim in live chats; "רוצה" and "נישבעתי" are identical
// in both genders and are deliberately absent.
const FEMININE_SELF =
  /(?:מעוניינת|מתעניינת|מבררת|בודקת|נשואה|גרושה|אלמנה|מבקשת|שמחתי|צריכה|יכולה|ילידת|בהיותי בת|אני בת \d|אני יכולה|אני מבינה|אני שואלת|אני מחפשת|אני חושבת|אני גרה|אני בטוחה)/;
const MASCULINE_SELF =
  /(?:מעוניין(?!ת)|מתעניין(?!ת)|מברר(?!ת)|בודק(?!ת)|נשוי|גרוש(?!ה)|אלמן(?!ה)|מבקש(?!ת)|צריך|יליד(?!ת)|בהיותי בן|אני בן \d|אני יכול(?!ה)|אני מבין(?!ה)|אני שואל(?!ת)|אני מחפש(?!ת)|אני חושב(?!ת)|אני גר(?!ה)|אני בטוח(?!ה))/;

function detectGender(text) {
  const t = String(text || '');
  const f = FEMININE_SELF.test(t);
  const m = MASCULINE_SELF.test(t);
  if (f && !m) return 'f';
  if (m && !f) return 'm';
  return null;
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

// 500 characters was clipping the bot's own messages in the middle of a word.
// Three transcripts from 8–10 October end mid-sentence — "כדי שנוכל לחזור אל",
// "רוצה שעו" — which is also what the model is shown as its own last turn, so
// it could not tell it had already said something and repeated whole passages.
// Sessions are JSONB in Postgres; keeping the message whole costs nothing.
const MAX_HISTORY_TEXT = 2000;

function pushHistory(session, role, text) {
  if (!text) return;
  session.history = session.history || [];
  session.history.push({
    role,
    text: String(text).slice(0, MAX_HISTORY_TEXT),
    at: new Date().toISOString(),
  });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

function save(phone, session) {
  storage.setConversation(phone, session);
}

/** Send a reply, record it in history, and keep the profile timestamps honest. */
/**
 * Put real meeting slots into a close, and remember that a meeting is on the
 * table.
 *
 * closing.callClose() leaves a placeholder where the slots go; here they are
 * filled from the real calendar (Sun–Thu, 17:00 / 18:00, at least three hours
 * ahead, never a slot another lead already asked for), and the meeting is
 * recorded as proposed so the next "יום שני" or "הראשון" books it.
 *
 * A meeting the model offered in its own words is recorded too: without that,
 * the lead's "כן" on the next turn had nothing to attach to.
 */
function prepareMeetingOffer(phone, session, text) {
  // The model once opened a reply with a stray Chinese character ("不לגבי").
  let out = String(text || '').replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, '');
  const p = session.profile || {};
  const mtg = leadProfile.ensureMeeting(p);

  // Never two meeting offers in one message. On 16 Oct the model's own offer
  // got slots appended AND the terminal close added a second, scripted offer
  // underneath — whose placeholder was never filled, so four customers saw
  // "{{MEETING_SLOTS}}". Keep the first offer; drop any later one wholesale.
  const firstTok = out.indexOf(closing.SLOTS_TOKEN);
  if (firstTok >= 0 && out.indexOf(closing.SLOTS_TOKEN, firstTok + 1) >= 0) {
    const paras = out.split(/\n{2,}/);
    let seen = false;
    out = paras.filter(pp => {
      if (!pp.includes(closing.SLOTS_TOKEN)) return true;
      if (seen) return false;
      seen = true; return true;
    }).join('\n\n');
  }
  if (out.includes(closing.SLOTS_TOKEN) && /יש לי (?:פגישה|פגישת)/.test(out)) {
    // Slots are already in the text — the scripted close is a duplicate.
    out = out.split(/\n{2,}/).filter(pp => !pp.includes(closing.SLOTS_TOKEN)
      && !/^(?:.{0,40})?הצעד הכי יעיל מכאן הוא \*פגיש/.test(pp)
      && !/^לא נוח להגיע\? אותה פגישה/.test(pp)).join('\n\n');
  }

  if (out.includes(closing.SLOTS_TOKEN)) {
    mtg.closeOffers = (mtg.closeOffers || 0) + 1;
    const mode = mtg.mode === 'video' ? 'video' : 'office';
    const slots = meeting.nextSlots({
      count: 2, taken: meeting.takenSlots(storage.getAllConversations()),
    });
    if (slots.length && !['requested', 'confirmed'].includes(mtg.status)) {
      mtg.mode = mode;
      mtg.offered = slots;
      mtg.offeredAt = new Date().toISOString();
      mtg.status = 'slots_proposed';
      storage.logEvent(phone, 'meeting_offered', {
        at: 'close', mode, slots: slots.map(s => s.iso),
      });
      out = out.split(closing.SLOTS_TOKEN).join(meeting.slotPrompt(slots, mode));
    } else {
      out = out.split(closing.SLOTS_TOKEN).join(meeting.slotPrompt([], mode));
      if (!mtg.status) { mtg.status = 'offered'; mtg.mode = mode; mtg.offeredAt = new Date().toISOString(); }
    }
  } else if (!mtg.status && meeting.mentionsMeetingOffer(out)) {
    mtg.status = 'offered';
    mtg.mode = /זום|וידאו/.test(out) && !/משרד/.test(out) ? 'video' : (mtg.mode || 'office');
    mtg.offeredAt = new Date().toISOString();
    storage.logEvent(phone, 'meeting_offered', { at: 'ai', mode: mtg.mode });
  }
  return out;
}

async function reply(phone, session, text) {
  if (!text) return false;
  text = prepareMeetingOffer(phone, session, text);
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

// ─── Agent messages ───────────────────────────────────────────────────────────

// Status replies are throttled: he may send several messages in a row, and he
// does not need the same summary three times. The queue is flushed every time.
const lastAgentStatus = new Map(); // phone → ms
const AGENT_STATUS_QUIET_MS = 10 * 60 * 1000;

/**
 * The owner wrote to the bot.
 *
 * This is not a lead and never was. Until 11 Oct it was treated as one: his
 * number ran up 63 messages, scored 100/100, appeared on the weekly page as a
 * hot lead nobody had called, and then crossed the message ceiling — at which
 * point the bot "handed him over to a human" and stopped answering him.
 *
 * What his message IS, is the thing that reopens the 24-hour window. So the
 * only two jobs here are: send him everything that was held while it was
 * closed, and tell him where things stand.
 */
async function handleAgentMessage(phone, message) {
  const text = message.type === 'text'
    ? (message.text?.body?.trim() || '')
    : `[${message.type}]`;

  console.log(`👔 [${phone}] agent message — "${text}" (not a lead)`);
  storage.logEvent(phone, 'agent_message', { text: text.slice(0, 200) });

  // The window is open again — deliver what the closed window swallowed.
  let flushed = { sent: 0, held: 0, skipped: 0 };
  try {
    flushed = await handoff.alertQueue.flush(phone);
  } catch (err) {
    console.warn(`⚠️  Alert flush failed for ${phone}: ${err.message}`);
  }

  const now = Date.now();
  const last = lastAgentStatus.get(phone) || 0;
  if (flushed.sent === 0 && now - last < AGENT_STATUS_QUIET_MS) return;
  lastAgentStatus.set(phone, now);

  // A short, honest status. Everything here is already computed for the
  // dashboard, so it costs nothing and it is what he actually asks for.
  let waiting = [], upcoming = [];
  try {
    waiting = dashboard.waitingForCallback();
    upcoming = dashboard.meetings();
  } catch (err) {
    console.warn(`⚠️  Agent status build failed: ${err.message}`);
  }

  const until = new Date(now + 24 * 3600000);
  const untilLabel = new Intl.DateTimeFormat('he-IL', {
    timeZone: config.TIMEZONE, weekday: 'long', hour: '2-digit', minute: '2-digit',
  }).format(until);

  const lines = ['✅ *החלון פתוח.*'];
  lines.push(`התראות יגיעו אליך ישירות עד *${untilLabel}*.`);
  lines.push('');

  if (flushed.sent) {
    lines.push(`📬 שלחתי לך ${flushed.sent} התראות שהמתינו.`);
    if (flushed.skipped) lines.push(`(עוד ${flushed.skipped} ישנות יותר — בדף השבועי.)`);
    lines.push('');
  }

  const requested = upcoming.filter(m => m.status === 'requested');
  if (requested.length) {
    lines.push(`📅 *${requested.length} בקשות פגישה ממתינות לאישור שלך:*`);
    for (const m of requested.slice(0, 5)) {
      lines.push(`• ${m.name || '+' + m.phone} — ${m.slotLabel}`);
    }
    lines.push('');
  }

  const confirmed = upcoming.filter(m => m.status === 'confirmed');
  if (confirmed.length) {
    lines.push(`✔️ *פגישות מאושרות:* ${confirmed.length}`);
    for (const m of confirmed.slice(0, 5)) {
      lines.push(`• ${m.name || '+' + m.phone} — ${m.slotLabel}`);
    }
    lines.push('');
  }

  if (waiting.length) {
    lines.push(`📞 *${waiting.length} לידים ממתינים לשיחה ממך:*`);
    for (const w of waiting.slice(0, 5)) {
      lines.push(`• ${w.name || '+' + w.phone} · ${w.clientPhone} · ${w.hoursWaiting} שעות`);
    }
    if (waiting.length > 5) lines.push(`_ועוד ${waiting.length - 5}._`);
    lines.push('');
  }

  if (!flushed.sent && !requested.length && !confirmed.length && !waiting.length) {
    lines.push('אין כרגע שום דבר שממתין לך. 👍');
    lines.push('');
  }

  if (config.ADMIN_TOKEN) {
    lines.push(`📊 ${config.PUBLIC_URL}/admin/weekly?token=${encodeURIComponent(config.ADMIN_TOKEN)}`);
  }

  await wa.sendText(phone, lines.join('\n').trim());
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function handleMessage(phone, message) {
  // An agent phone is never a customer. Intercepted before a session is even
  // loaded, so no conversation, no score, no message count, no lead.
  if (config.isAgentPhone(phone)) {
    return handleAgentMessage(phone, message);
  }

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
  } else if (['document', 'image', 'audio', 'video'].includes(msgType)) {
    // A client sending documents is the highest-intent signal there is, and
    // until 5 Sep we recorded it as the string "[document]" and dropped the
    // file. Meta keeps inbound media for about 30 days; capture the id now so
    // it can be fetched later, and say something human in the meantime.
    const media = message[msgType] || {};
    const filename = media.filename || media.caption || `${msgType}`;
    profile.documents = profile.documents || [];
    profile.documents.push({
      mediaId: media.id || null,
      type: msgType,
      filename,
      mime: media.mime_type || null,
      caption: media.caption || null,
      receivedAt: new Date().toISOString(),
      messageId: message.id || null,
    });
    storage.logEvent(phone, 'document_received', {
      mediaId: media.id, type: msgType, filename, mime: media.mime_type,
    });
    console.log(`📎 [${phone}] ${msgType} received — id=${media.id} name=${filename}`);

    // Sending documents is the strongest buying signal there is, and it counted
    // for nothing. On 8 Oct one lead sent a voice note, nineteen photographs, a
    // birth-certificate PDF and a death certificate inside four minutes. His
    // score was 7/100, his stage was DISCOVERY, nobody ever asked his name, and
    // three days later he got the generic "נזכרתי בשאלה ששאלת" follow-up.
    //
    // Nobody digs through a drawer for a 1950s birth certificate to pass the
    // time. The score moves with the first file and keeps moving, the documents
    // go in the file as a known fact, and once there are a few the owner is
    // told in person rather than one line per image.
    profile.eligibility = profile.eligibility || {};
    if (profile.eligibility.hasDocuments !== true) {
      profile.eligibility.hasDocuments = true;
    }
    const fileCount = profile.documents.length;
    const wasScore = profile.buyingIntent || 0;
    profile.buyingIntent = Math.min(100, Math.max(wasScore, fileCount >= 3 ? 85 : 70));
    profile.stage = stages.shouldAdvance(profile.stage, 'HIGH_INTENT');
    if (profile.buyingIntent !== wasScore) {
      console.log(`📈 [${phone}] documents received → score ${wasScore} → ${profile.buyingIntent}`);
      storage.logEvent(phone, 'hot_lead', {
        reason: 'documents_received', files: fileCount, score: profile.buyingIntent,
      });
    }
    // One alert when the pile becomes a pile, not one per photograph.
    if (fileCount === 3) {
      handoff.notifyHotLead(profile)
        .catch(e => console.warn('⚠️ document hot-lead notify:', e.message));
    }
    handoff.notifyAgents(
      `📎 *${profile.name || '+' + phone}* שלח/ה ${msgType === 'document' ? 'מסמך' : 'תמונה'}: ${filename}\n\n` +
      // The alert already carries the client's name and number, so a working
      // link is not the weakest link here — and a masked one is just useless.
      (config.ADMIN_TOKEN
        ? `להורדה: ${config.PUBLIC_URL}/admin/documents?token=${encodeURIComponent(config.ADMIN_TOKEN)}&phone=${phone}\n`
        : `להורדה: ${config.PUBLIC_URL}/admin/documents (דרוש ADMIN_TOKEN)\n`) +
      `_וואטסאפ שומרת את הקובץ כ-30 יום._`
    ).catch(e => console.warn('⚠️ document notify:', e.message));
    text = `[${msgType === 'document' ? 'מסמך' : msgType === 'image' ? 'תמונה' : msgType}: ${filename}]`;

    // People send documents in a burst — five photos of one file arrive as five
    // separate webhooks. On 6 Sep that produced six near-identical replies in
    // seven seconds, and on 7 Sep six copies of "מצוין, רשמתי. 👍" in a row.
    //
    // So: acknowledge the first file, then stay quiet for a short window while
    // the rest land. Every file is still recorded and every alert still sent —
    // only the chatter is suppressed.
    const now = Date.now();
    const lastAck = session.lastMediaAckAt ? new Date(session.lastMediaAckAt).getTime() : 0;
    const MEDIA_QUIET_MS = 45000;
    if (now - lastAck < MEDIA_QUIET_MS) {
      // Still record it in the transcript — the file is part of the story.
      profile.lastInboundAt = new Date(now).toISOString();
      profile.messageCount = (profile.messageCount || 0) + 1;
      pushHistory(session, 'user', text);
      console.log(`🤫 [${phone}] media burst — recorded, no reply`);
      save(phone, session);
      return;
    }
    session.lastMediaAckAt = new Date(now).toISOString();

    // The model never sees the file — only the placeholder above. Left to the
    // AI it invents an explanation, and on 14 Sep it told אפרים שמר that his
    // eight photos "כנראה לא עלו כמו שצריך". They had; the alert had already
    // gone out. He then typed a full transcription of a 1970 passport by hand.
    // So the acknowledgement is fixed copy: it arrived, and it is with the
    // office.
    profile.lastInboundAt = new Date(now).toISOString();
    profile.messageCount = (profile.messageCount || 0) + 1;
    pushHistory(session, 'user', text);

    // And ask for the one thing we still need. The lead who sent twenty files
    // was never asked his name, so there was nobody to call about them.
    const ackHe = `קיבלתי — הקובץ נשמר והועבר לעו״ד פודים, שיעבור עליו בעצמו. 📄\n\n` +
                  `אם יש עוד מסמכים, אפשר לשלוח גם אותם.`;
    const ackEn = `Got it — the file is saved and has been passed to Mr. Pudim, who will ` +
                  `go over it himself. \u{1F4C4}\n\nYou can send more if you have them.`;
    let ack = profile.lang === 'en' ? ackEn : ackHe;

    if (!profile.name) {
      ack += profile.lang === 'en'
        ? `\n\nSo he can match the files to you — *what is your full name?*`
        : `\n\nכדי שיֵדע לקשר את המסמכים אליך — *מה שמך המלא?*`;
    } else if (!profile.clientPhone && !(profile.contactRefusals > 0)) {
      ack += profile.lang === 'en'
        ? `\n\nAnd what number should he call you on, ${profile.name}?`
        : `\n\nולאיזה מספר שיחזור אליך, ${profile.name}?`;
    }

    await reply(phone, session, ack);
    save(phone, session);
    return;
  } else {
    // Location, contacts, stickers, unsupported types
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
        closing.callClose(profile, { variant: 'handoff' })
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
    await handleStart(phone, session, { firstMessage: text });
    return;
  }

  // ── Explicit restart ──────────────────────────────────────────────────────
  if (RESTART_WORDS.includes(normalise(text))) {
    session.state = 'WELCOME_SENT';
    session.data = {};
    await handleStart(phone, session, { keepProfile: true });
    // The opening no longer pushes a menu at people, but someone who typed
    // "תפריט" is asking for one. Show it.
    await new Promise(r => setTimeout(r, 400));
    await showInterestButtons(phone);
    save(phone, session);
    return;
  }

  // ── Brand-new number that did NOT send the trigger ────────────────────────
  // The old bot silently discarded these. That was the single biggest leak:
  // referrals, business cards, the website button and any ad-copy variant.
  if (isNew || session.state === 'NEW') {
    console.log(`🆕 [${phone}] Unknown number, no trigger — starting conversation anyway`);
    profile.source = profile.source === 'unknown' ? 'organic' : profile.source;
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

  // ── A message with nothing in it ──────────────────────────────────────────
  // One or two characters carry no question, no fact and no intent. Sending
  // them through the sales pipeline produced a full sales turn every morning
  // for three weeks. Answer briefly, in a way that invites a real message, and
  // do not spend an AI call on it.
  // "כן" and "לא" are two characters long and they are the two most common
  // answers in the language. מרדכי כהן answered "כן" to "יש לך נכדים מתחת
  // לגיל 18?" — the single most important question in his file — and was told
  // "לא הגיע לי טקסט מלא, אפשר לכתוב שוב?". So did a lead on 4 Oct who wrote
  // "לא". A real answer must never be treated as a truncated message.
  const MEANINGFUL_SHORT = new Set([
    'כן', 'לא', 'ok', 'אוק', 'נו', 'מה', 'למה', 'איך', 'כמה', 'מתי', 'מי',
    'yes', 'no', 'הי', 'היי', 'תודה', 'סבא', 'אמא', 'אבא', 'יש', 'אין',
  ]);
  const trimmed = (text || '').trim();
  if (trimmed && trimmed.length <= 2 && !/^\d+$/.test(trimmed)
      && !MEANINGFUL_SHORT.has(trimmed.toLowerCase())) {
    profile.lastInboundAt = new Date().toISOString();
    profile.messageCount = (profile.messageCount || 0) + 1;
    pushHistory(session, 'user', text);
    const nudges = [
      'נראה שההודעה נשלחה חלקית 🙂 מה רצית לשאול?',
      'לא הגיע לי טקסט מלא — אפשר לכתוב שוב?',
    ];
    await reply(phone, session, nudges[(profile.messageCount || 0) % nudges.length]);
    save(phone, session);
    return;
  }

  // ── Nobody in the family was born in Romania ──────────────────────────────
  // Say so plainly, once, and then stop: no sales close, no handoff, and no
  // follow-up three days later asking which Romanian city they came from.
  const lastBot = [...(session.history || [])].reverse()
    .find(m => m.role === 'assistant')?.text || '';
  if (!profile.eligibility?.ancestor && !profile.notEligible
      && leadProfile.signalsNoRomanianRelative(text, lastBot)) {
    profile.lastInboundAt = new Date().toISOString();
    profile.messageCount = (profile.messageCount || 0) + 1;
    pushHistory(session, 'user', text);

    profile.notEligible = true;
    profile.followUpsSuppressed = true;
    profile.stage = stages.shouldAdvance(profile.stage, 'NOT_ELIGIBLE');
    storage.logEvent(phone, 'not_eligible', { text: String(text).slice(0, 120) });

    await reply(phone, session, profile.lang === 'en'
      ? `Understood — without a relative born in Romania there is no basis for ` +
        `Romanian citizenship, and I would rather tell you that than keep you ` +
        `here. \u{1F642}\n\n` +
        `If something turns up later — an old family story, a document, a name ` +
        `that was changed — write to me and we will take another look. All the best!`
      : `מובן — בלי בן משפחה שנולד ברומניה אין בסיס לאזרחות רומנית, ואני מעדיף ` +
        `לומר לך את זה מראש. 🙂\n\n` +
        `אם בעתיד יתברר משהו — סיפור משפחתי, מסמך ישן, שם שהשתנה — פשוט תכתוב לי ` +
        `ונבדוק שוב. בהצלחה בכל מקרה!`);
    save(phone, session);
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
  // Someone who clicked an ad about Romanian citizenship already knows why they
  // are here. The old opening gave them four lines of introduction and then a
  // four-option menu — a decision to make before they had learned anything. The
  // first real ad lead, 2 Sep, read it and went silent.
  //
  // So: one line of who we are, and one concrete question they can answer from
  // memory. The menu still exists behind the word "תפריט" for anyone who wants it.
  //
  // The opening is under test — see src/sales/experiment.js. The variant is a
  // pure function of the phone number and is recorded on the profile the first
  // time we greet, so a returning lead never flips and the rollup can group by
  // it. Only the first-contact opening varies; the returning greeting does not.
  // A lead whose file is already open — a name, a number, or a handover to the
  // office — is never greeted as a stranger, whatever brought them back.
  // Answer in the language they wrote in. The English arm of the ad sends
  // "Hello! Can I get more info on this?" — and got a wall of Hebrew back.
  if (!profile.lang) profile.lang = detectLang(opts.firstMessage) || 'he';

  const known = !!(profile.name || profile.clientPhone);
  const returning = known &&
    ((profile.messageCount || 0) > 1 || stages.TERMINAL.includes(profile.stage));
  if (!profile.openingVariant) profile.openingVariant = experiment.assign(phone);

  // Count the conversation HERE, not in the caller.
  //
  // conversation_started used to be logged only in the "unknown number, no
  // trigger" branch. Every lead who clicks the ad sends the trigger phrase and
  // takes the other branch, so no ad lead was ever counted: the weekly page
  // showed started=0 on all 14 days of September, conversionRate came back
  // null, and the per-ad funnel and the opening A/B — both of which divide by
  // this number — had nothing to divide. Logging it in handleStart catches
  // every route in, and the profile flag keeps a "תפריט" restart from counting
  // the same lead twice.
  if (!profile.countedStartAt) {
    profile.countedStartAt = new Date().toISOString();
    storage.logEvent(phone, 'conversation_started', {
      source: profile.source,
      variant: profile.openingVariant,
      firstMessage: opts.firstMessage || null,
    });
  }
  // A lead who opened with a real question gets a one-line hello and then the
  // answer — not our question first. Asking "מי במשפחה נולד ברומניה?" to
  // someone who just wrote "סבתא נולדה בבוקרשט" is the opposite of listening.
  const opensWithQuestion = !!(opts.firstMessage &&
    !isTriggerMessage(opts.firstMessage) && opts.firstMessage.length > 8);
  const welcome = returning
    ? (opensWithQuestion
        ? `היי${profile.name ? ` ${profile.name}` : ''}! 👋 טוב לשמוע ממך שוב.`
        : `היי${profile.name ? ` ${profile.name}` : ''}! 👋 טוב לשמוע ממך שוב.\n\nבמה אוכל לעזור הפעם?`)
    : (opensWithQuestion
        ? experiment.greetingOnly(profile.lang)
        : experiment.opening(profile.openingVariant, profile.lang));

  await reply(phone, session, welcome);
  save(phone, session);

  storage.logEvent(phone, 'stage_changed', { stage: profile.stage, from: 'NEW_LEAD' });

  handoff.notifyChatStart(phone, profile)
    .catch(e => console.warn('⚠️ chat-start notify failed:', e.message));

  // If they opened with a real question rather than the trigger, answer it too
  if (opensWithQuestion) {
    session.justGreeted = true;
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

  // The language the customer is being answered in.
  //
  // On 8 Oct one conversation flipped three times: it opened in English, the
  // lead replied in Hebrew and got English back, then Hebrew, then English
  // again — and the two follow-ups three days later were in Hebrew. The cause
  // was that `lang` was only ever set on the first message and the reply
  // language was decided from whatever the current message happened to be.
  //
  // So: the customer's own language wins and it is REMEMBERED. A lead who
  // switches to Hebrew is answered in Hebrew from then on, including by the
  // follow-up engine, which reads this field.
  const wrote = detectLang(text);
  if (!profile.lang) profile.lang = wrote || 'he';
  else if (wrote && wrote !== profile.lang) {
    console.log(`🗣️  [${phone}] language switched ${profile.lang} → ${wrote}`);
    profile.lang = wrote;
  }

  // Lock the grammatical gender the first time the customer reveals it.
  if (!profile.gender) {
    const g = detectGender(text);
    if (g) profile.gender = g;
  }

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
  let analysis = ruleBasedAnalysis(text, profile, session);

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
  // Only the CUSTOMER can agree to a time. Scanning the whole history meant
  // the bot's own words counted as an agreement — and now that the office slots
  // print a real clock time ("יום שני, 13.10 בשעה 17:00"), every lead who was
  // merely OFFERED a slot would have read as already booked.
  const historyText = (session.history || [])
    .filter(h => h.role === 'user')
    .map(h => h.text)
    .join(' ');
  const timeAgreed = closing.alreadyScheduled(historyText) || closing.alreadyScheduled(text);

  if (!hadContact && leadProfile.hasContactDetails(p)) {
    p.stage = stages.shouldAdvance(p.stage, 'CONVERSION');
    session.state = 'COMPLETE';

    // This is THE moment of the conversation: the name and the number just
    // landed. For two weeks every single lead who reached it — פרץ, עמית,
    // מחמד, מרדכי, יצחק פוקס, פאני, עופר, שופט מלי, eight out of eight —
    // was asked "morning (09:00-12:00) or afternoon (14:00-18:00)?" for a
    // PHONE CALL, in hours that are not the office's meeting hours, with no
    // mention of the office at all. The meeting flow was live in the code and
    // never once reached a customer from here.
    //
    // So the office meeting is now the default close whenever the route is
    // clear enough to be worth an evening. The phone call is the fallback, not
    // the goal.
    const pending = leadProfile.ensureMeeting(p);

    // They already picked a slot and this message completes the details:
    // confirm the request — do not offer new slots and do not ask "when".
    if (pending.status === 'requested' && pending.slotLabel) {
      await reply(phone, session,
        `🎉 *תודה, ${p.name || ''}!*\n\nהבקשה לפגישה ב*${pending.slotLabel}* אצלנו. ` +
        `עו״ד פודים יאשר אותה, ותקבל הודעה כאן בוואטסאפ.\n\n` +
        `אם משהו משתנה — *${closing.OFFICE_PHONE}*.`);
      await maybeSaveLead(phone, session);
      save(phone, session);
      return;
    }

    const canBook = !['requested', 'confirmed'].includes(pending.status)
                    && (pending.accepted || meeting.isReadyForMeeting(p));

    if (canBook) {
      const slots = meeting.nextSlots({
        count: 2, taken: meeting.takenSlots(storage.getAllConversations()),
      });
      if (slots.length) {
        pending.offered = slots;
        pending.offeredAt = new Date().toISOString();
        pending.status = 'slots_proposed';
        storage.logEvent(phone, 'meeting_offered', {
          at: 'lead_captured', mode: pending.mode, slots: slots.map(s => s.iso),
        });
        await reply(phone, session,
          `🎉 מצוין, ${p.name} — רשמתי.\n\n${meeting.slotPrompt(slots, pending.mode)}`);
        await maybeSaveLead(phone, session);
        save(phone, session);
        return;
      }
    }

    const isCourse = p.interest?.includes('b1_course');
    // If a time was already agreed earlier in the conversation, asking again is
    // what made a lead on 5 Sep repeat "בבוקר" three times — and what made
    // פרץ רוב, who had just written "אחהצ בסביבות 18", get the identical
    // question back one minute later on 4 Oct.
    const ask = timeAgreed
      ? `נתראה במועד שסיכמנו. אם משהו משתנה — *${closing.OFFICE_PHONE}*.`
      : closing.nextContactAsk(p);
    await reply(phone, session, isCourse
      ? `🎉 *תודה, ${p.name}!*\n\nקיבלנו את הפרטים לגבי *קורס הרומנית B1*.\n\n${ask}`
      : `🎉 *מצוין, ${p.name}!*\n\nהפרטים אצלנו ועו״ד פודים יחזור אליך אישית.\n\n${ask}\n\n` +
        `_השיחה ללא התחייבות — הערכת סיכוי, מה צריך לאתר, וטווחי זמן ועלות למקרה שלך._`
    );
    await maybeSaveLead(phone, session);
    save(phone, session);
    return;
  }

  // 3b½. The customer is picking one of the meeting slots we put on the table.
  //
  //      Deterministic on purpose: the time, the address and the navigation
  //      links have to be exactly right, and nothing about them is worth
  //      letting a model paraphrase. Anything that is NOT a slot choice falls
  //      through to the normal pipeline — including "I'm abroad", which the
  //      decision layer turns into a video meeting.
  const mtg = leadProfile.ensureMeeting(p);
  if (mtg.status === 'slots_proposed' && (mtg.offered || []).length) {
    const picked = meeting.parseExplicitSlotChoice(text, mtg.offered);
    if (picked) {
      mtg.status = 'requested';
      mtg.slotIso = picked.iso;
      mtg.slotLabel = picked.label;
      mtg.requestedAt = new Date().toISOString();
      p.stage = stages.shouldAdvance(p.stage, 'HIGH_INTENT');

      storage.logEvent(phone, 'meeting_requested', {
        slot: picked.iso, label: picked.label, mode: mtg.mode,
      });
      console.log(`📅 [${phone}] meeting requested — ${picked.label} (${mtg.mode})`);

      // A meeting with no number to confirm it on is not a meeting. Ask for
      // exactly what is missing, and put the conversation into the contact
      // states so the answer is captured deterministically — on 16 Oct a lead
      // who typed his name after "לאיזה מספר?" was asked for his name again.
      let body = meeting.pendingText(p, picked, mtg.mode);
      if (!p.name) {
        session.state = 'LEAD_NAME';
        body += `\n\nכדי שהמשרד יאשר לך את הפגישה — *מה השם המלא ומספר הטלפון שלך?*`;
      } else if (!p.clientPhone) {
        session.state = 'LEAD_PHONE';
        body += `\n\n${p.name}, *לאיזה מספר לשלוח את אישור הפגישה?*`;
      }
      await reply(phone, session, body);

      await maybeSaveLead(phone, session);
      handoff.notifyMeetingRequest(p, picked, mtg.mode)
        .catch(e => console.warn('⚠️ meeting notify:', e.message));
      save(phone, session);
      return;
    }
  }

  // 3c. Everything is done — details captured and a time agreed. From here the
  //     only correct reply is a short acknowledgement. On 5 Sep the bot instead
  //     re-sent the consultation blurb twice and then offered an email address,
  //     after the lead had already booked Sunday morning.
  if (leadProfile.hasContactDetails(p) && timeAgreed) {
    const acks = [
      'מצוין, רשמתי. 👍 נדבר אז.',
      'סגור. 👍 עו״ד פודים יחזור אליך במועד שסיכמנו.',
      `רשום. אם משהו משתנה — *${closing.OFFICE_PHONE}*.`,
    ];
    await reply(phone, session, acks[(p.messageCount || 0) % acks.length]);
    save(phone, session);
    return;
  }

  // 4. Decide what a good salesperson does next
  const closedRecently =
    session.lastCloseTurn !== undefined &&
    ((p.messageCount || 0) - session.lastCloseTurn) < 3;
  // How many times has this lead asked for a price? The second ask opens the
  // approved range (owner's decision, 16 Oct).
  if (nextAction.PRICE_ASK_RE.test(text) || objections.detect(text).some(o =>
        ['need_price_first', 'price_too_high', 'cheaper_competitor'].includes(o))) {
    p.priceAsks = (p.priceAsks || 0) + 1;
    if (p.priceAsks >= 2) p.priceRangeAllowed = true;
  }

  const decision = nextAction.decide({
    analysis, profile: p, text, recentClose: closedRecently,
  });
  p.nextAction = decision.action;
  console.log(`🎯 [${phone}] action=${decision.action} (${decision.reason})`);

  // 4b. Record where the meeting stands, and fill in the real slots.
  if (decision.offerMeeting) {
    mtg.status = 'offered';
    mtg.mode = decision.meetingMode || 'office';
    mtg.offeredAt = new Date().toISOString();
    storage.logEvent(phone, 'meeting_offered', { mode: mtg.mode });
  }
  if (decision.meetingAccepted) mtg.accepted = true;
  if (decision.meetingMode) mtg.mode = decision.meetingMode;
  if (decision.proposeSlots) {
    mtg.mode = decision.meetingMode || mtg.mode || 'office';
    const slots = meeting.nextSlots({
      count: 2,
      taken: meeting.takenSlots(storage.getAllConversations()),
    });
    mtg.offered = slots;
    mtg.status = slots.length ? 'slots_proposed' : 'offered';
    // The model never invents a time, an address or a map link: this turn is
    // scripted from the real availability.
    decision.fallbackText = `מעולה. 🙂\n\n${meeting.slotPrompt(slots, mtg.mode)}`;
    decision.forceFallback = true;
  }
  if (decision.meetingDeclined) {
    mtg.status = 'declined';
    mtg.declines = (mtg.declines || 0) + 1;
    storage.logEvent(phone, 'meeting_declined', { mode: mtg.mode });
  }

  // 5. Compose the reply — AI first, scripted fallback
  let replyText = null;
  if (aiWillCompose && !decision.forceFallback) {
    replyText = await brain.compose(analysis, p, session.history || [],
      (decision.directive || '') + (decision.directiveSuffix || ''));
  }
  const aiComposed = !!replyText;
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

  if (!aiComposed) replyText = avoidTemplateRepeat(session, replyText);

  // A meeting offered in the model's own words still gets real slots: the
  // model is told never to name a day or an hour, so the times come from here.
  if (decision.offerMeeting && aiComposed && !replyText.includes(closing.SLOTS_TOKEN)
      && !['requested', 'confirmed'].includes(mtg.status)) {
    replyText = `${closing.stripTrailingAsk(replyText)}\n\n${closing.SLOTS_TOKEN}`;
  }
  replyText = avoidRepetition(session, replyText);

  // We already said hello in a separate message (handleStart). The model,
  // seeing a first message, tends to greet again — "היי! כאן המשרד…" and then
  // "היי רותם! 👋". One hello is enough.
  if (session.justGreeted) {
    replyText = stripLeadingGreeting(replyText);
    session.justGreeted = false;
  }

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

  // A lead with no Romanian-born relative gets no close of any kind. On 4 Oct
  // one was told "אני מכבד את זה, בהצלחה בכל מה שתעשו" and then, in the same
  // message, "מעביר את הפרטים לעו״ד פודים שיחזור אליך אישית — היום אחר הצהריים
  // או מחר בבוקר?". He had left neither a name nor a number, and his file still
  // says HUMAN_HANDOFF.
  // The model already said goodbye and asked them to come back ("תחזרי אליי
  // עם השנה", "בהצלחה עם הבדיקה") — a meeting pitch bolted underneath reads as
  // not having listened. דנה and מיכל, 16 Oct.
  const alreadySignedOff = aiComposed &&
    /(?:תחזור|תחזרי|תכתוב לי|תכתבי לי|כשתברר|כשתבררי|כשתדע|כשתדעי|בהצלחה|נמשיך משם|תעדכן|תעדכני)/.test(replyText);
  if (terminalTurn && !alreadySignedOff && !p.notEligible && p.stage !== 'NOT_ELIGIBLE') {
    const before = replyText;
    replyText = closing.ensureCallClose(replyText, p, {
      variant: decision.escalate
                 // The customer already named a time — confirm it, never ask again.
                 ? (timeAgreed ? 'handoff_confirmed' : 'handoff')
             // A second close hard on the heels of the first gets the short form.
             : departing ? (sinceClose <= 2 ? 'departing_brief' : 'departing')
             : undefined,
      seed: turn,
    });
    if (replyText !== before) session.lastCloseTurn = turn;
  }
  if (closing.hasCallClose(replyText)) session.lastCloseTurn = turn;

  if (/8,000\s*(?:₪)?\s*(?:ל-?|עד|[-–])\s*14,000/.test(replyText)) p.priceRangeGiven = true;
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
    // A lead who told us the call never happened must never be chased by the
    // scheduler afterwards.
    if (decision.suppressFollowUp) p.followUpsSuppressed = true;
    storage.logEvent(phone, 'human_handoff', {
      reason: decision.reason, urgent: !!decision.urgent,
    });
    handoff.notifyHandoff(p, decision.reason, { urgent: !!decision.urgent })
      .catch(e => console.warn('⚠️ handoff notify:', e.message));
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
      // "רון כהן 0521234567" — name and number in one message.
      const inlinePhone = text.match(PHONE_RE)?.[0] || null;
      const nameText = inlinePhone ? text.replace(inlinePhone, '').replace(/[,\-–]+/g, ' ').trim() : text.trim();
      if (analysis?.profileUpdates?.name) p.name = analysis.profileUpdates.name;
      else if (nameText.length >= 2) p.name = nameText;
      else if (!inlinePhone) {
        await reply(phone, session, 'אנא הזן שם מלא כדי שנוכל להמשיך. 😊');
        return true;
      }
      session.state = 'LEAD_PHONE';
      if (inlinePhone) return handleScriptedState(phone, session, inlinePhone, analysis);
      const forMeeting = (p.meeting || {}).status === 'requested';
      await reply(phone, session, forMeeting
        ? `תודה *${p.name}*! 🙏\n\nומה *מספר הטלפון* לאישור הפגישה?`
        : `תודה *${p.name}*! 🙏\n\nומה *מספר הטלפון* שלך לחזרה?`);
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

      // A meeting slot was already requested: confirm it, do not ask "when"
      // again and do not re-send the consultation blurb.
      const req = p.meeting || {};
      if (req.status === 'requested' && req.slotLabel) {
        await reply(phone, session,
          `🎉 *תודה, ${p.name}!*\n\nהבקשה לפגישה ב*${req.slotLabel}* אצלנו. ` +
          `עו״ד פודים יאשר אותה, ותקבל הודעה כאן בוואטסאפ.\n\n` +
          `אם משהו משתנה — *${closing.OFFICE_PHONE}*.`);
        await maybeSaveLead(phone, session);
        return true;
      }

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
    `כדי לאמת את זה מול הרשויות ברומניה, *עו״ד פודים צריך לעבור על המקרה*.\n\n` +
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

const ANCESTOR_RE = /(סבתא רבתא|סבא רבא|שני ההורים|אבא ואמא|אמא ואבא|ההורים|הוריי|הורים|הורי|סבתא|סבתי|סבא|סבי|אמא|אימא|אבא|אבי|אמי|הורה|דודה|דוד)(\s*(?:שלי|מצד\s*(?:אמא|אבא|אמי|אבי|האם|האב)))?/;

/**
 * The lead IS the Romanian-born relative.
 *
 * "אני ילידת רומניה", "אני נולדתי ברומניה ועליתי ב-1948" — four leads in the
 * first half of October opened exactly like that: פאני זילברמן, מרדכי כהן,
 * שופט מלי and the lead of 3 Oct. ANCESTOR_RE never matched any of them (and
 * "אני" is on the not-a-name list), so `ancestor` stayed empty, and with it
 * shut every gate that depends on knowing who was born in Romania — including
 * the office meeting. They are the shortest route the firm has.
 */
const SELF_BORN_RE = /יליד(?:ת|ה)?\s+רומניה|נולדתי\s+(?:ב)?רומניה|אני\s+נולדתי\s+שם/;
const NAME_RE = /(?:קוראים לי|שמי|השם שלי|אני נקרא(?:ת)?)\s+([֐-׿]+(?:\s+[֐-׿]+)?)/;

/**
 * A bare name, given as the answer to the question we just asked.
 *
 * NAME_RE only ever caught "קוראים לי X". A lead who is asked "מה שמך המלא?"
 * and types "שמשון לזר" was not recognised at all — so the bot asked for the
 * name again on the next turn, and never got as far as asking for a number.
 * Two leads on 8 Sep ended exactly there.
 */
const NAME_ASK_RE = /(מה שמך|שמך המלא|השם המלא|איך קוראים לך|מה השם שלך|איך לפנות אליך)/;
const BARE_NAME_RE = /^[֐-׿A-Za-z]{2,}(?:[\s'׳"״-]+[֐-׿A-Za-z]{2,}){0,2}$/;
/** Short replies that are answers to something else, never a name. */
const NOT_A_NAME = new Set([
  'כן', 'לא', 'תודה', 'אוקיי', 'אוקי', 'בסדר', 'סבבה', 'מעולה', 'היי', 'שלום',
  'אהלן', 'בוקר טוב', 'ערב טוב', 'למה', 'מה', 'איך', 'כמה', 'מתי', 'רגע',
  'סבתא', 'סבא', 'אמא', 'אבא', 'הורה', 'אני', 'רומניה', 'דרכון', 'אזרחות',
  'לא יודע', 'לא יודעת', 'לא בטוח', 'אולי', 'בטח', 'נשמע טוב',
  // Days and times get typed in answer to a slot question, never as a name.
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'מחר', 'היום',
  'בוקר', 'צהריים', 'ערב', 'אחהצ', 'הראשון', 'השני',
]);

function looksLikeBareName(text) {
  const t = String(text).trim();
  if (!t || t.length > 30 || /\d|[?@]/.test(t)) return false;
  if (/^יום\s/.test(t)) return false;              // "יום ראשון" is a slot, not a name
  if (NOT_A_NAME.has(t.replace(/[.!]/g, ''))) return false;
  return BARE_NAME_RE.test(t);
}
const PHONE_RE = /(?:\+?972|0)5\d[\s-]?\d{3}[\s-]?\d{4}/;
const YEAR_RE = /\b(1[89]\d{2}|20[0-2]\d)\b/g;

/**
 * Rule-based understanding — the fallback the customer actually gets whenever
 * the AI is off, erroring, or unconfident. Deliberately more capable than a
 * keyword list: Hebrew-prefix aware, and it extracts real facts.
 */
function ruleBasedAnalysis(text, profile, session = null) {
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

  // Did we just ask for a name, and is this a plausible answer to that?
  let bareName = null;
  if (!profile.name && !nameMatch && intent === 'unclear' && !detected.length) {
    const lastBot = [...(session?.history || [])].reverse()
      .find(m => m.role === 'assistant');
    if (lastBot && NAME_ASK_RE.test(lastBot.text || '') && looksLikeBareName(text)) {
      bareName = String(text).trim();
    }
  }
  const phoneMatch = text.match(PHONE_RE)?.[0] || null;

  // Deciding whether a year is a BIRTH year or an EMIGRATION year matters a
  // great deal — the emigration year is what classifies the legal route.
  // "עליתי לישראל ב-1960" did not match: /על[התו]/ wants ה/ת/ו after "על",
  // and "עליתי" has a yod. So the year of the single most important fact in the
  // file — when they left — was filed as a BIRTH year instead. שופט מלי wrote
  // "עליתי לישראל ב1960 בהיותי בת 3" and her emigration year was never set.
  const EMIGRATION_VERB = /עלי(?:תי|נו|ת)|על[התו]|עלייה|עזב|הגע(?:תי|נו)|הגיע|הגיעה|יצא|יצאה|ברח|ברחה|בא(?:תי|נו)? לארץ|באה לארץ|הגירה|היגר/;
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

  const selfBorn = SELF_BORN_RE.test(text);

  const eligibility = {
    // A message we are reading as the answer to "מה שמך?" is a name, not a
    // relative. "אבי רבינוביץ" otherwise files אבי — his own first name — as
    // the Romanian-born relative.
    ancestor: e.ancestor || bareName ? null
            : selfBorn ? 'הלקוח/ה עצמו/ה (נולד/ה ברומניה)'
            : ancestorMatch ? ancestorMatch[0].trim()
            : null,
    birthYear,
    leftYear,
    birthPlace: !e.birthPlace && place ? place.place : null,
    territory: !e.territory && place ? place.territory : null,
    likelyArticle: !e.likelyArticle && place ? place.article : null,
  };

  const extractedAnything =
    Object.values(eligibility).some(Boolean) || nameMatch || bareName || phoneMatch;

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
      name: !profile.name ? (nameMatch ? nameMatch[1].trim() : bareName) : null,
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
/**
 * A scripted template is never sent twice in one conversation.
 *
 * The 14 Oct trainer run: "הוגן לחלוטין — ואני לא רוצה לזרוק לך מספר באוויר…"
 * four times across the run and twice to the same lead (מיכל), and
 * "שווה להסתכל על זה ככה…" given to יוסי as the answer to "מי עובד במשרד?".
 * avoidRepetition only compares with the LAST bot message, so a template that
 * comes back three turns later slips through. A person who has already heard a
 * paragraph and rejected it gets one short honest line instead.
 */
const SECOND_TIME = [
  p => `לא אחזור על מה שכבר כתבתי. 🙂 בקצרה: את המספר נותן רק עו״ד פודים, אחרי שהוא רואה מה יש בתיק.\n\n` +
       `אם לא נוח לך לדבר — *שלח כאן צילום של המסמכים שיש לך*, והוא יעבור עליהם ויגיד לך כאן מה יש ומה חסר.`,
  p => `אני מבין שזו לא התשובה שרצית, ואני לא רוצה להתיש אותך באותו הסבר. 🙏\n\n` +
       `שתי דרכים בלי שיחה: לשלוח כאן צילומי מסמכים לעו״ד פודים, או להתקשר כשנוח לך — *${closing.OFFICE_PHONE}* · ${closing.HOURS}.`,
  p => closing.callClose(p, { variant: 'departing_brief' }),
];

function avoidTemplateRepeat(session, text) {
  if (!text) return text;
  const earlier = (session.history || []).filter(m => m.role === 'assistant');
  const heardBefore = earlier.some(m =>
    normalise(m.text) === normalise(text) || similarity(m.text, text) >= 0.75);
  if (!heardBefore) return text;
  session.templateRepeats = (session.templateRepeats || 0) + 1;
  const pick = SECOND_TIME[(session.templateRepeats - 1) % SECOND_TIME.length];
  console.log(`♻️  Template already sent in this conversation — sending a short alternative`);
  return pick(session.profile || {});
}

/** Drop an opening "היי…!" line when the conversation was greeted already. */
function stripLeadingGreeting(text) {
  if (!text) return text;
  const stripped = String(text)
    .replace(/^\s*(?:היי|הי|שלום|hi|hello)(?=[\s,!.])[^\n]{0,40}\n+/i, '')
    .trim();
  return stripped.length >= 20 ? stripped : text;
}

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
      let body = text.split(/\n+/)
        .filter(l => !l.includes(ask) && similarity(l, ask) < 0.75)
        .join('\n').trim();
      // What is left may be only the tail of the ask — "ואם נוח לך יותר
      // להתקשר בעצמך: 03-…". On 14 Oct דנה got exactly that line, alone, as a
      // whole message. A sentence that starts with "ואם"/"או" continues
      // something; without its first half it is not a reply.
      if (body && body.split(/\n+/).every(l => /^\s*(?:ואם|או\s|אם\s+נוח)/.test(l))) body = '';
      session.repeatedAsk = (session.repeatedAsk || 0) + 1;

      // If the ask WAS the whole reply, removing it leaves nothing — and
      // returning the original would repeat the question we just caught.
      // Change the approach instead of pressing the same button again.
      if (!body) {
        const alt = REPEAT_ALTERNATIVES[(session.repeatedAsk - 1) % REPEAT_ALTERNATIVES.length];
        if (session.repeatedAsk >= 3) {
          session.repeatedAsk = 0;
          return closing.nextContactAsk(session.profile, { seed: session.repeatedAsk + 2 });
        }
        return alt;
      }

      if (session.repeatedAsk >= 2) {
        session.repeatedAsk = 0;
        return `${body}\n\n${closing.nextContactAsk(session.profile, { seed: 1 })}`.trim();
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
    // callClose('handoff') already says who will call back — and, without a
    // phone on file, asks for one instead of claiming to pass on details.
    return `נראה שאני לא מצליח להתקדם כאן, ואני מעדיף לא להתיש אותך. 🙏\n\n` +
           closing.callClose(session.profile, { variant: 'handoff' });
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
  'רוצה שעו״ד פודים עצמו יעבור על המקרה שלך? *מה שמך המלא?*',
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
  //
  // A line ending in ":" does NOT close a thought — it promises a list. On
  // 1 Sep the trainer's "אבי" asked a simple eligibility question and got the
  // groups passage cut right after "מכאן שלושה מסלולים:", with the three
  // routes themselves missing. A heading with nothing under it is worse than
  // no heading, so it goes too.
  while (out.length > 1) {
    const last = out[out.length - 1].trim();
    if (last && !/:$/.test(last) &&
        (/[.!?•]$/.test(last) || /[.!?]["'״׳]?$/.test(last))) break;
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
  // A short answer to the question we just asked — "סבתא", "ביאשי", "1930" —
  // is a fact, not a question. Searching the corpus for it answered the word
  // "סבתא" with a document checklist, the same mistake as the B1 lecture.
  // While facts are still missing, the next move is the next question.
  // Recognise a fact by what it CONTAINS, not by what it lacks. A blacklist of
  // question words fails in Hebrew — \b is ASCII-only and never matches before
  // a Hebrew letter — and it also mislabels "אהה אני לא בטוח מה" as an answer.
  // So: it must actually look like one. A relative, a year, or a place.
  const t = String(text).trim();
  const LOOKS_LIKE_ANSWER =
    /סב(א|תא)|אבא|אמא|הורה|דוד|דודה|אב שלי|אם שלי/.test(t) ||
    /\b(1[89]\d{2}|20[0-2]\d)\b/.test(t) ||
    /בוקרשט|יאשי|יאסי|קישינב|צ׳רנוביץ|צרנוביץ|בסרביה|בוקובינה|טרנסילבניה|גלאץ|קונסטנצה/.test(t);

  const bareFact =
    t.length < 25 &&
    !t.includes('?') &&
    LOOKS_LIKE_ANSWER &&
    leadProfile.missingFacts(profile).length > 0;

  if (bareFact) {
    const next = leadProfile.missingFacts(profile)[0];
    const who = nextAction.normaliseAncestor
      ? nextAction.normaliseAncestor(profile.eligibility?.ancestor)
      : (profile.eligibility?.ancestor || 'אותו בן משפחה');
    const asks = {
      ancestor:   'כדי לבדוק את הזכאות — *מי במשפחה נולד ברומניה?* (הורה / סב / סבתא)',
      birthPlace: `ואיפה בערך ${who} נולד/ה? *עיר או אזור ברומניה* — זה קובע את המסלול.`,
      leftYear:   `ועכשיו השאלה הכי חשובה — *באיזו שנה בערך ${who} עלה/תה לישראל?*\n\n` +
                  `_שנת העלייה קובעת את המסלול, ולכן גם אם צריך מבחן שפה._`,
      birthYear:  `ומה *שנת הלידה המשוערת* של ${who}?`,
    };
    if (asks[next]) return asks[next];
  }

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
      return `${route}כדי שעו״ד פודים יעבור על המקרה שלך ויחזור אליך — *מה שמך המלא?*`;
    }
    return `${route}מעולה, *${profile.name}*. ומה *מספר הטלפון* שלך לחזרה?`;
  }
  return `לא בטוח שהבנתי במדויק — אפשר לנסח קצת אחרת? 🙏\n\n` +
         `או שאעביר אותך לעו״ד פודים שיענה לך ישירות. פשוט כתוב *נציג*.`;
}

module.exports = {
  handleMessage,
  handleAgentMessage,
  handleStart,
  showInterestButtons,
  isTriggerMessage,
  normalise,
  detectLang,
  detectGender,
  ruleBasedAnalysis,
  maybeSaveLead,
  trimToWhatsApp,
  stripLeadingGreeting,
  avoidTemplateRepeat,
  avoidRepetition,
  prepareMeetingOffer,
};
