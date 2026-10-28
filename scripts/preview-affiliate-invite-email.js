'use strict';

/**
 * Render affiliate invite email and serve a local browser preview.
 *
 *   node scripts/preview-affiliate-invite-email.js
 *   node scripts/preview-affiliate-invite-email.js --write-only
 *
 * Opens no browser automatically; prints URLs. Uses sample invite token for join_url only.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {
  renderAffiliateInviteEmail,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  DEFAULT_PUBLIC_BASE_URL,
} = require('../src/lib/affiliateInviteEmail');

const ROOT = path.resolve(__dirname, '..');
const OUT_HTML = path.join(
  ROOT,
  'samples',
  'email-drafts',
  'affiliate-invite-v1.preview.html',
);
const SAMPLE_TOKEN = 'PREVIEW-INVITE-TOKEN-NOT-VALID';

function parseWriteOnly(argv) {
  return argv.indexOf('--write-only') !== -1;
}

function buildPreviewApp(previewHtml) {
  const app = express();
  app.get('/preview', function (_req, res) {
    res.type('html').send(previewHtml);
  });
  app.use(
    '/email-assets',
    express.static(path.join(ROOT, 'public', 'email-assets'), { index: false }),
  );
  return app;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      resolve({
        server: server,
        origin: 'http://127.0.0.1:' + port,
      });
    });
  });
}

async function main() {
  const writeOnly = parseWriteOnly(process.argv);
  const publicBase = process.env.EMAIL_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const joinUrl = buildAffiliateJoinUrl(SAMPLE_TOKEN, publicBase);

  const rendered = renderAffiliateInviteEmail({
    publicBaseUrl: publicBase,
    joinUrl: joinUrl,
    termsUrl: buildAffiliateTermsUrl(publicBase),
    heroImageUrl: null,
  });

  if (!rendered.ok) {
    throw new Error(rendered.errorReason || 'render_failed');
  }

  fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
  fs.writeFileSync(OUT_HTML, rendered.html, 'utf8');

  process.stdout.write('Subject: ' + rendered.subject + '\n');
  process.stdout.write('Opt-in URL (sample): ' + joinUrl + '\n');
  process.stdout.write('Terms URL: ' + buildAffiliateTermsUrl(publicBase) + '\n');
  process.stdout.write(
    'Hero asset (prod after deploy): ' +
      buildAffiliateInviteHeroImageUrl(publicBase) +
      '\n',
  );
  process.stdout.write('Wrote: ' + OUT_HTML + '\n');

  if (writeOnly) {
    process.stdout.write(
      '\nNote: open the preview file after serving /email-assets locally, or run without --write-only.\n',
    );
    return;
  }

  const previewHtml = rendered.html.replace(
    new RegExp(buildAffiliateInviteHeroImageUrl(publicBase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    '/email-assets/affiliate-invite-hero-v1.jpg',
  );

  const h = await listen(buildPreviewApp(previewHtml));
  process.stdout.write('\nLocal preview (image + links):\n');
  process.stdout.write('  ' + h.origin + '/preview\n');
  process.stdout.write('\nPress Ctrl+C to stop.\n');

  await new Promise(function () {});
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}
