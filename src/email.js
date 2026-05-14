/**
 * email.js
 * Sends notification emails via Gmail SMTP using nodemailer.
 * Set GMAIL_USER and GMAIL_APP_PASSWORD in Railway environment variables.
 */
const nodemailer = require('nodemailer');
const config = require('./config');

let transporter = null;

function getTransporter() {
  if (!config.GMAIL_USER || !config.GMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.GMAIL_USER,
        pass: config.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

/**
 * Send a notification email to the configured address.
 * @param {string} subject
 * @param {string} body  — plain text body
 */
async function sendNotification(subject, body) {
  const t = getTransporter();
  if (!t) return; // email not configured — skip silently

  try {
    await t.sendMail({
      from: `"הבוט של פודים" <${config.GMAIL_USER}>`,
      to: config.NOTIFY_EMAIL || config.GMAIL_USER,
      subject,
      text: body,
    });
    console.log(`📧 Email sent: "${subject}"`);
  } catch (err) {
    console.error('❌ Email send error:', err.message);
  }
}

module.exports = { sendNotification };
