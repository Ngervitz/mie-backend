'use strict';

/**
 * Stage 6D.4 — direct HTML persistence service (mocked RPC/DB).
 * Run: node scripts/unit-bcu-html-persist.js
 *
 * Does NOT hit production DB.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PAGE_TYPE } = require('../src/lib/bcuHtmlParser');
const { hashConfirmPayload } = require('../src/lib/bcuExtractCanonical');
const { flattenInstitutionsForRpc } = require('../src/lib/rejectedBcuExtractConfirm');
const {
  persistTrustedBcuHtmlObservation,
  RESULT,
  PERSIST_RPC_NAME,
} = require('../src/lib/rejectedBcuHtmlPersist');
const { OPS_STATUS } = require('../src/lib/rejectedOps');

function money(mn, me) {
  return { mn: mn, me: me };
}

function baseExtraction(over) {
  return Object.assign(
    {
      extraction_contract_version: 'bcu_v1',
      currency_view_selected: 'MN_PESOS_ME_PESOS',
      period: '202607',
      document_ci_raw: 'UY IDE 000000000051769764',
      institutions: [
        {
          institution_name_raw: 'Banco Santander S.A.',
          category: '5',
          vigente: money(null, null),
          vigente_no_autoliquidable: money(null, null),
          colocacion_vencida: money(null, null),
          moroso: money(null, null),
          castigado_por_atraso: money(0, 3938.3),
          contingencias: money(null, null),
          creditos_reestructurados: money(null, null),
        },
        {
          institution_name_raw: 'OCA S.A.',
          category: '5',
          vigente: money(null, null),
          vigente_no_autoliquidable: money(null, null),
          colocacion_vencida: money(null, null),
          moroso: money(null, null),
          castigado_por_atraso: money(5180.88, 5683.32),
          contingencias: money(null, null),
          creditos_reestructurados: money(null, null),
        },
      ],
      summary: {
        vigente: money(null, null),
        vigente_no_autoliquidable: money(null, null),
        colocacion_vencida: money(null, null),
        moroso: money(null, null),
        castigado_por_atraso: money(5180.88, 9621.62),
        contingencias: money(null, null),
        creditos_reestructurados: money(null, null),
      },
      review: { warnings: [], illegible_fields: [] },
    },
    over || {},
  );
}

function chainable(result) {
  const api = {
    select: function () {
      return api;
    },
    eq: function () {
      return api;
    },
    in: function () {
      return api;
    },
    order: function () {
      return api;
    },
    limit: function () {
      return api;
    },
    maybeSingle: async function () {
      return result.maybeSingle || { data: null, error: null };
    },
    then: undefined,
  };
  // Make thenable for await client.from().select()...limit(1)
  api.then = function (resolve, reject) {
    const p = Promise.resolve(result.list || { data: [], error: null });
    return p.then(resolve, reject);
  };
  return api;
}

function makeClient(opts) {
  opts = opts || {};
  return {
    from: function (table) {
      if (table === 'rejected_bcu_snapshots') {
        if (opts.snapshotSelect) {
          return chainable(opts.snapshotSelect);
        }
        return chainable({
          list: { data: opts.existingSnapshots || [], error: null },
          maybeSingle: {
            data: opts.loadedSnapshot || null,
            error: null,
          },
        });
      }
      if (table === 'rejected_bcu_institutions') {
        return chainable({
          list: { data: opts.loadedInstitutions || [], error: null },
        });
      }
      if (table === 'rejected_bcu_extraction_drafts') {
        return chainable({
          list: {
            data: opts.activeDrafts || [],
            error: null,
          },
        });
      }
      return chainable({ list: { data: [], error: null } });
    },
    rpc: async function (name, params) {
      assert.strictEqual(name, PERSIST_RPC_NAME);
      if (opts.onRpc) return opts.onRpc(params);
      return {
        data: {
          already_confirmed: false,
          draft_id: null,
          confirmed_snapshot_id: 'snap-html-1',
          confirmed_at: null,
          reviewed_payload_sha256: params.p_reviewed_payload_sha256,
          draft: null,
          snapshot: {
            id: 'snap-html-1',
            ci: params.p_ci,
            period_label: params.p_period_label,
            consulted_on: params.p_consulted_on,
            source: params.p_source,
            storage_path: params.p_storage_path,
            original_filename: params.p_original_filename,
            content_type: params.p_content_type,
            file_size_bytes: params.p_file_size_bytes,
            currency_view_selected: params.p_currency_view_selected,
            extraction_contract_version: params.p_extraction_contract_version,
            document_ci_raw: params.p_document_ci_raw,
            summary: params.p_summary,
            summary_validation_status: params.p_summary_validation_status,
            summary_validation: params.p_summary_validation,
            reviewed_payload_sha256: params.p_reviewed_payload_sha256,
          },
          institutions: params.p_institutions.map(function (row, i) {
            return Object.assign({ id: 'i' + i, snapshot_id: 'snap-html-1' }, row);
          }),
        },
        error: null,
      };
    },
  };
}

async function main() {
  const consultedOn = '2026-09-09';
  const extraction = baseExtraction();
  const hash = hashConfirmPayload({
    consulted_on: consultedOn,
    reviewed: extraction,
  });

  // --- flatten null vs 0 ---
  {
    const flat = flattenInstitutionsForRpc(extraction);
    assert.strictEqual(flat[0].castigado_mn, 0);
    assert.strictEqual(flat[0].castigado_me, 3938.3);
    assert.strictEqual(flat[0].vigente_mn, null);
    assert.strictEqual(flat[0].vigente_me, null);
    assert.strictEqual(flat[1].castigado_mn, 5180.88);
  }

  // --- IMPORTED ---
  {
    let rpcParams = null;
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        onRpc: async function (params) {
          rpcParams = params;
          return makeClient().rpc(PERSIST_RPC_NAME, params);
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.IMPORTED);
    assert.strictEqual(out.snapshot_id, 'snap-html-1');
    assert.strictEqual(out.snapshot.source, 'html_import');
    assert.strictEqual(out.draft_id, null);
    assert.strictEqual(rpcParams.p_source, 'html_import');
    assert.strictEqual(rpcParams.p_draft_id, null);
    assert.strictEqual(rpcParams.p_storage_path, null);
    assert.strictEqual(rpcParams.p_reviewed_payload_sha256, hash);
    assert.strictEqual(out.ops.ops_status, OPS_STATUS.NO_AUTO_RECONSULT);
    assert.strictEqual(out.active_draft_exists, false);
  }

  // --- ALREADY_CONFIRMED same hash ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        existingSnapshots: [
          {
            id: 'snap-old',
            reviewed_payload_sha256: hash,
            source: 'html_import',
            consulted_on: consultedOn,
          },
        ],
        loadedSnapshot: {
          id: 'snap-old',
          ci: 51769764,
          period_label: '202607',
          consulted_on: consultedOn,
          source: 'html_import',
          reviewed_payload_sha256: hash,
        },
        loadedInstitutions: [
          {
            category: '5',
            castigado_mn: 0,
            castigado_me: 3938.3,
            moroso_mn: null,
            moroso_me: null,
            sort_order: 0,
          },
        ],
        onRpc: async function () {
          throw new Error('RPC must not be called on ALREADY_CONFIRMED');
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.ALREADY_CONFIRMED);
    assert.strictEqual(out.snapshot_id, 'snap-old');
  }

  // --- CONFLICT different hash ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        existingSnapshots: [
          {
            id: 'snap-other',
            reviewed_payload_sha256: 'a'.repeat(64),
            source: 'llm_assisted',
            consulted_on: '2026-09-01',
          },
        ],
        onRpc: async function () {
          throw new Error('RPC must not be called on CONFLICT');
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.CONFLICT_SAME_CI_PERIOD);
  }

  // --- CONFLICT null hash (manual historical) ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        existingSnapshots: [
          {
            id: 'snap-manual',
            reviewed_payload_sha256: null,
            source: 'manual',
            consulted_on: '2026-08-01',
          },
        ],
        onRpc: async function () {
          throw new Error('RPC must not be called on CONFLICT null hash');
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.CONFLICT_SAME_CI_PERIOD);
  }

  // --- invalid CI ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 'not-a-ci',
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient(),
    });
    assert.strictEqual(out.result, RESULT.INVALID_CI);
  }

  // --- trust gate fail (CONSULTA) ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.CONSULTA_FORM,
      client: makeClient({
        onRpc: async function () {
          throw new Error('RPC must not be called when untrusted');
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.UNTRUSTED_EXTRACTION);
  }

  // --- B currency blocked ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: baseExtraction({
        currency_view_selected: 'MN_PESOS_ME_USD',
      }),
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        onRpc: async function () {
          throw new Error('RPC must not be called for B currency');
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.UNTRUSTED_EXTRACTION);
    assert.ok(
      out.reasons.some(function (r) {
        return r.reason_code === 'CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST';
      }),
    );
  }

  // --- RPC failure ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        onRpc: async function () {
          return { data: null, error: { message: 'boom', code: 'XX' } };
        },
      }),
    });
    assert.strictEqual(out.result, RESULT.PERSIST_FAILED);
  }

  // --- active_draft_exists metadata (non-blocking) ---
  {
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      client: makeClient({
        activeDrafts: [{ id: 'draft-active-1' }],
      }),
    });
    assert.strictEqual(out.result, RESULT.IMPORTED);
    assert.strictEqual(out.active_draft_exists, true);
  }

  // --- migration SQL audit ---
  {
    const sqlPath = path.join(
      __dirname,
      '..',
      'migrations',
      '20260909_rechazados_bcu_html_direct_persistence.sql',
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.ok(sql.indexOf('html_import') >= 0);
    assert.ok(sql.indexOf('persist_rejected_bcu_observation') >= 0);
    assert.ok(sql.indexOf('confirm_rejected_bcu_extraction_draft') >= 0);
    assert.ok(sql.indexOf("'llm_assisted'") >= 0);
    assert.ok(sql.indexOf('FOR UPDATE') >= 0);
    assert.ok(sql.indexOf('INSERT INTO public.rejected_bcu_snapshots') >= 0);
    assert.ok(sql.indexOf('INSERT INTO public.rejected_bcu_institutions') >= 0);
    assert.ok(
      !/ADD COLUMN[\s\S]{0,80}extraction_method/i.test(sql),
      'must not add extraction_method column',
    );
    // Stage 4 wrapper forces llm_assisted
    assert.ok(/persist_rejected_bcu_observation\([\s\S]*?'llm_assisted'/i.test(sql));
  }

  // --- Stage 4 confirm SQL still present in original migration (historical) ---
  {
    const oldSql = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'migrations',
        '20260906_rechazados_bcu_confirm_stage4.sql',
      ),
      'utf8',
    );
    assert.ok(oldSql.indexOf('confirm_rejected_bcu_extraction_draft') >= 0);
  }

  console.log('unit-bcu-html-persist: PASS');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
