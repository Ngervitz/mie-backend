/**
 * TEMP — smoke test for EmailProvider / Resend adapter.
 * Delete after validating. Do not wire into the app.
 *
 * Usage (PowerShell):
 *   $env:RESEND_API_KEY = 're_...'
 *   # optional: $env:EMAIL_PROVIDER_MODE = 'resend'
 *   node scripts/test-email-provider.js destino@x.com remitente@credizona.com.uy
 */

if (!process.env.EMAIL_PROVIDER_MODE) {
  process.env.EMAIL_PROVIDER_MODE = 'resend';
}

const { getEmailProvider } = require('../src/services/email-provider');

async function main() {
  const to = process.argv[2] ? String(process.argv[2]).trim() : '';
  const from = process.argv[3] ? String(process.argv[3]).trim() : '';

  if (!to || !from) {
    console.error(
      'Usage: node scripts/test-email-provider.js <to@x.com> <from@credizona.com.uy>\n' +
        'Requires RESEND_API_KEY. EMAIL_PROVIDER_MODE defaults to "resend".',
    );
    process.exit(2);
  }

  console.log('EMAIL_PROVIDER_MODE=', process.env.EMAIL_PROVIDER_MODE);
  console.log('Calling getEmailProvider().send…', { to, from });

  const provider = getEmailProvider();
  const result = await provider.send({
    to,
    subject: 'Test EmailProvider',
    html: '<p>test</p>',
    from,
  });

  console.log('EmailProvider result (full):');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled failure:');
  console.error(err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
