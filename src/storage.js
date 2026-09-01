/**
 * storage.js — synchronous facade over an async persistence backend.
 *
 * Design: the whole conversation set is small (a law firm, not a marketplace),
 * so we hold it in memory and write behind asynchronously. This keeps the
 * existing synchronous call sites in flows.js working unchanged while the
 * data actually lives in Postgres.
 *
 * Call `await storage.init()` once at boot before serving traffic.
 */
const db = require('./storage/db');
const config = require('./config');

let conversations = {};   // phone → session
let ready = false;
const pendingWrites = new Set();

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  await db.init();
  try {
    conversations = await db.loadAllConversations();
    const count = Object.keys(conversations).length;
    console.log(`✅ Storage ready — ${count} conversation${count === 1 ? '' : 's'} restored`);
  } catch (err) {
    console.error('❌ Failed to load conversations:', err.message);
    conversations = {};
  }
  ready = true;
  pruneExpiredSessions();
  return { postgres: db.isPostgres() };
}

/** Fire-and-forget persistence that never crashes the request path. */
function persist(fn, label) {
  const p = fn().catch(err => console.error(`⚠️  Persist failed (${label}):`, err.message));
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p));
  return p;
}

/** Wait for in-flight writes — used before shutdown. */
async function flush() {
  await Promise.allSettled([...pendingWrites]);
}

// ─── Conversation state ───────────────────────────────────────────────────────

function getConversation(phone) {
  const session = conversations[phone];
  if (!session) return null;

  // Expire stale sessions so a customer who vanished months ago is greeted
  // properly instead of being resumed mid-interview.
  const updated = new Date(session.updatedAt || session.startedAt || 0).getTime();
  const ageDays = (Date.now() - updated) / 86400000;
  if (ageDays > config.SESSION_TTL_DAYS) {
    console.log(`🕐 [${phone}] Session expired after ${Math.round(ageDays)}d — starting fresh`);
    deleteConversation(phone);
    return null;
  }
  return session;
}

function setConversation(phone, data) {
  const record = { ...data, updatedAt: new Date().toISOString() };
  conversations[phone] = record;
  persist(() => db.saveConversation(phone, record), `conversation ${phone}`);
  return record;
}

function deleteConversation(phone) {
  delete conversations[phone];
  persist(() => db.deleteConversation(phone), `delete conversation ${phone}`);
}

function getAllConversations() {
  return conversations;
}

function pruneExpiredSessions() {
  const now = Date.now();
  let pruned = 0;
  for (const [phone, s] of Object.entries(conversations)) {
    const updated = new Date(s.updatedAt || s.startedAt || 0).getTime();
    if ((now - updated) / 86400000 > config.SESSION_TTL_DAYS) {
      deleteConversation(phone);
      pruned++;
    }
  }
  if (pruned) console.log(`🧹 Pruned ${pruned} expired session(s)`);
}

// ─── Leads ────────────────────────────────────────────────────────────────────

function saveLead(leadData) {
  const lead = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    ...leadData,
  };
  persist(() => db.insertLead(lead), `lead ${lead.waPhone}`);
  return lead;
}

async function getAllLeads(limit = 500) {
  return db.loadLeads(limit);
}

// ─── Events (analytics) ───────────────────────────────────────────────────────

function logEvent(waPhone, type, data = {}) {
  persist(() => db.insertEvent({ waPhone, type, data }), `event ${type}`);
}

async function getEvents(opts) {
  return db.queryEvents(opts);
}

// ─── Appointments (kept for backwards compatibility) ──────────────────────────

const appointments = [];
function saveAppointment(apptData) {
  const appt = { id: Date.now(), createdAt: new Date().toISOString(), ...apptData };
  appointments.push(appt);
  logEvent(apptData.waPhone, 'appointment_saved', appt);
  return appt;
}
function getAllAppointments() { return appointments; }
function getAppointmentsByDate(dateStr) { return appointments.filter(a => a.date === dateStr); }

module.exports = {
  init,
  flush,
  isReady: () => ready,
  isPostgres: () => db.isPostgres(),

  getConversation,
  setConversation,
  deleteConversation,
  getAllConversations,

  saveLead,
  getAllLeads,

  logEvent,
  getEvents,

  saveAppointment,
  getAllAppointments,
  getAppointmentsByDate,
};
