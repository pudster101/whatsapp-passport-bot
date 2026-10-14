/**
 * scheduler.js — intelligent follow-up.
 *
 * The old bot stopped the moment a customer went quiet. In a purchase that
 * takes 2-3 years to deliver, the follow-up sequence IS the sales process.
 *
 * Rules, non-negotiable:
 *   • every follow-up must carry real value — never "just checking in"
 *   • business hours only (Sun–Thu, 09:00–18:00 Israel)
 *   • max 3 per lead, ever
 *   • opt-out is instant and permanent
 *   • never follow up someone already handled by a human
 */
const config = require('../config');
const storage = require('../storage');
const wa = require('../whatsapp');
const stages = require('../sales/stages');
const kb = require('../kb/knowledge');

// ─── Sequences ────────────────────────────────────────────────────────────────
// Each entry: how long to wait since last inbound, and what to say.

const SEQUENCES = {
  // ─── The welcome landed and nothing came back ────────────────────────────
  //
  // 9 of 32 conversations in the first half of October ended here: the ad was
  // clicked, the opening question was sent, and the lead never wrote again.
  // 28% of the ad spend stops at the first message. The earliest follow-up
  // before this one was at 24 hours, by which time the moment has gone — the
  // person was on their phone, in the ad, a minute ago.
  //
  // One message, about an hour later, inside business hours. No pitch, no
  // second question, and never more than one.
  FIRST_TOUCH: [
    {
      afterHours: 1,
      message: () =>
        `רק מוודא שההודעה שלי הגיעה 🙂\n\n` +
        `אם זה יותר נוח — אפשר לענות במשפט אחד: *מי במשפחה נולד ברומניה?*\n` +
        `ואם זה לא הזמן, אין בעיה — אני כאן כשתרצה.`,
      messageEn: () =>
        `Just making sure my message reached you \u{1F642}\n\n` +
        `If it is easier, one sentence is enough: *who in your family was born ` +
        `in Romania?*\nAnd if now is not the time, no problem — I am here when it is.`,
    },
  ],

  // Dropped during qualification — the biggest recoverable segment
  QUALIFICATION: [
    {
      afterHours: 24,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''} 👋\n\n` +
        `רק בשביל הסדר — עצרנו באמצע בדיקת הזכאות שלך.\n\n` +
        `אם נוח לך, מספיק שתגיד לי *באיזו עיר או אזור ברומניה* נולד בן המשפחה, ואוכל להגיד לך הרבה יותר מדויק אם יש כאן תיק.`,
      messageEn: p =>
        `Hi${p.name ? ` ${p.name}` : ''} \u{1F44B}\n\n` +
        `We stopped halfway through checking your eligibility.\n\n` +
        `If you tell me *which town or region in Romania* your relative was born ` +
        `in, I can tell you much more precisely whether there is a case here.`,
    },
    {
      afterHours: 96,
      message: () =>
        `משהו ששווה לדעת גם אם לא ממשיכים איתנו: 📌\n\n` +
        `מאז מרץ 2025 נדרשת *תעודת שפה רומנית ברמת B1* לרוב מבקשי האזרחות.\n` +
        `המועד להגשתה הוארך עד *${kb.B1.deadline.date}*.\n\n` +
        `מי שמתכנן להתחיל — כדאי שיביא את זה בחשבון בלוח הזמנים.`,
      messageEn: () =>
        `Worth knowing even if you do not continue with us: \u{1F4CC}\n\n` +
        `Since March 2025 most citizenship applicants need a *Romanian B1 language ` +
        `certificate*. The deadline for submitting it has been extended to ` +
        `*${kb.B1.deadline.dateEn}*.\n\n` +
        `If you are planning to start, it is worth factoring into the timeline.`,
    },
    {
      afterHours: 336, // 14 days
      message: () =>
        `לא רוצה להטריד — זו ההודעה האחרונה שלי בנושא. 🙏\n\n` +
        `אם בעתיד תרצה לבדוק זכאות, אנחנו כאן:\n` +
        `📞 ${kb.FIRM.mainPhone}\n${kb.FIRM.website}\n\n` +
        `בהצלחה בכל מקרה!`,
      messageEn: () =>
        `I will not keep bothering you — this is my last message on it. \u{1F64F}\n\n` +
        `If you ever want to check your eligibility, we are here:\n` +
        `\u{1F4DE} ${kb.FIRM.mainPhone}\n${kb.FIRM.website}\n\n` +
        `All the best either way!`,
    },
  ],

  // Got information but never left details
  DISCOVERY: [
    {
      afterHours: 48,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''}, נזכרתי בשאלה ששאלת. 💭\n\n` +
        `אם תרצה, עו״ד פודים יכול לעבור על המקרה שלך בשיחה קצרה *ללא התחייבות* — ותדע בדיוק איפה אתה עומד לפני שאתה מחליט משהו.\n\n` +
        `רוצה שאסדר?`,
      messageEn: p =>
        `Hi${p.name ? ` ${p.name}` : ''} — I was thinking about your question. \u{1F4AD}\n\n` +
        `If you like, a lawyer from the office can go over your case in a short ` +
        `call *with no obligation*, so you know exactly where you stand before ` +
        `you decide anything.\n\n` +
        `Want me to arrange it?`,
    },
    {
      afterHours: 168,
      message: () =>
        `נקודה שהרבה אנשים לא מכירים, ואולי רלוונטית לך: 📂\n\n` +
        `*היעדר מסמכים הוא לא סוף הדרך.* ברוב התיקים אפשר לאתר רשומות בארכיונים ברומניה, מולדובה ואוקראינה — גם בלי מסמך אחד מהבית.\n\n` +
        `אם זו הייתה הסיבה שעצרת, שווה לבדוק.`,
      messageEn: () =>
        `Something many people do not know, and it may be relevant to you: \u{1F4C2}\n\n` +
        `*Having no documents is not the end of the road.* In most files the ` +
        `records can be traced in archives in Romania, Moldova and Ukraine — ` +
        `even without a single paper from home.\n\n` +
        `If that is why you stopped, it is worth a look.`,
    },
  ],

  // Raised an objection and went quiet
  OBJECTION: [
    {
      afterHours: 72,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''} 👋\n\n` +
        `חשבתי על מה שאמרת. אם זה עוזר — שיחת הייעוץ עצמה היא *ללא התחייבות*, ובסופה יש לך תמונה מלאה: מה הסיכוי, מה נדרש, וכמה זה עולה.\n\n` +
        `גם אם תחליט שלא — תצא עם מידע שיעזור לך בכל מקרה.`,
      messageEn: p =>
        `Hi${p.name ? ` ${p.name}` : ''} \u{1F44B}\n\n` +
        `I thought about what you said. If it helps — the consultation itself is ` +
        `*with no obligation*, and by the end of it you have the full picture: ` +
        `your chances, what is required, and what it costs.\n\n` +
        `Even if you decide against it, you leave with information that helps.`,
    },
    {
      afterHours: 240,
      message: () =>
        `עדכון שרלוונטי לכל מי ששוקל: ⏰\n\n` +
        `דרישת ה-B1 בתוקף, והמועד להגשת התעודה הוא *${kb.B1.deadline.date}*.\n` +
        `הכנת תיק ואיתור מסמכים לוקחים 2-6 חודשים לפני זה בכלל.\n\n` +
        `לא לחץ — רק שתדע איפה עומד לוח הזמנים.`,
      messageEn: () =>
        `An update relevant to anyone still considering it: \u{23F0}\n\n` +
        `The B1 requirement stands, and the deadline for submitting the ` +
        `certificate is *${kb.B1.deadline.dateEn}*.\n` +
        `Preparing a file and tracing documents takes 2-6 months before that.\n\n` +
        `No pressure — just so you know where the timeline stands.`,
    },
  ],

  // Said "not now"
  LOST_NOT_NOW: [
    {
      afterHours: 720, // 30 days
      message: () =>
        `היי, מקווה שהכל טוב. 😊\n\n` +
        `רק עדכון קצר למי שהתעניין בעבר: הזכאות לאזרחות רומנית *נשמרת* ולא נעלמת — מה שמשתנה זה דרישות החוק.\n\n` +
        `אם תרצה לבדוק מתישהו, אנחנו כאן.`,
      messageEn: () =>
        `Hi, I hope all is well. \u{1F60A}\n\n` +
        `A short update for anyone who enquired in the past: eligibility for ` +
        `Romanian citizenship *is preserved* and does not disappear — what ` +
        `changes is what the law requires.\n\n` +
        `If you ever want to check, we are here.`,
    },
  ],

  // High intent but never completed
  HIGH_INTENT: [
    {
      afterHours: 12,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''} 👋\n\n` +
        `נראה שנקטעה לנו השיחה. רק צריך את ${p.name ? '*מספר הטלפון*' : '*השם והטלפון*'} שלך ועו״ד פודים יחזור אליך.`,
      messageEn: p =>
        `Hi${p.name ? ` ${p.name}` : ''} \u{1F44B}\n\n` +
        `It looks like our conversation got cut off. All I need is your ` +
        `${p.name ? '*phone number*' : '*name and phone number*'} and a lawyer ` +
        `from the office will get back to you.`,
    },
    {
      afterHours: 72,
      message: () =>
        `אם עדיין רלוונטי — אפשר גם פשוט להתקשר ישירות למשרד:\n\n` +
        `📞 ${kb.FIRM.offices[0].phone} (תל אביב)\n` +
        `📞 ${kb.FIRM.offices[1].phone} (ירושלים)\n\n` +
        `${kb.FIRM.hours}`,
      messageEn: () =>
        `If it is still relevant, you are welcome to call the office directly:\n\n` +
        `\u{1F4DE} ${kb.FIRM.offices[0].phone} (Tel Aviv)\n` +
        `\u{1F4DE} ${kb.FIRM.offices[1].phone} (Jerusalem)\n\n` +
        `Sun-Thu 09:00-18:00`,
    },
  ],
};

// ─── Eligibility checks ───────────────────────────────────────────────────────

function isBusinessHours(date = new Date()) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: config.TIMEZONE }));
  const day = local.getDay();
  const hour = local.getHours();
  return config.BUSINESS_HOURS.days.includes(day) &&
         hour >= config.BUSINESS_HOURS.start &&
         hour < config.BUSINESS_HOURS.end;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

/** Should this lead get a follow-up right now, and which one? */
function evaluate(profile) {
  if (!config.FOLLOWUP_ENABLED) return null;
  if (profile.optedOut) return null;
  if (profile.humanStatus === 'handled') return null;
  if (profile.followUpsSuppressed) return null;
  if (profile.notEligible || profile.stage === 'NOT_ELIGIBLE') return null;
  if (stages.TERMINAL.includes(profile.stage) && profile.stage !== 'LOST_NOT_NOW') return null;

  // We already have a way to reach this person. Every sequence below exists to
  // collect details or restart a stalled qualification, and both read as
  // nonsense to someone whose number is already in the file with a call booked.
  // On 15 Sep one of them asked a lead for "השם והטלפון שלך" the morning after
  // he gave both and agreed on 16:30; he replied "יש לכם בעיה באלגוריתם?".
  if (profile.clientPhone) return null;
  if ((profile.followUpsSent || 0) >= config.FOLLOWUP_MAX) return null;

  // The opening question went out and nothing came back. This is the one case
  // where six hours is far too long to wait — they clicked the ad a minute ago.
  // Sent once, only on the same working day, and only if they have never
  // written anything beyond whatever brought them in.
  const unanswered = (profile.messageCount || 0) <= 1
                     && !(profile.followUpsSent || 0)
                     && ['NEW_LEAD', 'INITIAL_ENGAGEMENT'].includes(profile.stage);
  if (unanswered) {
    const idleNow = hoursSince(profile.lastInboundAt);
    if (idleNow < SEQUENCES.FIRST_TOUCH[0].afterHours || idleNow > 20) return null;
    return {
      stage: 'FIRST_TOUCH',
      index: 0,
      step: SEQUENCES.FIRST_TOUCH[0],
      idleHours: Math.round(idleNow),
    };
  }

  // Never follow up someone we spoke to in the last 6 hours
  if (hoursSince(profile.lastInboundAt) < 6) return null;
  // Never send two follow-ups within 12 hours of each other
  if (profile.lastFollowUpAt && hoursSince(profile.lastFollowUpAt) < 12) return null;

  const sequence = SEQUENCES[profile.stage];
  if (!sequence) return null;

  const index = profile.followUpsSent || 0;
  const step = sequence[index];
  if (!step) return null;

  const idle = hoursSince(profile.lastInboundAt);
  if (idle < step.afterHours) return null;

  return { step, index, idleHours: Math.round(idle) };
}

/** Run one sweep across all active conversations. */
async function runSweep() {
  if (!config.FOLLOWUP_ENABLED) return { checked: 0, sent: 0 };
  if (!isBusinessHours()) {
    console.log('⏰ Follow-up sweep skipped — outside business hours');
    return { checked: 0, sent: 0, skipped: 'business_hours' };
  }

  const conversations = storage.getAllConversations();
  const phones = Object.keys(conversations);
  let sent = 0;

  for (const phone of phones) {
    // Never chase one of our own numbers. The owner's keep-alive conversation
    // sat in QUALIFICATION for weeks and was a follow-up candidate every sweep.
    if (config.isAgentPhone(phone)) continue;

    const session = conversations[phone];
    const profile = session?.profile;
    if (!profile) continue;

    // Told on 8 Oct that nobody in his family was Romanian, and chased twice
    // afterwards — once to ask which Romanian city his relative was born in.
    if (profile.notEligible || profile.stage === 'NOT_ELIGIBLE') continue;

    const due = evaluate(profile);
    if (!due) continue;

    try {
      // Answer them in their own language. The English arm of the ad sends
      // "Hello! Can I get more info on this?" — and on 11 and 12 Oct one of
      // those leads got two follow-ups in Hebrew.
      const pick = profile.lang === 'en' && due.step.messageEn
        ? due.step.messageEn
        : due.step.message;
      const text = typeof pick === 'function' ? pick(profile) : pick;

      // No English copy for this step — better silence than a wall of Hebrew.
      if (profile.lang === 'en' && !due.step.messageEn) {
        console.log(`🤐 Follow-up skipped for ${phone} — no English copy for this step`);
        continue;
      }

      const ok = await wa.sendText(phone, text);
      if (!ok) {
        console.warn(`⚠️  Follow-up to ${phone} not delivered (likely 24h window)`);
        continue;
      }

      profile.followUpsSent = (profile.followUpsSent || 0) + 1;
      profile.lastFollowUpAt = new Date().toISOString();
      profile.lastOutboundAt = profile.lastFollowUpAt;
      session.history = session.history || [];
      session.history.push({ role: 'assistant', text, at: profile.lastFollowUpAt });

      storage.setConversation(phone, session);
      storage.logEvent(phone, 'followup_sent', {
        stage: profile.stage,
        index: due.index,
        idleHours: due.idleHours,
      });

      sent++;
      console.log(`📤 Follow-up #${profile.followUpsSent} → ${phone} (stage ${profile.stage}, idle ${due.idleHours}h)`);

      await new Promise(r => setTimeout(r, 1500)); // gentle pacing
    } catch (err) {
      console.error(`❌ Follow-up to ${phone} failed:`, err.message);
    }
  }

  console.log(`✅ Follow-up sweep: ${phones.length} checked, ${sent} sent`);
  return { checked: phones.length, sent };
}

module.exports = { runSweep, evaluate, isBusinessHours, SEQUENCES };
