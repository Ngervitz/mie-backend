/**
 * QA helper for manual Google SERP HTML import.
 *
 * Prerequisites (once, in Supabase SQL editor):
 *   1) Run migrations/20260719_google_serp_ads_manual.sql
 *   2) Bucket serp-html-imports is created automatically on first import
 *      (private); or create it manually in Storage as private.
 *
 * Usage:
 *   node scripts/qa-serp-import.js
 *   node scripts/qa-serp-import.js "C:\\path\\to\\serp.html"
 *   node scripts/qa-serp-import.js --empty   # zero-ads loud-failure case
 */

require('dotenv').config();

// Allow local QA without Apify (env.js requires these at boot via supabase chain).
process.env.APIFY_TOKEN = process.env.APIFY_TOKEN || 'qa-dummy';
process.env.APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'qa-dummy';

const fs = require('fs');
const path = require('path');
const {
  parseGoogleSerpHtml,
  importGoogleSerpHtml,
} = require('../src/steps/collectGoogleSerpImports');

const DEFAULT_SAMPLE =
  'C:\\Users\\Admin\\Desktop\\GoogleSERPTest\\prestamos con cedula - Google Search.html';

async function main() {
  const args = process.argv.slice(2);
  const emptyMode = args.includes('--empty');
  const fileArg = args.find((a) => a !== '--empty');

  if (emptyMode) {
    const buffer = Buffer.from(
      '<!doctype html><html><body><h1>Not a Google SERP</h1><p>random page</p></body></html>',
      'utf8',
    );
    console.log('--- Zero-ads loud failure ---');
    const result = await importGoogleSerpHtml({
      buffer,
      contentType: 'text/html',
      searchTermFallback: 'qa-empty-test',
      date: new Date().toISOString().slice(0, 10),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.parserFoundNoAdMarkers ? 0 : 1);
  }

  const filePath = fileArg || DEFAULT_SAMPLE;
  if (!fs.existsSync(filePath)) {
    console.error('Sample file not found:', filePath);
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  console.log('File:', filePath, 'bytes:', buffer.length);

  const parsed = parseGoogleSerpHtml(buffer.toString('utf8'));
  console.log('Parse preview:', {
    searchTermFromHtml: parsed.searchTermFromHtml,
    adBlockCount: parsed.adBlockCount,
    parserFoundNoAdMarkers: parsed.parserFoundNoAdMarkers,
    ads: parsed.ads.map((a) => ({
      position: a.position,
      advertiser_name: a.advertiser_name,
      advertiser_domain: a.advertiser_domain,
      ad_title: a.ad_title,
      destination_url: (a.destination_url || '').slice(0, 100),
    })),
  });

  console.log('\n--- Full import (Storage + DB) ---');
  const result = await importGoogleSerpHtml({
    buffer,
    contentType: 'text/html',
    date: new Date().toISOString().slice(0, 10),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('QA failed:', err.message);
  process.exit(1);
});
