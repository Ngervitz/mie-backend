'use strict';

/**
 * Mi Deuda — READ-ONLY parity audit: legacy APPROVED_RAW_TO_CANONICAL vs creditor catalog
 * over every DISTINCT rejected_bcu_institutions.institution_name, plus bag parity
 * (legacy builder pinned at LEGACY_COMMIT vs current builder) on the same BCU rows.
 *
 * Run:  node scripts/audit-creditor-catalog-bcu-parity-ro.js [--catalog=seed|db]
 *   --catalog=seed (default): resolver from src/lib/creditorCatalogBcuSeed.js (pre-migration).
 *   --catalog=db: resolver loaded from creditors/creditor_aliases (post-migration gate).
 *
 * The Supabase client is wrapped so only .from(t).select(cols).range(a, b) is reachable.
 * Prints counts only (no CI values).
 */

require('dotenv').config();

const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const { RESOLUTION, creditorKeyV1, buildCreditorResolver, resolveCreditor } = require('../src/lib/creditorCatalog');
const { seedCatalogRows } = require('../src/lib/creditorCatalogBcuSeed');
const { loadCreditorCatalog } = require('../src/lib/creditorCatalogRead');
const { fetchMiDeudaBagBundle } = require('../src/lib/miDeudaBagsRead');
const { buildMiDeudaBagModel, canonicalizeInstitutionName, MAP_STATUS } = require('../src/lib/miDeudaBags');

const LEGACY_COMMIT = 'd176eba';
const ALLOWED_TABLES = new Set([
  'rejected_bcu_snapshots',
  'rejected_bcu_institutions',
  'creditors',
  'creditor_aliases',
]);

function readOnlyClient(client) {
  return {
    from: function (table) {
      if (!ALLOWED_TABLES.has(table)) throw new Error('read-only guard: table not allowed: ' + table);
      return {
        select: function (cols) {
          const q = client.from(table).select(cols);
          return {
            range: function (from, to) {
              return q.range(from, to);
            },
          };
        },
      };
    },
  };
}

function loadLegacyBagModule() {
  const root = path.join(__dirname, '..');
  const code = execFileSync('git', ['show', LEGACY_COMMIT + ':src/lib/miDeudaBags.js'], {
    cwd: root,
    encoding: 'utf8',
  });
  const filename = path.join(root, 'src', 'lib', '__legacy_miDeudaBags_' + LEGACY_COMMIT + '.js');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(code, filename);
  return m.exports;
}

function bagSignature(model) {
  const out = {};
  model.bags.forEach(function (b) {
    out[b.institution_canonical] = {
      people_count: b.people_count,
      moroso_mn: b.moroso_mn,
      moroso_me: b.moroso_me,
      castigado_mn: b.castigado_mn,
      castigado_me: b.castigado_me,
      colocacion_vencida_mn: b.colocacion_vencida_mn,
      colocacion_vencida_me: b.colocacion_vencida_me,
      reestructurado_mn: b.reestructurado_mn,
      reestructurado_me: b.reestructurado_me,
      members: b.members
        .map(function (x) {
          return x.ci + '|' + x.raw_name;
        })
        .sort(),
    };
  });
  return out;
}

(async function main() {
  const catalogMode = (process.argv.find(function (a) {
    return a.indexOf('--catalog=') === 0;
  }) || '--catalog=seed').split('=')[1];
  if (catalogMode !== 'seed' && catalogMode !== 'db') throw new Error('--catalog must be seed|db');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const supabase = readOnlyClient(createClient(url, key, { auth: { persistSession: false } }));

  const resolver =
    catalogMode === 'db' ? await loadCreditorCatalog(supabase) : buildCreditorResolver(seedCatalogRows());
  const bundle = await fetchMiDeudaBagBundle(supabase);

  const ciBySnapshot = new Map();
  bundle.snapshots.forEach(function (s) {
    ciBySnapshot.set(s.id, s.ci);
  });

  const byRaw = new Map();
  bundle.institutions.forEach(function (row) {
    const raw = row.institution_name;
    const k = raw == null ? '\u0000null' : String(raw);
    if (!byRaw.has(k)) byRaw.set(k, { raw: raw, rows: 0, cis: new Set() });
    const e = byRaw.get(k);
    e.rows += 1;
    e.cis.add(ciBySnapshot.get(row.snapshot_id));
  });

  const counts = {
    SAME_RESOLUTION: 0,
    OLD_UNKNOWN_NEW_RESOLVED: 0,
    OLD_RESOLVED_NEW_UNKNOWN: 0,
    DIFFERENT_CREDITOR: 0,
    BOTH_UNKNOWN: 0,
  };
  const detail = [];
  const oldUnknownNewResolved = [];
  byRaw.forEach(function (e) {
    const oldRes = canonicalizeInstitutionName(e.raw);
    const newRes = resolveCreditor(resolver, 'bcu', e.raw);
    const oldOk = oldRes.status === MAP_STATUS.MAPPED;
    const newOk = newRes.resolution === RESOLUTION.RESOLVED;
    let cls;
    if (oldOk && newOk) cls = oldRes.canonical_name === newRes.display_name ? 'SAME_RESOLUTION' : 'DIFFERENT_CREDITOR';
    else if (!oldOk && newOk) cls = 'OLD_UNKNOWN_NEW_RESOLVED';
    else if (oldOk && !newOk) cls = 'OLD_RESOLVED_NEW_UNKNOWN';
    else cls = 'BOTH_UNKNOWN';
    counts[cls] += 1;
    const item = {
      raw: e.raw,
      normalized_key: newRes.normalized_key,
      classification: cls,
      old_canonical: oldRes.canonical_name,
      new_resolution: newRes.resolution,
      new_creditor_id: newRes.creditor_id,
      new_display_name: newRes.display_name,
      rows: e.rows,
      distinct_ci: e.cis.size,
    };
    detail.push(item);
    if (cls === 'OLD_UNKNOWN_NEW_RESOLVED') oldUnknownNewResolved.push(item);
  });
  const legacyRawByKey = new Map();
  Object.keys(require('../src/lib/miDeudaBags').APPROVED_RAW_TO_CANONICAL).forEach(function (raw) {
    const k = creditorKeyV1(raw);
    if (!legacyRawByKey.has(k)) legacyRawByKey.set(k, []);
    legacyRawByKey.get(k).push(raw);
  });
  oldUnknownNewResolved.forEach(function (item) {
    item.reason =
      'creditor_key_v1 = "' + item.normalized_key + '" equals key of legacy approved raw ' +
      JSON.stringify(legacyRawByKey.get(item.normalized_key) || []);
  });

  const legacy = loadLegacyBagModule();
  const oldModel = legacy.buildMiDeudaBagModel({ snapshots: bundle.snapshots, institutions: bundle.institutions });
  const newModel = buildMiDeudaBagModel({
    snapshots: bundle.snapshots,
    institutions: bundle.institutions,
    resolver: resolver,
  });
  const oldSig = bagSignature(oldModel);
  const newSig = bagSignature(newModel);
  const bagDiffs = [];
  new Set(Object.keys(oldSig).concat(Object.keys(newSig))).forEach(function (name) {
    const a = JSON.stringify(oldSig[name] || null);
    const b = JSON.stringify(newSig[name] || null);
    if (a !== b) {
      bagDiffs.push({
        bag: name,
        old_people: oldSig[name] ? oldSig[name].people_count : null,
        new_people: newSig[name] ? newSig[name].people_count : null,
      });
    }
  });
  const countsEqual = JSON.stringify(oldModel.counts) === JSON.stringify(newModel.counts);

  detail.sort(function (a, b) {
    return String(a.raw).localeCompare(String(b.raw));
  });

  console.log(
    JSON.stringify(
      {
        mode: 'READ_ONLY',
        catalog: catalogMode,
        legacy_commit: LEGACY_COMMIT,
        snapshots: bundle.snapshots.length,
        institution_rows: bundle.institutions.length,
        TOTAL_DISTINCT_RAW: byRaw.size,
        classification_counts: counts,
        old_unknown_new_resolved: oldUnknownNewResolved,
        distinct_raw_detail: detail.map(function (d) {
          return {
            raw: d.raw,
            normalized_key: d.normalized_key,
            classification: d.classification,
            new_display_name: d.new_display_name,
            rows: d.rows,
            distinct_ci: d.distinct_ci,
          };
        }),
        distinct_keys: new Set(detail.map(function (d) {
          return creditorKeyV1(d.raw);
        })).size,
        bag_parity: {
          old_counts: oldModel.counts,
          new_counts: newModel.counts,
          counts_equal: countsEqual,
          old_bags: oldModel.bags.length,
          new_bags: newModel.bags.length,
          bag_diffs: bagDiffs,
          result: countsEqual && bagDiffs.length === 0 ? 'PASS' : 'DIFF',
        },
      },
      null,
      2,
    ),
  );
})().catch(function (err) {
  console.error('audit-creditor-catalog-bcu-parity-ro: FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
