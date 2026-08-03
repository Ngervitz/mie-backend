/**
 * Isolated Resend smoke test — does not touch app routes/jobs.
 *
 * Usage:
 *   $env:RESEND_API_KEY = 're_...'
 *   node scripts/test-resend.js destino@ejemplo.com
 *
 * Optional:
 *   $env:RESEND_FROM = 'Janus <onboarding@resend.dev>'
 */

const { Resend } = require('resend');

async function main() {
  const to = process.argv[2] ? String(process.argv[2]).trim() : '';
  if (!to) {
    console.error(
      'Usage: node scripts/test-resend.js <destino@ejemplo.com>\n' +
        'Requires RESEND_API_KEY in the environment.',
    );
    process.exit(2);
  }

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.error('Missing RESEND_API_KEY in process.env');
    process.exit(2);
  }

  const from =
    (process.env.RESEND_FROM || '').trim() ||
    'Janus <onboarding@resend.dev>';

  const resend = new Resend(apiKey);

  console.log('Sending test email…');
  console.log({ from, to, subject: 'Resend smoke test (mie-backend)' });

  const result = await resend.emails.send({
    from,
    to: [to],
    subject: 'Resend smoke test (mie-backend)',
    text:
      'Hola — este es un email de prueba desde scripts/test-resend.js.\n' +
      `Enviado a: ${to}\n` +
      `Fecha (UTC): ${new Date().toISOString()}\n`,
  });

  // Official SDK returns { data, error }. Surface both fully.
  console.log('Resend response (full):');
  console.log(JSON.stringify(result, null, 2));

  if (result.error) {
    console.error('Resend API error object:');
    console.error(result.error);
    process.exit(1);
  }

  if (result.data && result.data.id) {
    console.log('message id:', result.data.id);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled failure:');
  console.error(err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
