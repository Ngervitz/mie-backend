'use strict';

/**
 * node scripts/unit-meta-agent-ad-aggregate.js
 * Ad-level period aggregation + UI helpers (Fase 2).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ui = require('../public/meta-agent.js');

function adLegacyRow(opts) {
  return ui.mapOwnAdAdMetricsToLegacyRow({
    campaign_id: opts.campaign_id,
    campaign_name: opts.campaign_name || 'Camp',
    ad_id: opts.ad_id,
    ad_name: opts.ad_name,
    metric_date: opts.metric_date,
    spend: opts.spend,
    impressions: opts.impressions,
    clicks: opts.clicks,
    created_at: opts.created_at || '2026-10-01T12:00:00.000Z',
    raw_json: opts.raw_json || {
      conversions: [
        {
          action_type: 'offsite_conversion.fb_pixel_custom.form_step_3',
          value: String(opts.leads != null ? opts.leads : 0),
        },
      ],
    },
  });
}

function test(name, fn) {
  return { name: name, fn: fn };
}

const tests = [
  test('mapOwnAdAdMetricsToLegacyRow uses spendNum for CPC (hotfix parity)', function () {
    const row = adLegacyRow({
      ad_id: 'ad-1',
      ad_name: 'Creative A',
      campaign_id: 'camp-1',
      metric_date: '2026-10-10',
      spend: 20,
      impressions: 200,
      clicks: 10,
      leads: 2,
    });
    assert.strictEqual(row.ad_id, 'ad-1');
    const cpc = parseFloat(row.cpc);
    assert.strictEqual(cpc, 2);
  }),

  test('buildAdListByAdId groups by ad_id not name', function () {
    const rows = [
      adLegacyRow({
        ad_id: '777',
        ad_name: 'Name A',
        campaign_id: 'camp-1',
        metric_date: '2026-10-01',
        spend: 5,
        impressions: 100,
        clicks: 10,
        leads: 1,
      }),
      adLegacyRow({
        ad_id: '777',
        ad_name: 'Name B typo',
        campaign_id: 'camp-1',
        metric_date: '2026-10-02',
        spend: 7,
        impressions: 100,
        clicks: 10,
        leads: 2,
      }),
    ];
    const list = ui.buildAdListByAdId(rows);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].ad_id, '777');
    assert.strictEqual(list[0].gasto, 12);
    assert.strictEqual(list[0].conversiones, 3);
    assert.strictEqual(list[0].cpl, 4);
  }),

  test('CPL is null when no form_step_3 on ad rows', function () {
    const row = ui.mapOwnAdAdMetricsToLegacyRow({
      ad_id: '1',
      ad_name: 'Ad',
      campaign_id: 'c1',
      metric_date: '2026-10-01',
      spend: 50,
      impressions: 100,
      clicks: 10,
      raw_json: { conversions: [] },
    });
    const list = ui.buildAdListByAdId([row]);
    assert.strictEqual(list[0].cpl, null);
    assert.strictEqual(list[0].cplSinConversiones, true);
  }),

  test('dedupeRowsByAdDate keeps newest created_at', function () {
    const older = adLegacyRow({
      ad_id: '1',
      campaign_id: 'c1',
      metric_date: '2026-10-05',
      spend: 1,
      impressions: 10,
      clicks: 1,
      leads: 1,
      created_at: '2026-10-05T08:00:00.000Z',
    });
    const newer = adLegacyRow({
      ad_id: '1',
      campaign_id: 'c1',
      metric_date: '2026-10-05',
      spend: 9,
      impressions: 10,
      clicks: 1,
      leads: 2,
      created_at: '2026-10-05T18:00:00.000Z',
    });
    const out = ui.dedupeRowsByAdDate([older, newer]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(parseFloat(out[0].spend), 9);
  }),

  test('computeAdsDerivedForState respects global period filter', function () {
    const rows = [
      adLegacyRow({
        ad_id: 'a1',
        campaign_id: '999',
        metric_date: '2026-10-10',
        spend: 10,
        impressions: 100,
        clicks: 10,
        leads: 1,
      }),
      adLegacyRow({
        ad_id: 'a1',
        campaign_id: '999',
        metric_date: '2026-10-20',
        spend: 5,
        impressions: 50,
        clicks: 5,
        leads: 0,
      }),
    ];
    const derived = ui.computeAdsDerivedForState(
      rows,
      'custom',
      '2026-10-10',
      '2026-10-11',
    );
    assert.strictEqual(derived.adList.length, 1);
    assert.strictEqual(derived.adList[0].gasto, 10);
    assert.strictEqual((derived.adsByCampaign['999'] || []).length, 1);
  }),

  test('toggleExpandedCampaign expands and collapses independently', function () {
    let map = {};
    map = ui.toggleExpandedCampaign(map, '111');
    assert.strictEqual(map['111'], true);
    map = ui.toggleExpandedCampaign(map, '222');
    assert.strictEqual(map['222'], true);
    assert.strictEqual(map['111'], true);
    map = ui.toggleExpandedCampaign(map, '111');
    assert.strictEqual(map['111'], undefined);
    assert.strictEqual(map['222'], true);
  }),

  test('campaign KPI path unchanged when ad dataset is empty', function () {
    const campRows = [
      ui.mapOwnAdMetricsToLegacyRow({
        campaign_id: '999',
        campaign_name: 'C',
        metric_date: '2026-10-10',
        spend: 40,
        impressions: 100,
        clicks: 10,
        raw_json: {
          conversions: [
            {
              action_type: 'offsite_conversion.fb_pixel_custom.form_step_3',
              value: '2',
            },
          ],
        },
      }),
    ];
    const derived = ui.computeDerivedForState(
      campRows,
      'custom',
      '2026-10-10',
      '2026-10-10',
    );
    const adsDerived = ui.computeAdsDerivedForState([], 'custom', '2026-10-10', '2026-10-10');
    assert.strictEqual(derived.period.spend, 40);
    assert.strictEqual(adsDerived.datasetEmpty, true);
    assert.strictEqual(adsDerived.adList.length, 0);
  }),

  test('meta-agent UI includes Ver anuncios control without new tabs', function () {
    const js = fs.readFileSync(
      path.join(__dirname, '../public/meta-agent.js'),
      'utf8',
    );
    assert.ok(js.includes('toggle-campaign-ads'));
    assert.ok(js.includes('ma-ad-toggle--compact'));
    assert.ok(js.includes('Ver anuncios'));
    assert.ok(js.includes('Ocultar anuncios'));
    assert.ok(js.includes('own_ad_ad_metrics'));
    assert.ok(!js.includes("data-ma-tab=\"ads\""));
  }),

  test('entity grid CSS fits JANUS 1366 desktop without forced horizontal scroll', function () {
    const css = fs.readFileSync(
      path.join(__dirname, '../public/meta-agent.css'),
      'utf8',
    );
    assert.ok(!css.includes('min-width: 1280px'));
    assert.ok(css.includes('overflow-x: hidden'));
    assert.ok(css.includes('repeat(15,'));
    const colMatch = css.match(/--ma-entity-grid-cols:\s*([^;]+)/);
    assert.ok(colMatch, 'grid column template');
    assert.ok(!colMatch[1].includes('76px'), 'no wide min column');
    const gapMatch = css.match(/--ma-entity-grid-gap:\s*([0-9.]+px)/);
    const gap = gapMatch ? Number(gapMatch[1].replace('px', '')) : 8;
    const sidebar = 220;
    const appPad = 40;
    const bodyPad = 24;
    const gridPad = 16;
    const avail =
      1366 - sidebar - appPad - bodyPad - gridPad - 15 * gap;
    const nameCol = 108;
    const perKpi = (avail - nameCol) / 15;
    assert.ok(perKpi >= 52, 'KPI col width at 1366: ' + perKpi.toFixed(1) + 'px');
  }),

  test('buildCampaignEntity uses byCampaignId rollup not only visible ad rows', function () {
    const camp = {
      campaign_id: '999',
      name: 'Camp',
      gasto: 100,
      impressions: 1000,
      clicks: 50,
      conversiones: 2,
      cpl: 50,
      cplSinConversiones: false,
      ctr: 5,
      cpc: 2,
      dias: 1,
    };
    const czPayload = {
      byAdId: {
        111: { solicitudCount: 2, preaprobadosCount: 1, grantedCount: 0 },
      },
      byCampaignId: {
        999: {
          identified: { solicitudCount: 2, preaprobadosCount: 1, grantedCount: 0 },
          unidentified: { solicitudCount: 1, preaprobadosCount: 0, grantedCount: 1 },
        },
      },
    };
    const adsDerived = {
      adsByCampaign: { 999: [] },
      czAttribution: czPayload,
    };
    const entity = ui.buildCampaignEntity(
      camp,
      adsDerived,
      [],
      { from: '2026-10-14', to: '2026-10-14' },
      [],
    );
    assert.strictEqual(entity.czSolicitudes, 3);
    assert.strictEqual(entity.czPreaprobados, 1);
    assert.strictEqual(entity.czGranted, 1);
    const orphan = ui.enrichCampaignAdsWithCzOrphans(
      '999',
      [],
      czPayload,
      [
        {
          entity_id: 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df',
          ad_id: '111',
          campaign_id: '999',
          metric_date: '2026-10-01',
        },
      ],
    );
    assert.strictEqual(orphan.length, 1);
    assert.strictEqual(orphan[0].czSolicitudes, 2);
    const unidentified = ui.buildUnidentifiedCzSyntheticAd('999', czPayload.byCampaignId['999']);
    assert.strictEqual(unidentified.name, 'Sin anuncio identificado');
    assert.strictEqual(unidentified.czSolicitudes, 1);
  }),

  test('unified entity grid shares KPI column order for campaign and ad rows', function () {
    assert.ok(Array.isArray(ui.MA_ENTITY_KPI_COLUMNS));
    assert.strictEqual(ui.MA_ENTITY_KPI_COLUMNS.length, 15);
    const ids = ui.MA_ENTITY_KPI_COLUMNS.map((c) => c.id);
    assert.deepStrictEqual(ids, [
      'gasto',
      'impressions',
      'clicks',
      'ctr',
      'cpc',
      'cplMeta',
      'convMeta',
      'czSolicitudes',
      'czPreaprobados',
      'czGranted',
      'cplCz',
      'costPerPreaprob',
      'costPerGranted',
      'alcance',
      'frecuencia',
    ]);
    const css = fs.readFileSync(
      path.join(__dirname, '../public/meta-agent.css'),
      'utf8',
    );
    assert.ok(css.includes('ma-entity-grid'));
    assert.ok(css.includes('--ma-kpi-gasto'));
    const prior = ui.resolvePreviousEquivalentRange('2026-10-10', '2026-10-12');
    assert.deepStrictEqual(prior, { from: '2026-10-07', to: '2026-10-09' });
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
  console.log('all meta-agent ad aggregate checks passed');
})();
