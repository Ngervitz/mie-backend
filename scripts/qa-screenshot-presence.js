const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://127.0.0.1:3011/mie-dashboard.html', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.click('#market-google-tab-btn');
  await page.waitForSelector('#serp-presence-list .serp-presence-row', { timeout: 30000 });
  await page.waitForTimeout(500);
  const section = await page.$('.serp-presence-section');
  if (section) {
    await section.screenshot({ path: 'samples/_qa_serp_presence.png' });
  }
  await page.screenshot({
    path: 'samples/_qa_serp_presence_full.png',
    clip: { x: 0, y: 90, width: 900, height: 520 },
  });
  console.log('ok');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
