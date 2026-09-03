'use strict';

/**
 * Offline unit checks for Rechazados V0 BCU write (no HTTP / no prod DB).
 * Run: node scripts/unit-rechazados-bcu-write.js
 */

const assert = require('assert');
const { OPS_STATUS, deriveRejectedOps } = require('../src/lib/rejectedOps');
const {
  parsePeriodLabel,
  parseConsultedOnInput,
  parseInstitutionsInput,
  parseBalance,
  parseCategory,
  parseSnapshotPayload,
  isValidCalendarDate,
} = require('../src/lib/rejectedBcuValidate');
const {
  MAX_FILE_BYTES,
  detectMagicMime,
  validateRejectedBcuFile,
  buildRejectedBcuObjectPath,
  pathContainsCi,
} = require('../src/lib/rejectedBcuStorage');
const { persistRejectedBcuSnapshot } = require('../src/lib/rejectedBcuPersist');
const { hasRejectedHistorico } = require('../src/lib/rejectedOpsRead');

function throwsStatus(fn, status, messagePart) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected throw');
  assert.strictEqual(caught.statusCode, status);
  if (messagePart) {
    assert.ok(
      String(caught.message).includes(messagePart),
      caught.message,
    );
  }
}

function jpegBuffer() {
  const buf = Buffer.alloc(16, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function pngBuffer() {
  const buf = Buffer.alloc(16, 0);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

function webpBuffer() {
  const buf = Buffer.alloc(16, 0);
  buf.write('RIFF', 0);
  buf.write('WEBP', 8);
  return buf;
}

function pdfBuffer() {
  const buf = Buffer.alloc(16, 0);
  buf.write('%PDF', 0);
  return buf;
}

const validInst = {
  institution_name: ' Banco A ',
  category: ' 1C ',
  vigente_mn: '10',
  vigente_me: 0,
};

const validBody = {
  period_label: ' Ago 2026 ',
  consulted_on: '2026-08-10',
  institutions: JSON.stringify([validInst]),
};

const parsedOk = parseSnapshotPayload(validBody);
assert.strictEqual(parsedOk.period_label, 'Ago 2026');
assert.strictEqual(parsedOk.consulted_on, '2026-08-10');
assert.strictEqual(parsedOk.institutions.length, 1);
assert.strictEqual(parsedOk.institutions[0].institution_name, 'Banco A');
assert.strictEqual(parsedOk.institutions[0].category, '1C');
assert.strictEqual(parsedOk.institutions[0].vigente_mn, 10);
assert.strictEqual(parsedOk.institutions[0].sort_order, 0);

throwsStatus(function () {
  parsePeriodLabel('');
}, 400);
throwsStatus(function () {
  parsePeriodLabel('   ');
}, 400);
throwsStatus(function () {
  parsePeriodLabel(null);
}, 400);
assert.ok(isValidCalendarDate('2026-08-10'));
assert.ok(isValidCalendarDate('2024-02-29'));
assert.ok(!isValidCalendarDate('2025-02-29'));
assert.ok(!isValidCalendarDate('2026-08-10T00:00:00Z'));
assert.ok(!isValidCalendarDate('2026/08/10'));
throwsStatus(function () {
  parseConsultedOnInput('2026-08-10T12:00:00Z');
}, 400);
throwsStatus(function () {
  parseConsultedOnInput('2025-02-29');
}, 400);

throwsStatus(function () {
  parseInstitutionsInput('{');
}, 400, 'institutions');
throwsStatus(function () {
  parseInstitutionsInput('[]');
}, 400);
throwsStatus(function () {
  parseInstitutionsInput([{ institution_name: '', category: '1C' }]);
}, 400, 'institution_name');

['1C', '2A', '2B', '3', '4', '5'].forEach(function (cat) {
  assert.strictEqual(parseCategory(' ' + cat + ' '), cat);
});
throwsStatus(function () {
  parseCategory('1c');
}, 400);
throwsStatus(function () {
  parseCategory('6');
}, 400);

assert.strictEqual(parseBalance(undefined), 0);
assert.strictEqual(parseBalance(null), 0);
assert.strictEqual(parseBalance(''), 0);
assert.strictEqual(parseBalance('12.5'), 12.5);
assert.strictEqual(parseBalance(3), 3);
throwsStatus(function () {
  parseBalance(-1);
}, 400);
throwsStatus(function () {
  parseBalance('-1');
}, 400);
throwsStatus(function () {
  parseBalance(NaN);
}, 400);
throwsStatus(function () {
  parseBalance(Infinity);
}, 400);
throwsStatus(function () {
  parseBalance('1e2');
}, 400);
throwsStatus(function () {
  parseBalance('abc');
}, 400);

const many = parseInstitutionsInput([
  { institution_name: 'A', category: '2A', vigente_mn: 1, vigente_me: 2 },
  { institution_name: 'B', category: '3', moroso_mn: 5, moroso_me: 9 },
  { institution_name: 'C', category: '1C' },
]);
assert.deepStrictEqual(
  many.map(function (r) {
    return r.sort_order;
  }),
  [0, 1, 2],
);
assert.strictEqual(many[0].vigente_mn, 1);
assert.strictEqual(many[0].vigente_me, 2);
assert.strictEqual(many[1].moroso_mn, 5);
assert.strictEqual(many[1].moroso_me, 9);
assert.notStrictEqual(many[1].moroso_mn + many[1].moroso_me, many[1].moroso_mn);

function derived(institutions, consultedOn) {
  return deriveRejectedOps({
    institutions: institutions,
    consultedOn: consultedOn,
  });
}

const retry = derived(
  [
    { category: '1C', moroso_mn: 0, moroso_me: 0, castigado_mn: 0, castigado_me: 0 },
    { category: '2A', moroso_mn: 0, moroso_me: 0, castigado_mn: 0, castigado_me: 0 },
  ],
  '2026-08-10',
);
assert.strictEqual(retry.ops_status, OPS_STATUS.RETRY_ELIGIBLE);

const recon = derived(
  [
    {
      category: '3',
      moroso_mn: 0,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
    },
  ],
  '2026-08-10',
);
assert.strictEqual(recon.ops_status, OPS_STATUS.RECONSULTABLE);
assert.strictEqual(recon.next_review_on, '2026-09-05');

const noAuto = derived(
  [
    {
      category: '5',
      moroso_mn: 0,
      moroso_me: 0,
      castigado_mn: 10,
      castigado_me: 0,
    },
  ],
  '2026-08-10',
);
assert.strictEqual(noAuto.ops_status, OPS_STATUS.NO_AUTO_RECONSULT);

const undef = derived(
  [
    {
      category: '5',
      moroso_mn: 0,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
    },
  ],
  '2026-08-10',
);
assert.strictEqual(undef.ops_status, OPS_STATUS.UNDEFINED_CASE);

assert.strictEqual(detectMagicMime(jpegBuffer()), 'image/jpeg');
assert.strictEqual(detectMagicMime(pngBuffer()), 'image/png');
assert.strictEqual(detectMagicMime(webpBuffer()), 'image/webp');
assert.strictEqual(detectMagicMime(pdfBuffer()), 'application/pdf');

const jpegOk = validateRejectedBcuFile({
  mimetype: 'image/jpeg',
  originalname: 'scan.jpg',
  buffer: jpegBuffer(),
});
assert.strictEqual(jpegOk.ext, 'jpg');
assert.ok(
  validateRejectedBcuFile({
    mimetype: 'image/png',
    originalname: 'a.png',
    buffer: pngBuffer(),
  }),
);
assert.ok(
  validateRejectedBcuFile({
    mimetype: 'image/webp',
    originalname: 'a.webp',
    buffer: webpBuffer(),
  }),
);
assert.ok(
  validateRejectedBcuFile({
    mimetype: 'application/pdf',
    originalname: 'a.pdf',
    buffer: pdfBuffer(),
  }),
);
throwsStatus(function () {
  validateRejectedBcuFile({
    mimetype: 'image/gif',
    originalname: 'a.gif',
    buffer: jpegBuffer(),
  });
}, 400);
throwsStatus(function () {
  validateRejectedBcuFile({
    mimetype: 'image/jpeg',
    originalname: 'x.jpg',
    buffer: pdfBuffer(),
  });
}, 400);
throwsStatus(function () {
  validateRejectedBcuFile({
    mimetype: 'image/jpeg',
    originalname: 'big.jpg',
    buffer: Buffer.concat([jpegBuffer(), Buffer.alloc(MAX_FILE_BYTES)]),
  });
}, 400);

const snapId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const objId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ci = 45006120;
const storagePath = buildRejectedBcuObjectPath(snapId, objId, 'jpg');
assert.strictEqual(storagePath, snapId + '/' + objId + '.jpg');
assert.strictEqual(pathContainsCi(storagePath, ci), false);
assert.ok(!storagePath.includes(String(ci)));

assert.strictEqual(
  hasRejectedHistorico(
    [
      {
        cz_historico_id: 1,
        cz_solicitud_id: 9,
        solicitudes_estados_id: 3,
        fechahora_src: '2026-01-01T00:00:00.000Z',
      },
    ],
    [{ cz_id: 9, ci: ci }],
    ci,
  ),
  true,
);
assert.strictEqual(
  hasRejectedHistorico(
    [
      {
        cz_historico_id: 1,
        cz_solicitud_id: 9,
        solicitudes_estados_id: 5,
        fechahora_src: '2026-01-01T00:00:00.000Z',
      },
    ],
    [{ cz_id: 9, ci: ci }],
    ci,
  ),
  false,
);

async function runPersistTests() {
  const institutions = parseInstitutionsInput([
    { institution_name: 'A', category: '1C' },
    { institution_name: 'B', category: '2A' },
  ]);

  const calls = { upload: 0, insertSnap: 0, insertInst: 0, remove: 0, deleteSnap: 0 };
  const created = await persistRejectedBcuSnapshot(
    {
      snapshotId: snapId,
      fileObjectId: objId,
      ci: ci,
      period_label: 'Ago 2026',
      consulted_on: '2026-08-10',
      institutions: institutions,
      created_by: '11111111-1111-1111-1111-111111111111',
    },
    {
      upload: async function () {
        throw new Error('should not upload');
      },
      insertSnapshot: async function (_sb, row) {
        calls.insertSnap += 1;
        return Object.assign({ created_at: '2026-09-03T00:00:00.000Z' }, row);
      },
      insertInstitutions: async function (_sb, rows) {
        calls.insertInst += 1;
        return rows.map(function (r, i) {
          return Object.assign({ id: 'inst-' + i, created_at: '2026-09-03T00:00:00.000Z' }, r);
        });
      },
    },
  );
  assert.strictEqual(created.ops_status, OPS_STATUS.RETRY_ELIGIBLE);
  assert.strictEqual(created.worst_bcu, '2A');
  assert.strictEqual(created.ci, ci);
  assert.strictEqual(created.source, 'manual');
  assert.strictEqual(created.institutions[0].sort_order, 0);
  assert.strictEqual(created.institutions[1].sort_order, 1);
  assert.strictEqual(calls.insertSnap, 1);
  assert.strictEqual(calls.insertInst, 1);

  const reconBody = await persistRejectedBcuSnapshot(
    {
      snapshotId: snapId,
      ci: ci,
      period_label: 'Ago',
      consulted_on: '2026-08-10',
      institutions: parseInstitutionsInput([{ institution_name: 'X', category: '3' }]),
      created_by: null,
    },
    {
      insertSnapshot: async function (_sb, row) {
        return Object.assign({ created_at: '2026-09-03T00:00:00.000Z' }, row);
      },
      insertInstitutions: async function (_sb, rows) {
        return rows.map(function (r) {
          return Object.assign({ id: 'i', created_at: 't' }, r);
        });
      },
    },
  );
  assert.strictEqual(reconBody.ops_status, OPS_STATUS.RECONSULTABLE);

  await persistRejectedBcuSnapshot(
    {
      snapshotId: snapId,
      ci: ci,
      period_label: 'Ago',
      consulted_on: '2026-08-10',
      institutions: parseInstitutionsInput([
        {
          institution_name: 'X',
          category: '5',
          castigado_mn: 1,
        },
      ]),
      created_by: null,
    },
    {
      insertSnapshot: async function (_sb, row) {
        return Object.assign({ created_at: 't' }, row);
      },
      insertInstitutions: async function (_sb, rows) {
        return rows.map(function (r) {
          return Object.assign({ id: 'i', created_at: 't' }, r);
        });
      },
    },
  ).then(function (body) {
    assert.strictEqual(body.ops_status, OPS_STATUS.NO_AUTO_RECONSULT);
  });

  const undefBody = await persistRejectedBcuSnapshot(
    {
      snapshotId: snapId,
      ci: ci,
      period_label: 'Ago',
      consulted_on: '2026-08-10',
      institutions: parseInstitutionsInput([{ institution_name: 'X', category: '5' }]),
      created_by: null,
    },
    {
      insertSnapshot: async function (_sb, row) {
        return Object.assign({ created_at: 't' }, row);
      },
      insertInstitutions: async function (_sb, rows) {
        return rows.map(function (r) {
          return Object.assign({ id: 'i', created_at: 't' }, r);
        });
      },
    },
  );
  assert.strictEqual(undefBody.ops_status, OPS_STATUS.UNDEFINED_CASE);

  let uploadCalls = 0;
  let snapWrites = 0;
  try {
    await persistRejectedBcuSnapshot(
      {
        snapshotId: snapId,
        fileObjectId: objId,
        ci: ci,
        period_label: 'Ago',
        consulted_on: '2026-08-10',
        institutions: institutions,
        created_by: null,
        fileMeta: jpegOk,
      },
      {
        upload: async function () {
          uploadCalls += 1;
          throw Object.assign(new Error('Error interno'), { statusCode: 500 });
        },
        insertSnapshot: async function () {
          snapWrites += 1;
          throw new Error('should not write snapshot');
        },
        insertInstitutions: async function () {
          throw new Error('should not write institutions');
        },
      },
    );
    assert.fail('expected storage failure');
  } catch (err) {
    assert.strictEqual(err.statusCode, 500);
  }
  assert.strictEqual(uploadCalls, 1);
  assert.strictEqual(snapWrites, 0);

  const logs = [];
  const fakeLog = {
    error: function (msg, meta) {
      logs.push({ msg: msg, meta: meta });
    },
  };

  let removed = [];
  try {
    await persistRejectedBcuSnapshot(
      {
        snapshotId: snapId,
        fileObjectId: objId,
        ci: ci,
        period_label: 'Ago',
        consulted_on: '2026-08-10',
        institutions: institutions,
        created_by: null,
        fileMeta: jpegOk,
      },
      {
        logger: fakeLog,
        upload: async function (opts) {
          const p = buildRejectedBcuObjectPath(
            opts.snapshotId,
            opts.objectId,
            opts.ext,
          );
          assert.strictEqual(pathContainsCi(p, ci), false);
          return p;
        },
        insertSnapshot: async function () {
          throw Object.assign(new Error('Error interno'), { statusCode: 500 });
        },
        insertInstitutions: async function () {
          throw new Error('should not insert institutions');
        },
        remove: async function (path) {
          removed.push(path);
        },
      },
    );
    assert.fail('expected snapshot insert failure');
  } catch (err) {
    assert.strictEqual(err.statusCode, 500);
  }
  assert.deepStrictEqual(removed, [snapId + '/' + objId + '.jpg']);

  removed = [];
  let deleted = [];
  try {
    await persistRejectedBcuSnapshot(
      {
        snapshotId: snapId,
        fileObjectId: objId,
        ci: ci,
        period_label: 'Ago',
        consulted_on: '2026-08-10',
        institutions: institutions,
        created_by: null,
        fileMeta: jpegOk,
      },
      {
        logger: fakeLog,
        upload: async function (opts) {
          return buildRejectedBcuObjectPath(
            opts.snapshotId,
            opts.objectId,
            opts.ext,
          );
        },
        insertSnapshot: async function (_sb, row) {
          return Object.assign({ created_at: 't' }, row);
        },
        insertInstitutions: async function () {
          throw Object.assign(new Error('Error interno'), { statusCode: 500 });
        },
        deleteSnapshot: async function (_sb, id) {
          deleted.push(id);
        },
        remove: async function (path) {
          removed.push(path);
        },
      },
    );
    assert.fail('expected institutions failure');
  } catch (err) {
    assert.strictEqual(err.statusCode, 500);
  }
  assert.deepStrictEqual(deleted, [snapId]);
  assert.deepStrictEqual(removed, [snapId + '/' + objId + '.jpg']);

  const cleanupLogs = [];
  try {
    await persistRejectedBcuSnapshot(
      {
        snapshotId: snapId,
        fileObjectId: objId,
        ci: ci,
        period_label: 'Ago',
        consulted_on: '2026-08-10',
        institutions: institutions,
        created_by: null,
        fileMeta: jpegOk,
      },
      {
        logger: {
          error: function (msg, meta) {
            cleanupLogs.push({ msg: msg, meta: meta });
          },
        },
        upload: async function (opts) {
          return buildRejectedBcuObjectPath(
            opts.snapshotId,
            opts.objectId,
            opts.ext,
          );
        },
        insertSnapshot: async function (_sb, row) {
          return Object.assign({ created_at: 't' }, row);
        },
        insertInstitutions: async function () {
          throw Object.assign(new Error('Error interno'), { statusCode: 500 });
        },
        deleteSnapshot: async function () {
          throw new Error('db cleanup boom');
        },
        remove: async function () {
          throw new Error('storage cleanup boom');
        },
      },
    );
    assert.fail('expected institutions failure');
  } catch (err) {
    assert.strictEqual(err.statusCode, 500);
  }
  const msgs = cleanupLogs.map(function (l) {
    return l.msg;
  });
  assert.ok(
    msgs.indexOf('rejected BCU snapshot cleanup failed') !== -1,
    String(msgs),
  );
  assert.ok(
    msgs.indexOf('rejected BCU storage cleanup failed') !== -1,
    String(msgs),
  );
}

runPersistTests()
  .then(function () {
    console.log('OK unit-rechazados-bcu-write');
  })
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  });
