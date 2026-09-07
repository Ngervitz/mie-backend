'use strict';

/**
 * Stage 3 — BCU extraction drafts (proposal only; never confirmed snapshots).
 *
 * same_upload = (ci, file_sha256). Soft dedup V1 ONLY among active statuses:
 *   extracting | extraction_failed | pending_review
 * Deliberately does NOT cover confirmed | abandoned | expired | rejected_bcu_snapshots.
 *
 * Does NOT import persistRejectedBcuSnapshot, deriveOpsStatus, or parseBalance.
 */

const { createHash, randomUUID } = require('crypto');
const logger = require('./logger');
const {
  classifyBcuExtraction,
  CLASSIFICATION,
} = require('./bcuExtractClassify');
const { EXTRACTION_CONTRACT_VERSION } = require('./bcuExtractContract');
const { extractBcuV1FromImage, resolveModel, resolveDetail, sanitizeErrorMessage } = require('./bcuExtractLlm');
const {
  LEASE_TTL_MS,
  ACTIVE_DEDUP_STATUSES,
} = require('./bcuExtractTiming');
const {
  uploadRejectedBcuFile,
  removeRejectedBcuFile,
  downloadRejectedBcuFile,
  pathContainsCi,
  MIME_TO_EXT,
} = require('./rejectedBcuStorage');

const DRAFT_TABLE = 'rejected_bcu_extraction_drafts';

const DRAFT_SELECT =
  'id, ci, status, storage_path, original_filename, content_type, file_size_bytes, file_sha256, extraction_json, validation_json, extraction_contract_version, currency_view_selected, document_ci_raw, confirmed_snapshot_id, created_by, created_at, updated_at, expires_at, abandoned_at, confirmed_at, purge_after, attempt_id, lease_expires_at';

function httpError(statusCode, message, code, data) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isLeaseExpired(draft, nowMs) {
  if (!draft || draft.status !== 'extracting') return false;
  if (draft.lease_expires_at == null) return true;
  const expires = Date.parse(draft.lease_expires_at);
  if (!Number.isFinite(expires)) return true;
  return expires < nowMs;
}

function reuseFlags(draft, nowMs) {
  const state = draft.status;
  if (state === 'pending_review') {
    return { can_retry: false, in_progress: false };
  }
  if (state === 'extraction_failed') {
    return { can_retry: true, in_progress: false };
  }
  if (state === 'extracting') {
    const expired = isLeaseExpired(draft, nowMs);
    return { can_retry: expired, in_progress: !expired };
  }
  return { can_retry: false, in_progress: false };
}

function buildDraftFileUrl(ci, draftId) {
  return (
    '/rechazados/' +
    encodeURIComponent(String(ci)) +
    '/bcu-extraction-drafts/' +
    encodeURIComponent(String(draftId)) +
    '/file'
  );
}

/** Public draft meta — never includes storage_path (browser uses file_url proxy). */
function publicDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    ci: row.ci,
    status: row.status,
    original_filename: row.original_filename,
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    file_sha256: row.file_sha256,
    extraction_contract_version: row.extraction_contract_version,
    currency_view_selected: row.currency_view_selected,
    document_ci_raw: row.document_ci_raw,
    confirmed_snapshot_id: row.confirmed_snapshot_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    abandoned_at: row.abandoned_at,
    confirmed_at: row.confirmed_at,
    purge_after: row.purge_after,
    lease_expires_at: row.lease_expires_at,
    file_available: !!row.storage_path,
    file_url: buildDraftFileUrl(row.ci, row.id),
  };
}

function buildResponse(draftRow, opts) {
  const nowMs = opts.nowMs;
  const flags = reuseFlags(draftRow, nowMs);
  return {
    draft: publicDraft(draftRow),
    state: draftRow.status,
    reused: !!opts.reused,
    can_retry: flags.can_retry,
    in_progress: flags.in_progress,
    extraction: draftRow.extraction_json,
    validation: draftRow.validation_json,
  };
}

function serializeFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.map(function (f) {
    return {
      severity: f.severity,
      reason_code: f.reason_code,
      path: f.path != null ? f.path : null,
      message: f.message != null ? String(f.message).slice(0, 500) : null,
    };
  });
}

function buildLlmMeta(partial) {
  return {
    total_calls: partial.total_calls != null ? partial.total_calls : 0,
    pass_count: partial.pass_count != null ? partial.pass_count : 0,
    reread_count: 0,
    usage: partial.usage != null ? partial.usage : null,
    cost_usd_estimated:
      partial.cost_usd_estimated !== undefined
        ? partial.cost_usd_estimated
        : null,
    latency_ms: partial.latency_ms != null ? partial.latency_ms : null,
    outcome: partial.outcome != null ? partial.outcome : null,
    error: partial.error != null ? String(partial.error).slice(0, 500) : null,
  };
}

function buildInitialValidationJson(meta) {
  return {
    human_review_required: true,
    auto_persist_allowed: false,
    meta: {
      file_sha256: meta.file_sha256,
      model: meta.model,
      detail: meta.detail,
      attempt_id: meta.attempt_id,
      phase: 'extracting',
      llm: buildLlmMeta({
        total_calls: 0,
        pass_count: 0,
        cost_usd_estimated: null,
      }),
    },
  };
}

function buildSuccessValidationJson(classified, meta, llmResult) {
  return {
    classification: classified.classification,
    reason_codes: classified.reason_codes,
    findings: serializeFindings(classified.findings),
    human_review_required: true,
    auto_persist_allowed: false,
    meta: {
      file_sha256: meta.file_sha256,
      model: llmResult.model || meta.model,
      detail: llmResult.detail || meta.detail,
      attempt_id: meta.attempt_id,
      llm: buildLlmMeta({
        total_calls: 1,
        pass_count: 1,
        usage: llmResult.usage,
        cost_usd_estimated: llmResult.cost_usd_estimated,
        latency_ms: llmResult.latency_ms,
        outcome: 'ok',
      }),
    },
  };
}

function buildFailureValidationJson(meta, llmResult, classified) {
  const classification =
    classified && classified.classification
      ? classified.classification
      : CLASSIFICATION.EXTRACTION_FAILED;
  return {
    classification: classification,
    reason_codes:
      classified && classified.reason_codes ? classified.reason_codes : [],
    findings: classified ? serializeFindings(classified.findings) : [],
    human_review_required: true,
    auto_persist_allowed: false,
    meta: {
      file_sha256: meta.file_sha256,
      model: (llmResult && llmResult.model) || meta.model,
      detail: (llmResult && llmResult.detail) || meta.detail,
      attempt_id: meta.attempt_id,
      llm: buildLlmMeta({
        total_calls: 1,
        pass_count: 0,
        usage: llmResult && llmResult.usage,
        cost_usd_estimated:
          llmResult && llmResult.cost_usd_estimated !== undefined
            ? llmResult.cost_usd_estimated
            : null,
        latency_ms: llmResult && llmResult.latency_ms,
        outcome: (llmResult && llmResult.outcome) || 'error',
        error: llmResult && llmResult.error,
      }),
    },
  };
}

function resolveDeps(deps) {
  const d = deps || {};
  return {
    supabase: d.supabase,
    upload: d.upload || uploadRejectedBcuFile,
    remove: d.remove || removeRejectedBcuFile,
    download: d.download || downloadRejectedBcuFile,
    extractLlm: d.extractLlm || extractBcuV1FromImage,
    classify: d.classify || classifyBcuExtraction,
    nowMs: d.nowMs || function () {
      return Date.now();
    },
    uuid: d.uuid || randomUUID,
    logger: d.logger || logger,
  };
}

async function findActiveSameUpload(supabase, ci, fileSha256) {
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .select(DRAFT_SELECT)
    .eq('ci', ci)
    .eq('file_sha256', fileSha256)
    .in('status', ACTIVE_DEDUP_STATUSES.slice())
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    logger.error('bcu extract draft soft-dedup query failed', {
      error: error.message,
    });
    throw httpError(500, 'Error interno', 'DEDUP_QUERY_FAILED');
  }
  const rows = data || [];
  return rows.length ? rows[0] : null;
}

async function fetchDraftById(supabase, draftId) {
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .select(DRAFT_SELECT)
    .eq('id', draftId)
    .maybeSingle();
  if (error) {
    throw httpError(500, 'Error interno', 'DRAFT_FETCH_FAILED');
  }
  return data || null;
}

async function casComplete(supabase, opts) {
  const patch = {
    status: opts.status,
    extraction_json: opts.extraction_json,
    validation_json: opts.validation_json,
    attempt_id: null,
    lease_expires_at: null,
    updated_at: new Date(opts.nowMs).toISOString(),
  };
  if (opts.currency_view_selected !== undefined) {
    patch.currency_view_selected = opts.currency_view_selected;
  }
  if (opts.document_ci_raw !== undefined) {
    patch.document_ci_raw = opts.document_ci_raw;
  }

  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .update(patch)
    .eq('id', opts.draftId)
    .eq('status', 'extracting')
    .eq('attempt_id', opts.attemptId)
    .select(DRAFT_SELECT)
    .maybeSingle();

  if (error) {
    logger.error('bcu extract draft CAS failed', {
      draftId: opts.draftId,
      error: error.message,
    });
    throw httpError(500, 'Error interno', 'CAS_UPDATE_FAILED');
  }
  return data || null;
}

async function runOwnedExtractionAttempt(input, deps) {
  const io = resolveDeps(deps);
  const {
    draftId,
    attemptId,
    fileSha256,
    buffer,
    contentType,
    expectedCi,
  } = input;
  const nowMs = io.nowMs();
  const meta = {
    file_sha256: fileSha256,
    model: resolveModel(),
    detail: resolveDetail(),
    attempt_id: attemptId,
  };

  let llmResult;
  try {
    llmResult = await io.extractLlm({
      buffer: buffer,
      contentType: contentType,
    });
  } catch (err) {
    // Draft already extracting: never leave ownership hanging on thrown errors.
    llmResult = {
      ok: false,
      outcome: 'error',
      model: meta.model,
      detail: meta.detail,
      latency_ms: null,
      usage: null,
      cost_usd_estimated: null,
      extraction: null,
      error: sanitizeErrorMessage(
        err && err.message ? err.message : 'llm_throw',
      ),
    };
  }

  if (!llmResult || !llmResult.ok || !llmResult.extraction) {
    const validation = buildFailureValidationJson(meta, llmResult || {}, null);
    const row = await casComplete(io.supabase, {
      draftId: draftId,
      attemptId: attemptId,
      status: 'extraction_failed',
      extraction_json: null,
      validation_json: validation,
      nowMs: io.nowMs(),
    });
    if (!row) {
      return handleSuperseded(io, draftId, attemptId, 'error');
    }
    return { httpStatus: input.created ? 201 : 200, data: buildResponse(row, { reused: false, nowMs: io.nowMs() }) };
  }

  const classified = io.classify(llmResult.extraction, {
    expected_ci: expectedCi != null ? String(expectedCi) : null,
  });

  if (classified.classification === CLASSIFICATION.EXTRACTION_FAILED) {
    const validation = buildFailureValidationJson(meta, llmResult, classified);
    validation.meta.llm.outcome = 'contract_invalid';
    const row = await casComplete(io.supabase, {
      draftId: draftId,
      attemptId: attemptId,
      status: 'extraction_failed',
      extraction_json: null,
      validation_json: validation,
      nowMs: io.nowMs(),
    });
    if (!row) {
      return handleSuperseded(io, draftId, attemptId, 'error');
    }
    return { httpStatus: input.created ? 201 : 200, data: buildResponse(row, { reused: false, nowMs: io.nowMs() }) };
  }

  // REVIEW_READY | HUMAN_REVIEW → pending_review (always human)
  const validation = buildSuccessValidationJson(classified, meta, llmResult);
  const row = await casComplete(io.supabase, {
    draftId: draftId,
    attemptId: attemptId,
    status: 'pending_review',
    extraction_json: llmResult.extraction,
    validation_json: validation,
    currency_view_selected: llmResult.extraction.currency_view_selected,
    document_ci_raw: llmResult.extraction.document_ci_raw,
    nowMs: io.nowMs(),
  });
  if (!row) {
    return handleSuperseded(io, draftId, attemptId, 'success');
  }
  return {
    httpStatus: input.created ? 201 : 200,
    data: buildResponse(row, { reused: false, nowMs: io.nowMs() }),
  };
}

async function handleSuperseded(io, draftId, attemptId, kind) {
  io.logger.warn('extraction_superseded', {
    draftId: draftId,
    stale_attempt_id: attemptId,
    kind: kind,
  });
  const current = await fetchDraftById(io.supabase, draftId);
  throw httpError(409, 'extraction_superseded', 'extraction_superseded', {
    draft: publicDraft(current),
    state: current && current.status,
    validation: current && current.validation_json,
  });
}

/**
 * Create or soft-reuse a BCU extraction draft from an uploaded image.
 * @param {{ ci: number, fileMeta: object, created_by: string|null }} input
 */
async function createBcuExtractionDraft(input, deps) {
  const io = resolveDeps(deps);
  if (!io.supabase) throw httpError(500, 'Error interno', 'NO_SUPABASE');

  const fileMeta = input.fileMeta;
  if (!fileMeta || !fileMeta.buffer) {
    throw httpError(400, 'archivo no permitido');
  }

  const fileSha256 = sha256Hex(fileMeta.buffer);
  const nowMs = io.nowMs();

  const existing = await findActiveSameUpload(
    io.supabase,
    input.ci,
    fileSha256,
  );
  if (existing) {
    return {
      httpStatus: 200,
      data: buildResponse(existing, { reused: true, nowMs: nowMs }),
      llmCalled: false,
    };
  }

  const draftId = input.draftId || io.uuid();
  const attemptId = input.attemptId || io.uuid();
  const ownershipMs = io.nowMs();
  const leaseExpiresAt = new Date(ownershipMs + LEASE_TTL_MS).toISOString();
  const model = resolveModel();
  const detail = resolveDetail();

  const storagePath = await io.upload(io.supabase, {
    ownerId: draftId,
    snapshotId: draftId,
    objectId: input.fileObjectId || io.uuid(),
    ext: fileMeta.ext,
    buffer: fileMeta.buffer,
    contentType: fileMeta.contentType,
  });

  if (pathContainsCi(storagePath, input.ci)) {
    try {
      await io.remove(io.supabase, storagePath);
    } catch (_e) {
      /* logged in remove */
    }
    throw httpError(500, 'Error interno', 'PATH_CONTAINS_CI');
  }

  const insertRow = {
    id: draftId,
    ci: input.ci,
    status: 'extracting',
    storage_path: storagePath,
    original_filename: fileMeta.originalFilename,
    content_type: fileMeta.contentType,
    file_size_bytes: fileMeta.fileSizeBytes,
    file_sha256: fileSha256,
    extraction_json: null,
    validation_json: buildInitialValidationJson({
      file_sha256: fileSha256,
      model: model,
      detail: detail,
      attempt_id: attemptId,
    }),
    extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
    currency_view_selected: null,
    document_ci_raw: null,
    created_by: input.created_by,
    attempt_id: attemptId,
    lease_expires_at: leaseExpiresAt,
  };

  const { data: inserted, error: insertError } = await io.supabase
    .from(DRAFT_TABLE)
    .insert(insertRow)
    .select(DRAFT_SELECT)
    .single();

  if (insertError || !inserted) {
    io.logger.error('bcu extract draft insert failed', {
      error: insertError && insertError.message,
    });
    try {
      await io.remove(io.supabase, storagePath);
    } catch (cleanErr) {
      io.logger.error('bcu extract draft storage cleanup failed', {
        storagePath: storagePath,
        error: cleanErr && cleanErr.message ? cleanErr.message : 'unknown',
      });
    }
    throw httpError(500, 'Error interno', 'DRAFT_INSERT_FAILED');
  }

  const result = await runOwnedExtractionAttempt(
    {
      draftId: draftId,
      attemptId: attemptId,
      fileSha256: fileSha256,
      buffer: fileMeta.buffer,
      contentType: fileMeta.contentType,
      expectedCi: input.ci,
      created: true,
    },
    io,
  );
  result.llmCalled = true;
  return result;
}

/**
 * Retry / reclaim without re-upload. Reuses draft.storage_path exactly.
 */
async function retryBcuExtractionDraft(input, deps) {
  const io = resolveDeps(deps);
  if (!io.supabase) throw httpError(500, 'Error interno', 'NO_SUPABASE');

  const draftId = input.draftId;
  const ci = input.ci;

  // SELECT is validation only (exists, ci, storage_path). Ownership is acquired
  // exclusively by the conditional UPDATE + RETURNING below — never by this read.
  const existing = await fetchDraftById(io.supabase, draftId);
  if (!existing || existing.ci !== ci) {
    throw httpError(404, 'No encontrado');
  }
  if (!existing.storage_path) {
    throw httpError(500, 'Error interno', 'MISSING_STORAGE_PATH');
  }
  if (pathContainsCi(existing.storage_path, ci)) {
    throw httpError(500, 'Error interno', 'PATH_CONTAINS_CI');
  }

  const attemptId = input.attemptId || io.uuid();
  const ownershipMs = io.nowMs();
  const leaseExpiresAt = new Date(ownershipMs + LEASE_TTL_MS).toISOString();

  const acquire = await acquireRetryOwnershipWithNow(
    io.supabase,
    draftId,
    ci,
    attemptId,
    leaseExpiresAt,
    ownershipMs,
  );

  if (!acquire.row) {
    const current = await fetchDraftById(io.supabase, draftId);
    throw httpError(409, 'extraction_in_progress_or_conflict', 'conflict', {
      draft: publicDraft(current),
      state: current && current.status,
      can_retry: current ? reuseFlags(current, ownershipMs).can_retry : false,
      in_progress: current
        ? reuseFlags(current, ownershipMs).in_progress
        : false,
    });
  }

  const buffer = await io.download(io.supabase, existing.storage_path);
  const contentType =
    existing.content_type ||
    Object.keys(MIME_TO_EXT).find(function (m) {
      return MIME_TO_EXT[m] === String(existing.storage_path).split('.').pop();
    }) ||
    'image/png';

  const result = await runOwnedExtractionAttempt(
    {
      draftId: draftId,
      attemptId: attemptId,
      fileSha256: existing.file_sha256,
      buffer: buffer,
      contentType: contentType,
      expectedCi: ci,
      created: false,
    },
    io,
  );
  result.llmCalled = true;
  result.storagePath = existing.storage_path;
  result.acquireMode = acquire.mode;
  return result;
}

async function acquireRetryOwnershipWithNow(
  supabase,
  draftId,
  ci,
  attemptId,
  leaseExpiresAt,
  ownershipMs,
) {
  const failed = await supabase
    .from(DRAFT_TABLE)
    .update({
      status: 'extracting',
      attempt_id: attemptId,
      lease_expires_at: leaseExpiresAt,
      updated_at: new Date(ownershipMs).toISOString(),
    })
    .eq('id', draftId)
    .eq('ci', ci)
    .eq('status', 'extraction_failed')
    .select(DRAFT_SELECT)
    .maybeSingle();

  if (failed.error) {
    throw httpError(500, 'Error interno', 'ACQUIRE_FAILED');
  }
  if (failed.data) return { row: failed.data, mode: 'retry' };

  const nowIso = new Date(ownershipMs).toISOString();
  const reclaim = await supabase
    .from(DRAFT_TABLE)
    .update({
      attempt_id: attemptId,
      lease_expires_at: leaseExpiresAt,
      updated_at: nowIso,
    })
    .eq('id', draftId)
    .eq('ci', ci)
    .eq('status', 'extracting')
    .lt('lease_expires_at', nowIso)
    .select(DRAFT_SELECT)
    .maybeSingle();

  if (reclaim.error) {
    throw httpError(500, 'Error interno', 'RECLAIM_FAILED');
  }
  if (reclaim.data) return { row: reclaim.data, mode: 'reclaim' };

  return { row: null, mode: null };
}

module.exports = {
  DRAFT_TABLE,
  sha256Hex,
  isLeaseExpired,
  reuseFlags,
  publicDraft,
  buildResponse,
  createBcuExtractionDraft,
  retryBcuExtractionDraft,
  casComplete,
  findActiveSameUpload,
  runOwnedExtractionAttempt,
  acquireRetryOwnershipWithNow,
  buildLlmMeta,
  buildSuccessValidationJson,
  buildFailureValidationJson,
};
