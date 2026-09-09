'use strict';

/**
 * Stage 6D.6 — batch import trusted BCU LoginServlet.html results.
 *
 * Usage:
 *   node scripts/import-bcu-html-batch.js --dir "C:\\Users\\Admin\\Pictures\\BCU" --dry-run
 *   node scripts/import-bcu-html-batch.js --dir "C:\\Users\\Admin\\Pictures\\BCU" --execute --consulted-on 2026-09-09
 *
 * Does NOT create drafts. Does NOT call OpenAI. Does NOT push/deploy.
 * HTML source file: V1 does NOT upload (storage MIME is image/pdf only; no snapshot file endpoint).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
  decodeBcuHtml,
  sanitizeBcuHtmlSensitive,
  parseBcuHtml,
  assertNoCaptchaLeak,
  PAGE_TYPE,
} = require('../src/lib/bcuHtmlParser');
const { isTrustedHtmlExtraction } = require('../src/lib/rejectedBcuHtmlTrust');
const {
  persistTrustedBcuHtmlObservation,
  RESULT,
} = require('../src/lib/rejectedBcuHtmlPersist');
const {
  normalizeCi,
  worstBcuCategory,
  deriveRejectedOps,
} = require('../src/lib/rejectedOps');
const {
  reconcileSummaryValidationStatus,
} = require('../src/lib/bcuExtractConfirmGates');

const ACTION = Object.freeze({
  READY_TO_IMPORT: 'READY_TO_IMPORT',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  CONFLICT_SAME_CI_PERIOD: 'CONFLICT_SAME_CI_PERIOD',
  NOT_RESULT_PAGE: 'NOT_RESULT_PAGE',
  UNTRUSTED_EXTRACTION: 'UNTRUSTED_EXTRACTION',
  PARSE_FAILED: 'PARSE_FAILED',
});

const DEFAULT_DIR = path.join('C:', 'Users', 'Admin', 'Pictures', 'BCU');

function parseArgs(argv) {
  const out = {
    dir: DEFAULT_DIR,
    dryRun: true,
    execute: false,
    consultedOn: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
      out.execute = false;
    } else if (a === '--execute') {
      out.execute = true;
      out.dryRun = false;
    } else if (a === '--dir' && argv[i + 1]) {
      out.dir = argv[++i];
    } else if (a.indexOf('--dir=') === 0) {
      out.dir = a.slice(6);
    } else if (a === '--consulted-on' && argv[i + 1]) {
      out.consultedOn = argv[++i];
    } else if (a.indexOf('--consulted-on=') === 0) {
      out.consultedOn = a.slice(15);
    }
  }
  return out;
}

function discoverLoginServlets(rootDir) {
  const found = [];
  function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (let i = 0; i < ents.length; i += 1) {
      const e = ents[i];
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'LoginServlet.html') found.push(full);
    }
  }
  walk(rootDir);
  return found.sort();
}

function presentCategories(extraction) {
  if (!extraction || !Array.isArray(extraction.institutions)) return [];
  return extraction.institutions.map(function (inst) {
    return inst.category;
  });
}

/**
 * Classify one HTML file without writes.
 * @param {{ htmlPath: string, existingByCiPeriod: Map<string, object>, payloadHashFn?: Function }} ctx
 */
function classifyHtmlFile(htmlPath, existingByCiPeriod) {
  const row = {
    path: htmlPath,
    filename: path.basename(htmlPath),
    relative: null,
    page_type: null,
    document_ci_raw: null,
    ci: null,
    period: null,
    currency: null,
    institution_count: 0,
    categories: [],
    worst_category: null,
    reconciliation: null,
    trusted: false,
    trust_reasons: [],
    existing: false,
    existing_snapshot_id: null,
    existing_source: null,
    existing_hash: null,
    action: ACTION.PARSE_FAILED,
    captcha_leak: false,
    extraction: null,
    error: null,
  };

  let buf;
  try {
    buf = fs.readFileSync(htmlPath);
  } catch (e) {
    row.error = e.message;
    row.action = ACTION.PARSE_FAILED;
    return row;
  }

  let decoded;
  let sanitized;
  try {
    decoded = decodeBcuHtml(buf);
    sanitized = sanitizeBcuHtmlSensitive(decoded.html);
    assertNoCaptchaLeak(sanitized, path.basename(htmlPath));
  } catch (e) {
    row.error = e.message;
    row.action = /captcha/i.test(e.message)
      ? ACTION.PARSE_FAILED
      : ACTION.PARSE_FAILED;
    row.captcha_leak = /captcha/i.test(e.message);
    return row;
  }

  let parsed;
  try {
    parsed = parseBcuHtml(sanitized, { charset: decoded.charset });
  } catch (e) {
    row.error = e.message;
    row.action = ACTION.PARSE_FAILED;
    return row;
  }

  row.page_type = parsed.page_type;
  if (parsed.page_type !== PAGE_TYPE.RESULT_PAGE) {
    row.action = ACTION.NOT_RESULT_PAGE;
    return row;
  }

  const extraction = parsed.extraction;
  if (!extraction) {
    row.action = ACTION.UNTRUSTED_EXTRACTION;
    return row;
  }

  row.extraction = extraction;
  row.document_ci_raw = extraction.document_ci_raw;
  row.period = extraction.period;
  row.currency = extraction.currency_view_selected;
  row.institution_count = Array.isArray(extraction.institutions)
    ? extraction.institutions.length
    : 0;
  row.categories = presentCategories(extraction);
  row.worst_category = worstBcuCategory(extraction.institutions);
  row.reconciliation = reconcileSummaryValidationStatus(extraction);

  const ciFromDoc = (function () {
    const m = /IDE\s+0*([0-9]{7,8})\b/i.exec(
      String(extraction.document_ci_raw || ''),
    );
    if (m) return normalizeCi(m[1]);
    const digits = String(extraction.document_ci_raw || '').replace(/\D/g, '');
    if (digits.length >= 7) {
      return normalizeCi(digits.replace(/^0+/, '') || digits.slice(-8));
    }
    return null;
  })();
  row.ci = ciFromDoc;

  if (row.ci == null) {
    row.action = ACTION.UNTRUSTED_EXTRACTION;
    row.trust_reasons = [{ reason_code: 'INVALID_CI' }];
    return row;
  }

  const trust = isTrustedHtmlExtraction({
    pageType: parsed.page_type,
    extraction: extraction,
    expectedCi: row.ci,
    parserMeta: parsed.parser_meta,
  });
  row.trusted = trust.ok === true;
  row.trust_reasons = trust.reasons || [];
  row.gate_ok = trust.gate && trust.gate.ok;
  row.summary_validation_status =
    trust.gate && trust.gate.summary_validation_status;

  if (!trust.ok) {
    row.action = ACTION.UNTRUSTED_EXTRACTION;
    return row;
  }

  const key = String(row.ci) + '|' + String(row.period);
  const existing = existingByCiPeriod.get(key);
  if (existing) {
    row.existing = true;
    row.existing_snapshot_id = existing.id;
    row.existing_source = existing.source;
    row.existing_hash = existing.reviewed_payload_sha256 || null;
    // Exact hash compare happens at persist time; dry-run marks existing as
    // ALREADY_CONFIRMED if any snapshot exists (conservative: CONFLICT if we
    // cannot compare without hash of incoming — persist layer distinguishes).
    row.action = ACTION.ALREADY_CONFIRMED;
    row._existing_for_persist = existing;
    return row;
  }

  row.action = ACTION.READY_TO_IMPORT;
  row._sanitized_html = sanitized;
  row._page_type = parsed.page_type;
  row._parser_meta = parsed.parser_meta;
  return row;
}

async function loadExistingSnapshots(sb, cis) {
  const map = new Map();
  if (!cis.length) return map;
  // chunk to avoid URL length limits
  const chunkSize = 50;
  for (let i = 0; i < cis.length; i += chunkSize) {
    const chunk = cis.slice(i, i + chunkSize);
    const { data, error } = await sb
      .from('rejected_bcu_snapshots')
      .select('id, ci, period_label, source, reviewed_payload_sha256, consulted_on')
      .in('ci', chunk);
    if (error) throw error;
    (data || []).forEach(function (r) {
      const key = String(r.ci) + '|' + String(r.period_label);
      const prev = map.get(key);
      if (!prev) map.set(key, r);
    });
  }
  return map;
}

function summarize(rows) {
  const counts = {
    total: rows.length,
    RESULT_PAGE: 0,
    CONSULTA_FORM: 0,
    UNKNOWN_PAGE: 0,
    READY_TO_IMPORT: 0,
    ALREADY_CONFIRMED: 0,
    CONFLICT_SAME_CI_PERIOD: 0,
    NOT_RESULT_PAGE: 0,
    UNTRUSTED_EXTRACTION: 0,
    PARSE_FAILED: 0,
  };
  rows.forEach(function (r) {
    if (r.page_type === PAGE_TYPE.RESULT_PAGE) counts.RESULT_PAGE += 1;
    else if (r.page_type === PAGE_TYPE.CONSULTA_FORM) counts.CONSULTA_FORM += 1;
    else if (r.page_type === PAGE_TYPE.UNKNOWN_PAGE) counts.UNKNOWN_PAGE += 1;
    if (counts[r.action] != null) counts[r.action] += 1;
  });
  return counts;
}

function printTable(rows) {
  console.log(
    'CI | period | inst | worst | recon | trusted | existing | action',
  );
  rows.forEach(function (r) {
    console.log(
      [
        r.ci != null ? r.ci : '-',
        r.period || '-',
        r.institution_count,
        r.worst_category || '-',
        r.reconciliation || '-',
        r.trusted ? 'Y' : 'N',
        r.existing ? 'Y' : 'N',
        r.action,
      ].join(' | '),
    );
  });
}

async function verifyImported(sb, snapshotId, expected) {
  const { data: snap, error: sErr } = await sb
    .from('rejected_bcu_snapshots')
    .select(
      'id, ci, period_label, consulted_on, source, currency_view_selected, extraction_contract_version, summary_validation_status',
    )
    .eq('id', snapshotId)
    .maybeSingle();
  if (sErr || !snap) {
    return { ok: false, error: (sErr && sErr.message) || 'snapshot_missing' };
  }
  const { data: inst, error: iErr } = await sb
    .from('rejected_bcu_institutions')
    .select('id, category, castigado_mn, vigente_mn')
    .eq('snapshot_id', snapshotId);
  if (iErr) return { ok: false, error: iErr.message };
  const { count: draftCount } = await sb
    .from('rejected_bcu_extraction_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('ci', expected.ci);

  const checks = {
    source_html_import: snap.source === 'html_import',
    period_ok: snap.period_label === expected.period,
    consulted_on_ok: snap.consulted_on === expected.consultedOn,
    inst_count_ok: (inst || []).length === expected.institution_count,
    contract_ok: snap.extraction_contract_version === 'bcu_v1',
    drafts_zero_ok: (draftCount || 0) === (expected.drafts_before || 0),
  };
  const ok = Object.keys(checks).every(function (k) {
    return checks[k];
  });
  return {
    ok: ok,
    checks: checks,
    summary_validation_status: snap.summary_validation_status,
    institutions: inst || [],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.consultedOn && args.execute) {
    console.error(
      JSON.stringify({
        error: 'CONSULTED_ON_REQUIRED',
        hint: 'Pass --consulted-on YYYY-MM-DD for execute mode',
      }),
    );
    process.exit(2);
  }
  // For dry-run default consulted_on display only
  const consultedOn = args.consultedOn || '2026-09-09';

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error(JSON.stringify({ error: 'NO_SUPABASE' }));
    process.exit(2);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const files = discoverLoginServlets(args.dir);
  // First pass parse to collect CIs for existing lookup (RESULT only)
  const preliminary = files.map(function (f) {
    return classifyHtmlFile(f, new Map());
  });
  const cis = [];
  preliminary.forEach(function (r) {
    if (r.ci != null && cis.indexOf(r.ci) < 0) cis.push(r.ci);
  });
  const existingMap = await loadExistingSnapshots(sb, cis);
  const rows = files.map(function (f) {
    return classifyHtmlFile(f, existingMap);
  });

  // Refine ALREADY vs CONFLICT using persist hash when existing
  const { hashConfirmPayload } = require('../src/lib/bcuExtractCanonical');
  rows.forEach(function (r) {
    if (r.action !== ACTION.ALREADY_CONFIRMED || !r.extraction) return;
    const incomingHash = hashConfirmPayload({
      consulted_on: consultedOn,
      reviewed: r.extraction,
    });
    if (r.existing_hash == null) {
      // historical / other source without comparable hash → conflict (no overwrite)
      if (r.existing_source && r.existing_source !== 'html_import') {
        r.action = ACTION.CONFLICT_SAME_CI_PERIOD;
      } else if (r.existing_hash == null && r.existing) {
        // same period exists; without hash treat as conflict unless we will get ALREADY from persist
        // Pilot html_import has hash — if missing hash → CONFLICT
        r.action = ACTION.CONFLICT_SAME_CI_PERIOD;
      }
    } else if (r.existing_hash === incomingHash) {
      r.action = ACTION.ALREADY_CONFIRMED;
    } else {
      // Different consulted_on changes hash even if extraction same — persist layer
      // uses same consulted_on. If hashes differ → CONFLICT
      r.action = ACTION.CONFLICT_SAME_CI_PERIOD;
    }
  });

  // Special case: existing html_import with SAME extraction but different consulted_on
  // in dry-run hash → CONFLICT. For pilot 51769764 we used consulted_on 2026-09-09 —
  // reusing same consulted_on yields ALREADY_CONFIRMED. Good.

  const counts = summarize(rows);
  console.log('=== DRY RUN SUMMARY ===');
  console.log(JSON.stringify(counts, null, 2));
  printTable(rows);

  const unexpected = rows.filter(function (r) {
    return r.action === ACTION.PARSE_FAILED && r.captcha_leak;
  });
  if (unexpected.length) {
    console.error(JSON.stringify({ error: 'CAPTCHA_LEAK', files: unexpected }));
    process.exit(4);
  }

  const out = {
    mode: args.execute ? 'execute' : 'dry-run',
    consulted_on: consultedOn,
    source_file_policy: 'source_file_not_persisted',
    source_file_reason:
      'rejected-bcu-files MIME whitelist is image/pdf only; HTML needs storage+download Content-Disposition work; avoid XSS. Data import not blocked.',
    captcha_leak: false,
    dry_run: counts,
    rows: rows.map(function (r) {
      return {
        path: r.path,
        page_type: r.page_type,
        ci: r.ci,
        period: r.period,
        institution_count: r.institution_count,
        worst_category: r.worst_category,
        reconciliation: r.reconciliation,
        trusted: r.trusted,
        existing: r.existing,
        action: r.action,
        trust_reasons: r.trust_reasons,
      };
    }),
    batch: null,
    db: null,
    ops: [],
    exceptions: [],
  };

  rows.forEach(function (r) {
    if (r.action !== ACTION.READY_TO_IMPORT) {
      out.exceptions.push({
        path: r.path,
        ci: r.ci,
        action: r.action,
        reasons: r.trust_reasons,
        error: r.error,
      });
    }
  });

  if (!args.execute) {
    console.log(JSON.stringify({ phase: 'dry-run-complete', report: out }, null, 2));
    return;
  }

  // --- global before counts ---
  const { count: snapsBefore } = await sb
    .from('rejected_bcu_snapshots')
    .select('id', { count: 'exact', head: true });
  const { count: instBefore } = await sb
    .from('rejected_bcu_institutions')
    .select('id', { count: 'exact', head: true });
  const { count: draftsBefore } = await sb
    .from('rejected_bcu_extraction_drafts')
    .select('id', { count: 'exact', head: true });

  const batch = {
    imported: 0,
    already_confirmed: 0,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  // Count non-ready as skipped
  rows.forEach(function (r) {
    if (r.action === ACTION.READY_TO_IMPORT) return;
    if (r.action === ACTION.ALREADY_CONFIRMED) batch.already_confirmed += 1;
    else if (r.action === ACTION.CONFLICT_SAME_CI_PERIOD) batch.conflicts += 1;
    else batch.skipped += 1;
  });

  const ready = rows.filter(function (r) {
    return r.action === ACTION.READY_TO_IMPORT;
  });

  // Also re-run persist for ALREADY_CONFIRMED rows that are RESULT trusted
  // to validate pilot path (especially 51769764) — user asked pilot must ALREADY_CONFIRMED
  const confirmRows = rows.filter(function (r) {
    return (
      r.action === ACTION.ALREADY_CONFIRMED ||
      r.action === ACTION.CONFLICT_SAME_CI_PERIOD
    );
  });

  for (let i = 0; i < confirmRows.length; i += 1) {
    const r = confirmRows[i];
    if (!r.extraction || r.ci == null) continue;
    const res = await persistTrustedBcuHtmlObservation({
      ci: r.ci,
      consultedOn: consultedOn,
      extraction: r.extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      parserMeta: r._parser_meta || null,
      client: sb,
    });
    batch.results.push({
      ci: r.ci,
      period: r.period,
      dry_action: r.action,
      result: res.result,
      snapshot_id: res.snapshot_id,
    });
    if (r.ci === 51769764 && r.period === '202607') {
      if (res.result !== RESULT.ALREADY_CONFIRMED) {
        console.error(
          JSON.stringify({
            error: 'PILOT_IDEMPOTENCY_FAIL',
            result: res.result,
            snapshot_id: res.snapshot_id,
          }),
        );
        process.exit(5);
      }
    }
    if (
      res.result === RESULT.IMPORTED ||
      res.result === RESULT.PERSIST_FAILED
    ) {
      // unexpected new write on "already" path
      if (res.result === RESULT.IMPORTED) {
        console.error(
          JSON.stringify({
            error: 'UNEXPECTED_IMPORT_ON_EXISTING',
            ci: r.ci,
            snapshot_id: res.snapshot_id,
          }),
        );
        process.exit(5);
      }
      if (res.result === RESULT.PERSIST_FAILED) {
        console.error(JSON.stringify({ error: 'SYSTEMIC_OR_CASE', res: res }));
        batch.failed += 1;
        process.exit(6);
      }
    }
  }

  for (let i = 0; i < ready.length; i += 1) {
    const r = ready[i];
    const { count: draftsCiBefore } = await sb
      .from('rejected_bcu_extraction_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('ci', r.ci);

    const res = await persistTrustedBcuHtmlObservation({
      ci: r.ci,
      consultedOn: consultedOn,
      extraction: r.extraction,
      pageType: PAGE_TYPE.RESULT_PAGE,
      parserMeta: r._parser_meta || null,
      client: sb,
    });

    const entry = {
      ci: r.ci,
      period: r.period,
      result: res.result,
      snapshot_id: res.snapshot_id,
      reasons: res.reasons,
      ops: res.ops,
      active_draft_exists: res.active_draft_exists,
      verify: null,
    };

    if (res.result === RESULT.IMPORTED) {
      batch.imported += 1;
      entry.verify = await verifyImported(sb, res.snapshot_id, {
        ci: r.ci,
        period: r.period,
        consultedOn: consultedOn,
        institution_count: r.institution_count,
        drafts_before: draftsCiBefore || 0,
      });
      if (!entry.verify.ok) {
        batch.failed += 1;
        console.error(JSON.stringify({ error: 'POST_VERIFY_FAIL', entry: entry }));
        // continue unless systemic — verification fail is case-level
      } else {
        out.ops.push({
          ci: r.ci,
          period: r.period,
          worst_bcu: r.worst_category,
          ops_status: res.ops && res.ops.ops_status,
          next_review_on: res.ops && res.ops.next_review_on,
        });
      }
    } else if (res.result === RESULT.ALREADY_CONFIRMED) {
      batch.already_confirmed += 1;
      batch.skipped -= 1; // was counted in dry skip? ready shouldn't hit this often
    } else if (res.result === RESULT.CONFLICT_SAME_CI_PERIOD) {
      batch.conflicts += 1;
    } else if (res.result === RESULT.PERSIST_FAILED) {
      batch.failed += 1;
      console.error(JSON.stringify({ error: 'PERSIST_FAILED', entry: entry }));
      // systemic RPC? if first failure looks like missing function, abort
      if (
        res.reasons &&
        res.reasons.some(function (x) {
          return x.reason_code === 'PERSIST_RPC_FAILED';
        })
      ) {
        console.error(JSON.stringify({ error: 'SYSTEMIC_RPC_FAIL', stopping: true }));
        process.exit(6);
      }
    } else {
      batch.failed += 1;
    }
    batch.results.push(entry);
  }

  const { count: snapsAfter } = await sb
    .from('rejected_bcu_snapshots')
    .select('id', { count: 'exact', head: true });
  const { count: instAfter } = await sb
    .from('rejected_bcu_institutions')
    .select('id', { count: 'exact', head: true });
  const { count: draftsAfter } = await sb
    .from('rejected_bcu_extraction_drafts')
    .select('id', { count: 'exact', head: true });

  out.batch = batch;
  out.db = {
    snapshots_before: snapsBefore,
    snapshots_after: snapsAfter,
    snapshots_delta: (snapsAfter || 0) - (snapsBefore || 0),
    institutions_before: instBefore,
    institutions_after: instAfter,
    institutions_delta: (instAfter || 0) - (instBefore || 0),
    drafts_before: draftsBefore,
    drafts_after: draftsAfter,
    drafts_created: (draftsAfter || 0) - (draftsBefore || 0),
  };

  // Ops for ALL imported in this batch + already known from results
  const importedIds = batch.results
    .filter(function (x) {
      return x.result === RESULT.IMPORTED && x.snapshot_id;
    })
    .map(function (x) {
      return x.snapshot_id;
    });

  console.log(JSON.stringify({ phase: 'batch-complete', report: out }, null, 2));
}

module.exports = {
  ACTION,
  discoverLoginServlets,
  classifyHtmlFile,
  summarize,
  parseArgs,
};

if (require.main === module) {
  main().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}
