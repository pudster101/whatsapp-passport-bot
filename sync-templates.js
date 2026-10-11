#!/usr/bin/env node
/**
 * sync-templates.js — bring Meta's template list in line with what the bot sends.
 *
 * Replaces create-templates.js and update-templates.js, which disagreed with
 * each other and with the code: between them they submitted two templates the
 * bot never calls and none of the three it needs most.
 *
 *   node sync-templates.js                 # report + submit anything missing
 *   node sync-templates.js --report        # report only, change nothing
 *   node sync-templates.js --fix-rejected  # resubmit everything Meta rejected
 *   node sync-templates.js --recreate NAME # delete one template and resubmit
 *
 * An APPROVED template is never touched. Approval usually takes minutes; a
 * template stays PENDING until Meta reviews it.
 *
 * After running, confirm in the browser:
 *   /admin/templates?token=...
 *   https://business.facebook.com/wa/manage/message-templates/
 */
require('dotenv').config();
const axios = require('axios');
const catalog = require('./src/templates');

const token = process.env.WHATSAPP_TOKEN;
const wabaId = process.env.WABA_ID || '912733271759794';
const BASE = `https://graph.facebook.com/v18.0/${wabaId}/message_templates`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const fixRejected = args.includes('--fix-rejected');
const recreate = args.includes('--recreate') ? args[args.indexOf('--recreate') + 1] : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listRemote() {
  const out = new Map();
  let url = `${BASE}?fields=id,name,status,category,language,rejected_reason&limit=100`;
  while (url) {
    const res = await axios.get(url, { headers, timeout: 20000 });
    for (const t of res.data?.data || []) out.set(t.name, t);
    url = res.data?.paging?.next || null;
  }
  return out;
}

async function submit(tpl) {
  try {
    // example.body_text is not optional. Without it Meta accepts the
    // submission, marks it PENDING, and then rejects it with INVALID_FORMAT —
    // which is what happened to every template on this account.
    const body = { type: 'BODY', text: tpl.text };
    if (tpl.params > 0) body.example = { body_text: [tpl.example] };

    const res = await axios.post(BASE, {
      name: tpl.name,
      category: tpl.category,
      language: tpl.language,
      components: [body],
    }, { headers, timeout: 20000 });
    console.log(`   ✅ submitted — id=${res.data.id} status=${res.data.status || 'PENDING'}`);
    return true;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`   ❌ rejected at submission: ${e?.message || err.message}`);
    if (e?.error_user_title) console.error(`      ${e.error_user_title}: ${e.error_user_msg}`);
    if (e?.error_data) console.error(`      ${JSON.stringify(e.error_data)}`);
    return false;
  }
}

/**
 * Rewrite a template in place.
 *
 * This is how a REJECTED template is fixed. The alternative — delete and
 * resubmit — needs whatsapp_business_management permission on the WABA, which
 * this token does not have (#100 "Need permission on either WhatsApp Business
 * Account"). Editing by template id needs no such permission and keeps the
 * name, so nothing in the code has to change.
 */
async function edit(tpl, id) {
  try {
    const body = { type: 'BODY', text: tpl.text };
    if (tpl.params > 0) body.example = { body_text: [tpl.example] };

    const res = await axios.post(`https://graph.facebook.com/v18.0/${id}`, {
      category: tpl.category,
      components: [body],
    }, { headers, timeout: 20000 });
    console.log(`   ✅ rewritten and resubmitted — ${res.data?.success ? 'accepted for review' : JSON.stringify(res.data)}`);
    return true;
  } catch (err) {
    const e = err.response?.data?.error;
    console.error(`   ❌ could not rewrite: ${e?.message || err.message}`);
    if (e?.error_user_msg) console.error(`      ${e.error_user_msg}`);
    return false;
  }
}

async function remove(name) {
  try {
    await axios.delete(`${BASE}?name=${encodeURIComponent(name)}`, { headers, timeout: 20000 });
    console.log(`   🗑  deleted "${name}"`);
    return true;
  } catch (err) {
    console.error(`   ❌ could not delete "${name}": ${err.response?.data?.error?.message || err.message}`);
    return false;
  }
}

(async () => {
  const problems = catalog.validate();
  if (problems.length) {
    console.error('\n❌ The catalog in src/templates.js is not valid — fix it before submitting:\n');
    problems.forEach(p => console.error(`   • ${p}`));
    process.exit(1);
  }

  if (!token) {
    console.error('\n❌ WHATSAPP_TOKEN is not set. Put it in .env, or run this on Railway.\n');
    process.exit(1);
  }

  let remote;
  try {
    remote = await listRemote();
  } catch (err) {
    console.error(`\n❌ Could not read the template list: ${err.response?.data?.error?.message || err.message}\n`);
    process.exit(1);
  }

  console.log('\n── What the bot sends, and where it stands with Meta ─────────\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`   ${pad('TEMPLATE', 24)} ${pad('STATUS', 12)} CRITICAL`);
  const missing = [];
  const rejected = [];

  for (const tpl of catalog.TEMPLATES) {
    const r = remote.get(tpl.name);
    const status = r ? r.status : 'NOT SUBMITTED';
    const critical = catalog.CRITICAL.includes(tpl.name) ? 'yes' : '';
    const icon = status === 'APPROVED' ? '✅' : status === 'PENDING' ? '⏳' : '❌';
    console.log(`${icon} ${pad(tpl.name, 24)} ${pad(status, 12)} ${critical}`);
    if (r?.rejected_reason && r.status === 'REJECTED') {
      console.log(`   ↳ Meta's reason: ${r.rejected_reason}`);
    }
    if (!r) missing.push(tpl);
    else if (r.status === 'REJECTED') rejected.push(tpl);
  }

  // Templates on the WABA that nothing in the code sends. Harmless, but they
  // are the reason the old scripts looked as if everything was in place.
  const orphans = [...remote.keys()].filter(n => !catalog.NAMES.includes(n));
  if (orphans.length) {
    console.log(`\n   ℹ️  On the account but never sent by the bot: ${orphans.join(', ')}`);
  }

  if (recreate) {
    const tpl = catalog.get(recreate);
    if (!tpl) {
      console.error(`\n❌ "${recreate}" is not in the catalog.\n`);
      process.exit(1);
    }
    const r = remote.get(recreate);
    if (r && r.status === 'APPROVED') {
      console.error(`\n❌ "${recreate}" is APPROVED. Refusing to delete a working template.\n`);
      process.exit(1);
    }
    console.log(`\n── Recreating "${recreate}" ──────────────────────────────────\n`);
    if (r) { await remove(recreate); await sleep(3000); }
    await submit(tpl);
    console.log('');
    return;
  }

  if (reportOnly) {
    console.log('\n(--report: nothing was submitted.)\n');
    if (rejected.length) {
      console.log(`To resubmit the ${rejected.length} rejected one(s): node sync-templates.js --fix-rejected\n`);
    }
    return;
  }

  // A REJECTED template will never send anything. Delete it and submit the
  // corrected body — this time with the sample values Meta requires.
  const toFix = fixRejected ? rejected : [];
  if (fixRejected && !rejected.length) {
    console.log('\nNothing is rejected. 👍\n');
  }
  if (toFix.length) {
    console.log(`\n── Rewriting ${toFix.length} rejected template(s) ─────────────────\n`);
    for (const tpl of toFix) {
      console.log(`▸ ${tpl.name}  (${tpl.params} parameter${tpl.params === 1 ? '' : 's'}) — ${tpl.sentBy}`);
      const id = remote.get(tpl.name)?.id;
      if (!id) { console.error('   ❌ no template id returned by Meta — skipped'); continue; }
      await edit(tpl, id);
      await sleep(1200);
    }
  }

  if (!missing.length) {
    if (toFix.length) {
      console.log('\nPENDING templates are usually reviewed within minutes.');
      console.log('Check again with: node sync-templates.js --report\n');
      return;
    }
    console.log('\nNothing to submit — every template the bot sends already exists.');
    if (rejected.length) {
      console.log(`\n⚠️  ${rejected.length} are REJECTED and will never send a thing:`);
      rejected.forEach(t => console.log(`   • ${t.name}`));
      console.log('\n   Resubmit them all with:  node sync-templates.js --fix-rejected');
    }
    console.log('');
    return;
  }

  console.log(`\n── Submitting ${missing.length} missing template(s) ──────────────────\n`);
  for (const tpl of missing) {
    console.log(`▸ ${tpl.name}  (${tpl.params} parameter${tpl.params === 1 ? '' : 's'}) — ${tpl.sentBy}`);
    await submit(tpl);
    await sleep(1200);
  }

  console.log('\nPENDING templates are usually reviewed within minutes.');
  console.log('The bot picks up newly approved templates on its next restart.\n');
})();
