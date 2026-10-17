'use strict';

/**
 * Frontend-only: API returns send_elm + viewer_may_send_elm but row gate must still paint the button.
 * Run: node scripts/unit-gestion-elm-row-send-render.js
 */

const assert = require('assert');
const { classifyOpportunity } = require('../src/services/elmOps/opportunityClassify');
const ElmOpsUi = require('../public/elm-ops.js');

const CZ = 1912;
const fmt = ElmOpsUi.defaultFmtDate;

function itemWithSend() {
  const item = classifyOpportunity({
    cz_solicitud_id: CZ,
    ci: '18165244',
    s1_status: 'eligible',
    s2_status: 'unknown',
    reason_code: 'elm_s2_unknown',
    since: '2026-10-05T12:00:00Z',
  });
  item.allowed_actions = [
    {
      id: 'send_elm',
      label: 'Enviar a ELM',
      enabled: true,
      explanation: 'Reenvío completo S1+S2',
    },
  ];
  return item;
}

async function run(name, fn) {
  await fn();
  console.log('ok — ' + name);
}

(async function main() {
  await run('gestionSendRowAllowed: viewer flag without canAct', async function () {
    assert.strictEqual(
      ElmOpsUi.gestionSendRowAllowed({ viewerMaySendElm: true, canAct: false }),
      true,
    );
    assert.strictEqual(
      ElmOpsUi.gestionSendRowAllowed({ viewerMaySendElm: false, canAct: false }),
      false,
    );
  });

  await run('opportunityRowHtml: send button when viewerMaySendElm only', async function () {
    const html = ElmOpsUi.opportunityRowHtml(itemWithSend(), fmt, null, {
      tableMode: 'gestion',
      canAct: false,
      viewerMaySendElm: true,
      dashboardIsAdmin: false,
    });
    assert.ok(
      html.includes('data-elm-ops-send-open="' + CZ + '"'),
      'expected row send button in DOM html',
    );
  });

  await run('opportunityRowHtml: no button when all gates false', async function () {
    const html = ElmOpsUi.opportunityRowHtml(itemWithSend(), fmt, null, {
      tableMode: 'gestion',
      canAct: false,
      viewerMaySendElm: false,
      dashboardIsAdmin: false,
    });
    assert.ok(!html.includes('data-elm-ops-send-open'), 'must not render send control');
  });

  await run('mount: API viewer_may_send_elm + send_elm, canAct stays false → button visible', async function () {
    const item = itemWithSend();
    const fetchFn = async function (url, opts) {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      if (u.includes('/preaprobados/elm-ops/assignees')) {
        return { status: 403, json: async function () { return { ok: false }; } };
      }
      if (u.includes('/api/auth/me')) {
        return { status: 401, json: async function () { return {}; } };
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
                { id: 'followup', label: 'Seguimiento' },
              ],
            };
          },
        };
      }
      return { status: 404, json: async function () { return {}; } };
    };

    const root = { innerHTML: '', addEventListener: function () {} };
    const desk = ElmOpsUi.mount({ root: root, api: '', fetch: fetchFn, canAct: false });
    await desk.load();
    assert.ok(
      root.innerHTML.includes('data-elm-ops-send-open="' + CZ + '"'),
      'mount must paint send button from viewer_may_send_elm alone',
    );

    desk.syncAdminAccess(false);
    assert.ok(
      root.innerHTML.includes('data-elm-ops-send-open="' + CZ + '"'),
      'syncAdminAccess(false) must not hide send when viewer_may_send_elm was true',
    );
  });

  console.log('unit-gestion-elm-row-send-render: all passed');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
