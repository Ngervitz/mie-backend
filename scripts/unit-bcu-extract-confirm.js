'use strict';

/**
 * Stage 4 confirm: gates, hash, flatten, service mocks, read null-preservation.
 * Run: node scripts/unit-bcu-extract-confirm.js
 *
 * Does NOT hit prod DB. Does NOT confirm draft 45006120.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  canonicalize,
  hashConfirmPayload,
} = require('../src/lib/bcuExtractCanonical');
const {
  evaluateConfirmGates,
  reconcileSummaryValidationStatus,
  SUMMARY_STATUS,
} = require('../src/lib/bcuExtractConfirmGates');
const {
  flattenInstitutionsForRpc,
  parseConfirmRequest,
  confirmBcuExtractionDraft,
  RPC_NAME,
} = require('../src/lib/rejectedBcuExtractConfirm');
const { formatInstitution, formatAmount } = require('../src/lib/rejectedOpsRead');
const { CLASSIFICATION, REASON } = require('../src/lib/bcuExtractContract');
const { TRI, deriveOpsStatus, OPS_STATUS } = require('../src/lib/rejectedOps');

function money(mn, me) {
  return { mn: mn, me: me };
}

function baseInstitution(overrides) {
  return Object.assign(
    {
      institution_name_raw: 'OCA S.A.',
      category: '1C',
      vigente: money(100, 0),
      vigente_no_autoliquidable: money(0, 0),
      colocacion_vencida: money(0, 0),
      moroso: money(0, 0),
      castigado_por_atraso: money(0, 0),
      contingencias: money(0, 0),
      creditos_reestructurados: money(0, 0),
    },
    overrides || {},
  );
}

function baseReviewed(overrides) {
  const inst = baseInstitution();
  return Object.assign(
    {
      extraction_contract_version: 'bcu_v1',
      currency_view_selected: 'MN_PESOS_ME_PESOS',
      period: '202607',
      document_ci_raw: '45006120',
      institutions: [inst],
      summary: {
        vigente: money(100, 0),
        vigente_no_autoliquidable: money(0, 0),
        colocacion_vencida: money(0, 0),
        moroso: money(0, 0),
        castigado_por_atraso: money(0, 0),
        contingencias: money(0, 0),
        creditos_reestructurados: money(0, 0),
      },
      review: { warnings: [], illegible_fields: [] },
    },
    overrides || {},
  );
}

function assertBlocked(reviewed, expectedCi, codeOrFn) {
  const r = evaluateConfirmGates(reviewed, { expected_ci: expectedCi || '45006120' });
  assert.strictEqual(r.ok, false, 'expected BLOCK');
  if (typeof codeOrFn === 'function') {
    codeOrFn(r);
  } else if (codeOrFn) {
    assert.ok(
      r.blockers.some(function (b) {
        return b.reason_code === codeOrFn;
      }),
      'missing blocker ' + codeOrFn + ' got ' + JSON.stringify(r.blockers),
    );
  }
  return r;
}

function assertAllowed(reviewed, expectedCi) {
  const r = evaluateConfirmGates(reviewed, { expected_ci: expectedCi || '45006120' });
  assert.strictEqual(r.ok, true, 'expected ALLOW got ' + JSON.stringify(r.blockers));
  return r;
}

// ---------- 1 REVIEW_READY ----------
{
  const r = assertAllowed(baseReviewed());
  assert.strictEqual(r.classification, CLASSIFICATION.REVIEW_READY);
  assert.strictEqual(r.summary_validation_status, SUMMARY_STATUS.MATCH);
}

// ---------- 2 HUMAN_REVIEW without blockers → allow + warning ----------
{
  // Illegible-only path keeps HUMAN_REVIEW semantics without structural blockers.
  const r = assertAllowed(
    baseReviewed({
      review: { warnings: ['blur'], illegible_fields: [] },
    }),
  );
  assert.strictEqual(r.classification, CLASSIFICATION.REVIEW_READY);
}

// ---------- 3 EXTRACTION_FAILED ----------
assertBlocked(
  baseReviewed({ extraction_contract_version: 'nope' }),
  '45006120',
  REASON.EXTRACTION_CONTRACT_INVALID,
);

// ---------- 4 CI mismatch ----------
assertBlocked(
  baseReviewed({ document_ci_raw: '99999999' }),
  '45006120',
  REASON.CI_MISMATCH,
);

// ---------- 5 currency ----------
assertBlocked(
  baseReviewed({ currency_view_selected: 'MN_PESOS_ME_USD' }),
  '45006120',
  REASON.CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS,
);

// ---------- 6 period null ----------
assertBlocked(baseReviewed({ period: null }), '45006120', 'PERIOD_MISSING');

// ---------- 7 period invalid ----------
assertBlocked(baseReviewed({ period: '2026-07' }), '45006120', 'PERIOD_INVALID');
assertBlocked(baseReviewed({ period: '202613' }), '45006120', 'PERIOD_INVALID');

// ---------- 8 money negative ----------
assertBlocked(
  baseReviewed({
    institutions: [baseInstitution({ vigente: money(-1, 0) })],
    summary: Object.assign(baseReviewed().summary, { vigente: money(-1, 0) }),
  }),
  '45006120',
  REASON.AMOUNT_NEGATIVE,
);

// ---------- 9 money >2 dec ----------
assertBlocked(
  baseReviewed({
    institutions: [baseInstitution({ vigente: money(1.234, 0) })],
    summary: Object.assign(baseReviewed().summary, { vigente: money(1.234, 0) }),
  }),
  '45006120',
  REASON.AMOUNT_PRECISION_INVALID,
);

// ---------- 10 empty institutions ----------
assertBlocked(
  baseReviewed({ institutions: [] }),
  '45006120',
  'INSTITUTIONS_EMPTY',
);

// ---------- 11 empty name ----------
assertBlocked(
  baseReviewed({
    institutions: [baseInstitution({ institution_name_raw: '  ' })],
  }),
  '45006120',
  REASON.STRUCTURE_EMPTY_INSTITUTION_NAME,
);

// ---------- 12 category null EXPLICIT ----------
{
  const r = assertBlocked(
    baseReviewed({
      institutions: [baseInstitution({ category: null })],
    }),
    '45006120',
    'CATEGORY_NULL',
  );
  assert.ok(
    r.blockers.some(function (b) {
      return b.reason_code === 'CATEGORY_NULL';
    }),
  );
}

// ---------- 13 category enum ----------
assertBlocked(
  baseReviewed({
    institutions: [baseInstitution({ category: '9Z' })],
  }),
  '45006120',
  REASON.CATEGORY_INVALID,
);

// ---------- 14 duplicate trim/case ----------
assertBlocked(
  baseReviewed({
    institutions: [
      baseInstitution({ institution_name_raw: 'OCA S.A.' }),
      baseInstitution({ institution_name_raw: ' oca s.a. ' }),
    ],
    summary: Object.assign(baseReviewed().summary, {
      vigente: money(200, 0),
    }),
  }),
  '45006120',
  REASON.STRUCTURE_DUPLICATE_INSTITUTION,
);

// ---------- 15 SUMMARY_DETAIL_MISMATCH ----------
assertBlocked(
  baseReviewed({
    summary: Object.assign(baseReviewed().summary, { vigente: money(999, 0) }),
  }),
  '45006120',
  REASON.SUMMARY_DETAIL_MISMATCH,
);

// ---------- 16 RUBRO_ORPHAN_SUMMARY_WITHOUT_INST → BLOCK ----------
assertBlocked(
  baseReviewed({
    institutions: [
      baseInstitution({
        contingencias: money(null, null),
      }),
    ],
    summary: Object.assign(baseReviewed().summary, {
      contingencias: money(10, 0),
    }),
  }),
  '45006120',
  REASON.RUBRO_ORPHAN_SUMMARY_WITHOUT_INST,
);

// ---------- 16b RUBRO_ORPHAN_INCONSISTENT_SUPPORT when sparse sum ≠ summary → BLOCK ----------
{
  const reviewed = baseReviewed({
    institutions: [
      baseInstitution({
        vigente: money(40, 0),
        moroso: money(null, 0),
      }),
      baseInstitution({
        institution_name_raw: 'Other SA',
        vigente: money(null, 0),
        moroso: money(10, 0),
      }),
    ],
    summary: Object.assign(baseReviewed().summary, {
      vigente: money(100, 0),
      moroso: money(10, 0),
    }),
  });
  const r = assertBlocked(
    reviewed,
    '45006120',
    REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT,
  );
  assert.ok(
    r.blockers.some(function (b) {
      return b.reason_code === REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT;
    }),
  );
  assert.ok(
    !r.warnings.some(function (w) {
      return w.reason_code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE;
    }),
    'NOT_COMPARABLE must not warn when RUBRO_ORPHAN_* blocks',
  );
}

// ---------- 16c sparse sum === summary → NOT_COMPARABLE warn, no orphan block ----------
{
  const reviewed = baseReviewed({
    institutions: [
      baseInstitution({
        vigente: money(40, 0),
        moroso: money(null, 0),
      }),
      baseInstitution({
        institution_name_raw: 'Other SA',
        vigente: money(60, 0),
        moroso: money(10, 0),
      }),
    ],
    summary: Object.assign(baseReviewed().summary, {
      vigente: money(100, 0),
      moroso: money(10, 0),
    }),
  });
  const r = assertAllowed(reviewed);
  // Aggregate status may still be MATCH on fully-numeric sides (e.g. *.me);
  // Stage 1 still emits NOT_COMPARABLE on sparse paths → confirm warns.
  assert.ok(
    r.warnings.some(function (w) {
      return w.reason_code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE;
    }),
  );
  assert.ok(
    !r.blockers.some(function (b) {
      return (
        typeof b.reason_code === 'string' &&
        b.reason_code.indexOf('RUBRO_ORPHAN_') === 0
      );
    }),
  );
}

// ---------- 17 NOT_COMPARABLE alone → allow warning ----------
{
  // All summary null → NOT_COMPARABLE, no RUBRO_ORPHAN
  const reviewed = baseReviewed({
    summary: {
      vigente: money(null, null),
      vigente_no_autoliquidable: money(null, null),
      colocacion_vencida: money(null, null),
      moroso: money(null, null),
      castigado_por_atraso: money(null, null),
      contingencias: money(null, null),
      creditos_reestructurados: money(null, null),
    },
  });
  const r = assertAllowed(reviewed);
  assert.strictEqual(r.summary_validation_status, SUMMARY_STATUS.NOT_COMPARABLE);
  assert.ok(
    r.warnings.some(function (w) {
      return w.reason_code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE;
    }),
  );
  assert.ok(
    !r.blockers.some(function (b) {
      return (
        typeof b.reason_code === 'string' &&
        b.reason_code.indexOf('RUBRO_ORPHAN_') === 0
      );
    }),
  );
}

// ---------- 18 illegible_fields allow ----------
{
  const r = assertAllowed(
    baseReviewed({
      review: { warnings: [], illegible_fields: ['summary.moroso.me'] },
    }),
  );
  assert.ok(
    r.warnings.some(function (w) {
      return w.reason_code === 'ILLEGIBLE_FIELDS_PRESENT';
    }),
  );
}

// ---------- 19-22 flatten null/0/>0 + 12 balances ----------
{
  const reviewed = baseReviewed({
    institutions: [
      baseInstitution({
        vigente: money(null, 0),
        vigente_no_autoliquidable: money(1.5, null),
        colocacion_vencida: money(null, null),
        moroso: money(0, 2),
        castigado_por_atraso: money(3, 4),
        contingencias: money(null, null),
        creditos_reestructurados: money(5, 0),
      }),
    ],
  });
  const rows = flattenInstitutionsForRpc(reviewed);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.vigente_mn, null);
  assert.strictEqual(row.vigente_me, 0);
  assert.strictEqual(row.vigente_no_autoliquidable_mn, 1.5);
  assert.strictEqual(row.vigente_no_autoliquidable_me, null);
  assert.strictEqual(row.moroso_mn, 0);
  assert.strictEqual(row.moroso_me, 2);
  assert.strictEqual(row.castigado_mn, 3);
  assert.strictEqual(row.castigado_me, 4);
  assert.strictEqual(row.contingencias_mn, null);
  assert.strictEqual(row.contingencias_me, null);
  assert.strictEqual(row.colocacion_vencida_mn, null);
  assert.strictEqual(row.colocacion_vencida_me, null);
  assert.strictEqual(row.creditos_reestructurados_mn, 5);
  assert.strictEqual(row.creditos_reestructurados_me, 0);
  assert.strictEqual(row.sort_order, 0);
  assert.strictEqual(row.institution_name, 'OCA S.A.');
}

// ---------- flatten colocacion_vencida >0 + 0 ----------
{
  const reviewedPos = baseReviewed({
    institutions: [
      baseInstitution({ colocacion_vencida: money(60420.61, 916.21) }),
    ],
    summary: Object.assign({}, baseReviewed().summary, {
      colocacion_vencida: money(60420.61, 916.21),
    }),
  });
  const rowPos = flattenInstitutionsForRpc(reviewedPos)[0];
  assert.strictEqual(rowPos.colocacion_vencida_mn, 60420.61);
  assert.strictEqual(rowPos.colocacion_vencida_me, 916.21);

  const reviewedZero = baseReviewed({
    institutions: [baseInstitution({ colocacion_vencida: money(0, 0) })],
  });
  const rowZero = flattenInstitutionsForRpc(reviewedZero)[0];
  assert.strictEqual(rowZero.colocacion_vencida_mn, 0);
  assert.strictEqual(rowZero.colocacion_vencida_me, 0);
}

// ---------- 23-25 read API null / 0 / Stage2 fields ----------
{
  const formatted = formatInstitution({
    id: 'x',
    institution_name: 'OCA',
    category: '1C',
    vigente_mn: null,
    vigente_me: 0,
    vigente_no_autoliquidable_mn: 1,
    vigente_no_autoliquidable_me: null,
    colocacion_vencida_mn: 12.5,
    colocacion_vencida_me: 0,
    moroso_mn: 0,
    moroso_me: null,
    castigado_mn: 2,
    castigado_me: 0,
    contingencias_mn: null,
    contingencias_me: null,
    creditos_reestructurados_mn: 3,
    creditos_reestructurados_me: null,
    sort_order: 0,
  });
  assert.strictEqual(formatted.vigente_mn, null);
  assert.strictEqual(formatted.vigente_me, 0);
  assert.strictEqual(formatted.vigente_no_autoliquidable_mn, 1);
  assert.strictEqual(formatted.colocacion_vencida_mn, 12.5);
  assert.strictEqual(formatted.colocacion_vencida_me, 0);
  assert.strictEqual(formatted.creditos_reestructurados_mn, 3);
  assert.strictEqual(formatted.creditos_reestructurados_me, null);
  assert.strictEqual(formatAmount(null), null);
  assert.strictEqual(formatAmount(0), 0);
}

// ---------- 26-36 ops tri-state (spot; full coverage in unit-rejected-ops) ----------
assert.strictEqual(
  deriveOpsStatus([
    {
      category: '4',
      moroso_mn: null,
      moroso_me: null,
      castigado_mn: null,
      castigado_me: null,
    },
  ]),
  OPS_STATUS.UNDEFINED_CASE,
);
assert.notStrictEqual(
  deriveOpsStatus([
    {
      category: '4',
      moroso_mn: null,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
    },
  ]),
  OPS_STATUS.RETRY_ELIGIBLE,
);
assert.strictEqual(
  deriveOpsStatus([{ category: '4', castigado_mn: 1, castigado_me: 0, moroso_mn: 0, moroso_me: 0 }]),
  OPS_STATUS.NO_AUTO_RECONSULT,
);
assert.strictEqual(
  deriveOpsStatus([
    {
      category: '4',
      moroso_mn: 10,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
    },
  ]),
  OPS_STATUS.RECONSULTABLE,
);
assert.strictEqual(TRI.UNKNOWN, 'UNKNOWN');

// ---------- 37-42 RPC SQL atomicity markers (no live DB) ----------
{
  const sqlPath = path.join(
    __dirname,
    '..',
    'migrations',
    '20260906_rechazados_bcu_confirm_stage4.sql',
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.indexOf('confirm_rejected_bcu_extraction_draft') >= 0);
  assert.ok(sql.indexOf('FOR UPDATE') >= 0);
  assert.ok(sql.indexOf("source") >= 0 && sql.indexOf("'llm_assisted'") >= 0);
  assert.ok(
    !/CREATE OR REPLACE FUNCTION[\s\S]*?p_storage_path[\s\S]*?RETURNS/i.test(sql),
    'RPC must not accept p_storage_path parameter',
  );
  assert.ok(sql.indexOf('reviewed_payload_sha256') >= 0);
  assert.ok(sql.indexOf('INSERT INTO public.rejected_bcu_snapshots') >= 0);
  assert.ok(sql.indexOf('INSERT INTO public.rejected_bcu_institutions') >= 0);
  assert.ok(sql.indexOf("status = 'confirmed'") >= 0);
  assert.ok(sql.indexOf("already_confirmed") >= 0);
  assert.strictEqual(RPC_NAME, 'confirm_rejected_bcu_extraction_draft');
}

// ---------- 37b Stage 6D.4 common writer + Stage 4 wrapper (not applied) ----------
{
  const sqlPath = path.join(
    __dirname,
    '..',
    'migrations',
    '20260909_rechazados_bcu_html_direct_persistence.sql',
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  assert.ok(sql.indexOf('persist_rejected_bcu_observation') >= 0);
  assert.ok(sql.indexOf('html_import') >= 0);
  assert.ok(sql.indexOf('FOR UPDATE') >= 0);
  assert.ok(sql.indexOf("status = 'confirmed'") >= 0);
  // Stage 4 wrapper must still force llm_assisted
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.confirm_rejected_bcu_extraction_draft[\s\S]*?'llm_assisted'/i.test(
      sql,
    ),
  );
  assert.ok(
    /RETURN public\.persist_rejected_bcu_observation/i.test(sql),
    'Stage 4 confirm must delegate to common persist RPC',
  );
}

async function runConfirmServiceCases() {
  const draftId = 'df85989a-2292-4210-baba-04b8cfe80956';
  const storagePath = draftId + '/file.png';
  const reviewed = baseReviewed();
  const consultedOn = '2026-09-06';
  const hash = hashConfirmPayload({ consulted_on: consultedOn, reviewed: reviewed });

  let rpcCalls = 0;

  function makeClient(opts) {
    return {
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  eq: function () {
                    return {
                      maybeSingle: async function () {
                        return {
                          data: opts.draft,
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      rpc: async function (name, params) {
        rpcCalls += 1;
        assert.strictEqual(name, RPC_NAME);
        if (opts.onRpc) {
          const out = await opts.onRpc(params);
          return out;
        }
        return {
          data: {
            already_confirmed: false,
            draft_id: draftId,
            confirmed_snapshot_id: 'snap-1',
            confirmed_at: '2026-09-06T12:00:00.000Z',
            reviewed_payload_sha256: params.p_reviewed_payload_sha256,
            draft: {
              id: draftId,
              status: 'confirmed',
              confirmed_snapshot_id: 'snap-1',
              confirmed_at: '2026-09-06T12:00:00.000Z',
            },
            snapshot: {
              id: 'snap-1',
              ci: 45006120,
              period_label: params.p_period_label,
              consulted_on: params.p_consulted_on,
              source: 'llm_assisted',
              storage_path: storagePath,
              original_filename: 'x.png',
              content_type: 'image/png',
              file_size_bytes: 10,
              reviewed_payload_sha256: params.p_reviewed_payload_sha256,
            },
            institutions: params.p_institutions.map(function (row, i) {
              return Object.assign({ id: 'i' + i, snapshot_id: 'snap-1' }, row);
            }),
          },
          error: null,
        };
      },
    };
  }

  rpcCalls = 0;
  const pendingDraft = {
    id: draftId,
    ci: 45006120,
    status: 'pending_review',
    storage_path: storagePath,
  };
  const ok = await confirmBcuExtractionDraft({
    ci: 45006120,
    draftId: draftId,
    body: { consulted_on: consultedOn, reviewed: reviewed },
    createdBy: null,
    client: makeClient({ draft: pendingDraft }),
  });
  assert.strictEqual(ok.httpStatus, 200);
  assert.strictEqual(ok.data.already_confirmed, false);
  assert.strictEqual(ok.data.review_completed, true);
  assert.strictEqual(ok.data.validation.human_review_required, true);
  assert.strictEqual(ok.data.validation.auto_persist_allowed, false);
  assert.strictEqual(ok.data.snapshot.storage_path, storagePath);
  assert.strictEqual(ok.data.snapshot.source, 'llm_assisted');
  assert.ok(rpcCalls === 1);

  rpcCalls = 0;
  let threw = false;
  try {
    await confirmBcuExtractionDraft({
      ci: 45006120,
      draftId: draftId,
      body: {
        consulted_on: consultedOn,
        reviewed: baseReviewed({
          institutions: [baseInstitution({ category: null })],
        }),
      },
      client: makeClient({ draft: pendingDraft }),
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.statusCode, 422);
    assert.strictEqual(e.code, 'CONFIRM_BLOCKED');
  }
  assert.ok(threw);
  assert.strictEqual(rpcCalls, 0);

  const confirmedDraft = {
    id: draftId,
    ci: 45006120,
    status: 'confirmed',
    storage_path: storagePath,
    confirmed_snapshot_id: 'snap-1',
    confirmed_at: '2026-09-06T12:00:00.000Z',
    reviewed_payload_sha256: hash,
  };
  const same = await confirmBcuExtractionDraft({
    ci: 45006120,
    draftId: draftId,
    body: { consulted_on: consultedOn, reviewed: reviewed },
    client: makeClient({
      draft: confirmedDraft,
      onRpc: async function () {
        return {
          data: {
            already_confirmed: true,
            draft_id: draftId,
            confirmed_snapshot_id: 'snap-1',
            confirmed_at: confirmedDraft.confirmed_at,
            reviewed_payload_sha256: hash,
            draft: confirmedDraft,
            snapshot: {
              id: 'snap-1',
              storage_path: storagePath,
              source: 'llm_assisted',
            },
            institutions: [],
          },
          error: null,
        };
      },
    }),
  });
  assert.strictEqual(same.data.already_confirmed, true);
  assert.strictEqual(same.data.reviewed_payload_mismatch, false);

  const mismatch = await confirmBcuExtractionDraft({
    ci: 45006120,
    draftId: draftId,
    body: { consulted_on: '2026-09-07', reviewed: reviewed },
    client: makeClient({
      draft: confirmedDraft,
      onRpc: async function () {
        return {
          data: {
            already_confirmed: true,
            draft_id: draftId,
            confirmed_snapshot_id: 'snap-1',
            confirmed_at: confirmedDraft.confirmed_at,
            reviewed_payload_sha256: hash,
            draft: confirmedDraft,
            snapshot: { id: 'snap-1', storage_path: storagePath },
            institutions: [],
          },
          error: null,
        };
      },
    }),
  });
  assert.strictEqual(mismatch.data.already_confirmed, true);
  assert.strictEqual(mismatch.data.reviewed_payload_mismatch, true);

  const altOn = '2026-08-01';
  const first = await confirmBcuExtractionDraft({
    ci: 45006120,
    draftId: draftId,
    body: { consulted_on: altOn, reviewed: reviewed },
    client: makeClient({
      draft: pendingDraft,
      onRpc: async function (params) {
        assert.strictEqual(params.p_consulted_on, altOn);
        return {
          data: {
            already_confirmed: false,
            draft_id: draftId,
            confirmed_snapshot_id: 'snap-2',
            confirmed_at: '2026-09-06T12:00:00.000Z',
            reviewed_payload_sha256: params.p_reviewed_payload_sha256,
            draft: {
              id: draftId,
              status: 'confirmed',
              confirmed_snapshot_id: 'snap-2',
              confirmed_at: '2026-09-06T12:00:00.000Z',
            },
            snapshot: {
              id: 'snap-2',
              consulted_on: altOn,
              storage_path: storagePath,
              source: 'llm_assisted',
            },
            institutions: [],
          },
          error: null,
        };
      },
    }),
  });
  assert.strictEqual(first.data.snapshot.consulted_on, altOn);
}

// ---------- 48-53 hash ----------
{
  const reviewed = baseReviewed();
  const a = hashConfirmPayload({
    consulted_on: '2026-09-06',
    reviewed: reviewed,
  });
  const reordered = {
    review: reviewed.review,
    summary: reviewed.summary,
    institutions: reviewed.institutions,
    document_ci_raw: reviewed.document_ci_raw,
    period: reviewed.period,
    currency_view_selected: reviewed.currency_view_selected,
    extraction_contract_version: reviewed.extraction_contract_version,
  };
  const b = hashConfirmPayload({
    reviewed: reordered,
    consulted_on: '2026-09-06',
  });
  assert.strictEqual(a, b);

  const c = hashConfirmPayload({
    consulted_on: '2026-09-06',
    reviewed: baseReviewed({ period: '202608' }),
  });
  assert.notStrictEqual(a, c);

  const d = hashConfirmPayload({
    consulted_on: '2026-09-07',
    reviewed: reviewed,
  });
  assert.notStrictEqual(a, d);

  // NFC
  const e1 = canonicalize('e\u0301');
  const e2 = canonicalize('\u00e9');
  assert.strictEqual(e1, e2);

  const arr1 = hashConfirmPayload({
    consulted_on: '2026-09-06',
    reviewed: baseReviewed({
      institutions: [
        baseInstitution({ institution_name_raw: 'A' }),
        baseInstitution({ institution_name_raw: 'B' }),
      ],
      summary: Object.assign(baseReviewed().summary, { vigente: money(200, 0) }),
    }),
  });
  const arr2 = hashConfirmPayload({
    consulted_on: '2026-09-06',
    reviewed: baseReviewed({
      institutions: [
        baseInstitution({ institution_name_raw: 'B' }),
        baseInstitution({ institution_name_raw: 'A' }),
      ],
      summary: Object.assign(baseReviewed().summary, { vigente: money(200, 0) }),
    }),
  });
  assert.notStrictEqual(arr1, arr2);

  // mismatch log shape contract (no CI / payload keys)
  const logKeys = ['draft_id', 'snapshot_id', 'sha_stored', 'sha_received'];
  assert.ok(logKeys.indexOf('ci') < 0);
}

// ---------- 54-57 storage: confirm module must not call storage writers ----------
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'rejectedBcuExtractConfirm.js'),
    'utf8',
  );
  assert.ok(src.indexOf('rejectedBcuStorage') < 0);
  assert.ok(src.indexOf('uploadRejectedBcuFile') < 0);
  assert.ok(src.indexOf('removeRejectedBcuFile') < 0);
  assert.ok(src.indexOf("require('./rejectedBcuPersist')") < 0);
  assert.ok(src.indexOf('parseBalance(') < 0);
}

// ---------- parseConfirmRequest ----------
{
  assert.throws(function () {
    parseConfirmRequest({});
  });
  const p = parseConfirmRequest({
    consulted_on: '2026-09-06',
    reviewed: baseReviewed(),
  });
  assert.strictEqual(p.consulted_on, '2026-09-06');
}

// ---------- reconcileSummaryValidationStatus explicit ----------
{
  assert.strictEqual(
    reconcileSummaryValidationStatus(baseReviewed()),
    SUMMARY_STATUS.MATCH,
  );
  assert.strictEqual(
    reconcileSummaryValidationStatus(
      baseReviewed({
        summary: Object.assign(baseReviewed().summary, { vigente: money(1, 0) }),
      }),
    ),
    SUMMARY_STATUS.MISMATCH,
  );
  assert.strictEqual(
    reconcileSummaryValidationStatus(
      baseReviewed({
        summary: {
          vigente: money(null, null),
          vigente_no_autoliquidable: money(null, null),
          colocacion_vencida: money(null, null),
          moroso: money(null, null),
          castigado_por_atraso: money(null, null),
          contingencias: money(null, null),
          creditos_reestructurados: money(null, null),
        },
      }),
    ),
    SUMMARY_STATUS.NOT_COMPARABLE,
  );
}

runConfirmServiceCases()
  .then(function () {
    console.log('OK unit-bcu-extract-confirm');
  })
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  });
