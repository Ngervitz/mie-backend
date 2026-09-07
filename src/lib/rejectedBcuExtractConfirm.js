'use strict';

/**
 * Stage 4 — confirm BCU extraction draft after human review.
 *
 * Does NOT use the manual snapshot writer or parseBalance.
 * Does NOT write/move/delete Storage objects.
 * Truth persisted = reviewed payload (not draft.extraction_json).
 */

const logger = require('./logger');
const { parseConsultedOnInput, parseCreatedBy, isValidCalendarDate } = require('./rejectedBcuValidate');
const {
  EXTRACTION_CONTRACT_VERSION,
  RUBRO_KEYS,
  MONEY_SIDES,
} = require('./bcuExtractContract');
const { hashConfirmPayload } = require('./bcuExtractCanonical');
const { evaluateConfirmGates } = require('./bcuExtractConfirmGates');
const { formatInstitution } = require('./rejectedOpsRead');

const DRAFT_TABLE = 'rejected_bcu_extraction_drafts';
const RPC_NAME = 'confirm_rejected_bcu_extraction_draft';

const DRAFT_SELECT =
  'id, ci, status, storage_path, original_filename, content_type, file_size_bytes, file_sha256, extraction_json, validation_json, extraction_contract_version, currency_view_selected, document_ci_raw, confirmed_snapshot_id, confirmed_at, reviewed_payload_sha256, attempt_id, lease_expires_at, created_by, created_at, updated_at';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveClient(input) {
  if (input && input.client) return input.client;
  // Lazy load so unit tests can inject a mock without requiring env secrets.
  return require('../clients/supabase');
}

function httpError(statusCode, message, code, data) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function assertDraftId(raw) {
  if (!raw || !UUID_RE.test(String(raw))) {
    throw httpError(400, 'draft inválido', 'DRAFT_INVALID');
  }
  return String(raw);
}

/**
 * Parse confirm body. consulted_on required; reviewed required object.
 * @param {unknown} body
 */
function parseConfirmRequest(body) {
  const src = body && typeof body === 'object' ? body : {};
  if (src.consulted_on == null || src.consulted_on === '') {
    throw httpError(400, 'consulted_on inválido', 'CONSULTED_ON_REQUIRED');
  }
  // Reuse calendar validator; throw shape matches manual write.
  let consulted_on;
  try {
    consulted_on = parseConsultedOnInput(src.consulted_on);
  } catch (e) {
    throw httpError(400, 'consulted_on inválido', 'CONSULTED_ON_INVALID');
  }
  if (!isValidCalendarDate(consulted_on)) {
    throw httpError(400, 'consulted_on inválido', 'CONSULTED_ON_INVALID');
  }

  const reviewed = src.reviewed;
  if (reviewed == null || typeof reviewed !== 'object' || Array.isArray(reviewed)) {
    throw httpError(400, 'reviewed inválido', 'REVIEWED_INVALID');
  }

  return { consulted_on: consulted_on, reviewed: reviewed };
}

function moneySideValue(pair, side) {
  if (pair == null || typeof pair !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(pair, side)) return null;
  const v = pair[side];
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Invalid types are blocked by gates before flatten; defensive null.
  return null;
}

/**
 * Flatten reviewed.institutions → RPC institution rows (12 amounts, null preserved).
 * @param {object} reviewed
 * @returns {object[]}
 */
function flattenInstitutionsForRpc(reviewed) {
  const list = Array.isArray(reviewed.institutions) ? reviewed.institutions : [];
  return list.map(function (inst, index) {
    const row = {
      institution_name: String(
        (inst && inst.institution_name_raw) || '',
      ).trim(),
      category: inst && inst.category != null ? inst.category : null,
      sort_order: index,
    };
    for (let r = 0; r < RUBRO_KEYS.length; r += 1) {
      const rubro = RUBRO_KEYS[r];
      const dbBase =
        rubro === 'castigado_por_atraso' ? 'castigado' : rubro;
      const pair = inst && inst[rubro];
      for (let s = 0; s < MONEY_SIDES.length; s += 1) {
        const side = MONEY_SIDES[s];
        row[dbBase + '_' + side] = moneySideValue(pair, side);
      }
    }
    return row;
  });
}

function publicDraftFromRow(row) {
  return {
    id: row.id,
    status: row.status,
    confirmed_snapshot_id: row.confirmed_snapshot_id,
    confirmed_at: row.confirmed_at,
  };
}

function publicSnapshotFromRpc(snapshot, institutions) {
  if (!snapshot) return null;
  const out = {
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
    institutions: (Array.isArray(institutions) ? institutions : []).map(
      formatInstitution,
    ),
  };
  return out;
}

function buildValidationResponse(gateResult) {
  const v = gateResult.validation;
  return {
    classification: gateResult.classification,
    reason_codes: (v && v.reason_codes) || [],
    findings: (v && v.findings) || [],
    warnings: gateResult.warnings || [],
    human_review_required: true,
    auto_persist_allowed: false,
  };
}

function mapRpcError(error) {
  const msg = String((error && error.message) || '');
  if (msg.indexOf('DRAFT_NOT_FOUND') >= 0) {
    return httpError(404, 'draft no encontrado', 'DRAFT_NOT_FOUND');
  }
  if (msg.indexOf('DRAFT_NOT_PENDING') >= 0) {
    return httpError(409, 'draft no confirmable', 'DRAFT_NOT_PENDING');
  }
  return httpError(
    500,
    'Error interno',
    'CONFIRM_RPC_FAILED',
    { rpc: RPC_NAME },
  );
}

/**
 * @param {{
 *   ci: number,
 *   draftId: string,
 *   body: unknown,
 *   createdBy?: string|null,
 *   client?: object,
 * }} input
 */
async function confirmBcuExtractionDraft(input) {
  const client = resolveClient(input);
  const ci = input.ci;
  const draftId = assertDraftId(input.draftId);
  const parsed = parseConfirmRequest(input.body);
  const createdBy = parseCreatedBy(input.createdBy);

  const receivedHash = hashConfirmPayload({
    consulted_on: parsed.consulted_on,
    reviewed: parsed.reviewed,
  });

  const { data: draftRow, error: loadErr } = await client
    .from(DRAFT_TABLE)
    .select(DRAFT_SELECT)
    .eq('id', draftId)
    .eq('ci', ci)
    .maybeSingle();

  if (loadErr) {
    logger.error('confirm draft load failed', {
      error: loadErr.message,
      draft_id: draftId,
    });
    throw httpError(500, 'Error interno', 'DRAFT_LOAD_FAILED');
  }
  if (!draftRow) {
    throw httpError(404, 'draft no encontrado', 'DRAFT_NOT_FOUND');
  }

  // Already confirmed: still go through RPC for lock-safe read; compare hashes in Node.
  if (draftRow.status === 'confirmed') {
    const rpcResult = await callConfirmRpc(client, {
      draftId: draftId,
      ci: ci,
      consultedOn: parsed.consulted_on,
      createdBy: createdBy,
      reviewed: parsed.reviewed,
      receivedHash: receivedHash,
      // Dummy validated fields unused on idempotent path — still required by signature.
      // Prefer re-running gates only when pending; for confirmed skip mutation path.
      gateResult: null,
      institutions: [],
      skipValidation: true,
    });
    return finalizeIdempotentResponse(rpcResult, receivedHash, null);
  }

  if (draftRow.status !== 'pending_review') {
    throw httpError(409, 'draft no confirmable', 'DRAFT_NOT_PENDING', {
      status: draftRow.status,
    });
  }

  const gateResult = evaluateConfirmGates(parsed.reviewed, {
    expected_ci: String(ci),
  });

  if (!gateResult.ok) {
    throw httpError(422, 'confirmación bloqueada', 'CONFIRM_BLOCKED', {
      blockers: gateResult.blockers,
      warnings: gateResult.warnings,
      validation: buildValidationResponse(gateResult),
      review_completed: false,
      already_confirmed: false,
      reviewed_payload_mismatch: false,
    });
  }

  const institutions = flattenInstitutionsForRpc(parsed.reviewed);

  const rpcResult = await callConfirmRpc(client, {
    draftId: draftId,
    ci: ci,
    consultedOn: parsed.consulted_on,
    createdBy: createdBy,
    reviewed: parsed.reviewed,
    receivedHash: receivedHash,
    gateResult: gateResult,
    institutions: institutions,
    skipValidation: false,
  });

  if (rpcResult.already_confirmed) {
    return finalizeIdempotentResponse(rpcResult, receivedHash, gateResult);
  }

  return {
    httpStatus: 200,
    data: {
      draft: publicDraftFromRow(rpcResult.draft || {
        id: rpcResult.draft_id,
        status: 'confirmed',
        confirmed_snapshot_id: rpcResult.confirmed_snapshot_id,
        confirmed_at: rpcResult.confirmed_at,
      }),
      snapshot: publicSnapshotFromRpc(
        rpcResult.snapshot,
        rpcResult.institutions,
      ),
      validation: buildValidationResponse(gateResult),
      review_completed: true,
      already_confirmed: false,
      reviewed_payload_mismatch: false,
    },
  };
}

async function callConfirmRpc(client, args) {
  const reviewed = args.reviewed;
  const gate = args.gateResult;

  const params = {
    p_draft_id: args.draftId,
    p_ci: args.ci,
    p_consulted_on: args.consultedOn,
    p_created_by: args.createdBy,
    p_period_label: args.skipValidation ? '' : reviewed.period,
    p_currency_view_selected: args.skipValidation
      ? null
      : reviewed.currency_view_selected,
    p_extraction_contract_version: args.skipValidation
      ? EXTRACTION_CONTRACT_VERSION
      : reviewed.extraction_contract_version || EXTRACTION_CONTRACT_VERSION,
    p_document_ci_raw: args.skipValidation ? null : reviewed.document_ci_raw,
    p_summary: args.skipValidation ? null : reviewed.summary || null,
    p_summary_validation_status: args.skipValidation
      ? 'NOT_COMPARABLE'
      : gate.summary_validation_status,
    p_summary_validation: args.skipValidation
      ? null
      : gate.summary_validation,
    p_reviewed_payload_sha256: args.receivedHash,
    p_institutions: args.institutions,
  };

  // Idempotent confirmed path: RPC ignores payload fields when status=confirmed.
  // Still pass a syntactically valid hash (received) for signature.
  const { data, error } = await client.rpc(RPC_NAME, params);
  if (error) {
    logger.error('confirm RPC failed', {
      error: error.message,
      draft_id: args.draftId,
      code: error.code || null,
    });
    throw mapRpcError(error);
  }
  return data && typeof data === 'object' ? data : {};
}

function finalizeIdempotentResponse(rpcResult, receivedHash, gateResult) {
  const stored = rpcResult.reviewed_payload_sha256 || null;
  const mismatch = stored != null && stored !== receivedHash;

  if (mismatch) {
    logger.warn('bcu confirm reviewed_payload_mismatch', {
      draft_id: rpcResult.draft_id,
      snapshot_id: rpcResult.confirmed_snapshot_id,
      sha_stored: stored,
      sha_received: receivedHash,
    });
  }

  const validation = gateResult
    ? buildValidationResponse(gateResult)
    : {
        classification: null,
        reason_codes: [],
        findings: [],
        warnings: [],
        human_review_required: true,
        auto_persist_allowed: false,
      };

  return {
    httpStatus: 200,
    data: {
      draft: publicDraftFromRow(rpcResult.draft || {
        id: rpcResult.draft_id,
        status: 'confirmed',
        confirmed_snapshot_id: rpcResult.confirmed_snapshot_id,
        confirmed_at: rpcResult.confirmed_at,
      }),
      snapshot: publicSnapshotFromRpc(
        rpcResult.snapshot,
        rpcResult.institutions,
      ),
      validation: validation,
      review_completed: true,
      already_confirmed: true,
      reviewed_payload_mismatch: mismatch,
    },
  };
}

module.exports = {
  RPC_NAME,
  parseConfirmRequest,
  flattenInstitutionsForRpc,
  confirmBcuExtractionDraft,
  hashConfirmPayload,
};
