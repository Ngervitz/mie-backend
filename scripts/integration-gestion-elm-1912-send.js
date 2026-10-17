'use strict';

/**
 * Reproduces Gestión ELM CZ 1912 / CI 18165244: admin must see «Enviar a ELM» on the row,
 * blocked preview (no POST), full S1+S2 intent — not «Reenviar paso 2» alone.
 *
 * Run: node scripts/integration-gestion-elm-1912-send.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const { S1, S2 } = require('../src/services/elm/constants');
const { HOLD } = require('../src/lib/rejectedElmResendGuard');
const { classifyOpportunity } = require('../src/services/elmOps/opportunityClassify');
const {
  applyGestionSendDisplay,
  SEND_NEXT_BY_MODE,
} = require('../src/services/elmOps/gestionSendDisplay');
const { SEND_MODES, sendRowActionFromPlan } = require('../src/services/elmOps/gestionElmSendPlan');
const { createElmOpsRouter } = require('../src/routes/elmOps');
const ElmOpsUi = require('../public/elm-ops.js');

const CZ = 1912;
const CI = '18165244';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function item1912Base() {
  const item = classifyOpportunity({
    cz_solicitud_id: CZ,
    ci: CI,
    s1_status: S1.ELIGIBLE,
    s2_status: S2.UNKNOWN,
    reason_code: 'elm_s2_unknown',
    since: '2026-10-05T12:00:00Z',
    age_hours: 264,
    process_id: '11111111-1111-4111-8111-111111111111',
  });
  return item;
}

function preview1912Blocked() {
  return {
    status: 'preview',
    cz_solicitud_id: CZ,
    ci: CI,
    can_send: false,
    code: HOLD.RECENT_SEND,
    mode: null,
    intended_mode: SEND_MODES.ADMIN_PROVIDER_RESEND,
    s1_status: S1.ELIGIBLE,
    s2_status: S2.UNKNOWN,
    duplicate_warning:
      'ELM puede tratar este envío como duplicado si la misma persona recibió otro lead recientemente.',
    warnings: [
      'Reenvío completo autorizado por ELM: se archiva el ciclo anterior en el mismo proceso ' +
        'y se reserva un único cupo CI antes de S1+S2. Requiere referencia ELM al confirmar.',
    ],
    hold: { reason: HOLD.RECENT_SEND },
    requires_provider_reference: true,
    expected_updated_at: '2026-10-16T14:00:00.000Z',
  };
}

async function startGestionServer() {
  const item = item1912Base();
  applyGestionSendDisplay(item, preview1912Blocked());
  const service = {
    async gestion() {
      return {
        items: [item],
        situations: [{ id: 'complete_send', label: 'Completar envío a ELM' }],
        vintages: [{ id: 'historical', label: 'Pendiente histórico' }],
        lanes: [{ id: 'attention', label: 'Requiere gestión' }],
        tab_enabled: true,
        cutover_at: null,
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/preaprobados/elm-ops',
    createElmOpsRouter({
      service: service,
      resolveDashboardElmAdmin: async function () {
        return true;
      },
      requireAction: function (req, res, next) {
        req.elmActorUserId = ADMIN;
        next();
      },
      actions: {
        async getSendPreview() {
          return preview1912Blocked();
        },
      },
    }),
  );
  return new Promise(function (resolve) {
    const server = app.listen(0, '127.0.0.1', function () {
      resolve(server);
    });
  });
}

function httpGet(server, path) {
  return new Promise(function (resolve, reject) {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        path: path,
        headers: { Accept: 'application/json' },
      },
      function (res) {
        let buf = '';
        res.on('data', function (c) {
          buf += c;
        });
        res.on('end', function () {
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function run(name, fn) {
  await fn();
  console.log('ok — ' + name);
}

(async function main() {
  await run('classifier: S2 unknown → full resend copy (not retry S2 alone)', async function () {
    const item = item1912Base();
    assert.strictEqual(item.next_step_key, 'admin_provider_resend');
    assert.ok(item.next_step.includes('S1+S2'));
    assert.ok(!item.next_step.includes('Reenviar paso 2'));
  });

  await run('applyGestionSendDisplay: row send_elm disabled with intended_mode', async function () {
    const item = item1912Base();
    applyGestionSendDisplay(item, preview1912Blocked());
    const send = (item.allowed_actions || []).filter(function (a) {
      return a.id === 'send_elm';
    })[0];
    assert.ok(send, 'send_elm action on row');
    assert.strictEqual(send.enabled, false);
    assert.strictEqual(item.next_step_key, 'admin_provider_resend');
    const rowPlan = sendRowActionFromPlan(preview1912Blocked());
    assert.strictEqual(rowPlan.enabled, false);
    assert.ok(rowPlan.explanation.includes('S1+S2'));
  });

  await run('GET /gestion: viewer_may_send_elm + send_elm for admin', async function () {
    const server = await startGestionServer();
    try {
      const res = await httpGet(server, '/preaprobados/elm-ops/gestion');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.viewer_may_send_elm, true);
      const row = (res.body.items || []).filter(function (i) {
        return i.cz_solicitud_id === CZ;
      })[0];
      assert.ok(row);
      const send = (row.allowed_actions || []).filter(function (a) {
        return a.id === 'send_elm';
      })[0];
      assert.ok(send);
      assert.strictEqual(send.enabled, false);
    } finally {
      server.close();
    }
  });

  await run('UI: admin via viewer_may_send_elm, row button, blocked preview, no POST form', async function () {
    const calls = [];
    const preview = preview1912Blocked();
    const item = item1912Base();
    applyGestionSendDisplay(item, preview);
    item.allowed_actions = item.allowed_actions.concat([
      {
        id: 'retry_s1',
        label: 'Reintentar S1',
        explanation: 'Solo pre-recepción',
      },
    ]);

    const fetchFn = async function (url, opts) {
      const method = (opts && opts.method) || 'GET';
      calls.push({ method: method, url: String(url), body: opts && opts.body });
      const u = String(url);
      if (u.includes('/preaprobados/elm-ops/assignees')) {
        return { status: 403, json: async function () { return { ok: false }; } };
      }
      if (u.includes('/api/auth/me')) {
        return { status: 401, json: async function () { return {}; } };
      }
      if (u.includes('/preaprobados/elm-ops/gestion/' + CZ + '/send-preview')) {
        return { status: 200, json: async function () { return preview; } };
      }
      if (u.includes('/preaprobados/elm-ops/gestion') && method === 'GET') {
        return {
          status: 200,
          json: async function () {
            return {
              ok: true,
              viewer_may_send_elm: true,
              items: [item],
              situations: [{ id: 'complete_send', label: 'Completar envío a ELM' }],
              vintages: [{ id: 'historical', label: 'Pendiente histórico' }],
              lanes: [
                { id: 'attention', label: 'Requiere gestión' },
                { id: 'followup', label: 'Seguimiento (no es un error)' },
              ],
            };
          },
        };
      }
      if (u.includes('/send-to-elm')) {
        throw new Error('POST send-to-elm must not run in blocked preview test');
      }
      return { status: 404, json: async function () { return {}; } };
    };

    const listeners = [];
    const root = {
      innerHTML: '',
      addEventListener: function (type, fn) {
        listeners.push({ type: type, fn: fn });
      },
    };

    const desk = ElmOpsUi.mount({ root: root, api: '', fetch: fetchFn });
    await desk.load();

    assert.ok(
      root.innerHTML.includes('data-elm-ops-send-open="' + CZ + '"'),
      'row Enviar a ELM visible for admin',
    );
    assert.ok(root.innerHTML.includes('is-muted'), 'blocked send shows muted button');
    assert.ok(
      root.innerHTML.includes('data-elm-next="admin_provider_resend"'),
      'next step is full resend',
    );
    assert.ok(!root.innerHTML.includes('Reenviar paso 2'));

    const click = listeners.find(function (l) {
      return l.type === 'click';
    });
    assert.ok(click);
    click.fn({
      target: {
        closest: function (sel) {
          if (sel === '[data-elm-ops-send-open]') {
            return {
              getAttribute: function (name) {
                return name === 'data-elm-ops-send-open' ? String(CZ) : null;
              },
            };
          }
          return null;
        },
      },
    });
    await new Promise(function (r) {
      setTimeout(r, 0);
    });
    await new Promise(function (r) {
      setTimeout(r, 0);
    });

    assert.ok(root.innerHTML.includes('elm-ops-send-modal-backdrop'));
    assert.ok(root.innerHTML.includes('data-elm-ops-send-modal'));
    assert.ok(root.innerHTML.includes('elm-ops-send-blocked'));
    assert.ok(
      /Reenvío completo S1 \+ S2/i.test(root.innerHTML),
      'modal shows full S1+S2 send type',
    );
    assert.ok(root.innerHTML.includes('18165244'));
    assert.ok(root.innerHTML.includes('Envío bloqueado'));
    assert.ok(!root.innerHTML.includes('data-elm-ops-form="send-to-elm"'));
    assert.ok(!calls.some(function (c) { return c.method === 'POST'; }));

    const tableOnly = root.innerHTML.split('elm-ops-send-modal-backdrop')[0];
    assert.ok(!tableOnly.includes('elm-ops-send-blocked'), 'blocked preview must not live inside table markup');

    click.fn({
      target: {
        closest: function (sel) {
          if (sel === '[data-elm-ops-open-detail]') {
            return {
              getAttribute: function (name) {
                return name === 'data-elm-ops-open-detail' ? String(CZ) : null;
              },
            };
          }
          return null;
        },
      },
    });
    assert.ok(root.innerHTML.includes('data-elm-ops-admin-slot'));
    assert.ok(root.innerHTML.includes('Reintentar S1'));
  });

  await run('SEND_NEXT_BY_MODE labels match Gestión copy', async function () {
    assert.ok(SEND_NEXT_BY_MODE[SEND_MODES.ADMIN_PROVIDER_RESEND].next_step.includes('S1+S2'));
  });

  console.log('integration-gestion-elm-1912-send: all passed');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
