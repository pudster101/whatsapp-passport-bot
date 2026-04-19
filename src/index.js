require('dotenv').config();
const express = require('express');
const config = require('./config');
const { handleMessage } = require('./flows');
const { markRead } = require('./whatsapp');
const storage = require('./storage');

const app = express();
app.use(express.json());

// ─── Webhook Verification (GET) ──────────────────────────────────────────────
// Meta sends this once when you register the webhook in the dashboard
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ─── Incoming Messages (POST) ────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          const phone = message.from;
          const msgId = message.id;

          console.log(`\n📨 New message from ${phone} [${message.type}]`);

          // Mark as read
          await markRead(msgId);

          // Route through the conversation flow
          await handleMessage(phone, message);
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
});

// ─── Admin endpoints ─────────────────────────────────────────────────────────

// View all leads (protect in production!)
app.get('/admin/leads', (req, res) => {
  res.json(storage.getAllLeads());
});

// View all active conversation sessions
app.get('/admin/sessions', (req, res) => {
  // Read raw db to expose conversations
  const db = require('./storage');
  res.json({
    appointments: db.getAllAppointments(),
    leads: db.getAllLeads(),
  });
});

// View all appointments
app.get('/admin/appointments', (req, res) => {
  res.json(storage.getAllAppointments());
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  console.log(`\n🤖 WhatsApp Passport Bot running on port ${config.PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${config.PORT}/webhook`);
  console.log(`📊 Admin: http://localhost:${config.PORT}/admin/leads\n`);
});
