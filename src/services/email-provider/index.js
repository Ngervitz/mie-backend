/**
 * Factory: pick EmailProvider from EMAIL_PROVIDER_MODE.
 *   'resend' | 'log' | unset/other → NotImplementedEmailProvider
 */

const { NotImplementedEmailProvider } = require('./not-implemented');
const { ResendEmailProvider } = require('./resend');
const { LogEmailProvider } = require('./log');

/**
 * @returns {import('./interface').EmailProvider}
 */
function getEmailProvider() {
  const mode = String(process.env.EMAIL_PROVIDER_MODE || '')
    .trim()
    .toLowerCase();
  if (mode === 'resend') return new ResendEmailProvider();
  if (mode === 'log') return new LogEmailProvider();
  return new NotImplementedEmailProvider();
}

module.exports = {
  getEmailProvider,
  NotImplementedEmailProvider,
  ResendEmailProvider,
  LogEmailProvider,
};
