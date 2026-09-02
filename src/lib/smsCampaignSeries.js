'use strict';

const SERIES_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIES_NAME_MAX = 200;

function getSupabase(override) {
  if (override) return override;
  return require('../clients/supabase');
}

function parseCampaignSeriesId(raw) {
  if (raw == null) return { id: null, error: null };
  if (typeof raw !== 'string') {
    return { id: null, error: 'campaign_series_id must be a UUID string' };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { id: null, error: null };
  if (!SERIES_UUID_RE.test(trimmed)) {
    return { id: null, error: 'campaign_series_id must be a UUID' };
  }
  return { id: trimmed, error: null };
}

function parseSeriesName(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > SERIES_NAME_MAX) return null;
  return trimmed;
}

function seriesRequiredBody() {
  return {
    error:
      'campaign_series_id is required when SMS individual tracking is enabled',
    kind: 'validation',
  };
}

function seriesNotFoundBody() {
  return {
    error: 'campaign_series_id not found',
    kind: 'validation',
  };
}

function partitionPhoneClassifications(rows) {
  const already_sent_in_series = [];
  const protected_clicked = [];
  const excluded_from_campaigns = [];
  const ok = [];
  const seen = new Set();
  for (let i = 0; i < (rows || []).length; i += 1) {
    const row = rows[i];
    if (!row || row.phone == null) continue;
    const phone = String(row.phone);
    if (seen.has(phone)) continue;
    seen.add(phone);
    const protection =
      row.protection == null || row.protection === ''
        ? null
        : String(row.protection);
    if (protection === 'excluded') {
      excluded_from_campaigns.push(phone);
    } else if (protection === 'already_sent') {
      already_sent_in_series.push(phone);
    } else if (protection === 'clicked') {
      protected_clicked.push(phone);
    } else {
      ok.push(phone);
    }
  }
  return {
    already_sent_in_series,
    protected_clicked,
    excluded_from_campaigns,
    ok,
  };
}

function hasFailClosedProtections(partition) {
  return (
    (partition.already_sent_in_series &&
      partition.already_sent_in_series.length > 0) ||
    (partition.protected_clicked && partition.protected_clicked.length > 0) ||
    (partition.excluded_from_campaigns &&
      partition.excluded_from_campaigns.length > 0)
  );
}

function buildFailClosedPayload(seriesId, partition) {
  return {
    error: 'One or more phones are protected from this campaign series',
    kind: 'validation',
    campaign_series_id: seriesId,
    already_sent_in_series: partition.already_sent_in_series.slice(),
    protected_clicked: partition.protected_clicked.slice(),
    excluded_from_campaigns: partition.excluded_from_campaigns.slice(),
  };
}

async function loadCampaignSeriesById(seriesId, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase
    .from('marketing_campaign_series')
    .select('id, name, created_at')
    .eq('id', seriesId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `marketing_campaign_series lookup failed: ${error.message}`,
    );
  }
  return data || null;
}

async function listCampaignSeries(supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase
    .from('marketing_campaign_series')
    .select('id, name, created_at')
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`marketing_campaign_series list failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

async function createCampaignSeries(name, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase
    .from('marketing_campaign_series')
    .insert({ name: name })
    .select('id, name, created_at')
    .limit(1);
  if (error || !data || !data[0]) {
    throw new Error(
      `marketing_campaign_series insert failed: ${error ? error.message : 'no row returned'}`,
    );
  }
  return data[0];
}

module.exports = {
  SERIES_UUID_RE,
  SERIES_NAME_MAX,
  parseCampaignSeriesId,
  parseSeriesName,
  seriesRequiredBody,
  seriesNotFoundBody,
  partitionPhoneClassifications,
  hasFailClosedProtections,
  buildFailClosedPayload,
  loadCampaignSeriesById,
  listCampaignSeries,
  createCampaignSeries,
};
