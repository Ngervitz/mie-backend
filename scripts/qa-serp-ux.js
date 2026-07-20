const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:3011';
const samples = path.join(__dirname, '..', 'samples');

async function dropHtmlOnZone(page, filePath) {
  const name = path.basename(filePath);
  const b64 = fs.readFileSync(filePath).toString('base64');
  await page.evaluate(
    ({ selector, name, b64 }) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type: 'text/html' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector(selector);
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { selector: '#serp-dropzone', name, b64 },
  );
}

(async () => {
  const sampleHtml = path.join(samples, 'prestamos con clearing - Buscar con Google.html');
  const badTxt = path.join(samples, '_qa_not_html.txt');
  if (!fs.existsSync(badTxt)) {
    fs.writeFileSync(badTxt, 'not html', 'utf8');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.goto(BASE + '/mie-dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.click('#market-google-tab-btn');
  await page.waitForSelector('#serp-imports-list .serp-captures-table, #serp-imports-list .mcl-empty');

  // 1) Collapsed by default
  const panelHidden = await page.$eval('#serp-upload-panel', (el) => el.hasAttribute('hidden'));
  const toggleLabel = await page.$eval('#serp-toggle-import-btn', (el) => el.textContent.trim());
  console.log('collapsed_default', panelHidden, toggleLabel);
  await page.locator('#serp-import-landing').screenshot({
    path: path.join(samples, '_qa_serp_ux_collapsed.png'),
  });

  // Table columns + status badges
  const headers = await page.$$eval('.serp-captures-table thead th', (ths) =>
    ths.map((t) => t.textContent.trim()),
  );
  console.log('table_headers', headers.join('|'));
  const badges = await page.$$eval('.serp-status-badge', (els) =>
    els.map((e) => ({ text: e.textContent.trim(), tone: e.className })),
  );
  console.log('badges', JSON.stringify(badges));

  await page.locator('.serp-history-section').screenshot({
    path: path.join(samples, '_qa_serp_ux_table.png'),
  });

  // 2) Expand form — table stays
  const tableHtmlBefore = await page.$eval('#serp-imports-list', (el) => el.innerHTML);
  await page.click('#serp-toggle-import-btn');
  await page.waitForSelector('#serp-upload-panel:not([hidden])');
  const tableHtmlAfter = await page.$eval('#serp-imports-list', (el) => el.innerHTML);
  console.log('table_unchanged_on_expand', tableHtmlBefore === tableHtmlAfter);
  console.log(
    'toggle_expanded_label',
    await page.$eval('#serp-toggle-import-btn', (el) => el.textContent.trim()),
  );
  await page.locator('#serp-import-landing').screenshot({
    path: path.join(samples, '_qa_serp_ux_expanded.png'),
  });

  // 3) Submit disabled without file
  const disabledEmpty = await page.$eval('#serp-upload-btn', (el) => el.disabled);
  console.log('submit_disabled_empty', disabledEmpty);

  // Picker selection shows filename + enables submit
  await page.setInputFiles('#serp-file-input', [sampleHtml]);
  // change handler may need a tick if DataTransfer sync runs
  await page.waitForTimeout(200);
  const selectedText = await page.$eval('#serp-selected-files', (el) => el.textContent.trim());
  const disabledWithFile = await page.$eval('#serp-upload-btn', (el) => el.disabled);
  console.log('selected_text', selectedText);
  console.log('submit_enabled_with_file', !disabledWithFile);

  // 4) Reject unsupported type
  await page.setInputFiles('#serp-file-input', [badTxt]);
  await page.waitForTimeout(200);
  const rejectStatus = await page.$eval('#serp-import-status', (el) => el.textContent);
  const afterRejectSelected = await page.$eval('#serp-selected-files', (el) => el.textContent.trim());
  const afterRejectDisabled = await page.$eval('#serp-upload-btn', (el) => el.disabled);
  console.log('reject_status', rejectStatus);
  console.log('after_reject_selected', afterRejectSelected);
  console.log('after_reject_submit_disabled', afterRejectDisabled);

  // 5) Drag-and-drop: dragover class + drop file
  await page.evaluate(() => {
    const z = document.getElementById('serp-dropzone');
    z.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
    z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  });
  const dragOver = await page.$eval('#serp-dropzone', (el) => el.classList.contains('is-dragover'));
  console.log('dragover_class', dragOver);
  await page.locator('#serp-dropzone').screenshot({
    path: path.join(samples, '_qa_serp_ux_dragover.png'),
  });
  await page.evaluate(() => {
    document.getElementById('serp-dropzone').classList.remove('is-dragover');
  });

  await dropHtmlOnZone(page, sampleHtml);
  await page.waitForTimeout(200);
  const afterDrop = await page.$eval('#serp-selected-files', (el) => el.textContent.trim());
  const dropEnabled = await page.$eval('#serp-upload-btn', (el) => !el.disabled);
  console.log('after_drop_selected', afterDrop);
  console.log('after_drop_submit_enabled', dropEnabled);

  // Upload (expect duplicate OK) — loading + no double submit
  await page.click('#serp-upload-btn');
  await page.waitForTimeout(100);
  const duringDisabled = await page.$eval('#serp-upload-btn', (el) => el.disabled);
  console.log('submit_disabled_during_upload', duringDisabled);
  await page.waitForFunction(
    () => {
      const s = document.getElementById('serp-import-status');
      return s && /Lote terminado|importación|Duplicado|OK/i.test(s.textContent || '');
    },
    null,
    { timeout: 120000 },
  );
  const finalStatus = await page.$eval('#serp-import-status', (el) => el.textContent);
  const panelCollapsedAfter = await page.$eval('#serp-upload-panel', (el) =>
    el.hasAttribute('hidden'),
  );
  console.log('final_status', finalStatus);
  console.log('collapsed_after_success', panelCollapsedAfter);

  // 6) Ver detalle
  const detailBtn = page.locator('.serp-detail-btn').first();
  await detailBtn.click();
  await page.waitForSelector('#serp-ads-detail:not([hidden])');
  const adsTitle = await page.$eval('#serp-ads-detail .serp-detail-subtitle', (el) =>
    el.textContent.trim(),
  );
  const organicTitle = await page.$$eval('#serp-ads-detail .serp-detail-subtitle', (els) =>
    els.map((e) => e.textContent.trim()),
  );
  console.log('detail_sections', organicTitle.join('|'));
  await page.locator('#serp-ads-detail').screenshot({
    path: path.join(samples, '_qa_serp_ux_detail.png'),
  });

  // 7) Meta regression — no serp spinner in meta
  await page.click('#market-meta-tab-btn');
  await page.waitForTimeout(300);
  const metaVisible = await page.$eval('#mie-market-root', (el) => !el.hasAttribute('hidden'));
  const googleHidden = await page.$eval('#serp-import-landing', (el) => el.hasAttribute('hidden'));
  console.log('meta_visible', metaVisible, 'google_hidden', googleHidden);

  await browser.close();
  console.log('QA_OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
