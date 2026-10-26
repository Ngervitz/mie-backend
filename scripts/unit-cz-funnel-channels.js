/**
 * Local checks for the utility-dashboard channel list.
 * Does not open the network and does not touch Supabase.
 * node scripts/unit-cz-funnel-channels.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'public', 'mie-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'mie-dashboard.css'), 'utf8');
const sanitizer = fs.readFileSync(path.join(root, 'src', 'lib', 'sanitizeCzTrackingData.js'), 'utf8');

const start = dashboard.indexOf('/* cz-funnel-channels-start */');
const end = dashboard.indexOf('/* cz-funnel-channels-end */');
assert.ok(start >= 0 && end > start, 'channel aggregate markers missing');

const slice = dashboard.slice(start, end);
const sandbox = {
  numOrZero: function (v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  },
};
vm.createContext(sandbox);
vm.runInContext(
  slice +
    '\nthis.__channels = CZ_FUNNEL_CHANNELS;' +
    '\nthis.__aggregate = currentMonthChannelMetrics;' +
    '\nthis.__channelsFor = czFunnelChannelsFor;',
  sandbox,
  { filename: 'cz-funnel-channels.js' },
);

const aggregate = sandbox.__aggregate;
const channelsFor = sandbox.__channelsFor;
const ids = sandbox.__channels.map(function (ch) {
  return ch.id;
});

assert.strictEqual(
  JSON.stringify(ids),
  JSON.stringify([
    'meta',
    'sms',
    'social_organico',
    'social_no_confirmado',
    'busqueda_organica',
    'origen_no_confirmado',
    'sin_atribuir',
  ]),
);

function row(month, channel, granted, monto, spend, utility) {
  return {
    period_month: month,
    channel: channel,
    granted_count: granted,
    monto_total_otorgado: monto,
    spend: spend,
    utility: utility,
  };
}

const month = '2026-10';
const rows = [
  row(month, 'meta', 0, 0, 7736.33, -7736.33),
  row(month, 'sms', 0, 0, 12, -12),
  row(month, 'social_organico', 2, 50000, 0, 3000),
  row(month, 'social_no_confirmado', 1, 10000, 0, 600),
  row(month, 'busqueda_organica', 1, 20000, 0, 1200),
  row(month, 'origen_no_confirmado', 1, 5000, 0, 300),
  row(month, 'sin_atribuir', 1, 100000, 0, 6000),
  row(month, 'canal_futuro', 3, 7000, 40, 380),
  row('2026-09', 'meta', 9, 999999, 999999, 999999),
  row(month, '', 8, 8000, 80, 800),
];

const agg = aggregate(rows, month);
ids.forEach(function (id) {
  assert.ok(agg.by[id], 'missing channel ' + id);
});
assert.strictEqual(agg.by.canal_futuro.granted_count, 3);
assert.strictEqual(agg.by.meta.granted_count, 0);
assert.strictEqual(agg.by.meta.spend, 7736.33);
assert.strictEqual(agg.total.granted_count, 9);
assert.strictEqual(agg.total.monto_total_otorgado, 192000);
assert.strictEqual(agg.total.spend, 7788.33);
assert.strictEqual(agg.total.utility, 3731.67);
assert.ok(!Object.prototype.hasOwnProperty.call(agg.by, ''));

const listed = channelsFor(agg.by).map(function (ch) {
  return ch.id;
});
assert.strictEqual(JSON.stringify(listed.slice(0, ids.length)), JSON.stringify(ids));
assert.ok(listed.indexOf('canal_futuro') >= 0);

const repeated = aggregate(
  [row(month, 'meta', 1, 10, 100, 1), row(month, 'meta', 4, 40, 5, 2)],
  month,
);
assert.strictEqual(repeated.by.meta.spend, 5);
assert.strictEqual(repeated.by.meta.granted_count, 4);
assert.strictEqual(repeated.total.spend, 5);

const missingFx = aggregate([row(month, 'meta', 1, 10, null, null)], month);
assert.strictEqual(missingFx.by.meta.spend, null);
assert.strictEqual(missingFx.total.spend, null);
assert.strictEqual(missingFx.total.utility, null);
assert.strictEqual(missingFx.total.granted_count, 1);

assert.ok(dashboard.indexOf("fetch(API + '/reports/cz-funnel-channel-utility'") > 0);
assert.ok(dashboard.indexOf('function initRechazados') > 0);
assert.ok(dashboard.indexOf('statusFilter: null') > 0);
assert.strictEqual(dashboard.indexOf('META_CPL_ACTION_TYPE'), -1);
assert.strictEqual(dashboard.indexOf('cplCz'), -1);
assert.ok(css.indexOf('repeat(auto-fit, minmax(140px, 1fr))') > 0);
assert.ok(css.indexOf('grid-column: 1 / -1') > 0);
assert.ok(sanitizer.indexOf("'fbclid'") === -1);
assert.ok(sanitizer.indexOf("'attribution_source'") === -1);
assert.ok(sanitizer.indexOf("'utm_source'") > 0);

console.log('cz funnel channels: ok');
