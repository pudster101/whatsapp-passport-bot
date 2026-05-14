require('dotenv').config();

module.exports = {
  // WhatsApp Business API
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'my_verify_token_123',

  // Server
  PORT: process.env.PORT || 3000,

  // Agent phones — supports comma-separated list for multiple recipients
  // e.g. AGENT_PHONE=972547787804,972501234567
  AGENT_PHONE: process.env.AGENT_PHONE,
  AGENT_PHONES: process.env.AGENT_PHONE
    ? process.env.AGENT_PHONE.split(',').map(p => p.trim()).filter(Boolean)
    : [],

  // Public URL of this Railway deployment (for media links)
  PUBLIC_URL: process.env.PUBLIC_URL || 'https://whatsapp-passport-bot-production.up.railway.app',

  // Email notifications (Gmail SMTP)
  GMAIL_USER: process.env.GMAIL_USER || '',
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || process.env.GMAIL_USER || '',

  // Business info
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'שירות דרכון רומני',

  // Available meeting slots (day of week: 0=Sun...6=Sat, hours in HH:MM format)
  MEETING_DAYS: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'],
  MEETING_HOURS: ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'],
};
