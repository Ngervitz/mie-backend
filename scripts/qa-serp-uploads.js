require('dotenv').config();
process.env.APIFY_TOKEN = process.env.APIFY_TOKEN || 'dummy';
process.env.APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'dummy';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const supabase = require('../src/clients/supabase');

const BASE = process.env.SERP_QA_BASE || 'http://127.0.0.1:3001';

async function postHtml(filePath, fields = {}) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'text/html' }), path.basename(filePath));
  for (const [k, v] of Object.entries(fields)) {
    if (v != null) form.append(k, String(v));
  }
  const res = await fetch(`${BASE}/reports/import-google-serp`, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

(async () => {
  // Download exact archived bytes of the first import for true dedup test
  const storageKey = '1784508079165-8b8c9b9f-56b7-4364-9d32-08aaa68dddd1.html';
  const archivedLocal = path.join('samples', '_archived_original_for_dedup.html');
  const { data: blob, error: dlErr } = await supabase.storage
    .from('serp-html-imports')
    .download(storageKey);
  if (dlErr) throw dlErr;
  const archivedBuf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(archivedLocal, archivedBuf);
  console.log('archived_download_bytes=', archivedBuf.length);
  console.log(
    'archived_sha256=',
    createHash('sha256').update(archivedBuf).digest('hex'),
  );

  console.log('\n=== 2a) POST archived original bytes (must match DB hash) ===');
  const dup = await postHtml(archivedLocal, { date: '2026-07-19' });
  console.log('HTTP', dup.status);
  console.log(JSON.stringify(dup.body, null, 2));

  console.log('\n=== 2b) POST current local samples/prestamos con cedula... ===');
  const localCedula = path.join('samples', 'prestamos con cedula - Google Search.html');
  const local1 = await postHtml(localCedula, { date: '2026-07-19' });
  console.log('HTTP', local1.status, 'bytes', local1.bytes, 'sha', local1.sha256);
  console.log(JSON.stringify(local1.body, null, 2));

  console.log('\n=== 2c) POST same current local AGAIN (dedup on new hash) ===');
  const local2 = await postHtml(localCedula, { date: '2026-07-19' });
  console.log('HTTP', local2.status);
  console.log(JSON.stringify(local2.body, null, 2));

  // Discover other top-level SERP htmls (exclude _qa / _archived)
  const files = fs
    .readdirSync('samples')
    .filter((n) => n.toLowerCase().endsWith('.html'))
    .filter((n) => !n.startsWith('_'))
    .filter((n) => n !== 'prestamos con cedula - Google Search.html')
    .map((n) => path.join('samples', n));

  console.log('\n=== 3) other HTML files found ===');
  console.log(JSON.stringify(files, null, 2));

  for (const f of files) {
    console.log('\n=== UPLOAD', f, '===');
    const r = await postHtml(f, { date: '2026-07-19' });
    console.log('HTTP', r.status, 'bytes', r.bytes);
    console.log(JSON.stringify(r.body, null, 2));
  }
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
