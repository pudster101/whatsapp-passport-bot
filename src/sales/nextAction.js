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
const meeting = require('./meeting');

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
  OFFER_MEETING:      'offer_meeting',
  PROPOSE_SLOTS:      'propose_slots',
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
  const PRICE_OBJECTIONS = ['need_price_first', 'price_too_high', 'cheaper_competitor'];
  const PRICE_ASK = /(?:כמה\s+(?:בערך\s+)?(?:זה\s+)?(?:בערך\s+|בסוף\s+)?(?:עולה|יוצא|יצא|ייצא|יעלה)|טווח|מחיר|עלות|סדר\s+גודל|שכר\s*טרחה)/;

  // Is this case ready for the office meeting? Then every close below points
  // there, and a phone call is the fallback — not the other way round.
  // Not in the first reply: answer what was asked first. On 16 Oct four leads
  // got a meeting with two evenings in the bot's very first message.
  const meetingReady = meeting.isReadyForMeeting(profile)
    && ((profile.meeting || {}).closeOffers || 0) < 2
    && (profile.messageCount || 0) >= 2
    // Offered and ignored is not a reason to offer the same two slots again
    // next turn — four of eight trainer leads got them verbatim twice (16 Oct).
    && ((profile.messageCount || 0) - ((profile.meeting || {}).lastOfferTurn ?? -99)) >= 3;
  const askingPrice = objections.detect(text).some(o => PRICE_OBJECTIONS.includes(o));
  const askingPriceAny = askingPrice || intent === 'ask_cost' || PRICE_ASK.test(text);
  const GOAL =
    meetingReady
      ? 'הצע *פגישה של 45 דקות במשרד עם עו״ד פודים* (אשכנזי 21, תל אביב), ללא עלות וללא התחייבות; ' +
        'מי שלא יכול להגיע — אותה פגישה בזום; ורק מי שלא רוצה פגישה בכלל — שיחת טלפון. ' +
        'אל תציין ימים או שעות בעצמך — המערכת מוסיפה את המועדים הפנויים האמיתיים.'
      : 'הצע שיחה קצרה עם עו״ד פודים עצמו — ללא עלות וללא התחייבות — עם שתי אפשרויות זמן קונקרטיות.';

  // We hold the number they write from. What is missing is a yes to using it.
  const PHONE_RIDER = noNumber
    ? ' ⚠️ הלקוח עוד לא אישר שיחה. סיים בשאלה אם אפשר שעו״ד פודים יתקשר *למספר הזה* ' +
      '("אפשר שעו״ד פודים יתקשר למספר הזה?"). לעולם אל תבקש שיקליד מספר.'
    : '';

  // 0. An insisting lead asking the price gets the approved range even when the
  //    analysis flagged frustration for escalation — the range IS the answer to
  //    "אתה מתחמק" (יוסי, 16 Oct: asked four times, escalated instead, never got it).
  const rangeDue = profile.priceRangeAllowed && !profile.priceRangeGiven && askingPriceAny
                   && intent !== 'request_human';

  // 1. Explicit human request or AI escalation — always wins
  if (!rangeDue && (intent === 'request_human' || analysis?.escalate)) {
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

  // 1d. A lead who keeps asking for a price gets the firm's approved range —
  //     once, with the caveat and the referral. Owner's decision, 16 Oct: the
  //     trainer kept showing price-pressed leads leaving after the second or
  //     third "אני לא יכול לנקוב במחיר". It sits above frustration on purpose:
  //     "אתה לא עונה לי!" about price IS the frustration, and the range answers it.
  if (profile.priceRangeAllowed && !profile.priceRangeGiven && askingPriceAny) {
    return {
      action: ACTIONS.HANDLE_OBJECTION,
      reason: 'insists on a price — approved range',
      directive:
        'הלקוח מתעקש על מחיר. עכשיו מותר — ורצוי — לתת את טווח המחירים הכללי של המשרד: ' +
        '*8,000 ל-14,000 ₪*. חובה לכלול באותה הודעה: (1) שכל מקרה נבחן לגופו והמחיר תלוי בתיק עצמו; ' +
        '(2) הפניה לפגישה עם עו״ד פודים או לשיחת ייעוץ כדי לקבל מחיר נכון ומותאם אישית. ' +
        'אל תצמצם את הטווח, אל תאמר איפה בטווח הוא צפוי להיות, אל תחלק לפי נפש, ' +
        'ואל תתחייב מה כלול או לא כלול — את זה מפרט עו״ד פודים.' + PHONE_RIDER,
      fallbackText: meetingReady
        ? `${closing.priceRangeAnswer(profile)}\n\n${closing.SLOTS_TOKEN}`
        : `${closing.priceRangeAnswer(profile)}\n\n${closing.withPhoneAsk(closing.callClose(profile, { variant: 'ask_phone', phoneOnly: true }), profile)}`,
      offerMeeting: meetingReady,
      priceRange: true,
      escalate: false,
    };
  }

  // 1e. The range was already given and they ask again ("קרוב ל-8 או ל-12?").
  //     Repeating "אי אפשר לתת מספר" after a range reads as a retreat (רון,
  //     16 Oct). Remind them of the range, say plainly it cannot be narrowed.
  const positionAsk = /קרוב\s+ל|באיזה\s+(?:צד|קצה)|איזה\s+קצה|איפה\s+(?:אני|זה|אנחנו)|לאיזה\s+(?:צד|כיוון)|(?:^|\s)ל?-?\d{1,2}(?:\s*אלף)?\s*(?:או|\?)/.test(text);
  // "תודה על הטווח" is not another price question — after the range was given,
  // the word "טווח" alone does not count (רותם, 16 Oct: her questions about a
  // paid-or-not first stage and a Zoom meeting got the range again instead).
  const priceAskAfterRange = askingPrice || /כמה\s+(?:זה\s+)?(?:עולה|יוצא|יעלה)|מחיר|עלות|סדר\s+גודל|שכר\s*טרחה/.test(text);
  if (profile.priceRangeGiven && (priceAskAfterRange || positionAsk) && !/תודה\s+על\s+הטווח/.test(text)) {
    return {
      action: ACTIONS.HANDLE_OBJECTION,
      reason: 'asks price again after the range',
      directive:
        'כבר נתת ללקוח את טווח המשרד (8,000 ל-14,000 ₪). הזכר אותו במשפט אחד, אמור בכנות שאינך יכול ' +
        'לצמצם אותו או לומר איפה בטווח המקרה שלו נמצא, ושאת המחיר המדויק נותן עו״ד פודים בפגישה או בשיחת ייעוץ. ' +
        'אל תאמר "צד נמוך", "נוטה", "קרוב ל-" או כל מיקום בטווח. ענה גם על כל שאלה אחרת בהודעה.' + PHONE_RIDER,
      fallbackText: meetingReady
        ? `${closing.priceRangeReminder(profile)}\n\n${closing.SLOTS_TOKEN}`
        : closing.withPhoneAsk(closing.priceRangeReminder(profile), profile),
      offerMeeting: meetingReady,
      escalate: false,
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
      ...((askingPrice && meetingReady && !recentClose) ? {
        directiveSuffix:
          ' בסוף ההודעה המערכת תוסיף שתי אפשרויות אמיתיות לפגישה במשרד (שם נותנים את המספר) — ' +
          'אל תוסיף הצעה, מועד או שאלת סגירה משלך.',
      } : {}),
      fallbackText: (askingPrice && meetingReady && !recentClose)
        ? `${closing.stripTrailingAsk(objections.respond(primary))}\n\n${closing.meetingClose(profile)}`
        : objections.respond(primary),
      // "How much?" from a lead whose case is clear is the natural moment for
      // the meeting: that is exactly where the number is given.
      offerMeeting: askingPrice && meetingReady && !recentClose,
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
        'הכר בזה במשפט אחד, ואז שים על השולחן צעד אחד קונקרטי: ' + GOAL + ' ' +
        `ומספר המשרד ${closing.OFFICE_PHONE} כדי שהשליטה תישאר אצלו.` + PHONE_RIDER,
      // Already pitched a turn or two ago? Then this is a goodbye, not a
      // second pitch — leave the number and stop talking.
      fallbackText: closing.withPhoneAsk(closing.callClose(profile, {
        variant: recentClose ? 'departing_brief' : 'departing',
        seed: profile.messageCount || 0,
      }), profile),
      appendContactAsk: noNumber,
      offerMeeting: meetingReady && !recentClose,
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
  // "כמה זה בסוף עולה בסך הכל?" was answered with the B1 exam fee (אלכס,
  // 16 Oct). A question about the price of the case gets the price answer.
  const priceOfCase = PRICE_ASK.test(text) && !/B1|בחינ|אפוסטיל|אגר|קונסוליה/i.test(text);
  const faqKey = priceOfCase ? 'cost' : faq.BY_INTENT[intent];
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

  // ── 4b. The office meeting ─────────────────────────────────────────────────
  //
  // This is the goal of the conversation, and it sits above the generic close
  // on purpose: once the route is clear, "let's sit down with the documents"
  // beats "let's have a call" at every measure the firm cares about. A lead who
  // gives up an evening and drives to Ashkenazi 21 has decided.
  //
  // The phone call is not abandoned — it is what we fall back to the moment the
  // customer shows they are not coming in.
  {
    const mtg = profile.meeting || {};

    // They were offered a meeting and answered.
    if (mtg.status === 'offered' || mtg.status === 'slots_proposed') {
      if (meeting.signalsMeetingRefusal(text)) {
        return {
          action: ACTIONS.CLOSE_TO_CALL,
          reason: 'declined the office meeting — falling back to a call',
          directive:
            'הלקוח העדיף לא להגיע למשרד. אל תתעקש ואל תחזור על ההצעה. ' +
            'קבל את זה במשפט אחד, והצע במקום זה שיחה קצרה עם עו״ד פודים עם שתי ' +
            'אפשרויות זמן קונקרטיות.' + PHONE_RIDER,
          fallbackText: closing.withPhoneAsk(
            closing.callClose(profile, { variant: 'ask_time', seed: profile.messageCount || 0, phoneOnly: true }),
            profile),
          meetingDeclined: true,
          escalate: false,
        };
      }

      // Acceptance is remembered. A lead who says "yes" and is then asked for
      // a phone number does not say "yes" a second time, and without this the
      // booking stalled there — offered, accepted, and never given a time.
      const accepted = !!mtg.accepted
        || meeting.signalsMeetingInterest(text) || meeting.signalsCannotCome(text);

      if (accepted) {
        const mode = (mtg.mode === 'video' || meeting.signalsCannotCome(text))
          ? 'video' : 'office';

        // They said yes but we cannot reach them. Ask for the details AS THE
        // BOOKING STEP — "so I can hold the slot" is a reason the customer
        // accepts, where a bare "what is your name?" in the middle of a
        // booking reads as the bot losing the thread.
        if (!leadProfile.hasContactDetails(profile)) {
          // Oct: "מה שמך המלא?" and then "מה מספר הטלפון שלך?" — two more
          // hurdles between a yes and a meeting. The number is the one they
          // write from; one tap confirms it, and the name is the office's job.
          return {
            action: ACTIONS.REQUEST_CONTACT,
            reason: 'meeting accepted — need consent to the WhatsApp number',
            directive:
              'הלקוח הסכים לפגישה. שאל רק אם אפשר שעו״ד פודים יאשר איתו את המועד *במספר הזה* — ' +
              'משפט אחד, בלי לחזור על ההצעה, בלי לשאול שם ובלי לתת מועדים עדיין.',
            fallbackText: `${profile.name ? `נהדר, ${profile.name}.` : 'מעולה. 🙂'}\n\n${closing.consentAsk(profile)}`,
            escalate: false,
            contactAsk: true,
            meetingAccepted: true,
            meetingMode: mode,
          };
        }

        return {
          action: ACTIONS.PROPOSE_SLOTS,
          reason: `meeting accepted (${mode})`,
          directive:
            (mode === 'video'
              ? 'הלקוח לא יכול להגיע פיזית. הצע פגישת וידאו — אותה פגישה בדיוק, לא גרסה מוקטנת. '
              : 'הלקוח מעוניין בפגישה במשרד. ') +
            'תן *שתי אפשרויות מועד קונקרטיות בלבד* מתוך אלה שיסופקו לך, ובקש שיבחר אחת. ' +
            'אל תמציא מועדים משלך, אל תבטיח שהמועד סגור, ואל תנקוב בעלות.' + PHONE_RIDER,
          fallbackText: null,          // flows fills this with the real slots
          proposeSlots: true,
          meetingAccepted: true,
          meetingMode: mode,
          escalate: false,
        };
      }
    }

    // Not offered yet, and the route is finally clear enough to be worth an
    // evening. isReadyForMeeting is stricter than isQualified on purpose:
    // relative, place AND year of departure.
    if (!mtg.status && meeting.isReadyForMeeting(profile) && (profile.messageCount || 0) >= 2) {
      const mode = meeting.signalsCannotCome(text) ? 'video' : 'office';
      return {
        action: ACTIONS.OFFER_MEETING,
        reason: `route is clear — offering a ${mode} meeting`,
        directive:
          `הגיע הרגע להציע *פגישה עם עו״ד פודים* — ${mode === 'video' ? 'בוידאו' : 'במשרד'}. ` +
          'זו המטרה של השיחה, לא שיחת טלפון. מכור את זה דרך מה שהלקוח כבר אמר: ' +
          'עוברים יחד על המסמכים שיש, ועו״ד פודים אומר בדיוק מה חסר ומאיפה מאתרים אותו. ' +
          'ציין שזה ללא עלות וללא התחייבות. אל תנקוב בסכום, אל תבטיח תוצאה, ' +
          'ואל תיתן כתובת או מועד שלא נמסרו לך.' + PHONE_RIDER,
        fallbackText: closing.meetingClose({ ...profile, meeting: { ...(profile.meeting || {}), mode } }),
        offerMeeting: true,
        meetingMode: mode,
        escalate: false,
      };
    }
  }

  // 5. Ready to start / very high intent — close
  if (intent === 'ready_to_start' || score >= 85) {
    return {
      action: ACTIONS.CLOSE,
      reason: 'customer signalled readiness',
      directive: 'הלקוח מוכן. ' + GOAL + ' לא "בהקדם".' + PHONE_RIDER,
      offerMeeting: meetingReady,
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
        : 'הלקוח מגלה עניין אמיתי. שאל בטבעיות אם אפשר שעו״ד פודים יתקשר אליו *למספר הזה*. אל תשאל שם ואל תבקש שיקליד מספר.',
      fallbackText: contactAttempts >= 1
        ? closing.contactLadder(profile, contactAttempts)
        : `נשמע שזה בהחלט רלוונטי. 🙂\n\n${closing.consentAsk(profile)}`,
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
        `יש לנו את שמו (${profile.name}) והוא כותב מהנייד שלו, אבל עוד לא אישר שיחה. ` +
        'שאל אם אפשר שעו״ד פודים יתקשר *למספר הזה* — במשפט אחד, בטבעיות. אל תבקש שיקליד מספר.',
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

const PRICE_ASK_RE = /(?:כמה\s+(?:בערך\s+)?(?:זה\s+)?(?:בערך\s+|בסוף\s+)?(?:עולה|יוצא|יצא|ייצא|יעלה)|טווח|מחיר|עלות|סדר\s+גודל|שכר\s*טרחה)/;

module.exports = {
  PRICE_ASK_RE,
  normaliseAncestor, ACTIONS, decide };
