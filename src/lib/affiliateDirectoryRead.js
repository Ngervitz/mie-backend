'use strict';

/**
 * Service-role reads and the admin insert for the affiliate directory.
 * Does not call persist_affiliate_plan and does not recompute attribution.
 */

const { normalizeCzClick } = require('./sanitizeCzTrackingData');
const {
  parseCi,
  describeOutcome,
  describeAffiliateAdhesion,
  isAffiliateAdhesionValidated,
  listCell,
  planAffiliateInsert,
  splitAttributions,
  formatAffiliateDisplayName,
  EXCLUSION_OUTCOMES,
  LIST_CAP,
} = require('./affiliateDirectory');

const {
  aggregateAffiliateInviteOutreach,
} = require('./affiliateInviteOutreachMetrics');

const PAGE = 500;
const IN_CHUNK = 200;
/** Affiliate invite rows in email_campaign_recipients (2-recipient + 7-recipient pilots). */
const AFFILIATE_INVITE_IDEMPOTENCY_LIKE = 'affiliate-pilot%';

function schemaMissing(err) {
  const code = err && err.code != null ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return code === '42703' || code === '42P01' || /does not exist/i.test(msg);
}

function uniqueViolation(err) {
  const code = err && err.code != null ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

async function pageAll(runPage) {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await runPage(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    all.push.apply(all, rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function selectIn(supabase, table, columns, field, ids) {
  const unique = [];
  const seen = new Set();
  ids.forEach(function (id) {
    if (id == null || seen.has(id)) return;
    seen.add(id);
    unique.push(id);
  });
  const all = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const rows = await pageAll(function (from, to) {
      return supabase.from(table).select(columns).in(field, chunk).range(from, to);
    });
    all.push.apply(all, rows);
  }
  return all;
}

async function ciExistsInFunnel(supabase, ci) {
  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id')
    .eq('ci', ci)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * @returns {Promise<{ ok: true, affiliate: object }|{ ok: false, status: number, error: string }>}
 */
async function createAffiliate(supabase, body, acceptedAt) {
  const plan = planAffiliateInsert(body, acceptedAt);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  if (!plan.row.is_test) {
    const exists = await ciExistsInFunnel(supabase, plan.row.ci);
    if (!exists) {
      return { ok: false, status: 400, error: 'La CI no tiene solicitudes en JANUS' };
    }
  }
  const { data, error } = await supabase
    .from('affiliates')
    .insert(plan.row)
    .select(
      'id, code, status, is_test, ci, accepted_at, acceptance_channel, terms_version, acceptance_evidence, created_at',
    )
    .single();
  if (error) {
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliates_identity_not_ready' };
    }
    if (uniqueViolation(error)) {
      return { ok: false, status: 409, error: 'Código o CI ya registrado' };
    }
    throw error;
  }
  return { ok: true, affiliate: data };
}

const AFFILIATE_COLUMNS =
  'id, code, status, is_test, ci, accepted_at, acceptance_channel, terms_version, acceptance_evidence, created_at';

async function listAffiliates(supabase) {
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliates')
      .select(AFFILIATE_COLUMNS)
      .order('created_at', { ascending: false })
      .range(from, to);
  });
  return rows;
}

function incrementCount(map, affiliateId) {
  if (!affiliateId) return;
  const key = String(affiliateId);
  map.set(key, (map.get(key) || 0) + 1);
}

async function aggregateClickCountsByAffiliate(supabase) {
  const counts = new Map();
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_clicks')
      .select('affiliate_id')
      .order('click_id', { ascending: true })
      .range(from, to);
  });
  rows.forEach(function (row) {
    incrementCount(counts, row.affiliate_id);
  });
  return counts;
}

async function countExactHead(supabase, table, applyFilters) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (applyFilters) query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw error;
  return typeof count === 'number' ? count : null;
}

async function countAffiliateInviteEmailsSent(supabase) {
  try {
    return await countExactHead(supabase, 'email_campaign_recipients', function (q) {
      return q.eq('status', 'sent').like('idempotency_key', AFFILIATE_INVITE_IDEMPOTENCY_LIKE);
    });
  } catch (err) {
    if (schemaMissing(err)) return null;
    throw err;
  }
}

async function countValidatedAffiliates(supabase) {
  try {
    const rows = await listAffiliates(supabase);
    let n = 0;
    rows.forEach(function (row) {
      if (isAffiliateAdhesionValidated(row)) n += 1;
    });
    return n;
  } catch (err) {
    if (schemaMissing(err)) return null;
    throw err;
  }
}

async function countActiveAffiliates(supabase) {
  try {
    const rows = await listAffiliates(supabase);
    let n = 0;
    rows.forEach(function (row) {
      if (row.is_test === true) return;
      if (String(row.status || '').toLowerCase() === 'active') n += 1;
    });
    return n;
  } catch (err) {
    if (schemaMissing(err)) return null;
    throw err;
  }
}

async function latestPersonNamesByCi(supabase, cis) {
  const parsed = [];
  const seen = new Set();
  (cis || []).forEach(function (raw) {
    const ci = parseCi(raw);
    if (ci == null || seen.has(ci)) return;
    seen.add(ci);
    parsed.push(ci);
  });
  if (!parsed.length) return new Map();
  try {
    const rows = await selectIn(
      supabase,
      'cz_funnel_solicitudes',
      'ci, nombre, apellido, cz_id',
      'ci',
      parsed,
    );
    const best = new Map();
    rows.forEach(function (row) {
      const ci = parseCi(row.ci);
      const czId = Number(row.cz_id);
      if (ci == null || !Number.isSafeInteger(czId)) return;
      const prev = best.get(ci);
      if (!prev || czId > prev.cz_id) {
        best.set(ci, {
          cz_id: czId,
          nombre: row.nombre,
          apellido: row.apellido,
        });
      }
    });
    const out = new Map();
    best.forEach(function (row, ci) {
      const name = formatAffiliateDisplayName(row.nombre, row.apellido, ci);
      if (name) out.set(ci, name);
    });
    return out;
  } catch (err) {
    if (schemaMissing(err)) return new Map();
    throw err;
  }
}

async function attachAffiliateDisplayNames(supabase, rows) {
  const cis = (rows || []).map(function (row) {
    return row.ci;
  });
  const names = await latestPersonNamesByCi(supabase, cis);
  return (rows || []).map(function (row) {
    const ci = parseCi(row.ci);
    let display_name = null;
    if (ci != null) {
      display_name = names.get(ci) || String(ci);
    } else if (row.code) {
      display_name = String(row.code);
    }
    return Object.assign({}, row, {
      display_name: display_name,
    });
  });
}

async function aggregateExcludedCountsByAffiliate(supabase) {
  const counts = new Map();
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_attributions')
      .select('affiliate_id, outcome')
      .in('outcome', EXCLUSION_OUTCOMES)
      .order('cz_id', { ascending: true })
      .range(from, to);
  });
  rows.forEach(function (row) {
    incrementCount(counts, row.affiliate_id);
  });
  return counts;
}

/**
 * Global KPI aggregates for the Afiliados dashboard (read-only).
 */
async function aggregateAffiliateDashboardSummary(supabase) {
  const summary = {
    active_affiliates_count: null,
    invitations_sent: null,
    registered_validated: null,
    clicks: null,
    referral_link_clicks: null,
    attributed_solicitudes: null,
    excluded_solicitudes: null,
    invite_outreach: null,
  };

  summary.invitations_sent = await countAffiliateInviteEmailsSent(supabase);

  try {
    summary.active_affiliates_count = await countActiveAffiliates(supabase);
  } catch (err) {
    if (!schemaMissing(err)) throw err;
  }

  try {
    summary.invite_outreach = await aggregateAffiliateInviteOutreach(
      supabase,
      countAffiliateInviteEmailsSent,
    );
  } catch (err) {
    if (!schemaMissing(err)) throw err;
  }

  try {
    summary.registered_validated = await countValidatedAffiliates(supabase);
  } catch (err) {
    if (!schemaMissing(err)) throw err;
  }

  try {
    summary.referral_link_clicks = await countExactHead(supabase, 'affiliate_clicks');
    summary.clicks = summary.referral_link_clicks;
  } catch (err) {
    if (schemaMissing(err)) {
      summary.clicks = null;
      summary.referral_link_clicks = null;
    } else throw err;
  }

  try {
    summary.attributed_solicitudes = await countExactHead(
      supabase,
      'affiliate_attributions',
      function (q) {
        return q.eq('outcome', 'attributed');
      },
    );
  } catch (err) {
    if (schemaMissing(err)) summary.attributed_solicitudes = null;
    else throw err;
  }

  try {
    summary.excluded_solicitudes = await countExactHead(
      supabase,
      'affiliate_attributions',
      function (q) {
        return q.in('outcome', EXCLUSION_OUTCOMES);
      },
    );
  } catch (err) {
    if (schemaMissing(err)) summary.excluded_solicitudes = null;
    else throw err;
  }

  return summary;
}

async function aggregateAttributedCountsByAffiliate(supabase) {
  const counts = new Map();
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_attributions')
      .select('affiliate_id, outcome')
      .eq('outcome', 'attributed')
      .order('cz_id', { ascending: true })
      .range(from, to);
  });
  rows.forEach(function (row) {
    incrementCount(counts, row.affiliate_id);
  });
  return counts;
}

/**
 * Directory list with per-row click and attributed counts (read-only aggregates).
 */
async function listAffiliatesWithRowStats(supabase) {
  const affiliates = await listAffiliates(supabase);
  const [clickCounts, attributedCounts, excludedCounts] = await Promise.all([
    aggregateClickCountsByAffiliate(supabase),
    aggregateAttributedCountsByAffiliate(supabase),
    aggregateExcludedCountsByAffiliate(supabase),
  ]);
  const enriched = affiliates.map(function (row) {
    const id = String(row.id);
    return Object.assign({}, row, {
      click_count: clickCounts.get(id) || 0,
      attributed_count: attributedCounts.get(id) || 0,
      excluded_count: excludedCounts.get(id) || 0,
      adhesion: describeAffiliateAdhesion(row),
      loans_granted: null,
      commissions: null,
    });
  });
  return attachAffiliateDisplayNames(supabase, enriched);
}

async function getAffiliate(supabase, id) {
  const { data, error } = await supabase
    .from('affiliates')
    .select(AFFILIATE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const rows = await attachAffiliateDisplayNames(supabase, [data]);
  return rows[0] || null;
}

async function listClicks(supabase, affiliateId) {
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_clicks')
      .select('click_id, occurred_at, user_agent, referer')
      .eq('affiliate_id', affiliateId)
      .order('occurred_at', { ascending: false })
      .range(from, to);
  });
  return {
    filter: 'sin_filtrar',
    note: 'Cada fila es un GET aceptado. Incluye bots y posibles vistas previas. HEAD no se guarda.',
    count: rows.length,
    clicks: rows.slice(0, LIST_CAP),
  };
}

async function clickIdsOf(supabase, affiliateId) {
  const rows = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_clicks')
      .select('click_id')
      .eq('affiliate_id', affiliateId)
      .range(from, to);
  });
  return rows
    .map(function (row) {
      return row.click_id ? String(row.click_id).toLowerCase() : null;
    })
    .filter(Boolean);
}

async function attributedCzIds(supabase) {
  const rows = await pageAll(function (from, to) {
    return supabase.from('affiliate_attributions').select('cz_id').range(from, to);
  });
  const set = new Set();
  rows.forEach(function (row) {
    const id = Number(row.cz_id);
    if (Number.isSafeInteger(id)) set.add(id);
  });
  return set;
}

/**
 * Solicitudes whose stored cz_click has no affiliate_attributions row.
 * Does not decide whether they would attribute.
 */
async function countClicksWithoutAttribution(supabase) {
  const known = await attributedCzIds(supabase);
  let count = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, tracking_data_summary')
      .not('tracking_data_summary->>cz_click', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach(function (row) {
      const summary = row.tracking_data_summary;
      const click =
        summary && typeof summary === 'object' ? normalizeCzClick(summary.cz_click) : null;
      const czId = Number(row.cz_id);
      if (!click || !Number.isSafeInteger(czId)) return;
      if (!known.has(czId)) count += 1;
    });
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return { count: count };
}

async function solicitudesForAffiliate(supabase, affiliateId) {
  const stored = await pageAll(function (from, to) {
    return supabase
      .from('affiliate_attributions')
      .select('cz_id, ci, outcome, presentation_at, evaluated_at, click_id')
      .eq('affiliate_id', affiliateId)
      .order('cz_id', { ascending: true })
      .range(from, to);
  });
  const split = splitAttributions(stored);
  const clicks = new Set(await clickIdsOf(supabase, affiliateId));
  const known = await attributedCzIds(supabase);
  const inProgress = [];
  if (clicks.size) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('cz_funnel_solicitudes')
        .select('cz_id, tracking_data_summary')
        .not('tracking_data_summary->>cz_click', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      rows.forEach(function (row) {
        const summary = row.tracking_data_summary;
        const click =
          summary && typeof summary === 'object' ? normalizeCzClick(summary.cz_click) : null;
        const czId = Number(row.cz_id);
        if (!click || !clicks.has(click) || !Number.isSafeInteger(czId)) return;
        if (known.has(czId)) return;
        inProgress.push({ cz_id: czId, detail: 'Sin evaluar' });
      });
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  return {
    attributed: split.attributed,
    excluded: split.excluded,
    recorded: split.recorded,
    in_progress: inProgress.slice(0, LIST_CAP),
    attributed_count: split.attributed_count,
    excluded_count: split.excluded_count,
    recorded_count: split.recorded_count,
    in_progress_count: inProgress.length,
  };
}

/**
 * Attach stored AF/REF data onto person rows. Returns false when the
 * identity columns are not in the database yet. Other errors propagate.
 * @param {object[]} rows
 * @param {{ ciOf: function, czIdsOf: function, stamp?: function }} readers
 */
async function decorateCiRows(supabase, rows, readers) {
  const list = rows || [];
  if (!list.length) return true;
  const cis = [];
  const czIds = [];
  list.forEach(function (row) {
    const ci = parseCi(readers.ciOf(row));
    if (ci != null) cis.push(ci);
    readers.czIdsOf(row).forEach(function (id) {
      const n = Number(id);
      if (Number.isSafeInteger(n) && n > 0) czIds.push(n);
    });
  });
  let affiliates;
  let attributions;
  try {
    affiliates = cis.length
      ? await selectIn(supabase, 'affiliates', 'ci, status, is_test', 'ci', cis)
      : [];
    attributions = czIds.length
      ? await selectIn(
          supabase,
          'affiliate_attributions',
          'cz_id, outcome',
          'cz_id',
          czIds,
        )
      : [];
  } catch (err) {
    if (schemaMissing(err)) return false;
    throw err;
  }
  const byCi = new Map();
  affiliates.forEach(function (row) {
    const ci = parseCi(row.ci);
    if (ci != null) byCi.set(ci, row);
  });
  const byCz = new Map();
  attributions.forEach(function (row) {
    byCz.set(Number(row.cz_id), describeOutcome(row.outcome));
  });
  list.forEach(function (row) {
    const ci = parseCi(readers.ciOf(row));
    const affiliate = ci != null ? byCi.get(ci) : null;
    const shown = readers.czIdsOf(row);
    const attributed = [];
    shown.forEach(function (id) {
      const n = Number(id);
      const described = byCz.get(n) || describeOutcome(null);
      if (described.kind === 'attributed') attributed.push(n);
      if (readers.stamp) readers.stamp(row, n, described);
    });
    row.affiliate = listCell({
      isAffiliate: Boolean(affiliate),
      isTest: Boolean(affiliate && affiliate.is_test === true),
      status: affiliate ? affiliate.status : null,
      attributedCzIds: attributed,
    });
  });
  return true;
}

async function outcomeForCzId(supabase, czId) {
  const { data, error } = await supabase
    .from('affiliate_attributions')
    .select('outcome')
    .eq('cz_id', czId)
    .maybeSingle();
  if (error) {
    if (schemaMissing(error)) return { available: false, affiliate_ref: null };
    throw error;
  }
  return {
    available: true,
    affiliate_ref: describeOutcome(data ? data.outcome : null),
  };
}

module.exports = {
  schemaMissing,
  createAffiliate,
  listAffiliates,
  listAffiliatesWithRowStats,
  aggregateAffiliateDashboardSummary,
  countAffiliateInviteEmailsSent,
  getAffiliate,
  listClicks,
  countClicksWithoutAttribution,
  solicitudesForAffiliate,
  decorateCiRows,
  outcomeForCzId,
};
