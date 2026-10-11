/**
 * DEPRECATED — use sync-templates.js instead.
 *
 * It DELETED every pudim_ template and resubmitted names the bot never calls (pudim_lead_passport, pudim_lead_b1), while the three alerts that matter most - pudim_meeting_request, pudim_waiting_list, pudim_meetings_digest - were never submitted at all.
 *
 * The authoritative list of templates now lives in src/templates.js, which is
 * checked against the code by the test suite. Run:
 *     node sync-templates.js --report   # look
 *     node sync-templates.js            # submit anything missing
 */
console.error("\n\u274C This script is deprecated and would put the templates out of step with the code.");
console.error("   Use:  node sync-templates.js --report\n");
process.exit(1);

/**
 * create-templates.js
 * Deletes existing pudim_ templates and resubmits clean versions for approval.
 * Run: node create-templates.js
 */
const axios = require('axios');
require('dotenv').config();

const token = process.env.WHATSAPP_TOKEN;
const wabaId = '912733271759794';
const BASE = `https://graph.facebook.com/v18.0/${wabaId}/message_templates`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// Clean templates — no emojis, no special chars, plain Hebrew
const TEMPLATES = [
  {
    name: 'pudim_bot_startup',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'הבוט פעיל ועובד.\n\nשעה: {{1}}\n\nתתקבלנה התראות על שיחות חדשות ולידים.',
    }],
  },
  {
    name: 'pudim_chat_start',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'שיחה חדשה החלה.\n\nמספר: {{1}}\nשעה: {{2}}\n\nאם לא תגיע הודעת ליד - הלקוח לא השלים את התהליך.',
    }],
  },
  {
    name: 'pudim_lead_passport',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'ליד חדש - דרכון רומני.\n\nשם: {{1}}\nטלפון: {{2}}\nוואטסאפ: {{3}}\nבן משפחה: {{4}}\nשנת לידה: {{5}}\nעיר: {{6}}',
    }],
  },
  {
    name: 'pudim_lead_b1',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'ליד חדש - קורס רומנית B1.\n\nשם: {{1}}\nטלפון: {{2}}\nוואטסאפ: {{3}}',
    }],
  },
  {
    name: 'pudim_handoff',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'לקוח מבקש נציג אנושי.\n\nשם: {{1}}\nוואטסאפ: {{2}}\nטלפון: {{3}}\n\nאנא צור קשר בהקדם.',
    }],
  },
  {
    name: 'pudim_daily_status',
    category: 'UTILITY',
    language: 'he',
    components: [{
      type: 'BODY',
      text: 'דוח יומי - הבוט פעיל.\n\nסך לידים: {{1}}\nלידים אתמול: {{2}}',
    }],
  },
];

async function deleteTemplateByName(name) {
  try {
    await axios.delete(`${BASE}?name=${name}`, { headers });
    console.log(`🗑  Deleted "${name}"`);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    if (msg.includes('does not exist') || msg.includes('not found')) {
      console.log(`   "${name}" not found — skip delete`);
    } else {
      console.log(`   Could not delete "${name}": ${msg}`);
    }
  }
}

async function createTemplate(tpl) {
  try {
    const res = await axios.post(BASE, {
      name: tpl.name,
      category: tpl.category,
      language: tpl.language,
      components: tpl.components,
    }, { headers });
    console.log(`✅ "${tpl.name}" submitted | id=${res.data.id} | status=${res.data.status}`);
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`❌ "${tpl.name}" failed: ${e?.message || err.message}`);
    if (e?.error_data) console.error('   Details:', JSON.stringify(e.error_data));
  }
}

(async () => {
  console.log('\n── Step 1: Deleting existing templates ─────────────────────\n');
  for (const tpl of TEMPLATES) {
    await deleteTemplateByName(tpl.name);
  }

  console.log('\n── Step 2: Waiting 3 seconds ────────────────────────────────\n');
  await new Promise(r => setTimeout(r, 3000));

  console.log('── Step 3: Submitting clean templates ───────────────────────\n');
  for (const tpl of TEMPLATES) {
    await createTemplate(tpl);
  }

  console.log('\nDone. PENDING templates will be reviewed by Meta (usually minutes to hours).');
  console.log('Check: https://business.facebook.com/wa/manage/message-templates/\n');
})();
