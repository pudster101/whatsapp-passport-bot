/**
 * verify-ai.js — proves whether the AI is actually writing the replies.
 *
 * Runs the SAME questions through the SAME pipeline twice:
 *   once with AI_MODE=off   → the scripted answer
 *   once with AI_MODE=live  → the AI answer
 * and prints them side by side, with token counts.
 *
 * If the two columns are identical, the AI is not running.
 * If the right column is different, freshly worded, and reports tokens —
 * it is running. Tokens cannot be faked: they come back from the API.
 *
 * Cost: a few agorot.
 *
 * Run:  npm run verify
 */
require('dotenv').config();
const Module = require('module');

// ─── Mock WhatsApp before anything loads it ─────────────────────────────────
const sent = [];
const waMock = {
  sendText: async (to, text) => { sent.push(text); return true; },
  sendButtons: async () => true,
  sendList: async () => true,
  sendImage: async () => true,
  sendTemplate: async () => false,
  markRead: async () => {},
  loadApprovedTemplates: async () => new Set(),
  approvedTemplates: () => new Set(),
  splitMessage: (t) => [t],
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === './whatsapp' || request === '../whatsapp') return waMock;
  return originalLoad.apply(this, arguments);
};

const config = require('../src/config');
const storage = require('../src/storage');
const brain = require('../src/ai/brain');
const flows = require('../src/flows');

// Questions chosen so a scripted answer and a composed answer must differ:
// each one depends on something the customer said earlier.
const SCRIPT = [
  'שלום! אפשר לקבל מידע נוסף על זה?',
  'סבתא שלי נולדה בצ׳רנוביץ ועלתה לארץ ב-1951',
  'כמה זמן זה ייקח לי?',
  'ומה עם הילדים שלי?',
  'זה נשמע יקר',
];

const C = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  grey: (s) => `\x1b[90m${s}\x1b[0m`,
  green:(s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red:  (s) => `\x1b[31m${s}\x1b[0m`,
};

async function runConversation(mode, tag) {
  config.AI_MODE = mode;
  const phone = `99${tag}${Date.now().toString().slice(-7)}`;
  const replies = [];
  const meta = [];

  for (const text of SCRIPT) {
    sent.length = 0;
    brain.clearLastCompose();
    await flows.handleMessage(phone, {
      type: 'text',
      id: `v${Math.random()}`,
      text: { body: text },
    });
    replies.push(sent.join('\n'));
    meta.push(brain.getLastCompose());
  }

  storage.deleteConversation(phone);
  return { replies, meta };
}

function wrap(text, width) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (line.length <= width) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      if ((cur + ' ' + word).trim().length > width) { out.push(cur.trim()); cur = word; }
      else cur = (cur + ' ' + word).trim();
    }
    if (cur) out.push(cur);
  }
  return out;
}

(async () => {
  console.log('\n' + C.bold('═══ בדיקה: האם ה-AI באמת כותב את התשובות? ═══') + '\n');

  if (!config.ANTHROPIC_API_KEY) {
    console.log(C.red('  ✗ אין ANTHROPIC_API_KEY בקובץ .env'));
    console.log('    בלי מפתח אין מה להשוות — כל התשובות יהיו מהתסריט.');
    console.log('    ראה START-HERE.md לקבלת מפתח.\n');
    process.exit(1);
  }

  await storage.init();
  const ready = brain.init();
  if (!ready) {
    console.log(C.red('  ✗ אתחול מנוע ה-AI נכשל'));
    process.exit(1);
  }

  console.log(C.grey('  מריץ את אותה שיחה פעמיים...\n'));

  const scripted = await runConversation('off', '1');
  const live     = await runConversation('live', '2');

  let identical = 0, aiTurns = 0, tokIn = 0, tokOut = 0;

  for (let i = 0; i < SCRIPT.length; i++) {
    console.log(C.bold(`\n👤 ${SCRIPT[i]}`));
    console.log('─'.repeat(74));

    const a = wrap(scripted.replies[i], 34);
    const b = wrap(live.replies[i], 34);
    const rows = Math.max(a.length, b.length);

    console.log(C.grey('  תסריט'.padEnd(38)) + C.green('  AI'));
    for (let r = 0; r < rows; r++) {
      const left = (a[r] || '').padEnd(36);
      console.log('  ' + C.grey(left) + '  ' + (b[r] || ''));
    }

    const m = live.meta[i];
    if (m && m.usedAI) {
      aiTurns++;
      tokIn += m.inputTokens; tokOut += m.outputTokens;
      console.log(C.dim(`  └─ ${m.model} · ${(m.ms / 1000).toFixed(1)}s · ${m.inputTokens}/${m.outputTokens} tokens`));
    } else {
      console.log(C.dim('  └─ תור זה נענה מהתסריט (תפריט / בקשת נציג / ביטחון נמוך)'));
    }

    if (scripted.replies[i].trim() === live.replies[i].trim()) identical++;
  }

  // ─── Verdict ──────────────────────────────────────────────────────────────
  const usd = (tokIn / 1e6) * 3 + (tokOut / 1e6) * 15;
  console.log('\n' + '═'.repeat(74));
  console.log(C.bold('  תוצאה'));
  console.log(`  תשובות שנכתבו ע״י AI: ${aiTurns} מתוך ${SCRIPT.length}`);
  console.log(`  תשובות זהות בין שני המצבים: ${identical}`);
  console.log(`  טוקנים: ${tokIn} נכנסים / ${tokOut} יוצאים  ≈ ${(usd * 3.7).toFixed(3)} ₪`);
  console.log();

  if (aiTurns === 0) {
    console.log(C.red('  ✗ ה-AI לא כתב אף תשובה.'));
    console.log('    בדוק ש-AI_MODE=live בקובץ .env, והרץ npm run check.');
  } else if (identical === SCRIPT.length) {
    console.log(C.red('  ✗ התשובות זהות — משהו לא תקין.'));
  } else {
    console.log(C.green('  ✓ ה-AI עובד.'));
    console.log('    הטוקנים חוזרים מהשרת של Anthropic — אי אפשר לזייף אותם,');
    console.log('    והתשובות בטור הימני נוסחו מחדש ולא הועתקו מהמאגר.');
  }
  console.log('═'.repeat(74) + '\n');

  await storage.flush();
  process.exit(0);
})().catch(err => {
  console.error('\n❌ הבדיקה נכשלה:', err.message);
  process.exit(1);
});
