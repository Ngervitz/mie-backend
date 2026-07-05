const supabase = require('../clients/supabase');

// V1 heuristics — configurable, not statistically validated.
const MARKET_EXIT_MIN_HOURS = Number(process.env.MARKET_EXIT_MIN_HOURS || 24);
const MARKET_EXIT_MAX_HOURS = Number(process.env.MARKET_EXIT_MAX_HOURS || 72);

// Cutoff: only post-deploy `empty_confirmed` snapshots count toward market-exit pairs.
// Set EMPTY_CONFIRMATION_GUARD_DEPLOY_AT in Railway at deploy time (ISO 8601 UTC).
// Legacy status='empty' rows before this timestamp are excluded from confirmation counting.
const EMPTY_CONFIRMATION_GUARD_DEPLOY_AT = process.env.EMPTY_CONFIRMATION_GUARD_DEPLOY_AT
  || '2026-07-05T00:00:00.000Z';

const DEPLOY_CUTOFF_MS = new Date(EMPTY_CONFIRMATION_GUARD_DEPLOY_AT).getTime();

function normalizeSnapshotStatus(status) {
  if (status === 'empty') {
    return 'empty_confirmed';
  }
  return status;
}

function isPostDeployEmptyConfirmed(snapshot) {
  if (!snapshot || snapshot.status !== 'empty_confirmed') {
    return false;
  }

  if (Number.isNaN(DEPLOY_CUTOFF_MS)) {
    return false;
  }

  return new Date(snapshot.created_at).getTime() >= DEPLOY_CUTOFF_MS;
}

function shiftDateUtc(dateStr, deltaDays) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().split('T')[0];
}

function enumerateDaysInclusive(startDateStr, endDateStr) {
  const days = [];
  let current = startDateStr;

  while (current <= endDateStr) {
    days.push(current);
    current = shiftDateUtc(current, 1);
  }

  return days;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60);
}

function getEmptyConfirmedAnchors(snapshots) {
  const firstByDay = new Map();
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const snap of sorted) {
    if (!isPostDeployEmptyConfirmed(snap)) {
      continue;
    }

    const day = snap.snapshot_date;
    if (!firstByDay.has(day)) {
      firstByDay.set(day, snap);
    }
  }

  return [...firstByDay.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function validateMarketExitWindow(allSnapshots, first, second) {
  const hours = hoursBetween(first.created_at, second.created_at);
  if (hours < MARKET_EXIT_MIN_HOURS || hours > MARKET_EXIT_MAX_HOURS) {
    return { valid: false, reason: 'hours_out_of_range', hours };
  }

  const days = enumerateDaysInclusive(first.snapshot_date, second.snapshot_date);
  const daysWithAnySnapshot = new Set(allSnapshots.map((s) => s.snapshot_date));

  for (const day of days) {
    if (!daysWithAnySnapshot.has(day)) {
      return { valid: false, reason: 'observation_gap', gapDay: day };
    }
  }

  const t0 = new Date(first.created_at).getTime();
  const t1 = new Date(second.created_at).getTime();

  for (const snap of allSnapshots) {
    const t = new Date(snap.created_at).getTime();
    if (t <= t0 || t >= t1) {
      continue;
    }

    const status = normalizeSnapshotStatus(snap.status);
    if (status === 'success' || status === 'empty_unconfirmed') {
      return { valid: false, reason: 'invalidating_status_between', status: snap.status };
    }
  }

  return { valid: true };
}

async function loadEntitySnapshots(entityId) {
  const { data, error } = await supabase
    .from('ad_snapshots')
    .select('id, status, snapshot_date, created_at')
    .eq('entity_id', entityId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch snapshots for entity ${entityId}: ${error.message}`);
  }

  return data || [];
}

async function isMarketExitConfirmed(entityId, currentSnapshot) {
  if (!isPostDeployEmptyConfirmed(currentSnapshot)) {
    return false;
  }

  const snapshots = await loadEntitySnapshots(entityId);
  const anchors = getEmptyConfirmedAnchors(snapshots);

  if (anchors.length < 2) {
    return false;
  }

  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      const validation = validateMarketExitWindow(snapshots, anchors[i], anchors[j]);
      if (!validation.valid) {
        continue;
      }

      if (new Date(currentSnapshot.created_at) >= new Date(anchors[j].created_at)) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  MARKET_EXIT_MIN_HOURS,
  MARKET_EXIT_MAX_HOURS,
  EMPTY_CONFIRMATION_GUARD_DEPLOY_AT,
  normalizeSnapshotStatus,
  isPostDeployEmptyConfirmed,
  isMarketExitConfirmed,
  getEmptyConfirmedAnchors,
  validateMarketExitWindow,
  enumerateDaysInclusive,
};
