/**
 * flows.js — Conversation engine for the Romanian passport bot.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     STATE MACHINE MAP                          │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  START (trigger phrase)                                        │
 * │    └→ WELCOME_SENT  (3 interest buttons shown)                 │
 * │         ├→ ELIG_Q1   (who in family?)                          │
 * │         ├→ PROCESS_INFO → ELIG_Q1                              │
 * │         └→ COST_INFO   → ELIG_Q1                               │
 * │                                                                 │
 * │  ELIG_Q1  (who in family born in Romania?)                      │
 * │    └→ ELIG_Q2  (approximate birth year?)                       │
 * │         ├→ ELIG_Q3  (city / region?)                           │
 * │         └→ELIG_NO_DOCS  (user doesn't know details)            │
 * │              └→ ELIG_POSITIVE                                   │
 * │                                                                 │
 * │  ELIG_Q3 → ELIG_Q4 (year they left Romania?)                   │
 * │    └→ ELIG_POSITIVE  (positive assessment)                      │
 * │         └→ LEAD_NAME → LEAD_PHONE → COMPLETE                   │
 * │                                                                 │
 * │  Any state → HANDOFF  (user asks for human agent)              │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * INLINE QUESTION DETECTION runs before state routing.
 * Keywords trigger contextual answers without breaking the flow.
 */

const wa = require('./whatsapp');
const storage = require('./storage');
const config = require('./config');
const { addDays, format, getDay } = require('date-fns');

// ─── Notify all configured agent phones ──────────────────────────────────────
async function notifyAgents(text) {
  if (!config.AGENT_PHONES.length) return;
  await Promise.all(config.AGENT_PHONES.map(phone => wa.sendText(phone, text)));
}

// ─── Trigger phrases (Click-to-WhatsApp from Facebook ads) ──────────────────

const TRIGGER_PHRASES = [
  'שלום! אפשר לקבל מידע נוסף על זה?',
  'hello! can i get more info on this?',
];

function isTriggerMessage(text) {
  return TRIGGER_PHRASES.some(t => text.trim().toLowerCase() === t.toLowerCase());
}

// ─── Inline question / keyword detection ─────────────────────────────────────
// Returns a handler key if the free-text message matches a known topic,
// so we can answer it without breaking the current flow state.

const INLINE_KEYWORDS = [
  {
    key: 'no_docs',
    patterns: ['אין לי מסמכים', 'אין מסמכים', 'בלי מסמכים', 'no documents', 'no docs'],
  },
  {
    key: 'legal',
    patterns: ['חוקי', 'קומבינה', 'בטוח', 'legal', 'legitimate', 'לגיטימי'],
  },
  {
    key: 'cost',
    patterns: ['כמה עולה', 'מחיר', 'עלות', 'עלויות', 'תשלום', 'price', 'cost', 'how much'],
  },
  {
    key: 'time',
    patterns: ['כמה זמן לוקח', 'how long does it take', 'timeline', 'duration'],
  },
  {
    key: 'stuck',
    patterns: ['יתקע', 'נתקע', 'מפחד', 'פחד', 'ניסיון קודם', 'stuck', 'afraid', 'worried'],
  },
  {
    key: 'worth_it',
    patterns: ['שווה', 'כדאי', 'למה', 'בשביל מה', 'worth it', 'why bother'],
  },
  {
    key: 'children',
    patterns: ['ילדים', 'ילד', 'בן', 'בת', 'נכד', 'children', 'kids', 'child'],
  },
  {
    key: 'travel',
    patterns: ['לנסוע', 'נסיעה', 'לטוס', 'רומניה עצמה', 'travel', 'visit'],
  },
  {
    key: 'human',
    patterns: ['אדם אמיתי', 'נציג', 'לדבר עם', 'מישהו אמיתי', 'human', 'agent', 'speak to someone'],
  },
];

function detectInlineQuestion(text) {
  const lower = text.toLowerCase().trim();
  for (const item of INLINE_KEYWORDS) {
    if (item.patterns.some(p => {
      // Match whole words only (handles Hebrew & English)
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[\\s,.:;!?״\'\"()])${escaped}([\\s,.:;!?״\'\"()]|$)`);
      return regex.test(lower);
    })) {
      return item.key;
    }
  }
  return null;
}

// ─── Inline answers ──────────────────────────────────────────────────────────
// These are sent as contextual responses mid-flow, followed by re-prompting
// the user back to where they were.

const INLINE_ANSWERS = {
  no_docs: `📂 *אין לך מסמכים – זה לא בעיה.*

לפי החוק הרומני, אפשר לאתר מסמכים בארכיונים ברומניה גם אם אין אצלך כלום:

✔ רישומי לידה ✔ רישומי נישואין
✔ רישומי אזרחות ✔ מסמכים היסטוריים נוספים

כדי לבדוק מה ניתן לאתר במקרה שלך, ניסה לתת לי לפחות:
• שם משפחה רומני (גם משוער)
• שנת לידה משוערת
• אזור/עיר משוערים`,

  legal: `⚖️ *כן, זה תהליך חוקי לחלוטין.*

המסד המשפטי: *חוק האזרחות הרומני* מאפשר לצאצאים של אזרחים רומנים שאיבדו את אזרחותם מסיבות היסטוריות – לשחזר אותה.

ההליך כולל הגשה *רשמית* לרשויות רומניה, שימוש *במסמכים רשמיים בלבד*, ורישום *כחוק* במרשם האוכלוסין.
אנחנו לא עוקפים שום דבר – עובדים בדיוק לפי הנהלים הקבועים בחוק.`,

  cost: `💰 *העלות נקבעת לפי מורכבות התיק:*

• האם יש מסמכים זמינים או שצריך לאתר בארכיונים
• האם מדובר בדור אחד או גם בילדים/נכדים
• האם יש שינויי שם, פערים במסמכים, אזורים שנויים במחלוקת

משרד רציני לא זורק מספר לפני שהוא מבין את התיק.
בשיחת ייעוץ עם עו״ד תקבל *טווח עלויות מדויק* לפי המקרה שלך.`,

  time: `⏳ *ציר הזמן תלוי בכמה גורמים:*

📁 *איתור מסמכים ברומניה* – שבועות עד מספר חודשים
📝 *הגשת הבקשה + עיבוד* – מספר חודשים עד שנה+
🪪 *רישום + הוצאת דרכון* – שלב קצר יחסית

*ברוב התיקים: כשנה עד שנתיים.* יש תיקים שמסתיימים מהר יותר – תלוי במורכבות.`,

  stuck: `✅ *מבין אותך – זה חשש לגיטימי.*

תיקים נתקעים בדרך כלל בגלל מסמכים חסרים, הגשה לא נכונה, או עבודה עם גורמים לא משפטיים.

אצלנו התהליך כולל:
✔ בדיקה משפטית של המסמכים *לפני* הגשה
✔ מעקב שוטף מול הרשויות
✔ טיפול בדרישות השלמה
✔ עדכון שוטף ללקוח

אם כבר ניסית בעבר – עו״ד יוכל לבדוק אם אפשר "להציל" את התיק.`,

  worth_it: `🌍 *שאלה מצוינת. הנה מה שדרכון רומני מעניק:*

• *חופש תנועה מלא* ב-27 מדינות האיחוד האירופי
• *זכות מגורים ועבודה* בכל מדינה באירופה – בלי ויזה
• *לימודים מסובסדים* בכל האוניברסיטאות האירופיות
• *הילדים שלך זכאים גם הם* – ירושה לדורות הבאים

עבור רבים זה הדרך הפשוטה ביותר לאזרחות אירופית.`,

  children: `👨‍👩‍👧 *כן, הילדים שלך זכאים גם הם.*

ברגע שאתה מוכר כאזרח רומני, ניתן להגיש בקשות עבור הילדים.
הסדר הרגיל: קודם מסדירים את שלך, אחר כך של הילדים.

גיל הילדים ומיקומם (ארץ/חו״ל) משפיעים על האופן הטכני – נסביר בשיחת הייעוץ.`,

  travel: `✈️ *ברוב המקרים – לא חובה לנסוע.*

רוב התהליך מתבצע מרחוק באמצעות ייפוי כוח ועבודה מול הרשויות ברומניה.
יש מצבים שבהם ביקור קצר יכול לקצר שלבים – אבל זה לא תנאי הכרחי ברוב התיקים.

בשיחת הייעוץ נסביר מה הסבירות שזה יידרש במקרה שלך.`,
};

// ─── Scheduling helpers ───────────────────────────────────────────────────────

function getNextWeekdays(count = 4) {
  const result = [];
  let date = new Date();
  date.setDate(date.getDate() + 1);
  while (result.length < count) {
    const dayNum = getDay(date);
    if (dayNum >= 0 && dayNum <= 4) {
      result.push({
        label: `${config.MEETING_DAYS[dayNum]} ${format(date, 'dd/MM')}`,
        value: format(date, 'yyyy-MM-dd'),
      });
    }
    date = addDays(date, 1);
  }
  return result;
}

// ─── Flow helpers ─────────────────────────────────────────────────────────────

async function sendInlineAnswer(phone, key, session) {
  const answer = INLINE_ANSWERS[key];
  if (answer) await wa.sendText(phone, answer + '\n\n_💡 לחזרה לתפריט הראשי כתוב: *מידע נוסף*_');
}

async function repromptCurrentState(phone, session) {
  // Re-ask the question for the current state so the user can continue
  const { state, data } = session;
  await new Promise(r => setTimeout(r, 600));

  switch (state) {
    case 'WELCOME_SENT':
      await showInterestButtons(phone);
      break;
    case 'ELIG_Q1':
      await wa.sendText(phone, '➤ אז חזרה לשאלה שלנו – *מי במשפחה נולד ברומניה?* (הורה / סב / סבתא)');
      break;
    case 'ELIG_Q2':
      await wa.sendText(phone, `➤ ומה *שנת הלידה המשוערת* של ${data.familyMember || 'אותו בן משפחה'}?`);
      break;
    case 'ELIG_Q3':
      await wa.sendText(phone, '➤ ואם ידוע – *שם העיר או המחוז ברומניה* שבו נולד?');
      break;
    case 'ELIG_Q4':
      await wa.sendText(phone, '➤ ובאיזו *שנה בערך עזב* את רומניה?');
      break;
    case 'ELIG_NO_DOCS':
      await wa.sendText(phone, '➤ אפשר לנסות לתת לי *שם משפחה רומני, שנת לידה, או אזור* – גם אם משוערים?');
      break;
    case 'LEAD_NAME':
      await wa.sendText(phone, '➤ כדי שנוכל לחזור אליך – מה *שמך המלא*?');
      break;
    case 'LEAD_PHONE':
      await wa.sendText(phone, '➤ ומה *מספר הטלפון* שלך לחזרה?');
      break;
    default:
      await showInterestButtons(phone);
  }
}

async function showInterestButtons(phone) {
  await wa.sendList(
    phone,
    'במה תרצה שנתחיל?',
    'בחר נושא',
    [{
      title: 'נושאים',
      rows: [
        { id: 'interest_eligibility',     title: '✅ בדיקת זכאות',        description: 'בדוק אם אתה זכאי לדרכון רומני' },
        { id: 'interest_process',         title: '📋 מידע על התהליך',      description: 'שלבי תהליך קבלת האזרחות' },
        { id: 'interest_cost',            title: '💰 עלויות וזמנים',       description: 'עלות צפויה וכמה זמן לוקח' },
        { id: 'interest_romanian_course', title: '🎓 קורס רומנית B1',      description: 'תעודת שפה – תנאי לשחזור אזרחות' },
      ],
    }]
  );
}

// ─── Main flow handlers ───────────────────────────────────────────────────────

async function handleStart(phone) {
  const newSession = {
    state: 'WELCOME_SENT',
    data: {},
    startedAt: new Date().toISOString(),
  };
  storage.setConversation(phone, newSession);

  // Notify agent that someone started the chat
  if (config.AGENT_PHONES.length) {
    const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    await notifyAgents(
      `👁️ *התחלת שיחה חדשה*\n\n📱 מספר: +${phone}\n🕐 שעה: ${now}\n\n_אם לא תגיע הודעת ליד בהמשך – הלקוח לא השלים את התהליך._`
    );
  }

  await wa.sendText(phone,
    `היי! 👋 תודה שפנית אלינו למשרד עורך דין יהונתן פודים - השער שלך לרומניה.\n\nאני כאן כדי לבדוק עבורך *זכאות לדרכון רומני* וללוות אותך עד קביעת שיחת ייעוץ עם *עו״ד מהמשרד*.\n\nכדי להתחיל – מה גרם לך להתעניין?`
  );
  await new Promise(r => setTimeout(r, 400));
  await showInterestButtons(phone);
}

// ── Interest selection ────────────────────────────────────────────────────────

async function handleInterestEligibility(phone, session) {
  session.state = 'ELIG_Q1';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `מצוין. נתחיל בבדיקה ראשונית. 🔍\n\nהזכאות נקבעת לפי שנת ומקום הלידה של בן המשפחה שנולד ברומניה.\n\n*מי במשפחה נולד ברומניה?*\n(הורה / סב / סבתא – ואם אפשר, מאיזה צד)`
  );
}

async function handleInterestProcess(phone, session) {
  session.state = 'ELIG_Q1';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `בשמחה. הנה הסבר קצר ומדויק על *התהליך לפי חוק האזרחות הרומני:*\n\n1️⃣ *איתור מסמכים ברומניה* – רישומי לידה, נישואין ופטירה בארכיונים.\n_(שבועות עד מספר חודשים)_\n\n2️⃣ *איסוף מסמכים בישראל* – תעודות לידה, נישואין ומסמכים אישיים נוספים הרלוונטיים לתיק.\n\n3️⃣ *הגשת בקשה להסדרה או שחזור אזרחות* – ההליך המדויק נקבע בהתאם למאפיינים האישיים של כל תיק.\n_(מספר חודשים עד שנתיים+)_\n\n4️⃣ *רישום במרשם האוכלוסין הרומני* – לאחר אישור האזרחות.\n\n5️⃣ *הוצאת דרכון רומני* – שלב קצר יחסית.\n\n⏳ *סה״כ: ברוב התיקים כשנה עד שנתיים.* יש תיקים שמסתיימים מהר יותר – תלוי במורכבות ובזמינות המסמכים.\n\nכדי להבין מה נדרש *במקרה שלך* – מי במשפחה נולד ברומניה ומה שנת הלידה שלו?`
  );
}

async function handleInterestCost(phone, session) {
  session.state = 'ELIG_Q1';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `כדי לתת תשובה אמינה ולא "בערך" – צריך להבין את *מורכבות התיק*.\n\nהזמנים והעלויות מושפעים מ-3 גורמים עיקריים:\n• האם יש מסמכים זמינים\n• *שנת הלידה* של בן המשפחה הרומני\n• *האזור* שבו נולד (חלק מהאזורים היו רומניים רק בתקופות מסוימות)\n\nבממוצע, תהליך מלא נע *בין שנה לשנתיים*, אבל יש תיקים מהירים יותר.\n\nרוצה שאעריך את הזמן והעלות במקרה שלך? מי במשפחה נולד ברומניה ומה שנת הלידה שלו?`
  );
}

async function handleInterestRomanianCourse(phone, session) {
  session.state = 'LEAD_NAME';
  session.data.source = 'romanian_course';
  storage.setConversation(phone, session);

  // Send the course flyer image first (if available)
  const flyerUrl = `${config.PUBLIC_URL}/public/course-flyer.jpg`;
  await wa.sendImage(phone, flyerUrl);
  await new Promise(r => setTimeout(r, 500));

  await wa.sendText(phone,
    `🎓 *קורס רומנית לתעודת B1*\n\nבמסגרת שיתוף הפעולה שלנו עם משרד עורכי דין מוביל ברומניה, אנו שמחים לבשר על הזדמנות ייחודית ללקוחות המשרד:\n\n*קורס רומנית רשמי ומוכר לקבלת תעודת שפה ברמת B1* — תנאי הכרחי בתהליך השבת האזרחות הרומנית, בהתאם לשינויי החקיקה.\n\n📍 הקורס מתקיים באוניברסיטת *סיביו לוציאן בלאגה*\n✅ עומד בדרישות *חוק 21/1991*\n📋 רישום המשתתפים מתבצע ישירות דרך משרדנו\n\n*תשאירו פרטים ונציג יחזור אליכם בהקדם.* 😊\n\nמה *שמך המלא*?`
  );
}

// ── Eligibility questions ─────────────────────────────────────────────────────

async function handleEligQ1(phone, text, session) {
  session.data.familyMember = text.trim();
  session.state = 'ELIG_Q2';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `תודה. ומה *שנת הלידה המשוערת* שלו/שלה?\n\n(אם לא יודע בדיוק – שנה משוערת מספיקה)`
  );
}

async function handleEligQ2(phone, text, session) {
  const lower = text.toLowerCase();
  const dontKnow = ['לא יודע', 'לא יודעת', "לא יודע", 'אין לי מושג', 'מושג', 'no idea', "don't know", 'לא זוכר'];

  if (dontKnow.some(d => lower.includes(d))) {
    session.state = 'ELIG_NO_DOCS';
    storage.setConversation(phone, session);

    await wa.sendText(phone,
      `זה בסדר גמור – הרבה לקוחות לא יודעים את כל הפרטים. 👍\n\nברוב המקרים אפשר לאתר מסמכים *בארכיונים ברומניה* גם בלי מסמך אחד מהבית.\n\nאפשר לתת לי לפחות אחד מאלה?\n• *שם משפחה רומני* (גם אם משוער)\n• *שנת לידה* משוערת\n• *אזור/עיר* משוערים`
    );
    return;
  }

  session.data.birthYear = text.trim();
  session.state = 'ELIG_Q3';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `מצוין. ואם ידוע – *שם העיר או המחוז ברומניה* שבו נולד?\n\n(אם לא ידוע, אפשר לכתוב "לא ידוע" ונמשיך)`
  );
}

async function handleEligQ3(phone, text, session) {
  session.data.city = text.trim();
  session.state = 'ELIG_Q4';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `ובאיזו *שנה בערך עזב* את רומניה?\n\n(גם אם לא ידוע בדיוק)`
  );
}

async function handleEligQ4(phone, text, session) {
  session.data.leftYear = text.trim();
  await showEligPositive(phone, session);
}

async function handleEligNoDocs(phone, text, session) {
  // Save whatever partial info the user gives
  session.data.partialInfo = text.trim();
  await showEligPositive(phone, session);
}

function hasUnknownAnswers(data) {
  const unknownPhrases = ['לא ידוע', 'לא זוכר', 'לא יודע', 'לא יודעת', 'אין לי מושג'];
  const fieldsToCheck = [data.city, data.leftYear, data.birthYear];
  return data.partialInfo !== undefined ||
    fieldsToCheck.some(f => f && unknownPhrases.some(p => f.toLowerCase().includes(p)));
}

async function showEligPositive(phone, session) {
  session.state = 'LEAD_NAME';
  storage.setConversation(phone, session);

  const { familyMember, birthYear, city } = session.data;
  let summary = '';
  if (familyMember) summary += `• בן משפחה: *${familyMember}*\n`;
  if (birthYear)   summary += `• שנת לידה: *${birthYear}*\n`;
  if (city)        summary += `• מקום: *${city}*\n`;

  const uncertain = hasUnknownAnswers(session.data);

  const assessment = uncertain
    ? `לפי הנתונים שמסרת – *ייתכן שקיימת זכאות*, אך יש צורך בבדיקה מעמיקה יותר. 🟡`
    : `לפי הנתונים שמסרת – *יש סיכוי ממשי לזכאות*. 🟢`;

  await wa.sendText(phone,
    `תודה! ${assessment}\n\n${summary ? `_מה שמסרת:_\n${summary}\n` : ''}כדי לבדוק את זה בצורה מקצועית, *עו״ד מהמשרד צריך לעבור על המקרה שלך*.\n\nנשמח לחזור אליך לתיאום שיחת ייעוץ. כדי שנוכל לעשות את זה – *מה שמך המלא?*`
  );
}

// ── Lead collection ───────────────────────────────────────────────────────────

async function handleLeadName(phone, text, session) {
  if (text.trim().length < 2) {
    await wa.sendText(phone, 'אנא הזן שם מלא כדי שנוכל להמשיך. 😊');
    return;
  }
  session.data.name = text.trim();
  session.state = 'LEAD_PHONE';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `תודה *${session.data.name}*! 🙏\n\nומה *מספר הטלפון* שלך לחזרה?\n(נחזור אליך לתיאום שיחת הייעוץ)`
  );
}

async function handleLeadPhone(phone, text, session) {
  const cleaned = text.replace(/[\s\-()]/g, '');
  if (!/^[0-9+]{7,15}$/.test(cleaned)) {
    await wa.sendText(phone, 'אנא הזן מספר טלפון תקין (לדוגמה: 0501234567)');
    return;
  }

  session.data.clientPhone = cleaned;
  session.state = 'COMPLETE';
  storage.setConversation(phone, session);

  const { name, familyMember, birthYear, city, leftYear, partialInfo, eligibility, source } = session.data;
  const isCourse = source === 'romanian_course';

  // Save lead
  storage.saveLead({
    waPhone: phone,
    name,
    clientPhone: cleaned,
    source: source || 'passport',
    familyMember: familyMember || partialInfo,
    birthYear,
    city,
    leftYear,
    eligibility,
  });

  // Confirm to user
  if (isCourse) {
    await wa.sendText(phone,
      `🎉 *תודה, ${name}!*\n\nקיבלנו את הפרטים שלך לגבי *קורס הרומנית B1*.\n*נציג מהמשרד יחזור אליך בהקדם* עם כל הפרטים.\n\nתודה שפנית אלינו! 😊\n\n─────────────────\nרוצה מידע נוסף בנושא אחר? בחר מהאפשרויות:`
    );
  } else {
    await wa.sendText(phone,
      `🎉 *מצוין, ${name}!*\n\nקיבלנו את הפרטים שלך. *עו״ד מהמשרד יחזור אליך בהקדם* לתיאום שיחת הייעוץ.\n\nשיחת הייעוץ כוללת:\n📋 הערכת סיכוי ראשונית\n📋 הסבר על השלבים הרלוונטיים לך\n📋 טווחי זמן ועלויות ריאליים\n\n*ללא התחייבות* – פשוט מבינים יחד מה המצב. 😊\n\nתודה שפנית אלינו!\n\n─────────────────\nרוצה מידע נוסף בנושא אחר? בחר מהאפשרויות:`
    );
  }
  await new Promise(r => setTimeout(r, 500));
  await showInterestButtons(phone);

  // Alert the human agent(s) with full lead summary
  if (config.AGENT_PHONES.length) {
    const summary = isCourse
      ? [
          `🎓 *ליד חדש – קורס רומנית B1*`,
          ``,
          `👤 שם: ${name}`,
          `📞 טלפון: ${cleaned}`,
          `📱 וואטסאפ: ${phone}`,
        ].join('\n')
      : [
          `🔔 *ליד חדש – דרכון רומני*`,
          ``,
          `👤 שם: ${name}`,
          `📞 טלפון: ${cleaned}`,
          `📱 וואטסאפ: ${phone}`,
          familyMember ? `👴 בן משפחה: ${familyMember}` : '',
          birthYear   ? `📅 שנת לידה: ${birthYear}` : '',
          city        ? `📍 עיר/מחוז: ${city}` : '',
          leftYear    ? `🛫 עזב רומניה: ${leftYear}` : '',
          partialInfo ? `📝 מידע חלקי: ${partialInfo}` : '',
        ].filter(Boolean).join('\n');

    await notifyAgents(summary);
  }
}

// ── Handoff to human ──────────────────────────────────────────────────────────

async function handleHandoff(phone, session) {
  session.state = 'HANDOFF';
  storage.setConversation(phone, session);

  await wa.sendText(phone,
    `👤 *בוודאי.* מעביר את הפרטים שלך לנציג מהמשרד.\n\nנציג יחזור אליך *בהקדם האפשרי*.\nשעות פעילות: *א׳–ה׳, 09:00–18:00*`
  );

  if (config.AGENT_PHONES.length) {
    const { name, clientPhone } = session.data;
    await notifyAgents(
      `🆘 *לקוח מבקש נציג אנושי*\n\n👤 שם: ${name || 'לא נאסף עדיין'}\n📱 וואטסאפ: ${phone}${clientPhone ? `\n📞 טלפון: ${clientPhone}` : ''}\n\n👉 אנא צור קשר בהקדם.`
    );
  }
}

// ─── Main message router ──────────────────────────────────────────────────────

async function handleMessage(phone, message) {
  let session = storage.getConversation(phone);
  const msgType = message.type;

  // Extract text and button ID
  let text = '';
  let buttonId = '';

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
  }

  // ── Trigger phrase always starts fresh (even if session exists) ──────────
  if (isTriggerMessage(text)) {
    await handleStart(phone);
    return;
  }

  // ── Guard: no active session ─────────────────────────────────────────────
  if (!session) {
    console.log(`🔇 [${phone}] Ignored (no session, not a trigger): "${text}"`);
    return;
  }

  const state = session.state;
  console.log(`📩 [${phone}] State: ${state} | text: "${text}" | btn: "${buttonId}"`);

  // ── Global restart ────────────────────────────────────────────────────────
  const restartWords = ['תפריט', 'menu', 'התחל', 'start', 'restart', 'התחל מחדש'];
  if (restartWords.includes(text.toLowerCase())) {
    storage.deleteConversation(phone);
    await handleStart(phone);
    return;
  }

  // ── Back to main menu (keep session data, just re-show the 3 options) ─────
  const backToMenuPhrases = [
    'אפשרות נוספת', 'אפשרויות נוספות', 'אפשרויות אחרות',
    'חזור לתפריט', 'תפריט ראשי', 'חזרה לתפריט', 'רוצה עוד מידע',
    'more options', 'back to menu', 'other options', 'something else',
  ];
  // Also match bare "מידע נוסף" only when it's a short standalone message
  const isShortBackRequest = text.trim() === 'מידע נוסף' || text.trim() === 'עוד מידע';
  if (isShortBackRequest || backToMenuPhrases.some(p => text.toLowerCase().includes(p))) {
    session.state = 'WELCOME_SENT';
    storage.setConversation(phone, session);
    await wa.sendText(phone, 'בוודאי! במה נוסף אוכל לעזור? 😊');
    await new Promise(r => setTimeout(r, 300));
    await showInterestButtons(phone);
    return;
  }

  // ── Inline question detection (for free-text during any state) ───────────
  // Only intercept when the user sends free text (not button presses) and
  // the current state is not itself a text-collection state
  const textCollectionStates = ['ELIG_Q1', 'ELIG_Q2', 'ELIG_Q3', 'ELIG_Q4', 'ELIG_NO_DOCS', 'LEAD_NAME', 'LEAD_PHONE'];
  const isButtonPress = !!buttonId;

  if (!isButtonPress && textCollectionStates.includes(state)) {
    const inlineKey = detectInlineQuestion(text);

    if (inlineKey === 'human') {
      await handleHandoff(phone, session);
      return;
    }

    if (inlineKey) {
      await sendInlineAnswer(phone, inlineKey, session);
      await repromptCurrentState(phone, session);
      return;
    }
  }

  // ── State routing ─────────────────────────────────────────────────────────

  switch (state) {

    case 'WELCOME_SENT': {
      if (buttonId === 'interest_eligibility') {
        await handleInterestEligibility(phone, session);
      } else if (buttonId === 'interest_process') {
        await handleInterestProcess(phone, session);
      } else if (buttonId === 'interest_cost') {
        await handleInterestCost(phone, session);
      } else if (buttonId === 'interest_romanian_course') {
        await handleInterestRomanianCourse(phone, session);
      } else {
        // Free text at welcome – detect or re-show buttons
        const inlineKey = detectInlineQuestion(text);
        if (inlineKey === 'human') {
          await handleHandoff(phone, session);
        } else if (inlineKey) {
          await sendInlineAnswer(phone, inlineKey, session);
          await new Promise(r => setTimeout(r, 600));
          await showInterestButtons(phone);
        } else {
          await showInterestButtons(phone);
        }
      }
      break;
    }

    case 'ELIG_Q1':
      await handleEligQ1(phone, text || buttonId, session);
      break;

    case 'ELIG_Q2':
      await handleEligQ2(phone, text || buttonId, session);
      break;

    case 'ELIG_Q3':
      await handleEligQ3(phone, text || buttonId, session);
      break;

    case 'ELIG_Q4':
      await handleEligQ4(phone, text || buttonId, session);
      break;

    case 'ELIG_NO_DOCS':
      await handleEligNoDocs(phone, text || buttonId, session);
      break;

    case 'LEAD_NAME':
      await handleLeadName(phone, text, session);
      break;

    case 'LEAD_PHONE':
      await handleLeadPhone(phone, text, session);
      break;

    case 'COMPLETE':
      // Handle interest button presses after lead collection
      if (buttonId === 'interest_eligibility') {
        await handleInterestEligibility(phone, session);
      } else if (buttonId === 'interest_process') {
        await handleInterestProcess(phone, session);
      } else if (buttonId === 'interest_cost') {
        await handleInterestCost(phone, session);
      } else if (buttonId === 'interest_romanian_course') {
        await handleInterestRomanianCourse(phone, session);
      } else {
        // Free text after completion
        const inlineKey = detectInlineQuestion(text);
        if (inlineKey === 'human') {
          await handleHandoff(phone, session);
        } else if (inlineKey) {
          await sendInlineAnswer(phone, inlineKey, session);
          await new Promise(r => setTimeout(r, 400));
          await showInterestButtons(phone);
        } else {
          await wa.sendText(phone,
            `הפרטים שלך כבר אצלנו. 😊 נציג יחזור אליך בהקדם.\n\nרוצה מידע נוסף בנושא אחר?`
          );
          await new Promise(r => setTimeout(r, 400));
          await showInterestButtons(phone);
        }
      }
      break;

    case 'HANDOFF':
      await wa.sendText(phone,
        `⏳ הבקשה שלך כבר אצל הצוות. נציג יחזור אליך בהקדם.\n\nשעות פעילות: *א׳–ה׳, 09:00–18:00*`
      );
      break;

    default:
      await handleStart(phone);
  }
}

module.exports = { handleMessage };
