/**
 * Job: liquidity_cycle_sync
 * Cadence: once daily via cron-job.org → POST /jobs/run-liquidity-cycle-sync
 *
 * Spend = SUM after DISTINCT ON (campaign_id, metric_date) ORDER BY created_at DESC
 * via RPC sum_deduped_own_ad_spend — never raw SUM on own_ad_metrics.
 */

const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { computeAuctionPressure } = require('../services/auction-pressure');

const SPEND_SOURCE_NOTE =
  'own_ad_metrics DISTINCT ON (campaign_id, metric_date) ORDER BY created_at DESC then SUM(spend)';

function phaseForDayOfMonth(day) {
  if (day >= 1 && day <= 7) return 'alta_demanda';
  if (day >= 8 && day <= 22) return 'mitad_mes';
  return 'cierre_mes';
}

async function resolveMontevideoYesterday() {
  const { data, error } = await supabase.rpc('montevideo_yesterday');
  if (error) {
    throw new Error(`montevideo_yesterday failed: ${error.message}`);
  }
  if (!data) {
    throw new Error('montevideo_yesterday returned empty');
  }
  return String(data);
}

async function runLiquidityCycleSync(options = {}) {
  const logDate =
    typeof options.logDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.logDate)
      ? options.logDate
      : await resolveMontevideoYesterday();

  const dayOfMonth = Number(String(logDate).slice(8, 10));
  const cyclePhase = phaseForDayOfMonth(dayOfMonth);

  const { data: spendRaw, error: spendErr } = await supabase.rpc(
    'sum_deduped_own_ad_spend',
    { p_metric_date: logDate },
  );
  if (spendErr) {
    throw new Error(`sum_deduped_own_ad_spend failed: ${spendErr.message}`);
  }

  const metaSpendDay =
    spendRaw === null || spendRaw === undefined
      ? null
      : Number(Number(spendRaw).toFixed(2));

  const { data: existingRow, error: existingErr } = await supabase
    .from('liquidity_cycle_daily_log')
    .select(
      'competitor_pressure_ratio, own_cpm_ratio, auction_pressure_index',
    )
    .eq('log_date', logDate)
    .maybeSingle();

  if (existingErr) {
    throw new Error(
      `liquidity_cycle_daily_log prior select failed: ${existingErr.message}`,
    );
  }

  let competitorPressureRatio = null;
  let ownCpmRatio = null;
  let auctionPressureIndex = null;

  try {
    const pressure = await computeAuctionPressure({ date: logDate });
    competitorPressureRatio =
      pressure.competitorPressureRatio != null
        ? Number(pressure.competitorPressureRatio)
        : null;
    ownCpmRatio =
      pressure.ownCpmRatio != null
        ? Number(pressure.ownCpmRatio)
        : null;
    auctionPressureIndex =
      pressure.auctionPressureIndex != null
        ? Number(pressure.auctionPressureIndex)
        : null;
  } catch (err) {
    logger.warn('liquidity_cycle_sync auction pressure skipped', {
      logDate,
      error: err && err.message ? err.message : 'unknown',
    });
  }

  if (existingRow) {
    if (competitorPressureRatio == null) {
      competitorPressureRatio = existingRow.competitor_pressure_ratio;
    }
    if (ownCpmRatio == null) {
      ownCpmRatio = existingRow.own_cpm_ratio;
    }
    if (auctionPressureIndex == null) {
      auctionPressureIndex = existingRow.auction_pressure_index;
    }
  }

  const row = {
    log_date: logDate,
    cycle_phase: cyclePhase,
    day_of_month: dayOfMonth,
    meta_spend_day: metaSpendDay,
    spend_source_note: SPEND_SOURCE_NOTE,
    competitor_pressure_ratio: competitorPressureRatio,
    own_cpm_ratio: ownCpmRatio,
    auction_pressure_index: auctionPressureIndex,
  };

  const { data: upserted, error: upsertErr } = await supabase
    .from('liquidity_cycle_daily_log')
    .upsert(row, { onConflict: 'log_date' })
    .select('*')
    .single();

  if (upsertErr) {
    throw new Error(`liquidity_cycle_daily_log upsert failed: ${upsertErr.message}`);
  }

  logger.info('liquidity_cycle_sync completed', {
    logDate,
    cyclePhase,
    dayOfMonth,
    metaSpendDay,
    competitorPressureRatio,
    ownCpmRatio,
    auctionPressureIndex,
  });

  return {
    ok: true,
    logDate,
    cyclePhase,
    dayOfMonth,
    metaSpendDay,
    competitorPressureRatio,
    ownCpmRatio,
    auctionPressureIndex,
    row: upserted,
  };
}

module.exports = {
  runLiquidityCycleSync,
  phaseForDayOfMonth,
  resolveMontevideoYesterday,
  SPEND_SOURCE_NOTE,
};
