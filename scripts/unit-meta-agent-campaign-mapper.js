'use strict';

/**
 * node scripts/unit-meta-agent-campaign-mapper.js
 * Regression: mapOwnAdMetricsToLegacyRow must not ReferenceError on spend.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMetaAgentTestApi() {
  const filePath = path.join(__dirname, '../public/meta-agent.js');
  let src = fs.readFileSync(filePath, 'utf8');
  const hook =
    "if (typeof global !== 'undefined') { global.__metaAgentTest = { mapOwnAdMetricsToLegacyRow: mapOwnAdMetricsToLegacyRow, computeLatestDateStats: computeLatestDateStats }; }";
  src = src.replace(
    "if (document.readyState === 'loading') {",
    hook + "\n  if (document.readyState === 'loading') {",
  );

  const sandbox = {
    console: console,
    setInterval: function () {
      return 0;
    },
    clearInterval: function () {},
    fetch: function () {
      return Promise.reject(new Error('fetch not available in unit test'));
    },
    window: {
      location: { protocol: 'https:' },
      Chart: undefined,
      __META_AGENT_DATASOURCE__: null,
    },
    document: {
      readyState: 'complete',
      getElementById: function () {
        return null;
      },
      addEventListener: function () {},
    },
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: filePath });
  return sandbox.__metaAgentTest;
}

const api = loadMetaAgentTestApi();
assert.ok(api && typeof api.mapOwnAdMetricsToLegacyRow === 'function');

const sampleRow = {
  campaign_name: 'Test Camp',
  metric_date: '2026-10-15',
  spend: 50,
  impressions: 1000,
  clicks: 25,
  frequency: 1.2,
  raw_json: {},
};

let mapped;
assert.doesNotThrow(function () {
  mapped = api.mapOwnAdMetricsToLegacyRow(sampleRow);
});

assert.strictEqual(mapped.gasto, '50');
assert.strictEqual(mapped.spend, '50');
assert.strictEqual(parseFloat(mapped.ctr), 2.5);
assert.strictEqual(parseFloat(mapped.cpc), 2);

const legacyRows = [mapped];
const stats = api.computeLatestDateStats(legacyRows);
assert.strictEqual(stats.spend, 50);
assert.strictEqual(stats.ctr, 2.5);
assert.strictEqual(stats.cpc, 2);
assert.strictEqual(stats.cpm, 50);

console.log('ok mapOwnAdMetricsToLegacyRow spend regression');
console.log('ok ctr gasto cpm unchanged via computeLatestDateStats');
console.log('all meta-agent campaign mapper checks passed');
