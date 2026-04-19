/**
 * Simple JSON-based storage for conversation states and leads.
 * Data is persisted to ./data/db.json
 */
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(path.join(dataDir, 'db.json'));
const db = low(adapter);

// Default structure
db.defaults({
  conversations: {},  // keyed by phone number
  leads: [],          // collected leads
  appointments: [],   // booked appointments
}).write();

// ─── Conversation State ───────────────────────────────────────────────

function getConversation(phone) {
  return db.get(`conversations.${phone}`).value() || null;
}

function setConversation(phone, data) {
  db.set(`conversations.${phone}`, {
    ...data,
    updatedAt: new Date().toISOString(),
  }).write();
}

function deleteConversation(phone) {
  db.unset(`conversations.${phone}`).write();
}

// ─── Leads ───────────────────────────────────────────────────────────

function saveLead(leadData) {
  const lead = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    ...leadData,
  };
  db.get('leads').push(lead).write();
  return lead;
}

function getAllLeads() {
  return db.get('leads').value();
}

// ─── Appointments ─────────────────────────────────────────────────────

function saveAppointment(apptData) {
  const appt = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    ...apptData,
  };
  db.get('appointments').push(appt).write();
  return appt;
}

function getAllAppointments() {
  return db.get('appointments').value();
}

function getAppointmentsByDate(dateStr) {
  return db.get('appointments').filter({ date: dateStr }).value();
}

module.exports = {
  getConversation,
  setConversation,
  deleteConversation,
  saveLead,
  getAllLeads,
  saveAppointment,
  getAllAppointments,
  getAppointmentsByDate,
};
