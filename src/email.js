/**
 * DEPRECATED — email notifications were removed in v2.0.
 *
 * Agent alerts now go out over WhatsApp only (see src/sales/handoff.js).
 * This stub remains so any stale import cannot crash the bot; the nodemailer
 * dependency has been removed from package.json.
 *
 * Safe to delete.
 */
async function sendNotification() {
  return false;
}

module.exports = { sendNotification };
