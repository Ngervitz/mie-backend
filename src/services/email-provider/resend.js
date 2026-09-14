/**
 * Resend adapter — CommonJS + SDK shape validated by scripts/test-resend.js.
 *
 * Observed successful response (terminal smoke test):
 *   { data: { id: "<uuid>" }, error: null, headers: { ... } }
 * Message id extracted as result.data.id (not data.data.id).
 *
 * Idempotency: Resend SDK v6 accepts second arg { idempotencyKey } → Idempotency-Key header.
 */

const { Resend } = require('resend');

/**
 * @implements {import('./interface').EmailProvider}
 */
class ResendEmailProvider {
  /**
   * @param {{ to: string, subject: string, html: string, from: string, idempotencyKey?: string }} args
   * @returns {Promise<import('./interface').EmailSendResult>}
   */
  async send({ to, subject, html, from, idempotencyKey }) {
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

    const payload = {
      from: fromAddr,
      to: [toAddr],
      subject: subjectText,
      html: htmlBody,
    };

    const options = {};
    if (idempotencyKey != null && String(idempotencyKey).trim() !== '') {
      options.idempotencyKey = String(idempotencyKey).trim();
    }

    // Same call shape as scripts/test-resend.js (to as array); options for Idempotency-Key.
    const result =
      Object.keys(options).length > 0
        ? await resend.emails.send(payload, options)
        : await resend.emails.send(payload);

    if (result.error) {
      const err = result.error;
      const wrapped = new Error(
        err && err.message ? String(err.message) : 'Resend send failed',
      );
      if (err && err.name) wrapped.name = String(err.name);
      if (err && err.statusCode != null) wrapped.statusCode = err.statusCode;
      throw wrapped;
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
