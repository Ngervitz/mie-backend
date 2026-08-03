/**
 * Dry-run adapter: logs what would be sent; no real provider call.
 * @implements {import('./interface').EmailProvider}
 */
class LogEmailProvider {
  /**
   * @param {{ to: string, subject: string, html: string, from: string }} args
   * @returns {Promise<import('./interface').EmailSendResult>}
   */
  async send({ to, subject, html, from }) {
    console.log('[LogEmailProvider] would send:', {
      to,
      subject,
      from,
      htmlPreview: String(html).slice(0, 100),
    });
    return {
      providerId: 'log',
      providerMessageId: 'log-' + Date.now(),
    };
  }
}

module.exports = { LogEmailProvider };
