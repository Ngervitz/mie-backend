const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:3011';
const samples = path.join(__dirname, '..', 'samples');

(async () => {
  const valid1 = path.join(samples, 'prestamos con clearing - Buscar con Google.html');
  const invalid = path.join(samples, '_qa_not_a_serp.html');
  // Byte-distinct pronto copy so we don't only hit duplicates if hash already used
  const prontoSrc = fs
    .readdirSync(samples)
    .find((n) => n.includes('pronto') && n.endsWith('.html') && !n.startsWith('_') && !n.includes('_files'));
  const valid2 = path.join(samples, prontoSrc);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(BASE + '/mie-dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.click('#market-google-tab-btn');
  await page.waitForSelector('#serp-file-input');

  await page.setInputFiles('#serp-file-input', [valid2, invalid, valid1]);
  const count = await page.$eval('#serp-file-input', (el) => el.files.length);
  console.log('files_selected', count);

  const form = await page.$('#serp-import-form');
  await form.screenshot({ path: path.join(samples, '_qa_serp_multi_selected.png') });

  await page.click('#serp-upload-btn');
  try {
    await page.waitForFunction(
      () => {
        const s = document.getElementById('serp-import-status');
        return s && /Lote terminado/i.test(s.textContent || '');
      },
      null,
      { timeout: 180000 },
    );
  } catch (err) {
    const status = await page.$eval('#serp-import-status', (el) => el.textContent).catch(() => '');
    const summary = await page.$eval('#serp-import-summary', (el) => el.innerHTML).catch(() => '');
    console.log('TIMEOUT_DEBUG status=', status);
    console.log('TIMEOUT_DEBUG summary=', summary.slice(0, 500));
    throw err;
  }

  const status = await page.$eval('#serp-import-status', (el) => el.textContent);
  const summary = await page.$eval('#serp-import-summary', (el) => el.innerText);
  console.log('STATUS', status);
  console.log('SUMMARY\n', summary);

  await page.locator('#serp-import-summary').screenshot({
    path: path.join(samples, '_qa_serp_multi_summary.png'),
  });
  await page.locator('.serp-history-section').screenshot({
    path: path.join(samples, '_qa_serp_multi_history.png'),
  });

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
