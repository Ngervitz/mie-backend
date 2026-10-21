'use strict';

/**
 * Attribute Credizona solicitudes to affiliates.
 * Reads funnel rows and affiliate_clicks. Writes attributions, originators
 * and the per-cédula evaluation instant through persist_affiliate_plan.
 * Does not update cz_funnel_solicitudes.
 *
 * The 30-day window uses presentation_at with an explicit zone and the click's
 * occurred_at. A naive timestamp is not a presentation time.
 *
 * One cz_click may attribute several solicitudes of the same cédula inside
 * that window. The same click on two cédulas is click_ci_conflict and is not
 * an automatic remunerable attribution.
 *
 * Credizona's current includes/inc.config.php calls
 * date_default_timezone_set('America/Buenos_Aires') on each request that loads
 * it. Date::getNow() then stores fechaReg without an offset. The clone's
 * php.ini, .user.ini and .htaccess do not set date.timezone. This module does
 * not reinterpret those historical strings onto a zone.
 *
 * is_test is copied from the affiliate. prize_eligible stays false: a test
 * affiliate cannot be paid, and a real attribution is not remunerable by itself.
 * A future prize would be one per granted loan that pays Copanel, deduped by loan.
 */

const {
  normalizeCzClick,
  normalizePresentationAt,
} = require('./sanitizeCzTrackingData');

const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SELECT_CHUNK = 200;

const OUTCOMES = Object.freeze([
  'no_click',
  'unknown_click',
  'unknown_affiliate',
  'no_presentation_at',
  'no_occurred_at',
  'click_after_presentation',
  'expired',
  'no_ci',
  'click_ci_conflict',
  'ambiguous_fecha_reg',
  'blocked_ambiguous_history',
  'excluded_prior_solicitud',
  'other_affiliate',
  'attributed',
]);

function normalizeId(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function summaryOf(row) {
  const raw =
    row && row.tracking_data_summary != null
      ? row.tracking_data_summary
      : row && row.tracking_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_err) {
      return {};
    }
  }
  return {};
}

function explicitInstant(raw) {
  if (raw == null || raw === '') return null;
  const text = raw instanceof Date ? raw.toISOString() : String(raw).trim();
  const zoned = normalizePresentationAt(text);
  if (!zoned) return null;
  const ms = new Date(zoned).getTime();
  if (Number.isNaN(ms)) return null;
  return { ms: ms, text: zoned };
}

function compareOrder(a, b) {
  const aMissing = a.orderMs == null;
  const bMissing = b.orderMs == null;
  if (aMissing && bMissing) return a.czId - b.czId;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (a.orderMs !== b.orderMs) return a.orderMs - b.orderMs;
  return a.czId - b.czId;
}

function indexClicks(clicks) {
  const byId = new Map();
  const list = clicks || [];
  for (let i = 0; i < list.length; i += 1) {
    const click = list[i];
    const clickId = normalizeCzClick(click && click.click_id);
    if (!clickId || byId.has(clickId)) continue;
    const occurred = explicitInstant(click.occurred_at);
    const affiliateId =
      click.affiliate_id == null || click.affiliate_id === ''
        ? null
        : String(click.affiliate_id);
    byId.set(clickId, {
      clickId: clickId,
      affiliateId: affiliateId,
      occurredMs: occurred ? occurred.ms : null,
      occurredText: occurred ? occurred.text : null,
      isTest: click.is_test === true,
      knownAffiliate: click.known_affiliate !== false && affiliateId != null,
    });
  }
  return byId;
}

function buildRecord(raw, czId, clicksById) {
  const summary = summaryOf(raw);
  const presented = explicitInstant(summary.presentation_at);
  const fecha = explicitInstant(raw && raw.fecha_reg);
  const clickId = normalizeCzClick(summary.cz_click);
  const click = clickId ? clicksById.get(clickId) : null;
  const rec = {
    czId: czId,
    ci: normalizeId(raw && raw.ci),
    clickId: click ? click.clickId : null,
    affiliateId: click && click.knownAffiliate ? click.affiliateId : null,
    occurredMs: click ? click.occurredMs : null,
    occurredText: click ? click.occurredText : null,
    presentationMs: presented ? presented.ms : null,
    presentationText: presented ? presented.text : null,
    orderMs: presented ? presented.ms : fecha ? fecha.ms : null,
    unorderable: !presented && !fecha,
    isTest: !!(click && click.knownAffiliate && click.isTest),
    outcome: 'no_click',
  };

  if (!clickId) {
    rec.outcome = 'no_click';
    return rec;
  }
  if (!click) {
    rec.outcome = 'unknown_click';
    return rec;
  }
  if (!click.knownAffiliate || !click.affiliateId) {
    rec.outcome = 'unknown_affiliate';
    return rec;
  }
  if (!presented) {
    rec.outcome = 'no_presentation_at';
    return rec;
  }
  if (click.occurredMs == null) {
    rec.outcome = 'no_occurred_at';
    return rec;
  }
  const delta = presented.ms - click.occurredMs;
  if (delta < 0) {
    rec.outcome = 'click_after_presentation';
    return rec;
  }
  if (delta > ATTRIBUTION_WINDOW_MS) {
    rec.outcome = 'expired';
    return rec;
  }
  rec.outcome = 'window_ok';
  return rec;
}

function ciBucket(row) {
  if (row.ci == null) return 'missing:' + row.czId;
  return 'ci:' + row.ci;
}

function assignClickConflicts(records) {
  const bucketsByClick = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    if (!row.clickId) continue;
    if (!bucketsByClick.has(row.clickId)) bucketsByClick.set(row.clickId, new Set());
    bucketsByClick.get(row.clickId).add(ciBucket(row));
  }
  const conflicted = new Set();
  bucketsByClick.forEach(function (buckets, clickId) {
    if (buckets.size > 1) conflicted.add(clickId);
  });
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    if (row.outcome === 'window_ok' && conflicted.has(row.clickId)) {
      row.outcome = 'click_ci_conflict';
    }
  }
}

function assignOriginators(records) {
  const byCi = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    if (row.ci == null) {
      if (row.outcome === 'window_ok') row.outcome = 'no_ci';
      continue;
    }
    if (!byCi.has(row.ci)) byCi.set(row.ci, []);
    byCi.get(row.ci).push(row);
  }

  const originators = [];
  const cis = Array.from(byCi.keys()).sort(function (a, b) {
    return a - b;
  });
  for (let c = 0; c < cis.length; c += 1) {
    const ci = cis[c];
    const rows = byCi.get(ci).slice().sort(compareOrder);
    if (rows.some(function (row) { return row.unorderable; })) {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.unorderable && row.outcome === 'no_click') {
          row.outcome = 'ambiguous_fecha_reg';
        } else if (row.outcome === 'window_ok') {
          row.outcome = 'blocked_ambiguous_history';
        }
      }
      continue;
    }
    let origin = null;
    let blocked = false;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!origin && !blocked) {
        if (row.outcome === 'window_ok') {
          row.outcome = 'attributed';
          origin = row;
        } else if (row.orderMs != null) {
          blocked = true;
        }
        continue;
      }
      if (blocked) {
        if (row.outcome === 'window_ok') row.outcome = 'excluded_prior_solicitud';
        continue;
      }
      if (row.outcome !== 'window_ok') continue;
      if (row.affiliateId === origin.affiliateId) row.outcome = 'attributed';
      else row.outcome = 'other_affiliate';
    }
    if (origin) {
      originators.push({
        ci: ci,
        affiliate_id: origin.affiliateId,
        first_cz_id: origin.czId,
        first_presentation_at: new Date(origin.presentationMs).toISOString(),
        is_test: origin.isTest === true,
        prize_eligible: false,
      });
    }
  }
  return originators;
}

function toAttribution(row) {
  return {
    cz_id: row.czId,
    ci: row.ci,
    outcome: row.outcome,
    click_id: row.clickId,
    affiliate_id: row.affiliateId,
    occurred_at: row.occurredText,
    presentation_at:
      row.presentationMs == null
        ? null
        : new Date(row.presentationMs).toISOString(),
    presentation_text: row.presentationText,
    is_test: row.isTest === true,
    prize_eligible: false,
  };
}

/**
 * @param {Array<object>} solicitudes funnel rows
 * @param {Array<object>} clicks affiliate_clicks joined with is_test
 * @returns {{ attributions: Array<object>, originators: Array<object> }}
 */
function evaluateAffiliateAttributions(solicitudes, clicks) {
  const clicksById = indexClicks(clicks);
  const records = [];
  const seen = new Set();
  const list = solicitudes || [];
  for (let i = 0; i < list.length; i += 1) {
    const czId = normalizeId(list[i] && list[i].cz_id);
    if (czId == null || seen.has(czId)) continue;
    seen.add(czId);
    records.push(buildRecord(list[i], czId, clicksById));
  }
  assignClickConflicts(records);
  const originators = assignOriginators(records);
  const attributions = records.map(toAttribution).sort(function (a, b) {
    return a.cz_id - b.cz_id;
  });
  return { attributions: attributions, originators: originators };
}

function uniqueIds(values) {
  const out = [];
  const seen = new Set();
  const list = values || [];
  for (let i = 0; i < list.length; i += 1) {
    const id = normalizeId(list[i]);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function selectIn(supabase, table, column, ids, columns) {
  const rows = [];
  for (let i = 0; i < ids.length; i += SELECT_CHUNK) {
    const chunk = ids.slice(i, i + SELECT_CHUNK);
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in(column, chunk);
    if (error) {
      throw new Error(table + ' lookup failed');
    }
    const list = data || [];
    for (let j = 0; j < list.length; j += 1) rows.push(list[j]);
  }
  return rows;
}

function clickIdsFrom(rows) {
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const clickId = normalizeCzClick(summaryOf(rows[i]).cz_click);
    if (!clickId || seen.has(clickId)) continue;
    seen.add(clickId);
    ids.push(clickId);
  }
  return ids;
}

/**
 * Load the named solicitudes, their cédula siblings, and the clicks they name.
 * Historical funnel rows are selected, never updated.
 * @param {object} supabase
 * @param {Array<number>} czIds
 * @param {{ evaluatedAt?: string }} [options]
 */
async function attributeSolicitudesByCzId(supabase, czIds, options) {
  const ids = uniqueIds(czIds);
  if (!ids.length) {
    return { attributions: [], originators: [], ciScope: [] };
  }
  const seed = await selectIn(
    supabase,
    'cz_funnel_solicitudes',
    'cz_id',
    ids,
    'cz_id, ci, fecha_reg, tracking_data_summary',
  );
  const cis = uniqueIds(
    seed.map(function (row) {
      return row.ci;
    }),
  );
  const siblings = cis.length
    ? await selectIn(
        supabase,
        'cz_funnel_solicitudes',
        'ci',
        cis,
        'cz_id, ci, fecha_reg, tracking_data_summary',
      )
    : [];
  const merged = new Map();
  const combined = seed.concat(siblings);
  for (let i = 0; i < combined.length; i += 1) {
    const czId = normalizeId(combined[i] && combined[i].cz_id);
    if (czId == null || merged.has(czId)) continue;
    merged.set(czId, combined[i]);
  }
  const rows = Array.from(merged.values());
  const clickIds = clickIdsFrom(rows);
  const clickRows = clickIds.length
    ? await selectIn(
        supabase,
        'affiliate_clicks',
        'click_id',
        clickIds,
        'click_id, affiliate_id, occurred_at',
      )
    : [];
  const affiliateIds = [];
  const seenAffiliates = new Set();
  for (let i = 0; i < clickRows.length; i += 1) {
    const affiliateId = clickRows[i] && clickRows[i].affiliate_id;
    if (affiliateId == null || seenAffiliates.has(String(affiliateId))) continue;
    seenAffiliates.add(String(affiliateId));
    affiliateIds.push(affiliateId);
  }
  const affiliateRows = affiliateIds.length
    ? await selectIn(
        supabase,
        'affiliates',
        'id',
        affiliateIds,
        'id, is_test, status',
      )
    : [];
  const affiliatesById = new Map();
  for (let i = 0; i < affiliateRows.length; i += 1) {
    affiliatesById.set(String(affiliateRows[i].id), affiliateRows[i]);
  }
  const clicks = clickRows.map(function (click) {
    const affiliate = affiliatesById.get(String(click.affiliate_id));
    return {
      click_id: click.click_id,
      affiliate_id: click.affiliate_id,
      occurred_at: click.occurred_at,
      is_test: !!(affiliate && affiliate.is_test === true),
      known_affiliate: !!affiliate,
    };
  });
  const plan = evaluateAffiliateAttributions(rows, clicks);
  plan.ciScope = cis;
  await persistAffiliatePlan(supabase, plan, options);
  return plan;
}

async function persistAffiliatePlan(supabase, plan, options) {
  const evaluatedAt =
    options && options.evaluatedAt
      ? String(options.evaluatedAt)
      : new Date().toISOString();
  const ciScope = uniqueIds(plan.ciScope || []);
  const attributions = (plan.attributions || []).map(function (row) {
    return Object.assign({}, row, {
      prize_eligible: false,
      is_test: row.is_test === true,
    });
  });
  const originators = (plan.originators || []).map(function (row) {
    return Object.assign({}, row, {
      prize_eligible: false,
      is_test: row.is_test === true,
    });
  });
  const { data, error } = await supabase.rpc('persist_affiliate_plan', {
    p_evaluated_at: evaluatedAt,
    p_ci_scope: ciScope,
    p_attributions: attributions,
    p_originators: originators,
  });
  if (
    error ||
    !data ||
    !Array.isArray(data.applied_ci) ||
    !Array.isArray(data.skipped_ci) ||
    !Array.isArray(data.skipped_cz_id)
  ) {
    throw new Error('persist_affiliate_plan failed');
  }
  plan.persistence = {
    appliedCi: data.applied_ci,
    skippedCi: data.skipped_ci,
    skippedCzId: data.skipped_cz_id,
  };
  return plan.persistence;
}

module.exports = {
  ATTRIBUTION_WINDOW_MS,
  OUTCOMES,
  evaluateAffiliateAttributions,
  attributeSolicitudesByCzId,
  persistAffiliatePlan,
};
