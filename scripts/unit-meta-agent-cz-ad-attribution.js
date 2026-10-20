'use strict';

/**
 * node scripts/unit-meta-agent-cz-ad-attribution.js
 * Credizona ↔ Meta ad attribution (Etapa 3).
 */

const assert = require('assert');
const cz = require('../src/lib/metaAgentCzAttribution');
const ui = require('../public/meta-agent.js');

const ENTITY = 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df';

/** Frozen audit baseline (READ ONLY cohort at 2026-10-15 review). Live Supabase may drift. */
const AUDIT_BASELINE = Object.freeze({
  note: 'fecha_reg >= 2026-10-14T18:08:50.000Z AND utm_source=meta',
  templateMetaRows: 122,
  attributedDistinctCz: 121,
  attributedDistinctCi: 119,
  pendingDistinctCz: 1,
});

function test(name, fn) {
  return { name, fn };
}

function sol(czId, ci, fechaReg, summary) {
  return {
    cz_id: czId,
    ci: ci,
    fecha_reg: fechaReg,
    tracking_data_summary: summary,
  };
}

function adMetric(adId, campaignId, metricDate, spend) {
  return {
    entity_id: ENTITY,
    ad_id: adId,
    campaign_id: campaignId,
    metric_date: metricDate || '2026-10-14',
    spend: spend != null ? spend : 10,
    created_at: '2026-10-14T12:00:00.000Z',
  };
}

function calendarDateInZone(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const tests = [
  test('czFunnelChannelFromUtmSource maps meta and legacy without breaking sms', function () {
    assert.strictEqual(cz.czFunnelChannelFromUtmSource('meta'), 'meta');
    assert.strictEqual(cz.czFunnelChannelFromUtmSource('facebook'), 'meta');
    assert.strictEqual(cz.czFunnelChannelFromUtmSource('ig'), 'meta');
    assert.strictEqual(cz.czFunnelChannelFromUtmSource('sms'), 'sms');
    assert.strictEqual(cz.czFunnelChannelFromUtmSource('google'), 'sin_atribuir');
  }),

  test('empty tracking → unknown_origin (not other_channel)', function () {
    var dim = new Map();
    assert.strictEqual(
      cz.classifyCzSolicitudBucket({}, dim, ENTITY),
      cz.CZ_ATTRIBUTION_BUCKETS.UNKNOWN_ORIGIN,
    );
  }),

  test('sms and jt-only → other_channel; meta+jt stays on Meta path', function () {
    var dim = cz.buildAdDimensionMap([adMetric('111', '999')], ENTITY);
    assert.strictEqual(
      cz.classifyCzSolicitudBucket({ utm_source: 'sms' }, dim, ENTITY),
      cz.CZ_ATTRIBUTION_BUCKETS.OTHER_CHANNEL,
    );
    assert.strictEqual(
      cz.classifyCzSolicitudBucket({ jt: 'journey-token' }, dim, ENTITY),
      cz.CZ_ATTRIBUTION_BUCKETS.OTHER_CHANNEL,
    );
    assert.strictEqual(
      cz.classifyCzSolicitudBucket(
        {
          utm_source: 'meta',
          utm_campaign: '999',
          utm_content: '111',
          jt: 'journey-token',
        },
        dim,
        ENTITY,
      ),
      cz.CZ_ATTRIBUTION_BUCKETS.META_AD_ATTRIBUTED,
    );
  }),

  test('single cz_id with CDV+ELM preaprob counts once in ad rollup', function () {
    var byAd = { 111: { solicitudCount: 1, uniqueCi: 1 } };
    var czToAd = new Map([[42, { adId: '111', czId: 42 }]]);
    var outcomes = new Map([
      [
        42,
        cz.computeSolicitudOutcomeFacts({
          cdvCohort: true,
          grantedCdv: false,
          elmReferred: true,
          elmDisbursed: false,
        }),
      ],
    ]);
    assert.strictEqual(outcomes.get(42).preaprobado, true);
    var merged = cz.mergeOutcomesIntoByAdId(byAd, czToAd, outcomes);
    assert.strictEqual(merged['111'].preaprobadosCount, 1);
  }),

  test('meta without numeric utm_content → meta_no_ad', function () {
    var dim = cz.buildAdDimensionMap([adMetric('111', '999')], ENTITY);
    assert.strictEqual(
      cz.classifyCzSolicitudBucket(
        { utm_source: 'meta', utm_campaign: '999', utm_content: 'not-id' },
        dim,
        ENTITY,
      ),
      cz.CZ_ATTRIBUTION_BUCKETS.META_NO_AD,
    );
  }),

  test('campaign mismatch → meta_ad_pending', function () {
    var dim = cz.buildAdDimensionMap([adMetric('111', '999')], ENTITY);
    assert.strictEqual(
      cz.classifyCzSolicitudBucket(
        { utm_source: 'meta', utm_campaign: '888', utm_content: '111' },
        dim,
        ENTITY,
      ),
      cz.CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING,
    );
  }),

  test('unknown ad_id in metrics → meta_ad_pending', function () {
    var dim = cz.buildAdDimensionMap([adMetric('111', '999')], ENTITY);
    assert.strictEqual(
      cz.classifyCzSolicitudBucket(
        { utm_source: 'meta', utm_campaign: '999', utm_content: '120253337803970508' },
        dim,
        ENTITY,
      ),
      cz.CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING,
    );
  }),

  test('computeCzAdAttribution dedupes cz_id and counts distinct CI globally', function () {
    var dim = cz.buildAdDimensionMap([adMetric('111', '999'), adMetric('222', '999')], ENTITY);
    var rows = [
      sol(1, 100, '2026-10-14T20:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '999',
        utm_content: '111',
      }),
      sol(1, 100, '2026-10-14T21:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '999',
        utm_content: '111',
      }),
      sol(2, 200, '2026-10-14T20:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '999',
        utm_content: '222',
      }),
    ];
    var out = cz.computeCzAdAttribution(rows, dim, ENTITY);
    assert.strictEqual(out.byAdId['111'].solicitudCount, 1);
    assert.strictEqual(out.byAdId['222'].solicitudCount, 1);
    assert.strictEqual(out.globalAttributed.solicitudCount, 2);
    assert.strictEqual(out.globalAttributed.uniqueCi, 2);
  }),

  test('attachCzStatsToAdList: CPL CZ null without solicitudes; spend without CZ ok', function () {
    var list = cz.attachCzStatsToAdList(
      [{ ad_id: '111', gasto: 50, conversiones: 2, cpl: 25 }],
      { 111: { solicitudCount: 0, uniqueCi: 0 } },
    );
    assert.strictEqual(list[0].czSolicitudes, 0);
    assert.strictEqual(list[0].cplCz, null);
    assert.strictEqual(list[0].cplCzSinSolicitudes, true);
    assert.strictEqual(list[0].cpl, 25);

    var withSol = cz.attachCzStatsToAdList(
      [{ ad_id: '111', gasto: 100 }],
      { 111: { solicitudCount: 4, uniqueCi: 3 } },
    );
    assert.strictEqual(withSol[0].cplCz, 25);
  }),

  test('filterSolicitudesByFechaRegPeriod uses America/Montevideo calendar dates', function () {
    var rows = [
      sol(1, 1, '2026-10-15T02:30:00.000Z', { utm_source: 'meta' }),
      sol(2, 2, '2026-10-16T02:30:00.000Z', { utm_source: 'meta' }),
    ];
    var filtered = cz.filterSolicitudesByFechaRegPeriod(
      rows,
      '2026-10-14',
      '2026-10-14',
      calendarDateInZone,
    );
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].cz_id, 1);
  }),

  test('buildAdDimensionMap ignores duplicate daily metric rows', function () {
    var dim = cz.buildAdDimensionMap(
      [
        adMetric('111', '999', '2026-10-14', 1),
        adMetric('111', '999', '2026-10-15', 2),
      ],
      ENTITY,
    );
    assert.strictEqual(dim.size, 1);
    assert.strictEqual(dim.get('111').campaign_id, '999');
  }),

  test('computeAdsDerivedForState wires CZ stats without double-counting CI in adList sum', function () {
    var adRows = [
      ui.mapOwnAdAdMetricsToLegacyRow({
        entity_id: ENTITY,
        ad_id: '111',
        ad_name: 'A',
        campaign_id: '999',
        metric_date: '2026-10-14',
        spend: 30,
        impressions: 100,
        clicks: 10,
        raw_json: {
          conversions: [
            {
              action_type: 'offsite_conversion.fb_pixel_custom.form_step_3',
              value: '1',
            },
          ],
        },
      }),
    ];
    var czRows = [
      sol(1, 100, '2026-10-14T18:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '999',
        utm_content: '111',
      }),
      sol(2, 100, '2026-10-14T19:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '999',
        utm_content: '111',
      }),
    ];
    var adDim = cz.buildAdDimensionMap(
      [
        adMetric('111', '999', '2026-10-14', 30),
      ],
      ENTITY,
    );
    var attr = cz.computeCzAdAttribution(czRows, adDim, ENTITY);
    var czPayload = cz.sanitizePublicAttributionPayload(attr, {
      entityId: ENTITY,
      timezone: 'America/Montevideo',
      from: '2026-10-14',
      to: '2026-10-14',
    });
    var derived = ui.computeAdsDerivedForState(
      adRows,
      'custom',
      '2026-10-14',
      '2026-10-14',
      czPayload,
    );
    assert.strictEqual(derived.adList[0].czSolicitudes, 2);
    assert.strictEqual(derived.adList[0].czUniqueCi, 1);
    assert.strictEqual(derived.adList[0].cplCz, 15);
    assert.strictEqual(derived.czAttribution.globalAttributed.solicitudCount, 2);
    assert.strictEqual(derived.czAttribution.globalAttributed.uniqueCi, 1);
  }),

  test('validateAttributionDateRange enforces 90-day inclusive max', function () {
    var ok = cz.validateAttributionDateRange('2026-01-01', '2026-03-31');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.dayCount, 90);
    var bad = cz.validateAttributionDateRange('2026-01-01', '2026-04-01');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, 'range_too_large');
  }),

  test('uyDayStartUtcIso aligns Montevideo midnight to 03:00Z', function () {
    assert.strictEqual(
      cz.uyDayStartUtcIso('2026-10-14'),
      '2026-10-14T03:00:00.000Z',
    );
    assert.strictEqual(
      cz.uyDayEndExclusiveUtcIso('2026-10-14'),
      '2026-10-15T03:00:00.000Z',
    );
  }),

  test('computeSolicitudOutcomeFacts dedupes preaprob and grant across CDV+ELM', function () {
    var both = cz.computeSolicitudOutcomeFacts({
      cdvCohort: true,
      grantedCdv: true,
      elmReferred: true,
      elmDisbursed: true,
    });
    assert.strictEqual(both.preaprobado, true);
    assert.strictEqual(both.granted, true);
    assert.strictEqual(both.lender, 'cdv_and_elm');

    var elmOnly = cz.computeSolicitudOutcomeFacts({
      cdvCohort: false,
      grantedCdv: false,
      elmReferred: true,
      elmDisbursed: false,
    });
    assert.strictEqual(elmOnly.preaprobado, true);
    assert.strictEqual(elmOnly.granted, false);
  }),

  test('mergeOutcomesIntoByAdId rolls preaprobados and granted to ad totals', function () {
    var byAd = { 111: { solicitudCount: 2, uniqueCi: 2 } };
    var czToAd = new Map([
      [1, { adId: '111', czId: 1 }],
      [2, { adId: '111', czId: 2 }],
    ]);
    var outcomes = new Map([
      [1, { preaprobado: true, granted: true, lender: 'cdv' }],
      [2, { preaprobado: true, granted: false, lender: null }],
    ]);
    var merged = cz.mergeOutcomesIntoByAdId(byAd, czToAd, outcomes);
    assert.strictEqual(merged['111'].preaprobadosCount, 2);
    assert.strictEqual(merged['111'].grantedCount, 1);
    var list = cz.attachCzStatsToAdList(
      [{ ad_id: '111', gasto: 100 }],
      merged,
    );
    assert.strictEqual(list[0].czPreaprobados, 2);
    assert.strictEqual(list[0].czGranted, 1);
    assert.strictEqual(list[0].costPerGranted, 100);
  }),

  test('aggregatePlatformSpendForAd sums publisher_platform slices in period', function () {
    var rows = [
      {
        ad_id: '111',
        metric_date: '2026-10-14',
        raw_json: {
          platform_slices: [
            { publisher_platform: 'facebook', spend: 10 },
            { publisher_platform: 'instagram', spend: 5 },
          ],
        },
      },
    ];
    var out = cz.aggregatePlatformSpendForAd(rows, '2026-10-14', '2026-10-14');
    assert.strictEqual(out['111'].facebook, 10);
    assert.strictEqual(out['111'].instagram, 5);
  }),

  test('audit baseline logic on synthetic cohort (121 attributed, 1 pending, 119 CI)', function () {
    var adIds = [];
    for (var i = 0; i < 121; i++) adIds.push(String(1000 + i));
    var pendingAd = '120253337803970508';
    var metrics = adIds.map(function (adId) {
      return adMetric(adId, '900001');
    });
    var dim = cz.buildAdDimensionMap(metrics, ENTITY);
    var rows = [];
    for (var j = 0; j < 121; j++) {
      rows.push(
        sol(
          2000 + j,
          3000 + (j % 119),
          '2026-10-14T19:00:00.000Z',
          {
            utm_source: 'meta',
            utm_medium: 'paid_social',
            utm_campaign: '900001',
            utm_content: adIds[j],
          },
        ),
      );
    }
    rows.push(
      sol(1685, 4000, '2026-10-14T19:00:00.000Z', {
        utm_source: 'meta',
        utm_campaign: '900001',
        utm_content: pendingAd,
      }),
    );

    var since = new Date('2026-10-14T18:08:50.000Z');
    var inWindow = rows.filter(function (r) {
      return new Date(r.fecha_reg).getTime() >= since.getTime();
    });
    assert.strictEqual(inWindow.length, AUDIT_BASELINE.templateMetaRows);

    var out = cz.computeCzAdAttribution(inWindow, dim, ENTITY);
    assert.strictEqual(
      out.globalAttributed.solicitudCount,
      AUDIT_BASELINE.attributedDistinctCz,
    );
    assert.strictEqual(out.globalAttributed.uniqueCi, AUDIT_BASELINE.attributedDistinctCi);
    assert.strictEqual(
      out.buckets[cz.CZ_ATTRIBUTION_BUCKETS.META_AD_PENDING].solicitudes,
      AUDIT_BASELINE.pendingDistinctCz,
    );
  }),
];

(async function main() {
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok ' + item.name);
    } catch (err) {
      console.error('FAIL ' + item.name);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('all meta-agent CZ attribution checks passed');
})();
