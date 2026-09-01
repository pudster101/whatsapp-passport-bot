require('dotenv').config();

module.exports = {
  // ─── WhatsApp Business API ──────────────────────────────────────────────
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WABA_ID: process.env.WABA_ID || '912733271759794',
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'my_verify_token_123',

  // Meta App Secret — enables webhook HMAC signature verification.
  // Find it at developers.facebook.com → your app → Settings → Basic → App Secret
  APP_SECRET: process.env.APP_SECRET || '',

  // ─── Server ─────────────────────────────────────────────────────────────
  PORT: process.env.PORT || 3000,
  PUBLIC_URL: process.env.PUBLIC_URL || 'https://whatsapp-passport-bot-production.up.railway.app',

  // ─── Persistence ────────────────────────────────────────────────────────
  // Railway Postgres provides DATABASE_URL automatically once the service is added.
  // Without it the bot falls back to a local JSON file (data is lost on redeploy).
  DATABASE_URL: process.env.DATABASE_URL || '',

  // ─── Admin API ──────────────────────────────────────────────────────────
  // Admin endpoints are DISABLED unless this token is set. Call them with
  // header:  Authorization: Bearer <ADMIN_TOKEN>   or  ?token=<ADMIN_TOKEN>
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',

  // ─── AI sales brain ─────────────────────────────────────────────────────
  // Without a key the bot runs in scripted mode exactly as before.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  AI_MODEL_FAST: process.env.AI_MODEL_FAST || 'claude-haiku-4-5-20251001',
  AI_MODEL_SMART: process.env.AI_MODEL_SMART || 'claude-sonnet-5',
  // 'off'    – no AI at all (scripted bot)
  // 'shadow' – AI analyses every message and logs its judgement, but replies stay scripted
  // 'live'   – AI composes replies for free-text turns (menus stay deterministic)
  AI_MODE: process.env.AI_MODE || 'shadow',
  // 'auto'   – the extra analysis call runs only when it adds something
  //            (opening messages, low confidence, objections). Fastest.
  // 'always' – analyse every message. Slightly better reads, ~2x latency.
  // 'off'    – rule-based understanding only.
  AI_ANALYSIS_MODE: process.env.AI_ANALYSIS_MODE || 'auto',
  // Buying-intent score at or above which a human is alerted as a hot lead
  HOT_LEAD_THRESHOLD: parseInt(process.env.HOT_LEAD_THRESHOLD || '70', 10),

  // ─── Agent phones ───────────────────────────────────────────────────────
  // Comma-separated list, e.g. AGENT_PHONE=972547787804,972542689322
  AGENT_PHONE: process.env.AGENT_PHONE,
  AGENT_PHONES: process.env.AGENT_PHONE
    ? process.env.AGENT_PHONE.split(',').map(p => p.trim()).filter(Boolean)
    : [],

  // ─── Follow-up engine ───────────────────────────────────────────────────
  FOLLOWUP_ENABLED: process.env.FOLLOWUP_ENABLED !== 'false',
  FOLLOWUP_MAX: parseInt(process.env.FOLLOWUP_MAX || '3', 10),
  BUSINESS_HOURS: { start: 9, end: 18, days: [0, 1, 2, 3, 4] }, // Sun–Thu, Israel time
  TIMEZONE: 'Asia/Jerusalem',

  // ─── Business policy ────────────────────────────────────────────────────
  // The bot must NEVER state a fee. It explains cost drivers and routes to consultation.
  QUOTE_FEES: false,
  SESSION_TTL_DAYS: parseInt(process.env.SESSION_TTL_DAYS || '30', 10),

  // ─── Limits ─────────────────────────────────────────────────────────────
  // A conversation this long is no longer a conversation — hand it to a human.
  MAX_MESSAGES_PER_CONVERSATION: parseInt(process.env.MAX_MESSAGES_PER_CONVERSATION || '60', 10),
  // Burst protection per phone number (messages / minutes)
  RATE_LIMIT_MESSAGES: parseInt(process.env.RATE_LIMIT_MESSAGES || '15', 10),
  RATE_LIMIT_WINDOW_MIN: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '5', 10),
  // Hard ceiling on AI calls per day. On reaching it the bot keeps working,
  // but in scripted mode — customers are never left without an answer.
  DAILY_AI_CALL_BUDGET: parseInt(process.env.DAILY_AI_CALL_BUDGET || '1500', 10),

  // ─── Business info ──────────────────────────────────────────────────────
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'משרד עו״ד יהונתן פודים ושות׳',
  OFFICE_TLV: 'חיים הזז 16, משרד 207, תל אביב · 03-5517801',
  OFFICE_JLM: 'יפו 33, בית יואל, ירושלים · 02-6249286',

  MEETING_DAYS: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'],
  MEETING_HOURS: ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'],
};
