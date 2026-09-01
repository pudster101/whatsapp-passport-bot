/**
 * db.js — persistence backend.
 *
 * Two modes, chosen automatically:
 *   • DATABASE_URL set  → Postgres (survives redeploys). Recommended.
 *   • DATABASE_URL unset → local JSON file (development only; Railway wipes it).
 *
 * Everything is exposed as async. The layer above (storage.js) keeps an
 * in-memory cache so the rest of the app can stay synchronous.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let pool = null;
let usingPg = false;

// ─── File fallback ────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', '..', 'data');
const dataFile = path.join(dataDir, 'db.json');

const EMPTY = () => ({ conversations: {}, leads: [], events: [] });

function readFile() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dataFile)) return EMPTY();
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (err) {
    // A corrupted file must not take the bot down. Quarantine it and start
    // clean — this is the development fallback; production uses Postgres.
    console.error('⚠️  Local db.json is unreadable:', err.message);
    try {
      const backup = `${dataFile}.corrupt-${Date.now()}`;
      fs.renameSync(dataFile, backup);
      console.error(`   הקובץ הפגום נשמר בשם ${require('path').basename(backup)} והתחלנו קובץ חדש`);
    } catch { /* nothing more we can do */ }
    return EMPTY();
  }
}

// Serialise writes: concurrent processes writing the same file is what
// corrupts it. Within a process this keeps writes ordered.
let writing = false;
let pending = null;

function writeFile(data) {
  if (writing) { pending = data; return; }
  writing = true;
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${dataFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dataFile); // atomic replace
  } catch (err) {
    console.error('⚠️  Could not write local db.json:', err.message);
  } finally {
    writing = false;
    if (pending) { const next = pending; pending = null; writeFile(next); }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  if (!config.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL not set — using local JSON file.');
    console.warn('    On Railway this means ALL LEADS ARE LOST on every redeploy.');
    console.warn('    Add a Postgres service in Railway to fix this permanently.');
    return { usingPg: false };
  }

  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pool.query('SELECT 1');
    await migrate();
    usingPg = true;
    console.log('✅ Postgres connected — leads now survive redeploys');
    return { usingPg: true };
  } catch (err) {
    console.error('❌ Postgres unavailable, falling back to file storage:', err.message);
    pool = null;
    return { usingPg: false };
  }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone       TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id          BIGSERIAL PRIMARY KEY,
      wa_phone    TEXT NOT NULL,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id          BIGSERIAL PRIMARY KEY,
      wa_phone    TEXT,
      type        TEXT NOT NULL,
      data        JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads (wa_phone);
    CREATE INDEX IF NOT EXISTS idx_events_phone  ON events (wa_phone);
    CREATE INDEX IF NOT EXISTS idx_events_type   ON events (type);
    CREATE INDEX IF NOT EXISTS idx_events_time   ON events (created_at DESC);
  `);
}

// ─── Conversations ────────────────────────────────────────────────────────────

async function loadAllConversations() {
  if (usingPg) {
    const res = await pool.query('SELECT phone, data FROM conversations');
    const out = {};
    for (const row of res.rows) out[row.phone] = row.data;
    return out;
  }
  return readFile().conversations || {};
}

async function saveConversation(phone, data) {
  if (usingPg) {
    await pool.query(
      `INSERT INTO conversations (phone, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (phone) DO UPDATE SET data = $2, updated_at = NOW()`,
      [phone, data]
    );
    return;
  }
  const db = readFile();
  db.conversations = db.conversations || {};
  db.conversations[phone] = data;
  writeFile(db);
}

async function deleteConversation(phone) {
  if (usingPg) {
    await pool.query('DELETE FROM conversations WHERE phone = $1', [phone]);
    return;
  }
  const db = readFile();
  if (db.conversations) delete db.conversations[phone];
  writeFile(db);
}

// ─── Leads ────────────────────────────────────────────────────────────────────

async function insertLead(lead) {
  if (usingPg) {
    const res = await pool.query(
      'INSERT INTO leads (wa_phone, data) VALUES ($1, $2) RETURNING id, created_at',
      [lead.waPhone || null, lead]
    );
    return { ...lead, id: res.rows[0].id, createdAt: res.rows[0].created_at };
  }
  const db = readFile();
  db.leads = db.leads || [];
  db.leads.push(lead);
  writeFile(db);
  return lead;
}

async function loadLeads(limit = 500) {
  if (usingPg) {
    const res = await pool.query(
      'SELECT id, data, created_at FROM leads ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return res.rows.map(r => ({ ...r.data, id: r.id, createdAt: r.created_at }));
  }
  return (readFile().leads || []).slice(-limit).reverse();
}

// ─── Events ───────────────────────────────────────────────────────────────────

async function insertEvent(evt) {
  if (usingPg) {
    await pool.query(
      'INSERT INTO events (wa_phone, type, data) VALUES ($1, $2, $3)',
      [evt.waPhone || null, evt.type, evt.data || {}]
    );
    return;
  }
  const db = readFile();
  db.events = db.events || [];
  db.events.push({ ...evt, createdAt: new Date().toISOString() });
  if (db.events.length > 5000) db.events = db.events.slice(-5000);
  writeFile(db);
}

async function queryEvents({ since, type, phone, limit = 1000 } = {}) {
  if (usingPg) {
    const where = [];
    const params = [];
    if (since) { params.push(since); where.push(`created_at >= $${params.length}`); }
    if (type)  { params.push(type);  where.push(`type = $${params.length}`); }
    if (phone) { params.push(phone); where.push(`wa_phone = $${params.length}`); }
    params.push(limit);
    const sql = `SELECT wa_phone, type, data, created_at FROM events
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT $${params.length}`;
    const res = await pool.query(sql, params);
    return res.rows.map(r => ({ waPhone: r.wa_phone, type: r.type, data: r.data, createdAt: r.created_at }));
  }
  let events = readFile().events || [];
  if (since) events = events.filter(e => new Date(e.createdAt) >= new Date(since));
  if (type)  events = events.filter(e => e.type === type);
  if (phone) events = events.filter(e => e.waPhone === phone);
  return events.slice(-limit).reverse();
}

module.exports = {
  init,
  isPostgres: () => usingPg,
  loadAllConversations,
  saveConversation,
  deleteConversation,
  insertLead,
  loadLeads,
  insertEvent,
  queryEvents,
};
