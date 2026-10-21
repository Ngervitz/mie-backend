'use strict';

/**
 * Job: affiliate_attribution
 * Cadence: none registered. POST /jobs/run-affiliate-attribution
 * (session or X-Cron-Key), after the Credizona funnel sync.
 *
 * Does not run inside POST /jobs/run-cz-data-sync and does not write
 * cz_funnel_solicitudes. Idle unless enabled is exactly true.
 * prize_eligible stays false. No prizes and no payments.
 *
 * A solicitud stays pending until its attribution upsert succeeds.
 * Each run reloads pending rows together with their cédula siblings and
 * every solicitud that shares their cz_click, then recalculates.
 */

const { randomUUID } = require('crypto');
const logger = require('../lib/logger');
const { normalizeCzClick } = require('../lib/sanitizeCzTrackingData');
const {
  attributeSolicitudesByCzId,
} = require('../lib/affiliateAttribution');

const JOB_NAME = 'affiliate_attribution';
const JOB_LOCK_TTL_SECONDS = 15 * 60;
const PAGE_SIZE = 500;

function clientOf(options) {
  if (options && options.supabase) return options.supabase;
  return require('../clients/supabase');
}

function emptySummary(enabled, extra) {
  return Object.assign(
    {
      ok: true,
      enabled: enabled === true,
      processed: 0,
      attributed: 0,
      excludedByReason: {},
      pending: enabled === true ? 0 : null,
      skipped: enabled === true ? 0 : null,
      errors: 0,
    },
    extra || {},
  );
}

function clickOf(row) {
  const summary = row && row.tracking_data_summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }
  return normalizeCzClick(summary.cz_click);
}

function safeId(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function isFresh(row, attribution) {
  if (!attribution) return false;
  const synced = Date.parse(row && row.synced_at ? row.synced_at : '');
  const evaluated = Date.parse(
    attribution.evaluated_at ? attribution.evaluated_at : '',
  );
  return (
    Number.isFinite(synced) &&
    Number.isFinite(evaluated) &&
    synced <= evaluated
  );
}

/**
 * Pending: no successful evaluation, a funnel write newer than evaluated_at,
 * or an originator that no longer matches an attributed row of that cédula.
 */
function pendingSeeds(funnel, attributions, originators) {
  const attrByCz = new Map();
  for (let i = 0; i < attributions.length; i += 1) {
    const czId = safeId(attributions[i] && attributions[i].cz_id);
    if (czId != null) attrByCz.set(czId, attributions[i]);
  }
  const originByCi = new Map();
  for (let i = 0; i < originators.length; i += 1) {
    const ci = safeId(originators[i] && originators[i].ci);
    if (ci != null) originByCi.set(ci, originators[i]);
  }
  const pending = new Set();
  const rowsByCi = new Map();
  for (let i = 0; i < funnel.length; i += 1) {
    const row = funnel[i];
    const czId = safeId(row && row.cz_id);
    if (czId == null) continue;
    if (!isFresh(row, attrByCz.get(czId))) pending.add(czId);
    const ci = safeId(row.ci);
    if (ci == null) continue;
    if (!rowsByCi.has(ci)) rowsByCi.set(ci, []);
    rowsByCi.get(ci).push(row);
  }
  rowsByCi.forEach(function (rows, ci) {
    const attributed = [];
    for (let i = 0; i < rows.length; i += 1) {
      const czId = safeId(rows[i].cz_id);
      const attr = czId == null ? null : attrByCz.get(czId);
      if (attr && attr.outcome === 'attributed') attributed.push(czId);
    }
    const origin = originByCi.get(ci);
    const originCz = origin ? safeId(origin.first_cz_id) : null;
    const matches =
      originCz != null && attributed.indexOf(originCz) !== -1;
    if (attributed.length && !matches) pending.add(safeId(rows[0].cz_id));
    if (origin && !matches) pending.add(safeId(rows[0].cz_id));
  });
  return Array.from(pending).filter(function (id) {
    return id != null;
  });
}

function expandClosure(funnel, seeds) {
  const byCz = new Map();
  const byCi = new Map();
  const byClick = new Map();
  for (let i = 0; i < funnel.length; i += 1) {
    const row = funnel[i];
    const czId = safeId(row && row.cz_id);
    if (czId == null) continue;
    byCz.set(czId, row);
    const ci = safeId(row.ci);
    if (ci != null) {
      if (!byCi.has(ci)) byCi.set(ci, []);
      byCi.get(ci).push(czId);
    }
    const click = clickOf(row);
    if (click) {
      if (!byClick.has(click)) byClick.set(click, []);
      byClick.get(click).push(czId);
    }
  }
  const included = new Set();
  const queue = seeds.slice();
  while (queue.length) {
    const czId = queue.pop();
    if (czId == null || included.has(czId) || !byCz.has(czId)) continue;
    included.add(czId);
    const row = byCz.get(czId);
    const ci = safeId(row.ci);
    if (ci != null && byCi.has(ci)) {
      const siblings = byCi.get(ci);
      for (let i = 0; i < siblings.length; i += 1) queue.push(siblings[i]);
    }
    const click = clickOf(row);
    if (click && byClick.has(click)) {
      const users = byClick.get(click);
      for (let i = 0; i < users.length; i += 1) queue.push(users[i]);
    }
  }
  return Array.from(included).sort(function (a, b) {
    return a - b;
  });
}

async function selectPages(supabase, table, columns) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(table + ' lookup failed');
    const list = data || [];
    for (let i = 0; i < list.length; i += 1) rows.push(list[i]);
    if (list.length < PAGE_SIZE) break;
  }
  return rows;
}

async function acquireJobLock(supabase, lockedBy) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) throw new Error('acquire_job_lock failed');
  return data === true;
}

async function releaseJobLock(supabase, lockedBy) {
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', { jobName: JOB_NAME });
  }
}

function countPlan(plan) {
  const persistence = plan && plan.persistence;
  const skippedCi = new Set(
    ((persistence && persistence.skippedCi) || []).map(Number),
  );
  const skippedCz = new Set(
    ((persistence && persistence.skippedCzId) || []).map(Number),
  );
  const excludedByReason = {};
  let processed = 0;
  let attributed = 0;
  const rows = (plan && plan.attributions) || [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.ci != null && skippedCi.has(Number(row.ci))) continue;
    if (skippedCz.has(Number(row.cz_id))) continue;
    processed += 1;
    if (row.outcome === 'attributed') {
      attributed += 1;
    } else {
      const reason = row.outcome || 'unknown';
      excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
    }
  }
  return {
    processed: processed,
    attributed: attributed,
    excludedByReason: excludedByReason,
    skipped: skippedCi.size + skippedCz.size,
  };
}

function logSummary(summary) {
  logger.info('affiliate_attribution completed', {
    enabled: summary.enabled,
    processed: summary.processed,
    attributed: summary.attributed,
    excludedByReason: summary.excludedByReason,
    pending: summary.pending,
    skipped: summary.skipped,
    errors: summary.errors,
  });
}

/**
 * @param {{ enabled?: boolean, supabase?: object, evaluatedAt?: string }} [options]
 */
async function runAffiliateAttribution(options) {
  const enabled = !!(options && options.enabled === true);
  if (!enabled) {
    const skipped = emptySummary(false);
    logSummary(skipped);
    return skipped;
  }

  const supabase = clientOf(options);
  const lockedBy = randomUUID();
  let acquired = false;
  let pendingCount = null;
  try {
    acquired = await acquireJobLock(supabase, lockedBy);
    if (!acquired) {
      const busy = emptySummary(true, {
        ok: false,
        reason: 'lock_not_acquired',
        pending: null,
      });
      logSummary(busy);
      return busy;
    }

    const funnel = await selectPages(
      supabase,
      'cz_funnel_solicitudes',
      'cz_id, ci, synced_at, tracking_data_summary',
    );
    const attributions = await selectPages(
      supabase,
      'affiliate_attributions',
      'cz_id, evaluated_at, outcome',
    );
    const originators = await selectPages(
      supabase,
      'affiliate_originators',
      'ci, first_cz_id',
    );
    const seeds = pendingSeeds(funnel, attributions, originators);
    pendingCount = seeds.length;
    if (!seeds.length) {
      const idle = emptySummary(true);
      logSummary(idle);
      return idle;
    }

    const czIds = expandClosure(funnel, seeds);
    const plan = await attributeSolicitudesByCzId(supabase, czIds, {
      evaluatedAt: options && options.evaluatedAt,
    });
    const counts = countPlan(plan);
    const done = emptySummary(true, counts);
    logSummary(done);
    return done;
  } catch (_err) {
    const failed = emptySummary(true, {
      ok: false,
      pending: pendingCount,
      errors: 1,
    });
    logSummary(failed);
    return failed;
  } finally {
    if (acquired) await releaseJobLock(supabase, lockedBy);
  }
}

module.exports = {
  JOB_NAME,
  runAffiliateAttribution,
  pendingSeeds,
  expandClosure,
};
