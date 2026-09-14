/**
 * Dry-run adapter: logs what would be sent; no real provider call.
 * Accepts optional idempotencyKey for logging/compat only — does not simulate Resend.
 * @implements {import('./interface').EmailProvider}
 */
class LogEmailProvider {
  /**
   * @param {{ to: string, subject: string, html: string, from: string, idempotencyKey?: string }} args
   * @returns {Promise<import('./interface').EmailSendResult>}
   */
  async send({ to, subject, html, from, idempotencyKey }) {
    const logPayload = {
      to,
      subject,
      from,
      htmlPreview: String(html).slice(0, 100),
    };
    if (idempotencyKey != null && String(idempotencyKey).trim() !== '') {
      logPayload.idempotencyKey = String(idempotencyKey).trim();
    }
    console.log('[LogEmailProvider] would send:', logPayload);
    return {
      providerId: 'log',
      providerMessageId: 'log-' + Date.now(),
    };
  }
}

module.exports = { LogEmailProvider };
