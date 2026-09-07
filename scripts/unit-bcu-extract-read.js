'use strict';

/**
 * Stage 5 — offline unit tests for BCU extraction draft read/public shapes.
 * Run: node scripts/unit-bcu-extract-read.js
 */

const assert = require('assert');
const {
  ACTIVE_DRAFT_STATUSES,
  DETAIL_READABLE_STATUSES,
  assertDraftId,
  buildDraftFileUrl,
  sanitizeDispositionFilename,
  resolveContentType,
  summarizeDraft,
  detailDraft,
  assertDraftReadableStatus,
} = require('../src/lib/rejectedBcuExtractRead');
const { ACTIVE_DEDUP_STATUSES } = require('../src/lib/bcuExtractTiming');
const { publicDraft } = require('../src/lib/rejectedBcuExtractDraft');

assert.deepStrictEqual(
  ACTIVE_DRAFT_STATUSES.slice(),
  ACTIVE_DEDUP_STATUSES.slice(),
  'latest active must match Stage 3 soft-dedup statuses',
);
assert.ok(ACTIVE_DRAFT_STATUSES.indexOf('confirmed') === -1);
assert.ok(DETAIL_READABLE_STATUSES.indexOf('confirmed') !== -1);
assert.ok(DETAIL_READABLE_STATUSES.indexOf('abandoned') === -1);

assert.strictEqual(
  buildDraftFileUrl('45006120', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '/rechazados/45006120/bcu-extraction-drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file',
);

assert.strictEqual(assertDraftId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
try {
  assertDraftId('not-a-uuid');
  assert.fail('expected invalid draft id');
} catch (err) {
  assert.strictEqual(err.statusCode, 400);
}

assert.strictEqual(sanitizeDispositionFilename('a/b\\c"\n.jpg'), 'a_b_c__.jpg');
assert.strictEqual(resolveContentType('image/jpeg; charset=binary'), 'image/jpeg');
assert.strictEqual(resolveContentType('text/html'), 'application/octet-stream');

const nowMs = Date.parse('2026-09-07T12:00:00.000Z');
const baseRow = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ci: '45006120',
  status: 'pending_review',
  storage_path: 'owner/uuid.jpg',
  original_filename: 'bcu.jpg',
  content_type: 'image/jpeg',
  file_size_bytes: 1200,
  file_sha256: 'abc',
  extraction_json: {
    extraction_contract_version: 'bcu_v1',
    institutions: [{ institution_name_raw: 'OCA', category: '1C' }],
    summary: {},
  },
  validation_json: {
    classification: 'REVIEW_READY',
    findings: [{ severity: 'warning', reason_code: 'X', message: 'm' }],
  },
  extraction_contract_version: 'bcu_v1',
  currency_view_selected: 'MN_PESOS_ME_PESOS',
  document_ci_raw: '45006120',
  confirmed_snapshot_id: null,
  created_at: '2026-09-06T10:00:00.000Z',
  updated_at: '2026-09-06T10:05:00.000Z',
  lease_expires_at: null,
  confirmed_at: null,
};

{
  const summary = summarizeDraft(baseRow, { nowMs: nowMs });
  assert.strictEqual(summary.status, 'pending_review');
  assert.strictEqual(summary.can_retry, false);
  assert.strictEqual(summary.in_progress, false);
  assert.strictEqual(summary.file_available, true);
  assert.strictEqual(
    summary.file_url,
    buildDraftFileUrl(baseRow.ci, baseRow.id),
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(summary, 'storage_path'));
  assert.strictEqual(JSON.stringify(summary).indexOf('storage_path'), -1);
  assert.strictEqual(JSON.stringify(summary).indexOf('owner/uuid'), -1);
}

{
  const detail = detailDraft(baseRow, { nowMs: nowMs });
  assert.ok(detail.draft);
  assert.ok(detail.extraction);
  assert.ok(detail.validation);
  assert.strictEqual(detail.can_retry, false);
  assert.strictEqual(detail.in_progress, false);
  assert.strictEqual(detail.file_available, true);
  assert.strictEqual(detail.file_url, detail.draft.file_url);
  assert.strictEqual(detail.confirmed_snapshot_id, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(detail, 'storage_path'));
  assert.ok(!Object.prototype.hasOwnProperty.call(detail.draft, 'storage_path'));
  assert.strictEqual(JSON.stringify(detail).indexOf('storage_path'), -1);
}

{
  const extracting = Object.assign({}, baseRow, {
    status: 'extracting',
    lease_expires_at: '2026-09-07T12:30:00.000Z',
  });
  const detail = detailDraft(extracting, { nowMs: nowMs });
  assert.strictEqual(detail.extraction, null);
  assert.strictEqual(detail.in_progress, true);
  assert.strictEqual(detail.can_retry, false);
}

{
  const failed = Object.assign({}, baseRow, { status: 'extraction_failed' });
  const summary = summarizeDraft(failed, { nowMs: nowMs });
  assert.strictEqual(summary.can_retry, true);
  assert.strictEqual(summary.in_progress, false);
}

{
  const confirmed = Object.assign({}, baseRow, {
    status: 'confirmed',
    confirmed_snapshot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    confirmed_at: '2026-09-06T11:00:00.000Z',
  });
  assertDraftReadableStatus(confirmed);
  const detail = detailDraft(confirmed, { nowMs: nowMs });
  assert.strictEqual(detail.confirmed_snapshot_id, confirmed.confirmed_snapshot_id);
  assert.ok(detail.extraction);
}

{
  try {
    assertDraftReadableStatus(
      Object.assign({}, baseRow, { status: 'abandoned' }),
    );
    assert.fail('abandoned should 404');
  } catch (err) {
    assert.strictEqual(err.statusCode, 404);
  }
}

{
  const pub = publicDraft(baseRow);
  assert.ok(pub);
  assert.ok(!Object.prototype.hasOwnProperty.call(pub, 'storage_path'));
  assert.strictEqual(pub.file_available, true);
  assert.strictEqual(pub.file_url, buildDraftFileUrl(baseRow.ci, baseRow.id));
  assert.strictEqual(JSON.stringify(pub).indexOf('storage_path'), -1);
}

{
  const noFile = Object.assign({}, baseRow, { storage_path: null });
  assert.strictEqual(summarizeDraft(noFile, { nowMs: nowMs }).file_available, false);
}

console.log('unit-bcu-extract-read: PASS');
