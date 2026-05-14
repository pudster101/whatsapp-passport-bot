/**
 * update-templates.js
 * Lists all templates, updates rejected ones with clean content,
 * and creates any missing templates under new names.
 * Run: node update-templates.js
 */
const axios = require('axios');
require('dotenv').config();

const token = process.env.WHATSAPP_TOKEN;
const wabaId = '912733271759794';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// Clean, emoji-free template content keyed by template name
const CLEAN_CONTENT = {
  pudim_bot_startup:   'הבוט פעיל ועובד.\nשעה: {{1}}\nתתקבלנה התראות על שיחות ולידים.',
  pudim_chat_start:    'שיחה חדשה החלה.\nמספר: {{1}}\nשעה: {{2}}\nאם לא תגיע הודעת ליד - הלקוח לא השלים את התהליך.',
  pudim_handoff:       'לקוח מבקש נציג אנושי.\nשם: {{1}}\nמספר וואטסאפ: {{2}}\nטלפון: {{3}}\nאנא צור קשר בהקדם.',
  pudim_daily_status:  'סיכום יומי.\nהבוט פועל.\nפניות בסך הכל: {{1}}\nפניות ביממה האחרונה: {{2}}\nהמערכת פעילה.',
};

// Lead templates with new names — neutral wording, no brand names
// NOTE: variables cannot be first or last — must end with static text
const NEW_TEMPLATES = [
  {
    name: 'passport_lead_new',
    category: 'UTILITY',
    language: 'he',
    text: 'פנייה חדשה - דרכון.\nשם: {{1}}\nטלפון: {{2}}\nמספר נוסף: {{3}}\nבן משפחה: {{4}}\nשנת לידה: {{5}}\nעיר: {{6}}\nנא לחזור בהקדם.',
  },
  {
    name: 'b1_lead_new',
    category: 'UTILITY',
    language: 'he',
    text: 'פנייה חדשה - קורס רומנית.\nשם: {{1}}\nטלפון: {{2}}\nמספר נוסף: {{3}}\nנא לחזור בהקדם.',
  },
];

async function listAllTemplates() {
  const res = await axios.get(
    `https://graph.facebook.com/v18.0/${wabaId}/message_templates?fields=name,id,status,category&limit=100`,
    { headers }
  );
  return res.data.data || [];
}

async function updateTemplate(id, name, text) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${id}`,
      { components: [{ type: 'BODY', text }] },
      { headers }
    );
    console.log(`✅ Updated "${name}" (${id}) → ${JSON.stringify(res.data)}`);
    return true;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`❌ Update "${name}" failed: ${e?.message || err.message}`);
    if (e?.error_data) console.error('   Details:', JSON.stringify(e.error_data));
    if (e?.error_user_msg) console.error('   User msg:', e.error_user_msg);
    return false;
  }
}

async function createTemplate(tpl) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates`,
      {
        name: tpl.name,
        category: tpl.category,
        language: tpl.language,
        components: [{ type: 'BODY', text: tpl.text }],
      },
      { headers }
    );
    console.log(`✅ Created "${tpl.name}" | id=${res.data.id} | status=${res.data.status}`);
    return true;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`❌ Create "${tpl.name}" failed: ${e?.message || err.message}`);
    if (e?.error_data) console.error('   Details:', JSON.stringify(e.error_data));
    if (e?.error_user_msg) console.error('   User msg:', e.error_user_msg);
    console.error('   Full error:', JSON.stringify(err.response?.data));
    return false;
  }
}

(async () => {
  console.log('\n── Listing ALL current templates ────────────────────────────\n');
  let templates;
  try {
    templates = await listAllTemplates();
  } catch (err) {
    console.error('Failed to list templates:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  }

  templates.forEach(t => console.log(`  ${t.status.padEnd(10)} [${(t.category||'').padEnd(10)}] ${t.name} (id=${t.id})`));

  console.log('\n── Updating pudim_ templates (skip if APPROVED) ─────────────\n');
  const pudim = templates.filter(t => t.name.startsWith('pudim_'));
  for (const t of pudim) {
    const newText = CLEAN_CONTENT[t.name];
    if (!newText) {
      console.log(`⏭  Skipping "${t.name}" — no content defined`);
      continue;
    }
    if (t.status === 'APPROVED') {
      console.log(`✅ "${t.name}" already APPROVED — skipping`);
      continue;
    }
    await updateTemplate(t.id, t.name, newText);
  }

  console.log('\n── Creating missing lead templates ──────────────────────────\n');
  for (const tpl of NEW_TEMPLATES) {
    const exists = templates.find(t => t.name === tpl.name);
    if (exists) {
      console.log(`⏭  "${tpl.name}" already exists (${exists.status}) — skipping`);
    } else {
      await createTemplate(tpl);
    }
  }

  console.log('\nDone. Check status at:');
  console.log('https://business.facebook.com/wa/manage/message-templates/\n');
})();
