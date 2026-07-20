const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const res = await page.goto('http://127.0.0.1:3010/mie-dashboard.html', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  console.log('status', res && res.status());
  const html = await page.content();
  console.log('has market-chrome', html.includes('market-chrome'));
  console.log('has market-meta', html.includes('market-meta-tab-btn'));
  console.log('has mie-market-meta-grad', html.includes('mie-market-meta-grad1'));

  const el = await page.$('#market-chrome');
  console.log('el', !!el);
  if (el) {
    const box = await el.boundingBox();
    const vis = await el.isVisible();
    console.log('visible', vis, 'box', JSON.stringify(box));
  }

  const panel = await page.$('#market-panel');
  if (panel) {
    console.log(
      'panel class',
      await panel.getAttribute('class'),
      'hidden attr',
      await panel.getAttribute('hidden'),
    );
  }

  await page.screenshot({ path: 'samples/_qa_market_full.png' });

  if (el) {
    await el.screenshot({ path: 'samples/_qa_market_subtabs_logos.png' });
    const box = await el.boundingBox();
    if (box) {
      await page.screenshot({
        path: 'samples/_qa_market_subtabs_margin.png',
        clip: {
          x: 0,
          y: Math.max(0, box.y - 40),
          width: 700,
          height: 120,
        },
      });
      console.log('left_x', box.x);
    }
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
