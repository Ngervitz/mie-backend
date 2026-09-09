'use strict';

/**
 * Stage 6D.4 — direct persist of trusted BCU HTML extractions (no draft).
 *
 * Does NOT parse HTML. Does NOT touch filesystem. Does NOT call OpenAI.
 * Ops status is derived in-memory after persist (not stored).
 */

const logger = require('./logger');
const { normalizeCi } = require('./rejectedOps');
const { deriveRejectedOps } = require('./rejectedOps');
const {
  parseConsultedOnInput,
  isValidCalendarDate,
  parseCreatedBy,
} = require('./rejectedBcuValidate');
const { EXTRACTION_CONTRACT_VERSION } = require('./bcuExtractContract');
const { hashConfirmPayload } = require('./bcuExtractCanonical');
const {
  flattenInstitutionsForRpc,
} = require('./rejectedBcuExtractConfirm');
const { isTrustedHtmlExtraction } = require('./rejectedBcuHtmlTrust');
const { PAGE_TYPE } = require('./bcuHtmlParser');
const { ACTIVE_DEDUP_STATUSES } = require('./bcuExtractTiming');
const { formatInstitution } = require('./rejectedOpsRead');

const SNAPSHOT_TABLE = 'rejected_bcu_snapshots';
const DRAFT_TABLE = 'rejected_bcu_extraction_drafts';
const PERSIST_RPC_NAME = 'persist_rejected_bcu_observation';

const RESULT = Object.freeze({
  IMPORTED: 'IMPORTED',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  CONFLICT_SAME_CI_PERIOD: 'CONFLICT_SAME_CI_PERIOD',
  UNTRUSTED_EXTRACTION: 'UNTRUSTED_EXTRACTION',
  INVALID_CI: 'INVALID_CI',
  PERSIST_FAILED: 'PERSIST_FAILED',
});

function resolveClient(input) {
  if (input && input.client) return input.client;
  return require('../clients/supabase');
}

function publicSnapshotFromRpc(snapshot, institutions) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    ci: snapshot.ci,
    period_label: snapshot.period_label,
    consulted_on: snapshot.consulted_on,
    source: snapshot.source,
    storage_path: snapshot.storage_path != null ? snapshot.storage_path : null,
    original_filename:
      snapshot.original_filename != null ? snapshot.original_filename : null,
    content_type: snapshot.content_type != null ? snapshot.content_type : null,
    file_size_bytes:
      snapshot.file_size_bytes != null ? Number(snapshot.file_size_bytes) : null,
    created_by: snapshot.created_by != null ? snapshot.created_by : null,
    created_at: snapshot.created_at,
    currency_view_selected:
      snapshot.currency_view_selected != null
        ? snapshot.currency_view_selected
        : null,
    extraction_contract_version:
      snapshot.extraction_contract_version != null
        ? snapshot.extraction_contract_version
        : null,
    document_ci_raw:
      snapshot.document_ci_raw != null ? snapshot.document_ci_raw : null,
    summary: snapshot.summary != null ? snapshot.summary : null,
    summary_validation_status:
      snapshot.summary_validation_status != null
        ? snapshot.summary_validation_status
        : null,
    summary_validation:
      snapshot.summary_validation != null ? snapshot.summary_validation : null,
    reviewed_payload_sha256:
      snapshot.reviewed_payload_sha256 != null
        ? snapshot.reviewed_payload_sha256
        : null,
    institutions: (Array.isArray(institutions) ? institutions : []).map(
      formatInstitution,
    ),
  };
}

function opsFromSnapshot(snapshot, institutions) {
  const rows = (Array.isArray(institutions) ? institutions : []).map(
    function (row) {
      return {
        category: row.category,
        moroso_mn: row.moroso_mn,
        moroso_me: row.moroso_me,
        castigado_mn: row.castigado_mn,
        castigado_me: row.castigado_me,
      };
    },
  );
  return deriveRejectedOps({
    institutions: rows,
    consultedOn: snapshot && snapshot.consulted_on,
  });
}

async function findActiveDraftExists(client, ci) {
  const { data, error } = await client
    .from(DRAFT_TABLE)
    .select('id')
    .eq('ci', ci)
    .in('status', ACTIVE_DEDUP_STATUSES.slice())
    .limit(1);
  if (error) {
    logger.warn('html persist active draft probe failed', {
      error: error.message,
      ci: ci,
    });
    return { exists: false, probe_error: true };
  }
  return { exists: Array.isArray(data) && data.length > 0, probe_error: false };
}

/**
 * Idempotency for (ci, period_label).
 * - same hash → ALREADY_CONFIRMED
 * - missing hash on existing (manual historical) → CONFLICT (conservative)
 * - different hash → CONFLICT
 */
async function checkSameCiPeriod(client, ci, periodLabel, payloadHash) {
  const { data, error } = await client
    .from(SNAPSHOT_TABLE)
    .select('id, reviewed_payload_sha256, source, consulted_on')
    .eq('ci', ci)
    .eq('period_label', periodLabel)
    .order('consulted_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    throw Object.assign(new Error('snapshot lookup failed'), {
      code: 'SNAPSHOT_LOOKUP_FAILED',
      cause: error,
    });
  }

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) {
    return { kind: 'none' };
  }

  const sameHash = rows.find(function (r) {
    return (
      r.reviewed_payload_sha256 != null &&
      r.reviewed_payload_sha256 === payloadHash
    );
  });
  if (sameHash) {
    return {
      kind: 'already',
      snapshot_id: sameHash.id,
      reviewed_payload_sha256: sameHash.reviewed_payload_sha256,
    };
  }

  // Existing rows with null hash (manual) or different hash → conflict, no overwrite.
  return {
    kind: 'conflict',
    snapshot_id: rows[0].id,
    existing_hash: rows[0].reviewed_payload_sha256 || null,
    existing_source: rows[0].source || null,
  };
}

async function loadSnapshotBundle(client, snapshotId) {
  const { data: snap, error: sErr } = await client
    .from(SNAPSHOT_TABLE)
    .select('*')
    .eq('id', snapshotId)
    .maybeSingle();
  if (sErr || !snap) {
    return { snapshot: null, institutions: [] };
  }
  const { data: inst } = await client
    .from('rejected_bcu_institutions')
    .select('*')
    .eq('snapshot_id', snapshotId)
    .order('sort_order', { ascending: true });
  return { snapshot: snap, institutions: Array.isArray(inst) ? inst : [] };
}

/**
 * @param {{
 *   ci: number|string,
 *   consultedOn: unknown,
 *   extraction: object,
 *   pageType?: string,
 *   parserMeta?: object|null,
 *   provenance?: object|null,
 *   createdBy?: string|null,
 *   client?: object,
 * }} input
 */
async function persistTrustedBcuHtmlObservation(input) {
  const client = resolveClient(input);
  const pageType =
    input.pageType != null ? input.pageType : PAGE_TYPE.RESULT_PAGE;

  const ci = normalizeCi(input.ci);
  if (ci == null) {
    return {
      result: RESULT.INVALID_CI,
      snapshot_id: null,
      reasons: [{ reason_code: 'INVALID_CI', path: 'ci' }],
      warnings: [],
      ops: null,
      active_draft_exists: false,
      snapshot: null,
    };
  }

  let consultedOn;
  try {
    consultedOn = parseConsultedOnInput(input.consultedOn);
  } catch (_e) {
    return {
      result: RESULT.UNTRUSTED_EXTRACTION,
      snapshot_id: null,
      reasons: [{ reason_code: 'CONSULTED_ON_INVALID', path: 'consulted_on' }],
      warnings: [],
      ops: null,
      active_draft_exists: false,
      snapshot: null,
    };
  }
  if (!isValidCalendarDate(consultedOn)) {
    return {
      result: RESULT.UNTRUSTED_EXTRACTION,
      snapshot_id: null,
      reasons: [{ reason_code: 'CONSULTED_ON_INVALID', path: 'consulted_on' }],
      warnings: [],
      ops: null,
      active_draft_exists: false,
      snapshot: null,
    };
  }

  const trust = isTrustedHtmlExtraction({
    pageType: pageType,
    extraction: input.extraction,
    expectedCi: ci,
    parserMeta: input.parserMeta || null,
  });

  if (!trust.ok) {
    return {
      result: RESULT.UNTRUSTED_EXTRACTION,
      snapshot_id: null,
      reasons: trust.reasons,
      warnings: trust.warnings,
      validation: trust.validation,
      ops: null,
      active_draft_exists: false,
      snapshot: null,
    };
  }

  const extraction = input.extraction;
  const payloadHash = hashConfirmPayload({
    consulted_on: consultedOn,
    reviewed: extraction,
  });

  const activeProbe = await findActiveDraftExists(client, ci);
  const active_draft_exists = activeProbe.exists === true;

  let dedup;
  try {
    dedup = await checkSameCiPeriod(
      client,
      ci,
      String(extraction.period),
      payloadHash,
    );
  } catch (e) {
    logger.error('html persist dedup lookup failed', {
      error: e.message,
      ci: ci,
    });
    return {
      result: RESULT.PERSIST_FAILED,
      snapshot_id: null,
      reasons: [{ reason_code: 'SNAPSHOT_LOOKUP_FAILED' }],
      warnings: trust.warnings,
      ops: null,
      active_draft_exists: active_draft_exists,
      snapshot: null,
    };
  }

  if (dedup.kind === 'already') {
    const bundle = await loadSnapshotBundle(client, dedup.snapshot_id);
    return {
      result: RESULT.ALREADY_CONFIRMED,
      snapshot_id: dedup.snapshot_id,
      reasons: [],
      warnings: trust.warnings,
      ops: opsFromSnapshot(bundle.snapshot, bundle.institutions),
      active_draft_exists: active_draft_exists,
      snapshot: publicSnapshotFromRpc(bundle.snapshot, bundle.institutions),
      reviewed_payload_sha256: payloadHash,
    };
  }

  if (dedup.kind === 'conflict') {
    return {
      result: RESULT.CONFLICT_SAME_CI_PERIOD,
      snapshot_id: dedup.snapshot_id,
      reasons: [
        {
          reason_code: 'CONFLICT_SAME_CI_PERIOD',
          path: 'period',
          detail: {
            existing_snapshot_id: dedup.snapshot_id,
            existing_hash: dedup.existing_hash,
            existing_source: dedup.existing_source,
            incoming_hash: payloadHash,
          },
        },
      ],
      warnings: trust.warnings,
      ops: null,
      active_draft_exists: active_draft_exists,
      snapshot: null,
      reviewed_payload_sha256: payloadHash,
    };
  }

  const institutions = flattenInstitutionsForRpc(extraction);
  const gate = trust.gate;
  const createdBy = parseCreatedBy(input.createdBy);

  const params = {
    p_ci: ci,
    p_period_label: extraction.period,
    p_consulted_on: consultedOn,
    p_source: 'html_import',
    p_created_by: createdBy,
    p_currency_view_selected: extraction.currency_view_selected,
    p_extraction_contract_version:
      extraction.extraction_contract_version || EXTRACTION_CONTRACT_VERSION,
    p_document_ci_raw: extraction.document_ci_raw,
    p_summary: extraction.summary || null,
    p_summary_validation_status: gate.summary_validation_status,
    p_summary_validation: gate.summary_validation,
    p_reviewed_payload_sha256: payloadHash,
    p_institutions: institutions,
    p_storage_path: null,
    p_original_filename: null,
    p_content_type: null,
    p_file_size_bytes: null,
    p_draft_id: null,
  };

  const { data, error } = await client.rpc(PERSIST_RPC_NAME, params);
  if (error) {
    logger.error('html persist RPC failed', {
      error: error.message,
      ci: ci,
      code: error.code || null,
    });
    return {
      result: RESULT.PERSIST_FAILED,
      snapshot_id: null,
      reasons: [{ reason_code: 'PERSIST_RPC_FAILED', detail: { rpc: PERSIST_RPC_NAME } }],
      warnings: trust.warnings,
      ops: null,
      active_draft_exists: active_draft_exists,
      snapshot: null,
    };
  }

  const rpc = data && typeof data === 'object' ? data : {};
  const snapshot = publicSnapshotFromRpc(rpc.snapshot, rpc.institutions);

  return {
    result: RESULT.IMPORTED,
    snapshot_id: rpc.confirmed_snapshot_id || (rpc.snapshot && rpc.snapshot.id) || null,
    reasons: [],
    warnings: trust.warnings,
    ops: opsFromSnapshot(rpc.snapshot, rpc.institutions),
    active_draft_exists: active_draft_exists,
    snapshot: snapshot,
    reviewed_payload_sha256: payloadHash,
    draft_id: rpc.draft_id || null,
  };
}

module.exports = {
  RESULT,
  PERSIST_RPC_NAME,
  persistTrustedBcuHtmlObservation,
  checkSameCiPeriod,
};
