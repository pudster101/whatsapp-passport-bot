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
  // Dropped during qualification — the biggest recoverable segment
  QUALIFICATION: [
    {
      afterHours: 24,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''} 👋\n\n` +
        `רק בשביל הסדר — עצרנו באמצע בדיקת הזכאות שלך.\n\n` +
        `אם נוח לך, מספיק שתגיד לי *באיזו עיר או אזור ברומניה* נולד בן המשפחה, ואוכל להגיד לך הרבה יותר מדויק אם יש כאן תיק.`,
    },
    {
      afterHours: 96,
      message: () =>
        `משהו ששווה לדעת גם אם לא ממשיכים איתנו: 📌\n\n` +
        `מאז מרץ 2025 נדרשת *תעודת שפה רומנית ברמת B1* לרוב מבקשי האזרחות.\n` +
        `המועד להגשתה הוארך עד *${kb.B1.deadline.date}*.\n\n` +
        `מי שמתכנן להתחיל — כדאי שיביא את זה בחשבון בלוח הזמנים.`,
    },
    {
      afterHours: 336, // 14 days
      message: () =>
        `לא רוצה להטריד — זו ההודעה האחרונה שלי בנושא. 🙏\n\n` +
        `אם בעתיד תרצה לבדוק זכאות, אנחנו כאן:\n` +
        `📞 ${kb.FIRM.mainPhone}\n${kb.FIRM.website}\n\n` +
        `בהצלחה בכל מקרה!`,
    },
  ],

  // Got information but never left details
  DISCOVERY: [
    {
      afterHours: 48,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''}, נזכרתי בשאלה ששאלת. 💭\n\n` +
        `אם תרצה, עו״ד מהמשרד יכול לעבור על המקרה שלך בשיחה קצרה *ללא התחייבות* — ותדע בדיוק איפה אתה עומד לפני שאתה מחליט משהו.\n\n` +
        `רוצה שאסדר?`,
    },
    {
      afterHours: 168,
      message: () =>
        `נקודה שהרבה אנשים לא מכירים, ואולי רלוונטית לך: 📂\n\n` +
        `*היעדר מסמכים הוא לא סוף הדרך.* ברוב התיקים אפשר לאתר רשומות בארכיונים ברומניה, מולדובה ואוקראינה — גם בלי מסמך אחד מהבית.\n\n` +
        `אם זו הייתה הסיבה שעצרת, שווה לבדוק.`,
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
    },
    {
      afterHours: 240,
      message: () =>
        `עדכון שרלוונטי לכל מי ששוקל: ⏰\n\n` +
        `דרישת ה-B1 בתוקף, והמועד להגשת התעודה הוא *${kb.B1.deadline.date}*.\n` +
        `הכנת תיק ואיתור מסמכים לוקחים 2-6 חודשים לפני זה בכלל.\n\n` +
        `לא לחץ — רק שתדע איפה עומד לוח הזמנים.`,
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
    },
  ],

  // High intent but never completed
  HIGH_INTENT: [
    {
      afterHours: 12,
      message: p =>
        `היי${p.name ? ` ${p.name}` : ''} 👋\n\n` +
        `נראה שנקטעה לנו השיחה. רק צריך את ${p.name ? '*מספר הטלפון*' : '*השם והטלפון*'} שלך ועו״ד מהמשרד יחזור אליך.`,
    },
    {
      afterHours: 72,
      message: () =>
        `אם עדיין רלוונטי — אפשר גם פשוט להתקשר ישירות למשרד:\n\n` +
        `📞 ${kb.FIRM.offices[0].phone} (תל אביב)\n` +
        `📞 ${kb.FIRM.offices[1].phone} (ירושלים)\n\n` +
        `${kb.FIRM.hours}`,
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
  if (stages.TERMINAL.includes(profile.stage) && profile.stage !== 'LOST_NOT_NOW') return null;
  if ((profile.followUpsSent || 0) >= config.FOLLOWUP_MAX) return null;

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
    const session = conversations[phone];
    const profile = session?.profile;
    if (!profile) continue;

    const due = evaluate(profile);
    if (!due) continue;

    try {
      const text = typeof due.step.message === 'function'
        ? due.step.message(profile)
        : due.step.message;

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
