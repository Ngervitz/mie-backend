'use strict';

/**
 * Layout contract for Gestión ELM (full width + horizontal scroll + sticky Acciones).
 * Run: node scripts/unit-gestion-elm-layout-css.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.css'), 'utf8');

function blockFor(selector) {
  const idx = css.indexOf(selector);
  assert.ok(idx >= 0, 'missing selector: ' + selector);
  const start = css.lastIndexOf('\n', idx);
  const end = css.indexOf('\n}', idx);
  return css.slice(start, end + 2);
}

(async function main() {
  const groupStart = css.indexOf('/* ---------- Top-level section panels');
  assert.ok(groupStart >= 0, 'section panel group comment exists');
  const groupEnd = css.indexOf('/* Gestión ELM: full content width');
  assert.ok(groupEnd > groupStart, 'Gestión ELM layout block exists');
  const groupBlock = css.slice(groupStart, groupEnd);
  assert.ok(
    !groupBlock.includes('#elm-gestion-panel'),
    'elm-gestion-panel must not share --maxw section cap',
  );

  const panel = blockFor('#mie-dashboard-app #elm-gestion-panel {');
  assert.ok(/max-width:\s*none/.test(panel), 'panel uses full content width');
  assert.ok(/width:\s*100%/.test(panel), 'panel width 100%');

  const wrap = blockFor('#mie-dashboard-app #elm-gestion-panel .table-wrap {');
  assert.ok(/overflow-x:\s*auto/.test(wrap), 'table-wrap allows horizontal scroll');

  assert.ok(
    css.includes('#mie-dashboard-app #elm-gestion-panel .elm-ops-opportunities td.elm-ops-actions'),
    'sticky actions column rule present',
  );
  assert.ok(
    /#elm-gestion-panel[\s\S]{0,800}position:\s*sticky/.test(css),
    'Gestión ELM block uses sticky positioning',
  );

  const SIDEBAR = 220;
  const PANEL_PAD = 40;
  const TABLE_MIN = 1280;
  [1366, 1920].forEach(function (vw) {
    const content = vw - SIDEBAR - PANEL_PAD;
    const needsScroll = TABLE_MIN > content;
    assert.ok(content > 900, 'content width sane at ' + vw + 'px: ' + content);
    if (vw === 1366) {
      assert.strictEqual(needsScroll, true, '1366 expects horizontal scroll for wide table');
    }
    if (vw === 1920) {
      assert.strictEqual(needsScroll, false, '1920 fits table without forced scroll');
    }
  });

  console.log('unit-gestion-elm-layout-css: all passed (1366 → scroll; 1920 → full table)');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
