/**
 * nextAction.js — decides what a good salesperson does next.
 *
 * Runs with or without the AI. Without it, the rules alone still produce
 * meaningfully better behaviour than the original fixed questionnaire.
 */
const leadProfile = require('./leadProfile');
const objections = require('./objections');
const faq = require('../kb/faq');
const config = require('../config');
const closing = require('./closing');

const ACTIONS = {
  ANSWER_QUESTION:    'answer_question',
  ASK_DISCOVERY:      'ask_discovery',
  QUALIFY:            'qualify',
  PRESENT_VALUE:      'present_value',
  HANDLE_OBJECTION:   'handle_objection',
  OFFER_CONSULTATION: 'offer_consultation',
  REQUEST_CONTACT:    'request_contact',
  SEND_MATERIAL:      'send_material',
  ESCALATE_HUMAN:     'escalate_human',
  CLOSE:              'close',
  CLOSE_TO_CALL:      'close_to_call',
};

/**
 * Turn what the customer said ("סבתא שלי", "סבא שלי מצד אמא") into something
 * the bot can say about THEIR relative without sounding like it means its own.
 */
/**
 * The model sometimes fills the entity in English — "parent", "grandparents",
 * even "self". That value went straight into the customer-facing question and
 * produced "ומה שנת הלידה המשוערת של parent?" in four live conversations.
 * Translate anything that comes back in English before it is ever spoken.
 */
const ANCESTOR_HE = {
  parent: 'ההורה', mother: 'אמא', father: 'אבא',
  grandparent: 'הסבא/סבתא', grandparents: 'הסבים',
  grandmother: 'סבתא', grandfather: 'סבא',
  'great-grandparent': 'הסב רבא', greatgrandparent: 'הסב רבא',
  self: 'אתה', me: 'אתה', i: 'אתה',
  sibling: 'האח/אחות', uncle: 'הדוד', aunt: 'הדודה',
};

function normaliseAncestor(raw) {
  if (!raw) return 'אותו בן משפחה';
  const key = String(raw).trim().toLowerCase().replace(/[_\s]+/g, '');
  if (ANCESTOR_HE[key]) return ANCESTOR_HE[key];
  // Any leftover Latin-only value is a placeholder, not something to say aloud.
  if (/^[a-z\s'-]+$/i.test(String(raw).trim())) return 'אותו בן משפחה';

  let s = String(raw).trim()
    .replace(/\s*של[יוה]\b/g, '')      // שלי / שלו / שלה
    .replace(/\s*שלכם?\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) return 'אותו בן משפחה';
  // Keep the side of the family if they mentioned it — it's useful context
  return s.length > 40 ? 'אותו בן משפחה' : s;
}

/**
 * @returns {{action:string, reason:string, directive:string, fallbackText:string|null, escalate:boolean}}
 */
function decide({ analysis, profile, text, recentClose = false }) {
  const intent = analysis?.intent || 'unclear';
  const openObjections = (profile.objections || []).filter(o => !o.resolved);
  const score = profile.buyingIntent || 0;
  const missing = leadProfile.missingFacts(profile);
  const contactAttempts = profile.contactAsks || 0;
  // A lead who volunteered a name and nothing else. Two of those on 8 Sep —
  // שמשון לזר and מרקוביץ ליאת — gave their name, were never asked for a
  // number, and were never reachable again. A name without a number is not a
  // contact detail; it is a lead we can watch leave.
  const needsPhone = !!profile.name && !profile.clientPhone
                     && !(profile.contactRefusals > 0);

  // No number in the file at all — name or no name. Every branch that closes,
  // hands over, or agrees a time carries the request with it. Three leads in
  // mid-September picked a time and were never asked for a number, because the
  // "we just closed, don't nag" rule silenced the ask at the warmest moment.
  const noNumber = closing.needsPhoneAsk(profile);
  const PHONE_RIDER = noNumber
    ? ' ⚠️ אין מספר טלפון בתיק. סיים את ההודעה בבקשה מפורשת למספר טלפון — ' +
      'גם אם כבר סוכם מועד, וגם אם ביקשת בעבר. מועד בלי מספר אינו פגישה.'
    : '';

  // 1. Explicit human request or AI escalation — always wins
  if (intent === 'request_human' || analysis?.escalate) {
    return {
      action: ACTIONS.ESCALATE_HUMAN,
      reason: analysis?.escalateReason || 'customer requested a human',
      directive: 'הודע בטבעיות שעו״ד פודים עצמו יחזור אליו — ואז שאל מתי נוח, ' +
                 'עם שתי אפשרויות זמן קונקרטיות. לעולם לא "בהקדם".' + PHONE_RIDER,
      fallbackText: closing.withPhoneAsk(
        closing.callClose(profile, { variant: 'handoff' }), profile),
      appendContactAsk: noNumber,
      escalate: true,
    };
  }

  // 1b. "You never called me back." Nothing outranks this except an explicit
  //     request for a human, which lands in the same place anyway. No pitch,
  //     no scheduling script, no closing line — an apology, a commitment, and
  //     an urgent alert to the office.
  if (closing.signalsMissedCallback(text)) {
    return {
      action: ACTIONS.ESCALATE_HUMAN,
      reason: 'customer says nobody called back',
      directive:
        'הלקוח אומר שלא חזרו אליו. זו תלונה, לא שלב במכירה. ' +
        'התנצל במשפט אחד, אל תמכור שום דבר, אל תסביר תהליך, ואל תציע "לתאם" מחדש. ' +
        'אמור שאתה מעביר את זה לעו״ד פודים עכשיו, ותן את מספר המשרד כדי שהשליטה ' +
        `תהיה אצלו: ${closing.OFFICE_PHONE} · ${closing.HOURS}.` + PHONE_RIDER,
      fallbackText: closing.withPhoneAsk(
        `אני מתנצל — זה לא היה אמור לקרות. 🙏\n\n` +
        `אני מעביר את זה לעו״ד פודים עכשיו כדי שיחזור אליך היום.\n` +
        `ואם נוח לך להקדים — *${closing.OFFICE_PHONE}* · ${closing.HOURS}, תבקש אותו ישירות.`,
        profile),
      escalate: true,
      urgent: true,
    };
  }

  // 1c. "We already spoke." An instruction to stop, not an opening to sell.
  if (closing.signalsAlreadySpoke(text)) {
    return {
      action: ACTIONS.ESCALATE_HUMAN,
      reason: 'customer says the call already happened',
      directive:
        'הלקוח אומר שכבר שוחחו איתו. אל תתאם שוב, אל תחזור על מה שסוכם, ' +
        'ואל תתעקש שהשיחה עוד לפניו — אינך יודע מה קרה מחוץ לוואטסאפ. ' +
        'אשר במשפט אחד שהכל רשום, ואמור שתוודא שלא תישלח אליו פנייה נוספת.',
      fallbackText:
        `מצוין, תודה שעדכנת — רשמתי שכבר דיברתם. 🙏\n\n` +
        `לא נטריד אותך שוב בעניין הזה. אם יעלה משהו — *${closing.OFFICE_PHONE}*.`,
      escalate: true,
      suppressFollowUp: true,
    };
  }

  // 2. Frustration — never keep selling to an unhappy customer
  if (analysis?.emotion === 'frustrated') {
    return {
      action: ACTIONS.ESCALATE_HUMAN,
      reason: 'customer appears frustrated',
      directive: 'הכר ברגש, אל תמכור, והצע שעו״ד פודים עצמו יחזור אליו — עם מועד קונקרטי.',
      fallbackText: `אני מבין את התסכול, ומצטער. 🙏\n\n` +
                    closing.callClose(profile, { variant: 'handoff' }),
      escalate: true,
    };
  }

  // 3. Open objection — handle it before anything else
  if (openObjections.length) {
    const primary = openObjections[0].type;
    // Has this objection already been answered once? The trainer scored a
    // conversation 45/100 because the bot gave the same "לא בסמכותי" reason in
    // turns 3 AND 4 — "חזרתיות גבוהה, לא הציע חלופה" — and the lead left for a
    // competitor. Repeating a reason the lead already rejected is not handling
    // an objection, it is stonewalling.
    const timesRaised = (profile.objections || [])
      .filter(o => o.type === primary).length
      + (profile.objectionHistory?.[primary] || 0);
    const isRepeat = timesRaised > 1 || !!profile.objectionAnswered?.[primary];

    return {
      action: ACTIONS.HANDLE_OBJECTION,
      reason: `open objection: ${primary}${isRepeat ? ' (repeat)' : ''}`,
      directive: isRepeat
        ? `הלקוח מעלה את "${objections.label(primary)}" *בפעם השנייה*. ` +
          `אסור לחזור על אותו נימוק — הוא כבר שמע אותו ודחה אותו. ` +
          `במקום זה תן משהו חדש ומוחשי: מה בדיוק כלול בטיפול, מי עושה מה ` +
          `(עו״ד פודים נוטריון בעצמו — התרגום הנוטריוני נעשה בתוך המשרד). ` +
          `אם הוא משווה למשרדים אחרים — שאל אותו מה כלול אצלם ומי מטפל בתיק בפועל. ` +
          `אל תציע לתאם שיחה בתשובה הזו — הוא עדיין באמצע בירור.`
        : `הלקוח העלה התנגדות מסוג "${objections.label(primary)}". ` +
          `הכר בה, הבן את השורש, וענה ספציפית. אל תתווכח ואל תלחץ.`,
      fallbackText: objections.respond(primary),
      escalate: false,
      closeToCall: true,
    };
  }

  // 3a. The lead just refused to leave a phone number. This is not a moment to
  //     push — it is a moment to step down. Ask for less, or hand over control.
  if (closing.signalsContactRefusal(text)) {
    return {
      action: ACTIONS.REQUEST_CONTACT,
      reason: 'customer refused to leave a phone number',
      directive:
        'הלקוח סירב להשאיר טלפון. אל תבקש שוב ואל תסביר למה כדאי. ' +
        'הכר בזה במשפט, ותן לו חלופות שהשליטה בהן אצלו: להתקשר בעצמו למשרד, ' +
        'לכתוב למייל, או פשוט לחזור לכאן כשירצה. סיים בלי לחץ.',
      fallbackText: closing.contactLadder(profile, (profile.contactRefusals || 0) + 1),
      escalate: false,
    };
  }

  // 3b. The lead is leaving and has no open objection — "תודה, אחשוב על זה".
  //     This is the turn the trainer kept scoring 3.8/10: the bot said
  //     "מה שנוח לך" and the conversation died. Never end on the lead's terms
  //     without putting one concrete call on the table first.
  if (closing.signalsEnding(text)) {
    return {
      action: ACTIONS.CLOSE_TO_CALL,
      reason: 'customer signalled the conversation is ending',
      directive:
        'הלקוח מסיים את השיחה. אל תילחם ואל תחזור על מה שכבר נאמר. ' +
        'הכר בזה במשפט אחד, ואז שים על השולחן שיחה קצרה עם עו״ד פודים עצמו — ' +
        'ללא עלות וללא התחייבות — עם שתי אפשרויות זמן קונקרטיות, ' +
        `ומספר המשרד ${closing.OFFICE_PHONE} כדי שהשליטה תישאר אצלו.` + PHONE_RIDER,
      // Already pitched a turn or two ago? Then this is a goodbye, not a
      // second pitch — leave the number and stop talking.
      fallbackText: closing.withPhoneAsk(closing.callClose(profile, {
        variant: recentClose ? 'departing_brief' : 'departing',
        seed: profile.messageCount || 0,
      }), profile),
      appendContactAsk: noNumber,
      escalate: false,
      closeToCall: true,
    };
  }

  // 4. A DIRECT QUESTION IS ALWAYS ANSWERED — even from a hot lead.
  //
  //    This branch deliberately sits above the contact request. Answering
  //    "how long does it take?" with "what is your name?" is the fastest way
  //    to lose a serious prospect — it is exactly what a bad salesperson does.
  //    When intent is high we still push, but as an ADDITION to the answer,
  //    never as a replacement for it.
  const faqKey = faq.BY_INTENT[intent];
  if (faqKey) {
    const isQualified = leadProfile.isQualified(profile);
    const wantsContact = !leadProfile.hasContactDetails(profile)
      && (score >= config.HOT_LEAD_THRESHOLD || needsPhone);

    return {
      action: ACTIONS.ANSWER_QUESTION,
      reason: `direct question: ${intent}` + (wantsContact ? ' (+contact ask)' : ''),
      directive:
        (isQualified
          ? 'ענה על השאלה וקשר אותה למקרה הספציפי שלו לפי מה שכבר ידוע עליו.'
          : 'ענה על השאלה בקצרה ולעניין.') +
        (wantsContact
          ? (needsPhone
              ? ' יש לנו את שמו אבל אין מספר. אחרי התשובה הוסף משפט קצר אחד שמבקש *מספר טלפון* לחזרה — לא "פרטים" ולא מייל. אל תוותר על התשובה לטובת הבקשה.'
              : ' הלקוח מגלה עניין אמיתי — אחרי התשובה הוסף משפט קצר אחד שמזמין אותו להשאיר פרטים לשיחת ייעוץ. אל תוותר על התשובה לטובת הבקשה.')
          : ' אם זה מתאים לרגע, סיים בשאלה אחת שמקדמת.'),
      fallbackText: faq.get(faqKey),
      appendContactAsk: wantsContact,
      escalate: false,
    };
  }

  // 5. Ready to start / very high intent — close
  if (intent === 'ready_to_start' || score >= 85) {
    return {
      action: ACTIONS.CLOSE,
      reason: 'customer signalled readiness',
      directive: 'הלקוח מוכן. הסבר בשורה מה כוללת שיחת הייעוץ, ואז סגור מועד — ' +
                 'שתי אפשרויות זמן קונקרטיות, לא "בהקדם".' + PHONE_RIDER,
      fallbackText: closing.withPhoneAsk(
        `${faq.get('consultation')}\n\n` + closing.callClose(profile), profile),
      appendContactAsk: noNumber,
      escalate: false,
    };
  }

  // 6. High intent, but no question on the table — now it IS right to ask
  // Asking for contact details is itself a close. If we closed a turn or two
  // ago, asking again is the nagging that cost us the third trainer run.
  if (score >= config.HOT_LEAD_THRESHOLD && !leadProfile.hasContactDetails(profile)
      && !recentClose) {
    return {
      action: ACTIONS.REQUEST_CONTACT,
      reason: `buying intent ${score} — high, no open question`,
      directive: contactAttempts >= 1
        ? `⚠️ כבר ביקשת פרטים ${contactAttempts} פעמים והלקוח לא נתן. ` +
          `אל תבקש שוב את אותו דבר — רד מדרגה: בקש רק שם פרטי, או הצע מייל, ` +
          `או פשוט תן את מספר המשרד ותן לו את השליטה.`
        : !profile.name
          ? 'הלקוח מגלה עניין אמיתי. בקש בטבעיות את שמו כדי שנוכל לחזור אליו.'
          : 'יש לנו שם. בקש את מספר הטלפון לחזרה.',
      fallbackText: contactAttempts >= 1
        ? closing.contactLadder(profile, contactAttempts)
        : (!profile.name
            ? `נשמע שזה בהחלט רלוונטי עבורך. 😊\n\nכדי שעו״ד פודים יחזור אליך — *מה שמך המלא?*`
            : `מעולה. *ומה מספר הטלפון שלך לחזרה?*`),
      escalate: false,
      contactAsk: true,
    };
  }

  // 6b. We have a name and no number, at any score. Giving a name IS the buying
  //     signal — nobody types their full name to a bot they intend to ignore.
  //     The 70-point threshold above never fires for these leads, which is
  //     precisely why two of them walked away unasked.
  // A recent close no longer silences this. It used to: `!recentClose` meant
  // that the moment a lead agreed to a time — the warmest turn in the whole
  // conversation — the number was never asked for. Three leads on 14–17 Sep.
  if (needsPhone && contactAttempts < 3) {
    return {
      action: ACTIONS.REQUEST_CONTACT,
      reason: 'name known, phone missing',
      directive:
        `יש לנו את שמו (${profile.name}) אבל אין מספר טלפון. ` +
        'בקש *מספר טלפון* — במשפט אחד, בטבעיות, ובלי לחזור על ניסוח שכבר השתמשת בו. ' +
        'אל תבקש מייל במקום, ואל תסתפק בשם.',
      fallbackText: closing.nextContactAsk(profile, { seed: contactAttempts }),
      escalate: false,
      contactAsk: true,
    };
  }

  // 7. Nothing known yet — discover before interrogating
  if (!profile.motivation && (profile.messageCount || 0) <= 2) {
    return {
      action: ACTIONS.ASK_DISCOVERY,
      reason: 'motivation unknown',
      directive: 'שאל שאלת גילוי אחת — מה גרם לו להתעניין דווקא עכשיו.',
      fallbackText: null,
      escalate: false,
    };
  }

  // 8. Qualify — one fact at a time, only what's missing
  if (missing.length && !leadProfile.isQualified(profile)) {
    const next = missing[0];
    // The customer says "סבתא שלי" — echoing that verbatim makes the bot
    // sound like it is talking about its own grandmother. Strip possessives.
    const who = normaliseAncestor(profile.eligibility?.ancestor);
    const asks = {
      ancestor:   'שאל מי במשפחה נולד ברומניה (הורה / סב / סבתא, ומאיזה צד).',
      birthPlace: 'שאל באיזו עיר או אזור ברומניה נולד/ה — זה קובע את המסלול המשפטי.',
      leftYear:   'שאל באיזו שנה בערך הוא/היא עלה/תה לישראל. זו השאלה החשובה ביותר — ' +
                  'שנת העלייה קובעת אם האזרחות נשללה, ומכאן את מגבלת הדורות ואת דרישת ה-B1.',
      birthYear:  'שאל מה שנת הלידה המשוערת שלו/שלה.',
    };
    const fallbacks = {
      ancestor:   'כדי לבדוק את הזכאות שלך — *מי במשפחה נולד ברומניה?* (הורה / סב / סבתא)',
      birthPlace: `ואם ידוע — *באיזו עיר או אזור ברומניה* נולד/ה ${who}?`,
      leftYear:   `ועכשיו השאלה הכי חשובה — *באיזו שנה בערך ${who} עלה/תה לישראל?*\n\n` +
                  `_שנת העלייה קובעת את המסלול: אם האזרחות נשמרה או נשללה, וזה משנה הכל._`,
      birthYear:  `ומה *שנת הלידה המשוערת* של ${who}?`,
    };
    return {
      action: ACTIONS.QUALIFY,
      reason: `missing: ${next}`,
      directive: asks[next] || 'שאל שאלת הסמכה אחת.',
      fallbackText: fallbacks[next] || null,
      escalate: false,
    };
  }

  // 9. Qualified but not committed — present value tied to motivation
  if (leadProfile.isQualified(profile) && !leadProfile.hasContactDetails(profile)) {
    return {
      action: ACTIONS.PRESENT_VALUE,
      reason: 'qualified, needs value framing',
      directive:
        `הלקוח מוסמך. הצג הערכה ראשונית לפי מה שידוע ` +
        `(${profile.eligibility?.likelyArticle ? `כנראה סעיף ${profile.eligibility.likelyArticle}` : 'מסלול לבדיקה'}) ` +
        `וקשר את הערך למניע שלו${profile.motivation ? ` (${profile.motivation})` : ''}. ` +
        `סיים בהצעה לשיחת ייעוץ.`,
      fallbackText: null,
      escalate: false,
    };
  }

  // 10. Default — offer the consultation
  return {
    action: ACTIONS.OFFER_CONSULTATION,
    reason: 'default',
    directive: 'ענה לעניין והצע שיחת ייעוץ ללא התחייבות אם זה מתאים לרגע.',
    fallbackText: null,
    escalate: false,
  };
}

module.exports = {
  normaliseAncestor, ACTIONS, decide };
