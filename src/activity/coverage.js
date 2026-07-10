const {
  WINDOW_DAYS,
  MAX_BASELINE_BLOCKS,
  VALID_SNAPSHOT_STATUSES,
} = require('./constants');
const { shiftDateUtc, enumerateDaysHalfOpen } = require('./dates');

function buildCurrentWindow(executionDate) {
  // 7 calendar days ending on execution_date, semi-open [start, end).
  // Same pattern as reports history: end exclusive = execution_date + 1.
  const currentWindowEnd = shiftDateUtc(executionDate, 1);
  const currentWindowStart = shiftDateUtc(executionDate, -(WINDOW_DAYS - 1));
  return { currentWindowStart, currentWindowEnd };
}

function buildBaselineBlocks(currentWindowStart) {
  const blocks = [];
  let end = currentWindowStart;

  for (let i = 0; i < MAX_BASELINE_BLOCKS; i += 1) {
    const start = shiftDateUtc(end, -WINDOW_DAYS);
    blocks.push({ start, end });
    end = start;
  }

  return blocks;
}

/**
 * Latest snapshot for a calendar day: ORDER BY created_at DESC, first row.
 * Matches reports.js / Run History Integrity convention.
 */
function latestSnapshotForDay(snapshotsByDate, day) {
  const list = snapshotsByDate.get(day);
  if (!list || list.length === 0) {
    return null;
  }
  return list[0];
}

function isDayCoverageValid(snapshotsByDate, day) {
  const snap = latestSnapshotForDay(snapshotsByDate, day);
  if (!snap) {
    return false;
  }
  return VALID_SNAPSHOT_STATUSES.has(snap.status);
}

function isBlockCoverageValid(snapshotsByDate, start, end) {
  const days = enumerateDaysHalfOpen(start, end);
  if (days.length === 0) {
    return false;
  }
  return days.every((day) => isDayCoverageValid(snapshotsByDate, day));
}

function indexSnapshotsByDate(snapshots) {
  const map = new Map();
  const sorted = [...(snapshots || [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  for (const snap of sorted) {
    const day = snap.snapshot_date;
    if (!day) continue;
    if (!map.has(day)) {
      map.set(day, []);
    }
    map.get(day).push(snap);
  }

  return map;
}

module.exports = {
  buildCurrentWindow,
  buildBaselineBlocks,
  latestSnapshotForDay,
  isDayCoverageValid,
  isBlockCoverageValid,
  indexSnapshotsByDate,
};
