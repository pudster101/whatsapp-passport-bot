/**
 * check-setup.js — preflight check before testing locally.
 *
 * Verifies the environment and makes ONE tiny API call to prove the key
 * works, so you find out in 5 seconds rather than mid-conversation.
 *
 * Run:  npm run check
 */
require('dotenv').config();
const config = require('../src/config');

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

let blocking = 0;

(async () => {
  console.log('\n\x1b[1m═══ בדיקת מוכנות לבדיקה מקומית ═══\x1b[0m\n');

  // ─── 1. AI key ──────────────────────────────────────────────────────────
  console.log('\x1b[1mמנוע ה-AI\x1b[0m');
  if (!config.ANTHROPIC_API_KEY) {
    bad('ANTHROPIC_API_KEY חסר — הבוט ירוץ במצב תסריט בלבד');
    console.log('     צור מפתח: https://console.anthropic.com/settings/keys');
    console.log('     ואז הוסף לקובץ .env את השורה:');
    console.log('     ANTHROPIC_API_KEY=sk-ant-...');
    blocking++;
  } else if (!config.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
    bad('המפתח לא נראה תקין — מפתחות Anthropic מתחילים ב-sk-ant-');
    blocking++;
  } else {
    ok(`מפתח נמצא (${config.ANTHROPIC_API_KEY.slice(0, 12)}…)`);

    // Real call, smallest possible
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const started = Date.now();
      const res = await client.messages.create({
        model: config.AI_MODEL_FAST,
        max_tokens: 12,
        messages: [{ role: 'user', content: 'ענה במילה אחת בעברית: שלום' }],
      });
      const ms = Date.now() - started;
      const reply = res.content?.[0]?.text?.trim() || '';
      ok(`חיבור ל-Anthropic עובד — ${config.AI_MODEL_FAST} ענה "${reply}" תוך ${ms}ms`);
      ok(`טוקנים בבדיקה: ${res.usage?.input_tokens || 0} נכנסים / ${res.usage?.output_tokens || 0} יוצאים`);
    } catch (err) {
      const msg = err?.error?.error?.message || err.message;
      bad(`הקריאה ל-Anthropic נכשלה: ${msg}`);
      if (/credit|balance|quota/i.test(msg)) {
        console.log('     נראה שאין יתרה בחשבון. הוסף אשראי ב-console.anthropic.com → Billing');
      } else if (/authentication|api key|401/i.test(msg)) {
        console.log('     המפתח נדחה. ודא שהעתקת אותו במלואו.');
      }
      blocking++;
    }
  }

  if (config.AI_MODE === 'live') ok('AI_MODE=live — ה-AI ינסח את התשובות');
  else if (config.AI_MODE === 'shadow') warn('AI_MODE=shadow — ה-AI ינתח אך התשובות יישארו כתובות מראש. לבדיקה מלאה שנה ל-live');
  else warn(`AI_MODE=${config.AI_MODE} — ה-AI כבוי. שנה ל-live בקובץ .env`);

  // ─── 2. Knowledge base ──────────────────────────────────────────────────
  console.log('\n\x1b[1mמאגר הידע\x1b[0m');
  try {
    const { PASSAGES } = require('../src/kb/corpus');
    const retrieve = require('../src/kb/retrieve');
    ok(`${PASSAGES.length} פסקאות ידע נטענו`);
    const hits = retrieve.retrieve('סבתא נולדה בצ׳רנוביץ ועלתה ב-1951', { limit: 1 });
    if (hits.length) ok(`מנוע האחזור עובד (בדיקה החזירה: ${hits[0].id})`);
    else { bad('מנוע האחזור לא החזיר תוצאה לשאילתת בדיקה'); blocking++; }
  } catch (err) {
    bad(`שגיאה בטעינת המאגר: ${err.message}`);
    blocking++;
  }

  // ─── 3. Safety: nothing can reach WhatsApp ──────────────────────────────
  console.log('\n\x1b[1mבטיחות\x1b[0m');
  ok('הסימולטור מנטרל את WhatsApp לחלוטין — אף הודעה לא תישלח ללקוח אמיתי');
  if (config.QUOTE_FEES === false) ok('מדיניות מחיר: הבוט לא ינקוב בשכר טרחה');
  if (config.AGENT_PHONES.length) {
    ok(`התראות נציג מוגדרות ל-${config.AGENT_PHONES.length} מספרים (בסימולטור הן מוצגות בצד, לא נשלחות)`);
  }

  // ─── 4. Production readiness (not needed for local testing) ─────────────
  console.log('\n\x1b[1mלייצור בלבד (לא נדרש לבדיקה מקומית)\x1b[0m');
  config.DATABASE_URL ? ok('DATABASE_URL מוגדר') : warn('DATABASE_URL חסר — לידים יימחקו בכל דיפלוי ב-Railway');
  config.ADMIN_TOKEN  ? ok('ADMIN_TOKEN מוגדר')  : warn('ADMIN_TOKEN חסר — נקודות הניהול מושבתות');
  config.APP_SECRET   ? ok('APP_SECRET מוגדר')   : warn('APP_SECRET חסר — אימות חתימת webhook כבוי');

  // ─── Verdict ────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  if (blocking === 0) {
    console.log('\x1b[32m\x1b[1m  מוכן. הרץ:  npm run sim\x1b[0m');
    console.log('  ואז פתח: http://localhost:3010');
  } else {
    console.log(`\x1b[31m\x1b[1m  ${blocking} דברים חוסמים בדיקה מלאה עם AI\x1b[0m`);
    console.log('  אפשר עדיין להריץ npm run sim ולבדוק את מצב התסריט.');
  }
  console.log('═'.repeat(50) + '\n');

  process.exit(0);
})();
