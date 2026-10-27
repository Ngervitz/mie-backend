'use strict';

/**
 * Ensures GET /affiliates list enrichment is wired (read-only aggregates).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = require('../src/lib/affiliateDirectoryRead');
assert.ok(typeof read.listAffiliatesWithRowStats === 'function');

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/affiliates-admin.js'),
  'utf8',
);
assert.ok(routeSrc.indexOf('listAffiliatesWithRowStats') !== -1);
assert.ok(routeSrc.indexOf('listAffiliates(supabase)') === -1);

console.log('unit-affiliate-list-row-stats: ok');
