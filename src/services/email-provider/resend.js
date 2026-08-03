/**
 * Resend adapter — CommonJS + SDK shape validated by scripts/test-resend.js.
 *
 * Observed successful response (terminal smoke test):
 *   { data: { id: "<uuid>" }, error: null, headers: { ... } }
 * Message id extracted as result.data.id (not data.data.id).
 */

const { Resend } = require('resend');

/**
 * @implements {import('./interface').EmailProvider}
 */
class ResendEmailProvider {
  /**
   * @param {{ to: string, subject: string, html: string, from: string }} args
   * @returns {Promise<import('./interface').EmailSendResult>}
   */
  async send({ to, subject, html, from }) {
    const toAddr = to == null ? '' : String(to).trim();
    const subjectText = subject == null ? '' : String(subject).trim();
    const htmlBody = html == null ? '' : String(html).trim();
    const fromAddr = from == null ? '' : String(from).trim();

    if (!toAddr) {
      throw new Error('EmailProvider.send: "to" is required');
    }
    if (!subjectText) {
      throw new Error('EmailProvider.send: "subject" is required');
    }
    if (!htmlBody) {
      throw new Error('EmailProvider.send: "html" is required');
    }
    if (!fromAddr) {
      throw new Error('EmailProvider.send: "from" is required');
    }

    const apiKey = (process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    const resend = new Resend(apiKey);

    // Same call shape as scripts/test-resend.js (to as array).
    const result = await resend.emails.send({
      from: fromAddr,
      to: [toAddr],
      subject: subjectText,
      html: htmlBody,
    });

    if (result.error) {
      throw result.error;
    }

    const providerMessageId =
      result.data && result.data.id != null ? String(result.data.id) : '';

    if (!providerMessageId) {
      throw new Error(
        'Resend returned success without data.id (unexpected response shape)',
      );
    }

    return {
      providerId: 'resend',
      providerMessageId,
    };
  }
}

module.exports = { ResendEmailProvider };
