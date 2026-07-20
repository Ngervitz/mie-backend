const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE', m.text());
  });
  await page.goto('http://127.0.0.1:3011/mie-dashboard.html', {
    waitUntil: 'domcontentloaded',
  });
  await page.click('#market-google-tab-btn');
  await page.setInputFiles('#serp-file-input', [
    path.join('samples', '_qa_not_a_serp.html'),
    path.join('samples', 'préstamo pronto - Google Search.html'),
  ]);
  console.log(
    'selected',
    await page.$eval('#serp-file-input', (el) => el.files.length),
  );
  await page.click('#serp-upload-btn');
  await page.waitForTimeout(10000);
  console.log(
    'status=',
    await page.$eval('#serp-import-status', (el) => el.textContent),
  );
  console.log(
    'summary=',
    await page.$eval('#serp-import-summary', (el) => el.innerText.slice(0, 1000)),
  );
  console.log(
    'busyBtn',
    await page.$eval('#serp-upload-btn', (el) => el.disabled),
  );
  await page.locator('#serp-import-form').screenshot({
    path: 'samples/_qa_serp_multi_selected.png',
  });
  const sum = page.locator('#serp-import-summary');
  if (await sum.isVisible()) {
    await sum.screenshot({ path: 'samples/_qa_serp_multi_summary.png' });
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
