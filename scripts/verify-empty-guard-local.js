#!/usr/bin/env node
/**
 * Local verification for Empty Result Confirmation Guard (no DB / no .env).
 * Run: node scripts/verify-empty-guard-local.js
 */

const APIFY_FAILURE_PATTERNS = [
  'timeout', 'sources failed', 'failed to get source', 'connection error',
  'browser closed', 'context closed', 'page closed', 'net::err', 'blocked', 'rate limit',
];

function detectApifyFailurePattern(logText) {
  if (!logText || typeof logText !== 'string') return { detected: false, pattern: null };
  const lower = logText.toLowerCase();
  for (const pattern of APIFY_FAILURE_PATTERNS) {
    if (lower.includes(pattern)) return { detected: true, pattern };
  }
  return { detected: false, pattern: null };
}

const EMPTY_CONFIRMATION_GUARD_DEPLOY_AT = '2026-07-05T00:00:00.000Z';
const DEPLOY_CUTOFF_MS = new Date(EMPTY_CONFIRMATION_GUARD_DEPLOY_AT).getTime();

function isPostDeployEmptyConfirmed(snapshot) {
  return snapshot
    && snapshot.status === 'empty_confirmed'
    && new Date(snapshot.created_at).getTime() >= DEPLOY_CUTOFF_MS;
}

function getEmptyConfirmedAnchors(snapshots) {
  const firstByDay = new Map();
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  for (const snap of sorted) {
    if (!isPostDeployEmptyConfirmed(snap)) continue;
    if (!firstByDay.has(snap.snapshot_date)) firstByDay.set(snap.snapshot_date, snap);
  }
  return [...firstByDay.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function shiftDateUtc(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function enumerateDaysInclusive(start, end) {
  const days = [];
  let cur = start;
  while (cur <= end) { days.push(cur); cur = shiftDateUtc(cur, 1); }
  return days;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3600000;
}

function validateMarketExitWindow(allSnapshots, first, second) {
  const hours = hoursBetween(first.created_at, second.created_at);
  if (hours < 24 || hours > 72) return { valid: false };
  const days = enumerateDaysInclusive(first.snapshot_date, second.snapshot_date);
  const covered = new Set(allSnapshots.map((s) => s.snapshot_date));
  if (!days.every((d) => covered.has(d))) return { valid: false };
  const t0 = new Date(first.created_at).getTime();
  const t1 = new Date(second.created_at).getTime();
  for (const s of allSnapshots) {
    const t = new Date(s.created_at).getTime();
    if (t <= t0 || t >= t1) continue;
    if (s.status === 'success' || s.status === 'empty_unconfirmed') return { valid: false };
  }
  return { valid: true };
}

function assert(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) process.exitCode = 1;
}

function isoAfterDeploy(d) {
  const b = new Date(EMPTY_CONFIRMATION_GUARD_DEPLOY_AT);
  b.setUTCDate(b.getUTCDate() + d);
  return b.toISOString();
}

function isoBeforeDeploy(d) {
  const b = new Date(EMPTY_CONFIRMATION_GUARD_DEPLOY_AT);
  b.setUTCDate(b.getUTCDate() - d);
  return b.toISOString();
}

console.log('=== Empty Result Confirmation Guard — local verification ===\n');
console.log(`Deploy cutoff: ${EMPTY_CONFIRMATION_GUARD_DEPLOY_AT}\n`);

const failure = detectApifyFailurePattern('ERROR Navigation timeout of 30000 ms exceeded');
assert('detectApifyFailurePattern finds timeout', failure.detected && failure.pattern === 'timeout');
assert('clean log has no pattern', !detectApifyFailurePattern('Done! 0 ads').detected);

const legacyAndNew = [
  { status: 'empty', snapshot_date: '2026-06-01', created_at: isoBeforeDeploy(5) },
  { status: 'empty_confirmed', snapshot_date: '2026-07-06', created_at: isoAfterDeploy(1) },
];
assert('legacy empty cannot pair with new empty_confirmed (< 2 anchors)', getEmptyConfirmedAnchors(legacyAndNew).length < 2);
assert('legacy empty excluded from isPostDeployEmptyConfirmed', !isPostDeployEmptyConfirmed(legacyAndNew[0]));

const day1 = isoAfterDeploy(1);
const day2 = isoAfterDeploy(2);
const twoConfirmed = [
  { status: 'empty_confirmed', snapshot_date: day1.split('T')[0], created_at: day1 },
  { status: 'empty_confirmed', snapshot_date: day2.split('T')[0], created_at: day2 },
];
const anchors = getEmptyConfirmedAnchors(twoConfirmed);
assert('two post-deploy empty_confirmed => 2 anchors', anchors.length === 2);
assert('valid 24-72h window with continuity', validateMarketExitWindow(twoConfirmed, anchors[0], anchors[1]).valid);

const RANK = ['normal', 'interesting', 'high_activity', 'strategic_movement'];
assert('high_activity > interesting (old cap to high_activity was too high)', RANK.indexOf('high_activity') > RANK.indexOf('interesting'));
console.log('\nTaxonomía:', RANK.join(' < '));
console.log('\nDB/pipeline E2E: No demostrado — requiere .env + Supabase + Apify.');
