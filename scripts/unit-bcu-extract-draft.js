'use strict';

/**
 * Stage 3 — offline unit tests for BCU extraction drafts.
 * Mocks only: no DB / Storage / OpenAI network.
 *
 * Run: node scripts/unit-bcu-extract-draft.js
 */

const assert = require('assert');

const {
  OPENAI_TIMEOUT_MS,
  LEASE_MARGIN_MS,
  LEASE_TTL_MS,
} = require('../src/lib/bcuExtractTiming');
const {
  validateRejectedBcuExtractFile,
  validateRejectedBcuFile,
  EXTRACT_IMAGE_MIME_TYPES,
  pathContainsCi,
  buildRejectedBcuObjectPath,
} = require('../src/lib/rejectedBcuStorage');
const { estimateCostUsd } = require('../src/lib/bcuExtractLlm');
const { CLASSIFICATION } = require('../src/lib/bcuExtractContract');
const { classifyBcuExtraction } = require('../src/lib/bcuExtractClassify');
const {
  sha256Hex,
  createBcuExtractionDraft,
  retryBcuExtractionDraft,
  casComplete,
  isLeaseExpired,
  reuseFlags,
  runOwnedExtractionAttempt,
} = require('../src/lib/rejectedBcuExtractDraft');
const { normalizeCi } = require('../src/lib/rejectedOps');

assert.ok(LEASE_TTL_MS > OPENAI_TIMEOUT_MS, 'case 29 lease invariant');
assert.strictEqual(LEASE_TTL_MS, OPENAI_TIMEOUT_MS + LEASE_MARGIN_MS);

function jpegBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}
function pngBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}
function webpBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf.write('RIFF', 0);
  buf.write('WEBP', 8);
  return buf;
}
function pdfBuffer() {
  const buf = Buffer.alloc(32, 0);
  buf.write('%PDF', 0);
  return buf;
}

// --- 1–4 MIME ---
{
  const j = validateRejectedBcuExtractFile({
    mimetype: 'image/jpeg',
    buffer: jpegBuffer(),
    originalname: 'a.jpg',
  });
  assert.strictEqual(j.contentType, 'image/jpeg');
  const p = validateRejectedBcuExtractFile({
    mimetype: 'image/png',
    buffer: pngBuffer(),
    originalname: 'a.png',
  });
  assert.strictEqual(p.contentType, 'image/png');
  const w = validateRejectedBcuExtractFile({
    mimetype: 'image/webp',
    buffer: webpBuffer(),
    originalname: 'a.webp',
  });
  assert.strictEqual(w.contentType, 'image/webp');
  let pdfErr = null;
  try {
    validateRejectedBcuExtractFile({
      mimetype: 'application/pdf',
      buffer: pdfBuffer(),
      originalname: 'a.pdf',
    });
  } catch (e) {
    pdfErr = e;
  }
  assert.ok(pdfErr);
  assert.strictEqual(pdfErr.statusCode, 400);
  assert.ok(EXTRACT_IMAGE_MIME_TYPES.includes('image/jpeg'));
  assert.ok(!EXTRACT_IMAGE_MIME_TYPES.includes('application/pdf'));
  // snapshots still allow PDF
  assert.strictEqual(
    validateRejectedBcuFile({
      mimetype: 'application/pdf',
      buffer: pdfBuffer(),
      originalname: 'a.pdf',
    }).contentType,
    'application/pdf',
  );
}

// --- 5 CI ---
assert.strictEqual(normalizeCi('abc'), null);
assert.strictEqual(normalizeCi('45006120'), 45006120);

function baseExtraction(over) {
  return Object.assign(
    {
      extraction_contract_version: 'bcu_v1',
      currency_view_selected: 'MN_PESOS_ME_PESOS',
      period: '202607',
      document_ci_raw: 'UY IDE 000000000045006120',
      institutions: [
        {
          institution_name_raw: 'OCA S.A.',
          category: '1C',
          vigente: { mn: 17.5, me: 0 },
          vigente_no_autoliquidable: { mn: 17.5, me: 0 },
          moroso: { mn: null, me: null },
          castigado_por_atraso: { mn: null, me: null },
          contingencias: { mn: null, me: null },
          creditos_reestructurados: { mn: null, me: null },
        },
      ],
      summary: {
        vigente: { mn: 17.5, me: 0 },
        vigente_no_autoliquidable: { mn: 17.5, me: 0 },
        moroso: { mn: null, me: null },
        castigado_por_atraso: { mn: null, me: null },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
      review: { warnings: [], illegible_fields: [] },
    },
    over || {},
  );
}

/**
 * Minimal fluent PostgREST mock for rejected_bcu_extraction_drafts only.
 */
function createDraftDb() {
  const drafts = new Map();
  const touchedTables = new Set();
  let uuidSeq = 0;

  function nextUuid() {
    uuidSeq += 1;
    return '00000000-0000-4000-8000-' + String(uuidSeq).padStart(12, '0');
  }

  function matchesFilters(row, filters) {
    for (let i = 0; i < filters.length; i += 1) {
      const f = filters[i];
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'in' && f.val.indexOf(row[f.col]) < 0) return false;
      if (f.op === 'lt') {
        const a = Date.parse(row[f.col]);
        const b = Date.parse(f.val);
        if (!(Number.isFinite(a) && Number.isFinite(b) && a < b)) return false;
      }
    }
    return true;
  }

  function clone(row) {
    return JSON.parse(JSON.stringify(row));
  }

  function from(table) {
    touchedTables.add(table);
    const state = {
      table: table,
      filters: [],
      patch: null,
      insertRow: null,
      orderAsc: true,
      limitN: null,
      mode: null,
    };

    const api = {
      select() {
        return api;
      },
      insert(row) {
        state.mode = 'insert';
        state.insertRow = row;
        return api;
      },
      update(patch) {
        state.mode = 'update';
        state.patch = patch;
        return api;
      },
      eq(col, val) {
        state.filters.push({ op: 'eq', col: col, val: val });
        return api;
      },
      in(col, vals) {
        state.filters.push({ op: 'in', col: col, val: vals });
        return api;
      },
      lt(col, val) {
        state.filters.push({ op: 'lt', col: col, val: val });
        return api;
      },
      order(col, opts) {
        state.orderCol = col;
        state.orderAsc = !(opts && opts.ascending === false);
        return api;
      },
      limit(n) {
        state.limitN = n;
        return api;
      },
      async single() {
        const r = await api.maybeSingle();
        if (!r.data) {
          return { data: null, error: { message: 'no rows' } };
        }
        return r;
      },
      async maybeSingle() {
        if (state.table !== 'rejected_bcu_extraction_drafts') {
          return { data: null, error: { message: 'unexpected table' } };
        }
        if (state.mode === 'insert') {
          const row = Object.assign({}, state.insertRow);
          drafts.set(row.id, row);
          return { data: clone(row), error: null };
        }
        if (state.mode === 'update') {
          const hits = [];
          drafts.forEach(function (row) {
            if (matchesFilters(row, state.filters)) hits.push(row);
          });
          if (!hits.length) return { data: null, error: null };
          const target = hits[0];
          Object.assign(target, state.patch);
          return { data: clone(target), error: null };
        }
        // select
        let rows = [];
        drafts.forEach(function (row) {
          if (matchesFilters(row, state.filters)) rows.push(clone(row));
        });
        if (state.orderCol) {
          rows.sort(function (a, b) {
            const av = a[state.orderCol];
            const bv = b[state.orderCol];
            if (av === bv) return 0;
            if (state.orderAsc) return av < bv ? -1 : 1;
            return av > bv ? -1 : 1;
          });
        }
        if (state.limitN != null) rows = rows.slice(0, state.limitN);
        if (state.filters.some(function (f) {
          return f.op === 'eq' && f.col === 'id';
        })) {
          return { data: rows[0] || null, error: null };
        }
        return { data: rows, error: null };
      },
      then(resolve, reject) {
        return api.maybeSingle().then(resolve, reject);
      },
    };
    return api;
  }

  return {
    drafts: drafts,
    touchedTables: touchedTables,
    nextUuid: nextUuid,
    supabase: { from: from },
    seed(row) {
      drafts.set(row.id, row);
    },
  };
}

function makeFileMeta(buf, mime, ext, name) {
  return {
    contentType: mime,
    ext: ext,
    fileSizeBytes: buf.length,
    originalFilename: name,
    buffer: buf,
  };
}

async function createWithMocks(opts) {
  const db = opts.db || createDraftDb();
  const uploads = [];
  const removes = [];
  let llmCalls = 0;
  const now = opts.nowMs || 1_700_000_000_000;
  const result = await createBcuExtractionDraft(
    {
      ci: opts.ci != null ? opts.ci : 45006120,
      fileMeta:
        opts.fileMeta ||
        makeFileMeta(jpegBuffer(), 'image/jpeg', 'jpg', 'x.jpg'),
      created_by: null,
      draftId: opts.draftId,
      attemptId: opts.attemptId,
      fileObjectId: opts.fileObjectId || '11111111-1111-4111-8111-111111111111',
    },
    {
      supabase: db.supabase,
      upload: async function (_sb, uopts) {
        if (opts.uploadFail) {
          const e = new Error('upload fail');
          e.statusCode = 500;
          e.code = 'BCU_UPLOAD_FAILED';
          throw e;
        }
        const path = buildRejectedBcuObjectPath(
          uopts.ownerId || uopts.snapshotId,
          uopts.objectId,
          uopts.ext,
        );
        uploads.push({ path: path, opts: uopts });
        return path;
      },
      remove: async function (_sb, path) {
        removes.push(path);
        if (opts.removeFail) throw new Error('remove fail');
      },
      extractLlm: async function (args) {
        llmCalls += 1;
        if (opts.extractLlm) return opts.extractLlm(args);
        return {
          ok: true,
          outcome: 'ok',
          model: 'gpt-4.1',
          detail: 'high',
          latency_ms: 12,
          http_status: 200,
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          cost_usd_estimated: null,
          extraction: opts.extraction || baseExtraction(),
          error: null,
        };
      },
      classify: opts.classify || classifyBcuExtraction,
      nowMs: function () {
        return typeof now === 'function' ? now() : now;
      },
      uuid: opts.uuid || db.nextUuid,
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  return { result, db, uploads, removes, llmCalls };
}

async function retryWithMocks(opts) {
  const db = opts.db;
  let llmCalls = 0;
  const downloads = [];
  const now = opts.nowMs != null ? opts.nowMs : 1_700_000_000_000;
  const result = await retryBcuExtractionDraft(
    {
      ci: opts.ci != null ? opts.ci : 45006120,
      draftId: opts.draftId,
      attemptId: opts.attemptId,
    },
    {
      supabase: db.supabase,
      download: async function (_sb, path) {
        downloads.push(path);
        return opts.buffer || jpegBuffer();
      },
      extractLlm: async function (args) {
        llmCalls += 1;
        if (opts.extractLlm) return opts.extractLlm(args);
        return {
          ok: true,
          outcome: 'ok',
          model: 'gpt-4.1',
          detail: 'high',
          latency_ms: 9,
          http_status: 200,
          usage: null,
          cost_usd_estimated: null,
          extraction: opts.extraction || baseExtraction(),
          error: null,
        };
      },
      classify: opts.classify || classifyBcuExtraction,
      nowMs: function () {
        return typeof now === 'function' ? now() : now;
      },
      uuid: opts.uuid || db.nextUuid,
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  return { result, llmCalls, downloads };
}

(async function main() {
  // Route HTTP coverage (CI inválida→400, fuera de universo→404) remains pending
  // non-blocking: would need Express harness; lib+route wiring mirrors bcu-snapshots.

  // 11–13 create new REVIEW_READY / HUMAN_REVIEW
  {
    const a = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    });
    assert.strictEqual(a.result.httpStatus, 201);
    assert.strictEqual(a.result.data.reused, false);
    assert.strictEqual(a.result.data.state, 'pending_review');
    assert.strictEqual(a.result.data.can_retry, false);
    assert.strictEqual(a.llmCalls, 1);
    assert.ok(a.uploads[0].path.indexOf('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/') === 0);
    assert.ok(!pathContainsCi(a.uploads[0].path, 45006120));
    assert.strictEqual(
      a.result.data.validation.meta.llm.cost_usd_estimated,
      null,
    );
    assert.strictEqual(a.result.data.validation.human_review_required, true);
    assert.strictEqual(a.result.data.validation.auto_persist_allowed, false);
    assert.ok(!a.db.touchedTables.has('rejected_bcu_snapshots'));
    assert.ok(!a.db.touchedTables.has('rejected_bcu_institutions'));
  }

  {
    const hum = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      extraction: baseExtraction({
        currency_view_selected: 'UNKNOWN',
      }),
    });
    assert.strictEqual(hum.result.data.state, 'pending_review');
    assert.strictEqual(
      hum.result.data.validation.classification,
      CLASSIFICATION.HUMAN_REVIEW,
    );
  }

  // 14 EXTRACTION_FAILED classification
  {
    const f = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      extraction: baseExtraction({ extraction_contract_version: 'nope' }),
    });
    assert.strictEqual(f.result.data.state, 'extraction_failed');
    assert.strictEqual(f.result.data.extraction, null);
    assert.strictEqual(f.result.data.can_retry, true);
    assert.ok(f.db.drafts.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3').storage_path);
  }

  // 15 timeout
  {
    const t = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      extractLlm: async function () {
        return {
          ok: false,
          outcome: 'timeout',
          model: 'gpt-4.1',
          detail: 'high',
          latency_ms: 120000,
          usage: null,
          cost_usd_estimated: null,
          extraction: null,
          error: 'OpenAI request timed out after 120000ms',
        };
      },
    });
    assert.strictEqual(t.result.data.state, 'extraction_failed');
    assert.ok(t.db.drafts.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4').storage_path);
    assert.strictEqual(t.removes.length, 0);
  }

  // 16 HTTP error
  {
    const h = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
      extractLlm: async function () {
        return {
          ok: false,
          outcome: 'http_error',
          model: 'gpt-4.1',
          detail: 'high',
          latency_ms: 50,
          http_status: 500,
          usage: null,
          cost_usd_estimated: null,
          extraction: null,
          error: 'OpenAI HTTP 500',
        };
      },
    });
    assert.strictEqual(h.result.data.state, 'extraction_failed');
  }

  // 17 parse error
  {
    const p = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
      extractLlm: async function () {
        return {
          ok: false,
          outcome: 'parse_error',
          model: 'gpt and',
          detail: 'high',
          latency_ms: 40,
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          cost_usd_estimated: null,
          extraction: null,
          error: 'JSON_PARSE_FAIL',
        };
      },
    });
    assert.strictEqual(p.result.data.state, 'extraction_failed');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        p.result.data.validation.meta.llm,
        'cost_usd_estimated',
      ),
      true,
    );
  }

  // 18 upload OK + INSERT fail → cleanup
  {
    const db = createDraftDb();
    const origInsert = db.supabase.from.bind(db.supabase);
    // break insert by wrapping from
    const removes = [];
    let caught = null;
    try {
      await createBcuExtractionDraft(
        {
          ci: 45006120,
          fileMeta: makeFileMeta(jpegBuffer(), 'image/jpeg', 'jpg', 'x.jpg'),
          created_by: null,
          draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
          attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7',
          fileObjectId: '11111111-1111-4111-8111-111111111117',
        },
        {
          supabase: {
            from(table) {
              const chain = origInsert(table);
              if (table === 'rejected_bcu_extraction_drafts') {
                const realInsert = chain.insert.bind(chain);
                chain.insert = function () {
                  return {
                    select() {
                      return {
                        async single() {
                          return { data: null, error: { message: 'insert boom' } };
                        },
                      };
                    },
                  };
                };
                // still need select path — override only insert
                void realInsert;
              }
              return chain;
            },
          },
          upload: async function (_sb, uopts) {
            return buildRejectedBcuObjectPath(
              uopts.ownerId,
              uopts.objectId,
              uopts.ext,
            );
          },
          remove: async function (_sb, path) {
            removes.push(path);
          },
          extractLlm: async function () {
            throw new Error('LLM should not run');
          },
          nowMs: function () {
            return 1_700_000_000_000;
          },
          uuid: db.nextUuid,
          logger: { info() {}, warn() {}, error() {} },
        },
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.strictEqual(caught.statusCode, 500);
    assert.strictEqual(removes.length, 1);
  }

  // 7–10 soft dedup
  {
    const buf = jpegBuffer();
    const hash = sha256Hex(buf);
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
      ci: 45006120,
      status: 'pending_review',
      storage_path: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1/o.jpg',
      file_sha256: hash,
      extraction_json: baseExtraction(),
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: null,
      attempt_id: null,
    });
    const r = await createWithMocks({
      db: db,
      fileMeta: makeFileMeta(buf, 'image/jpeg', 'jpg', 'x.jpg'),
      nowMs: now,
    });
    assert.strictEqual(r.result.httpStatus, 200);
    assert.strictEqual(r.result.data.reused, true);
    assert.strictEqual(r.result.data.state, 'pending_review');
    assert.strictEqual(r.result.data.can_retry, false);
    assert.strictEqual(r.result.data.in_progress, false);
    assert.strictEqual(r.llmCalls, 0);
  }

  {
    const buf = pngBuffer();
    const hash = sha256Hex(buf);
    const db = createDraftDb();
    db.seed({
      id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
      ci: 45006120,
      status: 'extraction_failed',
      storage_path: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2/o.png',
      file_sha256: hash,
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: null,
      attempt_id: null,
    });
    const r = await createWithMocks({
      db: db,
      fileMeta: makeFileMeta(buf, 'image/png', 'png', 'x.png'),
    });
    assert.strictEqual(r.result.httpStatus, 200);
    assert.strictEqual(r.result.data.reused, true);
    assert.strictEqual(r.result.data.state, 'extraction_failed');
    assert.strictEqual(r.result.data.can_retry, true);
    assert.strictEqual(r.llmCalls, 0);
  }

  {
    const buf = webpBuffer();
    const hash = sha256Hex(buf);
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
      ci: 45006120,
      status: 'extracting',
      storage_path: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3/o.webp',
      file_sha256: hash,
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now + 60_000).toISOString(),
      attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10',
    });
    const r = await createWithMocks({
      db: db,
      fileMeta: makeFileMeta(buf, 'image/webp', 'webp', 'x.webp'),
      nowMs: now,
    });
    assert.strictEqual(r.result.data.reused, true);
    assert.strictEqual(r.result.data.in_progress, true);
    assert.strictEqual(r.result.data.can_retry, false);
    assert.strictEqual(r.llmCalls, 0);
  }

  {
    const buf = jpegBuffer();
    buf[10] = 0xab;
    const hash = sha256Hex(buf);
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
      ci: 45006120,
      status: 'extracting',
      storage_path: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4/o.jpg',
      file_sha256: hash,
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now - 1).toISOString(),
      attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11',
    });
    const r = await createWithMocks({
      db: db,
      fileMeta: makeFileMeta(buf, 'image/jpeg', 'jpg', 'x.jpg'),
      nowMs: now,
    });
    assert.strictEqual(r.result.data.reused, true);
    assert.strictEqual(r.result.data.state, 'extracting');
    assert.strictEqual(r.result.data.can_retry, true);
    assert.strictEqual(r.result.data.in_progress, false);
    assert.strictEqual(r.llmCalls, 0);
  }

  // 19 retry from extraction_failed
  {
    const db = createDraftDb();
    const storagePath = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1/obj.jpg';
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      ci: 45006120,
      status: 'extraction_failed',
      storage_path: storagePath,
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: null,
      attempt_id: null,
    });
    const r = await retryWithMocks({
      db: db,
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      attemptId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    });
    assert.strictEqual(r.llmCalls, 1);
    assert.deepStrictEqual(r.downloads, [storagePath]);
    assert.strictEqual(r.result.data.state, 'pending_review');
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1').storage_path,
      storagePath,
    );
  }

  // 20 reclaim expired
  {
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    const storagePath = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2/obj.jpg';
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
      ci: 45006120,
      status: 'extracting',
      storage_path: storagePath,
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now - 5000).toISOString(),
      attempt_id: 'old-attempt-id-0000-0000-000000000001',
    });
    const r = await retryWithMocks({
      db: db,
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
      attemptId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
      nowMs: now,
    });
    assert.strictEqual(r.llmCalls, 1);
    assert.strictEqual(r.result.acquireMode, 'reclaim');
    assert.strictEqual(r.result.data.state, 'pending_review');
  }

  // 21 reclaim while lease valid → 409, 0 LLM
  {
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
      ci: 45006120,
      status: 'extracting',
      storage_path: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3/obj.jpg',
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: {},
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now + 60_000).toISOString(),
      attempt_id: 'live-attempt',
    });
    let err = null;
    let llmCalls = 0;
    try {
      await retryBcuExtractionDraft(
        {
          ci: 45006120,
          draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
        },
        {
          supabase: db.supabase,
          download: async function () {
            throw new Error('should not download');
          },
          extractLlm: async function () {
            llmCalls += 1;
            throw new Error('should not LLM');
          },
          nowMs: function () {
            return now;
          },
          uuid: db.nextUuid,
          logger: { info() {}, warn() {}, error() {} },
        },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.strictEqual(err.statusCode, 409);
    assert.strictEqual(llmCalls, 0);
  }

  // 22 two concurrent retries — only one wins acquire
  {
    const db = createDraftDb();
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
      ci: 45006120,
      status: 'extraction_failed',
      storage_path: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4/obj.jpg',
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: {},
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: null,
      attempt_id: null,
    });
    const a = retryWithMocks({
      db: db,
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
      attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffa1',
    });
    const b = retryWithMocks({
      db: db,
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
      attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffa2',
    });
    const settled = await Promise.allSettled([a, b]);
    const ok = settled.filter(function (s) {
      return s.status === 'fulfilled';
    });
    const bad = settled.filter(function (s) {
      return s.status === 'rejected';
    });
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].reason.statusCode, 409);
    assert.strictEqual(ok[0].value.llmCalls, 1);
  }

  // 23–25 stale CAS success/error → no write; 25 full superseded path
  {
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      ci: 45006120,
      status: 'extracting',
      storage_path: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5/obj.jpg',
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: {},
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now + LEASE_TTL_MS).toISOString(),
      attempt_id: 'owner-b',
      currency_view_selected: null,
      document_ci_raw: null,
    });
    // Stale attempt A tries success CAS
    const staleOk = await casComplete(db.supabase, {
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      attemptId: 'owner-a-stale',
      status: 'pending_review',
      extraction_json: baseExtraction(),
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      nowMs: now,
    });
    assert.strictEqual(staleOk, null);
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5').attempt_id,
      'owner-b',
    );
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5').status,
      'extracting',
    );

    const staleFail = await casComplete(db.supabase, {
      draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      attemptId: 'owner-a-stale',
      status: 'extraction_failed',
      extraction_json: null,
      validation_json: { meta: { llm: { cost_usd_estimated: null } } },
      nowMs: now,
    });
    assert.strictEqual(staleFail, null);
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5').status,
      'extracting',
    );

    // 25: full attempt path with stale attempt_id → extraction_superseded 409
    let supersededErr = null;
    try {
      await runOwnedExtractionAttempt(
        {
          draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
          attemptId: 'owner-a-stale',
          fileSha256: 'abc',
          buffer: jpegBuffer(),
          contentType: 'image/jpeg',
          expectedCi: 45006120,
          created: false,
        },
        {
          supabase: db.supabase,
          extractLlm: async function () {
            return {
              ok: true,
              outcome: 'ok',
              model: 'gpt-4.1',
              detail: 'high',
              latency_ms: 1,
              usage: null,
              cost_usd_estimated: null,
              extraction: baseExtraction(),
              error: null,
            };
          },
          classify: classifyBcuExtraction,
          nowMs: function () {
            return now;
          },
          logger: { info() {}, warn() {}, error() {} },
        },
      );
    } catch (e) {
      supersededErr = e;
    }
    assert.ok(supersededErr);
    assert.strictEqual(supersededErr.statusCode, 409);
    assert.strictEqual(supersededErr.code, 'extraction_superseded');
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5').status,
      'extracting',
    );
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5').attempt_id,
      'owner-b',
    );
  }

  // extractLlm throws → owner CAS to extraction_failed, file kept
  {
    const t = await createWithMocks({
      draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb20',
      extractLlm: async function () {
        throw new Error('boom sk-secretkey1234567890abcdef');
      },
    });
    assert.strictEqual(t.result.httpStatus, 201);
    assert.strictEqual(t.result.data.state, 'extraction_failed');
    assert.strictEqual(t.result.data.extraction, null);
    assert.ok(t.db.drafts.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20').storage_path);
    assert.strictEqual(t.removes.length, 0);
    assert.ok(
      !String(t.result.data.validation.meta.llm.error).includes('sk-secret'),
    );
  }

  // extractLlm throws but attempt stale → superseded, no failed write
  {
    const db = createDraftDb();
    const now = 1_700_000_000_000;
    db.seed({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
      ci: 45006120,
      status: 'extracting',
      storage_path: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6/obj.jpg',
      file_sha256: 'abc',
      content_type: 'image/jpeg',
      extraction_json: null,
      validation_json: {},
      extraction_contract_version: 'bcu_v1',
      created_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: new Date(now + LEASE_TTL_MS).toISOString(),
      attempt_id: 'owner-b-live',
    });
    let err = null;
    try {
      await runOwnedExtractionAttempt(
        {
          draftId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
          attemptId: 'stale-a',
          fileSha256: 'abc',
          buffer: jpegBuffer(),
          contentType: 'image/jpeg',
          expectedCi: 45006120,
          created: false,
        },
        {
          supabase: db.supabase,
          extractLlm: async function () {
            throw new Error('late throw');
          },
          nowMs: function () {
            return now;
          },
          logger: { info() {}, warn() {}, error() {} },
        },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.strictEqual(err.statusCode, 409);
    assert.strictEqual(err.code, 'extraction_superseded');
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6').status,
      'extracting',
    );
    assert.strictEqual(
      db.drafts.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6').attempt_id,
      'owner-b-live',
    );
  }

  // 26–27 path reuse / no CI — covered above
  assert.ok(!pathContainsCi('uuid/uuid.jpg', 45006120));
  assert.ok(pathContainsCi('45006120/x.jpg', 45006120));

  // 30 cost null without pricing
  assert.strictEqual(
    estimateCostUsd({ prompt_tokens: 10, completion_tokens: 10 }, null),
    null,
  );
  assert.strictEqual(
    estimateCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      { inputPer1M: 2, outputPer1M: 8 },
    ),
    10,
  );

  // 28 Stage 1 smoke — full n=6 fixtures: run scripts/unit-bcu-extract-validate.js separately
  {
    const c = classifyBcuExtraction(baseExtraction(), { expected_ci: '45006120' });
    assert.strictEqual(c.classification, CLASSIFICATION.REVIEW_READY);
  }

  // flags helpers
  assert.strictEqual(
    isLeaseExpired(
      { status: 'extracting', lease_expires_at: '2000-01-01T00:00:00.000Z' },
      Date.now(),
    ),
    true,
  );
  const flags = reuseFlags(
    {
      status: 'extracting',
      lease_expires_at: new Date(Date.now() + 99999).toISOString(),
    },
    Date.now(),
  );
  assert.strictEqual(flags.in_progress, true);

  console.log('OK unit-bcu-extract-draft');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
