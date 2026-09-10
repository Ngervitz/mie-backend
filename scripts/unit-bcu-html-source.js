'use strict';

/**
 * Stage 6D.7 — sanitized BCU HTML source storage (mocked Storage/DB).
 * Run: node scripts/unit-bcu-html-source.js
 *
 * Does NOT hit production DB or Storage.
 */

const assert = require('assert');
const { createHash } = require('crypto');
const { PAGE_TYPE } = require('../src/lib/bcuHtmlParser');
const {
  prepareSanitizedBcuHtmlSource,
  uploadSourceThenPersist,
  planHtmlSourceBackfill,
  evaluateLocalHtmlSafeToDelete,
  buildRejectedBcuObjectPath,
} = require('../src/lib/rejectedBcuHtmlSource');
const {
  BCU_SOURCE_CONTENT_TYPE,
  BCU_SOURCE_EXT,
  pathContainsCi,
} = require('../src/lib/rejectedBcuStorage');
const {
  loadSnapshotSourceFileBytes,
  buildSnapshotSourceFileUrl,
  assertSnapshotId,
} = require('../src/lib/rejectedBcuSnapshotSourceRead');
const {
  persistTrustedBcuHtmlObservation,
  RESULT,
  PERSIST_RPC_NAME,
} = require('../src/lib/rejectedBcuHtmlPersist');

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
      ],
      summary: {
        vigente: money(null, null),
        vigente_no_autoliquidable: money(null, null),
        colocacion_vencida: money(null, null),
        moroso: money(null, null),
        castigado_por_atraso: money(0, 3938.3),
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
  };
  api.then = function (resolve, reject) {
    return Promise.resolve(result.list || { data: [], error: null }).then(
      resolve,
      reject,
    );
  };
  return api;
}

function makeStorageClient(opts) {
  opts = opts || {};
  const uploaded = [];
  const removed = [];
  const client = {
    _uploaded: uploaded,
    _removed: removed,
    from: function (table) {
      if (table === 'rejected_bcu_snapshots') {
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
          list: { data: opts.activeDrafts || [], error: null },
        });
      }
      return chainable({ list: { data: [], error: null } });
    },
    rpc: async function (name, params) {
      assert.strictEqual(name, PERSIST_RPC_NAME);
      if (opts.rpcFail) {
        return { data: null, error: { message: 'rpc boom' } };
      }
      if (opts.onRpc) return opts.onRpc(params);
      return {
        data: {
          already_confirmed: false,
          draft_id: null,
          confirmed_snapshot_id: 'snap-src-1',
          confirmed_at: null,
          reviewed_payload_sha256: params.p_reviewed_payload_sha256,
          draft: null,
          snapshot: {
            id: 'snap-src-1',
            ci: params.p_ci,
            period_label: params.p_period_label,
            consulted_on: params.p_consulted_on,
            source: params.p_source,
            storage_path: params.p_storage_path,
            original_filename: params.p_original_filename,
            content_type: params.p_content_type,
            file_size_bytes: params.p_file_size_bytes,
            file_sha256: params.p_file_sha256 || null,
            currency_view_selected: params.p_currency_view_selected,
            extraction_contract_version: params.p_extraction_contract_version,
            document_ci_raw: params.p_document_ci_raw,
            summary: params.p_summary,
            summary_validation_status: params.p_summary_validation_status,
            summary_validation: params.p_summary_validation,
            reviewed_payload_sha256: params.p_reviewed_payload_sha256,
          },
          institutions: (params.p_institutions || []).map(function (row, i) {
            return Object.assign({ id: 'i' + i, snapshot_id: 'snap-src-1' }, row);
          }),
        },
        error: null,
      };
    },
    storage: {
      from: function () {
        return {
          upload: async function (storagePath, buffer, meta) {
            if (opts.uploadFail) {
              return { error: { message: 'upload denied' } };
            }
            uploaded.push({
              path: storagePath,
              size: buffer.length,
              contentType: meta && meta.contentType,
            });
            return { error: null };
          },
          remove: async function (paths) {
            removed.push.apply(removed, paths);
            return { error: null };
          },
          download: async function (storagePath) {
            if (opts.downloadFail) {
              return { data: null, error: { message: 'missing' } };
            }
            const blob = {
              arrayBuffer: async function () {
                return Buffer.from(opts.downloadBytes || 'opaque', 'utf8').buffer;
              },
            };
            return { data: blob, error: null };
          },
        };
      },
    },
  };
  return client;
}

async function main() {
  const dirtyHtml =
    '<!-- saved from url=(0026)https://www.bcu.gub.uy/LoginServlet?g-recaptcha-response=SECRETTOKEN123 -->\n' +
    '<html><body><input name="g-recaptcha-response" value="SECRETTOKEN123"/>' +
    '<table><tr><td>Periodo</td><td>202607</td></tr></table>' +
    '</body></html>';

  // --- sanitize before storage + captcha leak false + saved-from removed ---
  {
    const prepared = prepareSanitizedBcuHtmlSource(dirtyHtml);
    assert.ok(prepared.buffer.length > 0);
    assert.ok(!/SECRETTOKEN123/.test(prepared.buffer.toString('utf8')));
    assert.ok(
      /g-recaptcha-response=REDACTED/i.test(prepared.buffer.toString('utf8')) ||
        !/g-recaptcha-response=/i.test(prepared.buffer.toString('utf8')),
    );
    assert.ok(!/saved from url=\([^)]*https?:/i.test(prepared.buffer.toString('utf8')));
    assert.strictEqual(prepared.sha256.length, 64);
    const again = createHash('sha256').update(prepared.buffer).digest('hex');
    assert.strictEqual(again, prepared.sha256);
  }

  // --- hash over sanitized bytes (not raw) ---
  {
    const rawHash = createHash('sha256').update(Buffer.from(dirtyHtml, 'utf8')).digest('hex');
    const prepared = prepareSanitizedBcuHtmlSource(dirtyHtml);
    assert.notStrictEqual(prepared.sha256, rawHash);
  }

  // --- storage path without CI ---
  {
    const owner = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const obj = '11111111-2222-3333-4444-555555555555';
    const p = buildRejectedBcuObjectPath(owner, obj, BCU_SOURCE_EXT);
    assert.strictEqual(p, owner + '/' + obj + '.' + BCU_SOURCE_EXT);
    assert.strictEqual(pathContainsCi(p, 51769764), false);
    assert.ok(!p.includes('51769764'));
  }

  // --- upload failure → persistFn not called / no ok ---
  {
    let persistCalled = false;
    const client = makeStorageClient({ uploadFail: true });
    const prepared = prepareSanitizedBcuHtmlSource(dirtyHtml);
    let threw = false;
    try {
      await uploadSourceThenPersist(client, prepared, async function () {
        persistCalled = true;
        return { ok: true };
      }, { ci: 51769764 });
    } catch (e) {
      threw = true;
      assert.ok(e && e.code === 'BCU_UPLOAD_FAILED');
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(persistCalled, false);
    assert.strictEqual(client._uploaded.length, 0);
  }

  // --- DB/persist failure → storage compensation delete ---
  {
    const client = makeStorageClient();
    const prepared = prepareSanitizedBcuHtmlSource(dirtyHtml);
    const out = await uploadSourceThenPersist(
      client,
      prepared,
      async function () {
        return { ok: false, reason: 'rpc' };
      },
      { ci: 51769764 },
    );
    assert.strictEqual(out.ok, false);
    assert.strictEqual(client._uploaded.length, 1);
    assert.strictEqual(client._removed.length, 1);
    assert.strictEqual(client._removed[0], client._uploaded[0].path);
    assert.strictEqual(client._uploaded[0].contentType, BCU_SOURCE_CONTENT_TYPE);
  }

  // --- persist throw → compensate ---
  {
    const client = makeStorageClient();
    const prepared = prepareSanitizedBcuHtmlSource(dirtyHtml);
    let threw = false;
    try {
      await uploadSourceThenPersist(
        client,
        prepared,
        async function () {
          throw new Error('db down');
        },
        { ci: 51769764 },
      );
    } catch (e) {
      threw = true;
      assert.strictEqual(e.message, 'db down');
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(client._removed.length, 1);
  }

  // --- ALREADY_CONFIRMED → no upload ---
  {
    const client = makeStorageClient({
      existingSnapshots: [
        {
          id: 'snap-already',
          reviewed_payload_sha256: null, // will conflict unless same hash
          source: 'html_import',
          consulted_on: '2026-09-09',
        },
      ],
    });
    // Use same-hash already path
    const extraction = baseExtraction();
    const { hashConfirmPayload } = require('../src/lib/bcuExtractCanonical');
    const consultedOn = '2026-09-09';
    const hash = hashConfirmPayload({
      consulted_on: consultedOn,
      reviewed: extraction,
    });
    client.from = function (table) {
      if (table === 'rejected_bcu_snapshots') {
        return chainable({
          list: {
            data: [
              {
                id: 'snap-already',
                reviewed_payload_sha256: hash,
                source: 'html_import',
                consulted_on: consultedOn,
              },
            ],
            error: null,
          },
          maybeSingle: {
            data: {
              id: 'snap-already',
              ci: 51769764,
              period_label: '202607',
              consulted_on: consultedOn,
              source: 'html_import',
              storage_path: null,
            },
            error: null,
          },
        });
      }
      if (table === 'rejected_bcu_institutions') {
        return chainable({ list: { data: [], error: null } });
      }
      if (table === 'rejected_bcu_extraction_drafts') {
        return chainable({ list: { data: [], error: null } });
      }
      return chainable({ list: { data: [], error: null } });
    };
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      sanitizedSourceHtml: dirtyHtml,
      client: client,
    });
    assert.strictEqual(out.result, RESULT.ALREADY_CONFIRMED);
    assert.strictEqual(client._uploaded.length, 0);
  }

  // --- CONFLICT → no upload ---
  {
    const client = makeStorageClient();
    const consultedOn = '2026-09-09';
    const extraction = baseExtraction();
    client.from = function (table) {
      if (table === 'rejected_bcu_snapshots') {
        return chainable({
          list: {
            data: [
              {
                id: 'snap-conflict',
                reviewed_payload_sha256: 'a'.repeat(64),
                source: 'llm_assisted',
                consulted_on: consultedOn,
              },
            ],
            error: null,
          },
          maybeSingle: { data: null, error: null },
        });
      }
      if (table === 'rejected_bcu_extraction_drafts') {
        return chainable({ list: { data: [], error: null } });
      }
      return chainable({ list: { data: [], error: null } });
    };
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: consultedOn,
      extraction: extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      sanitizedSourceHtml: dirtyHtml,
      client: client,
    });
    assert.strictEqual(out.result, RESULT.CONFLICT_SAME_CI_PERIOD);
    assert.strictEqual(client._uploaded.length, 0);
  }

  // --- IMPORTED with source: upload then RPC with storage meta; MIME opaque ---
  {
    let rpcParams = null;
    const client = makeStorageClient({
      onRpc: async function (params) {
        rpcParams = params;
        return makeStorageClient().rpc(PERSIST_RPC_NAME, params);
      },
    });
    const out = await persistTrustedBcuHtmlObservation({
      ci: 51769764,
      consultedOn: '2026-09-09',
      extraction: baseExtraction(),
      pageType: PAGE_TYPE.RESULT_PAGE,
      sanitizedSourceHtml: dirtyHtml,
      client: client,
    });
    assert.strictEqual(out.result, RESULT.IMPORTED);
    assert.strictEqual(client._uploaded.length, 1);
    assert.ok(rpcParams.p_storage_path);
    assert.ok(!String(rpcParams.p_storage_path).includes('51769764'));
    assert.strictEqual(rpcParams.p_content_type, BCU_SOURCE_CONTENT_TYPE);
    assert.ok(rpcParams.p_file_size_bytes > 0);
    assert.strictEqual(rpcParams.p_file_sha256, undefined); // gated until migration
    assert.ok(out.source_file);
    assert.strictEqual(out.source_file.content_type, BCU_SOURCE_CONTENT_TYPE);
  }

  // --- upload fail → no DB write (no RPC) ---
  {
    let rpcCalled = false;
    const client = makeStorageClient({
      uploadFail: true,
      onRpc: async function (params) {
        rpcCalled = true;
        return { data: {}, error: null };
      },
    });
    let threw = false;
    try {
      await persistTrustedBcuHtmlObservation({
        ci: 51769764,
        consultedOn: '2026-09-09',
        extraction: baseExtraction(),
        pageType: PAGE_TYPE.RESULT_PAGE,
        sanitizedSourceHtml: dirtyHtml,
        client: client,
      });
    } catch (e) {
      threw = true;
      assert.ok(e && e.code === 'BCU_UPLOAD_FAILED');
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(rpcCalled, false);
  }

  // --- download attachment headers / no inline HTML / no raw URL ---
  {
    const snapId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const client = {
      from: function () {
        return {
          select: function () {
            return this;
          },
          eq: function () {
            return this;
          },
          maybeSingle: async function () {
            return {
              data: {
                id: snapId,
                ci: 51769764,
                storage_path: 'owner/obj.bcuhtml',
                original_filename: 'secret-name.html',
                content_type: 'text/html',
                file_size_bytes: 12,
                source: 'html_import',
              },
              error: null,
            };
          },
        };
      },
      storage: {
        from: function () {
          return {
            download: async function () {
              return {
                data: {
                  arrayBuffer: async function () {
                    return Buffer.from('<html>x</html>', 'utf8').buffer;
                  },
                },
                error: null,
              };
            },
          };
        },
      },
    };
    const file = await loadSnapshotSourceFileBytes(client, snapId, 51769764);
    assert.strictEqual(file.contentType, BCU_SOURCE_CONTENT_TYPE);
    assert.ok(file.headers['Content-Disposition'].indexOf('attachment') === 0);
    assert.ok(file.headers['Content-Disposition'].indexOf('inline') < 0);
    assert.strictEqual(file.headers['X-Content-Type-Options'], 'nosniff');
    assert.strictEqual(file.headers['Content-Type'], BCU_SOURCE_CONTENT_TYPE);
    assert.ok(!JSON.stringify(file.headers).includes('owner/obj'));
    assert.ok(!file.filename.includes('51769764'));
    const url = buildSnapshotSourceFileUrl(51769764, snapId);
    assert.strictEqual(
      url,
      '/rechazados/51769764/bcu-snapshots/' + snapId + '/source-file',
    );
    assert.ok(!url.includes('owner/obj'));
  }

  // --- wrong CI / missing snapshot blocked ---
  {
    const snapId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const client = {
      from: function () {
        return {
          select: function () {
            return this;
          },
          eq: function () {
            return this;
          },
          maybeSingle: async function () {
            return { data: null, error: null };
          },
        };
      },
    };
    let status = null;
    try {
      await loadSnapshotSourceFileBytes(client, snapId, 11111111);
    } catch (e) {
      status = e.statusCode;
    }
    assert.strictEqual(status, 404);
    try {
      assertSnapshotId('not-a-uuid');
      assert.fail('expected throw');
    } catch (e) {
      assert.strictEqual(e.statusCode, 400);
    }
  }

  // --- backfill planner ---
  {
    const ok = planHtmlSourceBackfill({
      ci: 51769764,
      trusted: true,
      parsed: { page_type: 'RESULT_PAGE', period: '202607' },
      snapshot: {
        source: 'html_import',
        storage_path: null,
        ci: 51769764,
        period_label: '202607',
      },
    });
    assert.strictEqual(ok.ok, true);
    const blockLlm = planHtmlSourceBackfill({
      ci: 50212550,
      trusted: true,
      parsed: { page_type: 'RESULT_PAGE', period: '202607' },
      snapshot: {
        source: 'llm_assisted',
        storage_path: null,
        ci: 50212550,
        period_label: '202607',
      },
    });
    assert.strictEqual(blockLlm.ok, false);
    assert.strictEqual(blockLlm.reason, 'SOURCE_NOT_HTML_IMPORT');
  }

  // --- SAFE_TO_DELETE gate ---
  {
    const bad = evaluateLocalHtmlSafeToDelete({
      page_type: 'CONSULTA_FORM',
      snapshot_confirmed: false,
      source_file_stored: false,
      source_hash_verified: false,
      ci_period_match: false,
      payload_match: false,
      conflict: false,
    });
    assert.strictEqual(bad.safe_to_delete, false);
    assert.ok(bad.reasons.indexOf('NOT_RESULT_PAGE') >= 0);
    const good = evaluateLocalHtmlSafeToDelete({
      page_type: 'RESULT_PAGE',
      snapshot_confirmed: true,
      source_file_stored: true,
      source_hash_verified: true,
      ci_period_match: true,
      payload_match: true,
      conflict: false,
    });
    assert.strictEqual(good.safe_to_delete, true);
  }

  console.log('unit-bcu-html-source: PASS');
}

main().catch(function (err) {
  console.error('unit-bcu-html-source: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
