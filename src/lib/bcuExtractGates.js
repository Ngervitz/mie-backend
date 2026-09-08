'use strict';

/**
 * Deterministic gates over a bcu_v1-shaped payload.
 * Blind to origin (LLM vision, fixture, hand-built JSON — same rules).
 *
 * SUMMARY_DETAIL / RUBRO_ORPHAN: provisional, calibrated on n=6 real BCUs.
 * reason_codes are stable for later FP/FN measurement — do not retune per fixture.
 *
 * No I/O. No FX. No auto-persist.
 */

const { normalizeCi, BCU_CATEGORIES } = require('./rejectedOps');
const {
  EXTRACTION_CONTRACT_VERSION,
  CURRENCY_VIEWS,
  CURRENCY_VIEW_REVIEW_READY,
  RUBRO_KEYS,
  MONEY_SIDES,
  REASON,
} = require('./bcuExtractContract');
const { moneySlot, moneyPairSlots } = require('./bcuExtractMoney');

/**
 * @typedef {{
 *   gate: string,
 *   severity: 'blocker'|'info',
 *   reason_code: string,
 *   path?: string,
 *   detail?: object
 * }} Finding
 */

function finding(gate, severity, reason_code, path, detail) {
  const row = {
    gate: gate,
    severity: severity,
    reason_code: reason_code,
  };
  if (path != null) row.path = path;
  if (detail != null) row.detail = detail;
  return row;
}

function moneyOf(obj, rubro) {
  const block = obj && typeof obj === 'object' ? obj[rubro] : null;
  return moneyPairSlots(block);
}

/**
 * @param {unknown} extraction
 * @param {{ expected_ci?: string|null }} [options]
 * @returns {Finding[]}
 */
function runBcuExtractGates(extraction, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const findings = [];

  if (extraction == null) {
    findings.push(
      finding('CONTRACT', 'blocker', REASON.EXTRACTION_MISSING),
    );
    return findings;
  }
  if (typeof extraction !== 'object' || Array.isArray(extraction)) {
    findings.push(
      finding('CONTRACT', 'blocker', REASON.EXTRACTION_NOT_OBJECT),
    );
    return findings;
  }

  if (extraction.extraction_contract_version !== EXTRACTION_CONTRACT_VERSION) {
    findings.push(
      finding('CONTRACT', 'blocker', REASON.EXTRACTION_CONTRACT_INVALID, null, {
        got: extraction.extraction_contract_version,
        expected: EXTRACTION_CONTRACT_VERSION,
      }),
    );
    // Still continue other gates when possible for observability.
  }

  // --- currency view ---
  const cv = extraction.currency_view_selected;
  if (cv == null || cv === '') {
    findings.push(
      finding('CURRENCY_VIEW', 'blocker', REASON.CURRENCY_VIEW_MISSING),
    );
  } else if (CURRENCY_VIEWS.indexOf(cv) < 0) {
    findings.push(
      finding('CURRENCY_VIEW', 'blocker', REASON.CURRENCY_VIEW_INVALID, null, {
        got: cv,
      }),
    );
  } else if (cv !== CURRENCY_VIEW_REVIEW_READY) {
    findings.push(
      finding(
        'CURRENCY_VIEW',
        'blocker',
        REASON.CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS,
        'currency_view_selected',
        { got: cv },
      ),
    );
  }

  // --- CI (digit-normalize; compare as strings without leading zeros) ---
  function ciNormDigits(raw) {
    if (raw == null || raw === '') return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    // Ensure value is a safe CI integer form (reuse rejectedOps rule when possible)
    const stripped = digits.replace(/^0+/, '') || '0';
    if (normalizeCi(stripped) == null && normalizeCi(digits) == null) {
      // Still allow digit comparison for gate observability
      return stripped;
    }
    return stripped;
  }

  const expectedCi = ciNormDigits(opts.expected_ci);
  const docRaw = extraction.document_ci_raw;
  const extractedCiNorm = ciNormDigits(docRaw);

  if (expectedCi != null) {
    if (extractedCiNorm == null) {
      findings.push(
        finding('CI', 'blocker', REASON.CI_MISSING, 'document_ci_raw'),
      );
    } else if (extractedCiNorm !== expectedCi) {
      findings.push(
        finding('CI', 'blocker', REASON.CI_MISMATCH, 'document_ci_raw', {
          expected: expectedCi,
          extracted: extractedCiNorm,
          document_ci_raw: docRaw,
        }),
      );
    }
  }

  // --- institutions structure ---
  const institutions = extraction.institutions;
  if (!Array.isArray(institutions)) {
    findings.push(
      finding('STRUCTURE', 'blocker', REASON.STRUCTURE_INSTITUTIONS_NOT_ARRAY),
    );
    return findings;
  }

  const summary = extraction.summary && typeof extraction.summary === 'object'
    ? extraction.summary
    : {};

  let anySummaryNumeric = false;
  for (let r = 0; r < RUBRO_KEYS.length; r += 1) {
    const slots = moneyOf(summary, RUBRO_KEYS[r]);
    for (let s = 0; s < MONEY_SIDES.length; s += 1) {
      if (slots[MONEY_SIDES[s]].kind === 'cents') anySummaryNumeric = true;
      if (slots[MONEY_SIDES[s]].kind === 'error') {
        findings.push(
          finding(
            'MONEY',
            'blocker',
            slots[MONEY_SIDES[s]].reason,
            'summary.' + RUBRO_KEYS[r] + '.' + MONEY_SIDES[s],
          ),
        );
      }
    }
  }

  if (!institutions.length && anySummaryNumeric) {
    findings.push(
      finding(
        'STRUCTURE',
        'blocker',
        REASON.STRUCTURE_SUMMARY_WITHOUT_INSTITUTIONS,
      ),
    );
  }

  const seenNames = Object.create(null);
  for (let i = 0; i < institutions.length; i += 1) {
    const inst = institutions[i];
    const name =
      inst && typeof inst === 'object'
        ? String(inst.institution_name_raw || '').trim()
        : '';
    if (!name) {
      findings.push(
        finding(
          'STRUCTURE',
          'blocker',
          REASON.STRUCTURE_EMPTY_INSTITUTION_NAME,
          'institutions[' + i + '].institution_name_raw',
        ),
      );
    } else {
      const key = name.toLowerCase();
      if (seenNames[key]) {
        findings.push(
          finding(
            'STRUCTURE',
            'blocker',
            REASON.STRUCTURE_DUPLICATE_INSTITUTION,
            'institutions[' + i + '].institution_name_raw',
            { name: name },
          ),
        );
      }
      seenNames[key] = true;
    }

    if (inst && typeof inst === 'object') {
      const cat = inst.category;
      if (cat != null && BCU_CATEGORIES.indexOf(cat) < 0) {
        findings.push(
          finding(
            'STRUCTURE',
            'blocker',
            REASON.CATEGORY_INVALID,
            'institutions[' + i + '].category',
            { got: cat },
          ),
        );
      }
      for (let r = 0; r < RUBRO_KEYS.length; r += 1) {
        const slots = moneyOf(inst, RUBRO_KEYS[r]);
        for (let s = 0; s < MONEY_SIDES.length; s += 1) {
          if (slots[MONEY_SIDES[s]].kind === 'error') {
            findings.push(
              finding(
                'MONEY',
                'blocker',
                slots[MONEY_SIDES[s]].reason,
                'institutions[' +
                  i +
                  '].' +
                  RUBRO_KEYS[r] +
                  '.' +
                  MONEY_SIDES[s],
              ),
            );
          }
        }
      }
    }
  }

  // --- SUMMARY_DETAIL (exact BigInt cents) + RUBRO_ORPHAN ---
  for (let r = 0; r < RUBRO_KEYS.length; r += 1) {
    const rubro = RUBRO_KEYS[r];
    for (let s = 0; s < MONEY_SIDES.length; s += 1) {
      const side = MONEY_SIDES[s];
      const path = rubro + '.' + side;
      const sumSlot = moneyOf(summary, rubro)[side];

      if (sumSlot.kind === 'error') {
        continue; // already reported
      }

      let nCents = 0;
      let nNull = 0;
      let nError = 0;
      let detailSum = 0n;
      const instSlots = [];

      for (let i = 0; i < institutions.length; i += 1) {
        const slot = moneyOf(institutions[i], rubro)[side];
        instSlots.push(slot);
        if (slot.kind === 'cents') {
          nCents += 1;
          detailSum += slot.cents;
        } else if (slot.kind === 'null') {
          nNull += 1;
        } else {
          nError += 1;
        }
      }

      if (sumSlot.kind === 'null') {
        if (nCents > 0 && nNull > 0) {
          findings.push(
            finding(
              'RUBRO_ORPHAN',
              'blocker',
              REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT,
              path,
              { summary: null, nCents: nCents, nNull: nNull },
            ),
          );
        }
        continue;
      }

      // summary has cents
      if (!institutions.length || nCents === 0) {
        findings.push(
          finding(
            'RUBRO_ORPHAN',
            'blocker',
            REASON.RUBRO_ORPHAN_SUMMARY_WITHOUT_INST,
            path,
            {
              summary_cents: sumSlot.cents.toString(),
              nCents: nCents,
              nNull: nNull,
            },
          ),
        );
        continue;
      }

      if (nError > 0) {
        continue;
      }

      if (nNull > 0) {
        // Sparse detail: cannot declare MATCH under strict all-cells compare.
        // Always emit NOT_COMPARABLE (info).
        // ORPHAN blocker only when the non-null subset does NOT sum to summary.
        // If sum(non-null) === summary exactly (BigInt cents), do not orphan —
        // typical BCU matrix where institutions omit unused rubros as null.
        findings.push(
          finding(
            'SUMMARY_DETAIL',
            'info',
            REASON.SUMMARY_DETAIL_NOT_COMPARABLE,
            path,
            {
              summary_cents: sumSlot.cents.toString(),
              nCents: nCents,
              nNull: nNull,
              detail_sparse_cents: detailSum.toString(),
            },
          ),
        );
        if (detailSum !== sumSlot.cents) {
          findings.push(
            finding(
              'RUBRO_ORPHAN',
              'blocker',
              REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT,
              path,
              {
                summary_cents: sumSlot.cents.toString(),
                nCents: nCents,
                nNull: nNull,
                detail_sparse_cents: detailSum.toString(),
              },
            ),
          );
        }
        continue;
      }

      // all institutions numeric for this cell
      if (detailSum === sumSlot.cents) {
        // MATCH — no finding
      } else {
        findings.push(
          finding(
            'SUMMARY_DETAIL',
            'blocker',
            REASON.SUMMARY_DETAIL_MISMATCH,
            path,
            {
              summary_cents: sumSlot.cents.toString(),
              detail_sum_cents: detailSum.toString(),
              delta_cents: (sumSlot.cents > detailSum
                ? sumSlot.cents - detailSum
                : detailSum - sumSlot.cents
              ).toString(),
            },
          ),
        );
      }
    }
  }

  return findings;
}

module.exports = {
  runBcuExtractGates,
  finding,
};
