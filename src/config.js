require('dotenv').config();

module.exports = {
  // WhatsApp Business API
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'my_verify_token_123',

  // Server
  PORT: process.env.PORT || 3000,

  // Human agent phone (your number - gets notified when handoff is needed)
  AGENT_PHONE: process.env.AGENT_PHONE,

  // Business info
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'שירות דרכון רומני',

  // Available meeting slots (day of week: 0=Sun...6=Sat, hours in HH:MM format)
  MEETING_DAYS: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'],
  MEETING_HOURS: ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'],
};
