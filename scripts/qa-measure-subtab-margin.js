const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:3010/mie-dashboard.html', {
    waitUntil: 'domcontentloaded',
  });
  const boxes = {
    tabs: await (await page.$('.dashboard-tabs')).boundingBox(),
    chrome: await (await page.$('#market-chrome')).boundingBox(),
    metaBtn: await (await page.$('#market-meta-tab-btn')).boundingBox(),
    compBtn: await (await page.$('#tab-market')).boundingBox(),
  };
  console.log(JSON.stringify(boxes, null, 2));
  await browser.close();
})();
