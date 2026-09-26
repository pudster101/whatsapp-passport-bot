/**
 * A/B on the opening message.
 *
 * Why this exists: the creative test (CMP-ROM-002) gave each arm a third of the
 * traffic to detect a 1% difference in yield, and could not. A third of paid
 * conversations die on the first exchange — 22 of 63 sit unmoved at
 * INITIAL_ENGAGEMENT, 10 of 31 real conversations died there in the 7 Sep
 * review. That is the effect worth measuring, and a two-way split gives each
 * variant HALF of all traffic instead of a third.
 *
 * Assignment is a pure function of the phone number: no state, no counter, no
 * race. The same lead always lands in the same variant, so a returning lead
 * never sees the experiment change under them.
 */
const crypto = require('crypto');

const VARIANTS = ['A', 'B'];

/** Deterministic, uniform, stable across restarts and across processes. */
function assign(phone) {
  if (!phone) return 'A';
  const digest = crypto.createHash('sha256').update(String(phone)).digest();
  return VARIANTS[digest[0] % VARIANTS.length];
}

/**
 * The opening message, per variant.
 *
 * A — control. The wording live since early September.
 *
 * B — challenger. Three changes, each aimed at something visible in the data:
 *   1. It answers before it asks. `ask_eligibility` is the most common intent
 *      by a distance (109 occurrences); the control replies to it with a
 *      question instead of an answer.
 *   2. It includes the third degree. The control's "(הורה / סב / סבתא)" omits
 *      great-grandparents, who are inside CL-004. Someone whose
 *      great-grandparent was born in Romania reads the control as a rejection.
 *   3. It removes the wrong answer. A lead who knows "סבא היה מרומניה" but not
 *      who was *born* there has nothing safe to type. "לא בטוח" gives them one.
 *
 * Compliance: "עשוי להיות זכאי" is the hedge CL-004 requires — a possibility,
 * never a determination. No outcome promised, no timeline promised (the
 * Tal Yehoshua lesson, 10 Sep), no comparative claim.
 */
const OPENING = {
  A: 'היי! \u{1F44B} הגעת למשרד עו\u05F4ד יהונתן פודים — *השער שלך לרומניה*.\n\n' +
     'בוא נראה מה המצב שלך. *מי במשפחה נולד ברומניה?* (הורה / סב / סבתא)',

  B: 'היי! \u{1F44B} כאן המשרד של עו\u05F4ד יהונתן פודים.\n\n' +
     'הכלל הבסיסי: מי שיש לו הורה, סב/סבתא או סבא-רבא/סבתא-רבתא שנולדו ברומניה — ' +
     '*עשוי* להיות זכאי. גם אם הפרטים לא ברורים לכם.\n\n' +
     '*באיזה דור זה אצלכם?* ואם לא ידוע במדויק — כתבו \u00AB‏לא בטוח\u00BB ונתקדם מכאן.',
};

/**
 * The same two openings in English.
 *
 * The ad runs an English arm — four conversations in the 10–24 Sep window
 * opened with "Hello! Can I get more info on this?" — and every one of them
 * was answered in Hebrew and died within three messages. Nothing in the code
 * had ever looked at the language of the incoming message.
 */
const OPENING_EN = {
  A: "Hi! \u{1F44B} You've reached the office of Yehonatan Pudim, Attorney at Law — " +
     '*your gateway to Romania*.\n\n' +
     "Let's see where you stand. *Who in your family was born in Romania?* " +
     '(parent / grandparent)',

  B: "Hi! \u{1F44B} This is the office of Yehonatan Pudim, Attorney at Law.\n\n" +
     'The basic rule: if a parent, grandparent or great-grandparent of yours was ' +
     'born in Romania, you *may* be eligible — even if the details are unclear.\n\n' +
     '*Which generation is it in your family?* If you are not sure, just write ' +
     '«not sure» and we will take it from there.',
};

function opening(variant, lang) {
  const table = lang === 'en' ? OPENING_EN : OPENING;
  return table[variant] || table.A;
}

module.exports = { VARIANTS, assign, opening, OPENING, OPENING_EN };
