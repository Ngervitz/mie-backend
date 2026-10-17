'use strict';

/**
 * Gestión ELM «Enviar a ELM» modal markup + CSS contract (no live send).
 * Run: node scripts/unit-gestion-elm-send-modal.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ElmOpsUi = require('../public/elm-ops.js');

const CZ = 1912;
const fmt = ElmOpsUi.defaultFmtDate;

function previewBlocked() {
  return {
    status: 'preview',
    cz_solicitud_id: CZ,
    ci: '18165244',
    can_send: false,
    code: 'recent_send',
    intended_mode: 'admin_provider_resend',
    s1_status: 'eligible',
    s2_status: 'unknown',
    duplicate_warning: 'ELM puede tratar este envío como duplicado.',
    warnings: ['Reenvío completo autorizado por ELM: S1+S2.'],
    requires_provider_reference: true,
  };
}

function previewAllowed() {
  return Object.assign({}, previewBlocked(), {
    can_send: true,
    code: null,
    expected_updated_at: '2026-10-16T14:00:00.000Z',
  });
}

function itemRow() {
  return {
    cz_solicitud_id: CZ,
    ci: '18165244',
    vintage_label: 'Histórico',
    lane_label: 'Atención',
    situation_label: 'Completar envío',
    reason_label: 'S2 incierto',
    since: '2026-10-05T12:00:00Z',
    age_hours: 200,
    last_elm: '—',
    next_step: 'Reenvío S1+S2',
    next_step_key: 'admin_provider_resend',
    allowed_actions: [
      {
        id: 'send_elm',
        label: 'Enviar a ELM',
        enabled: true,
        explanation: 'Reenvío completo',
      },
    ],
    technical: {},
  };
}

(async function main() {
  const css = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.css'), 'utf8');
  assert.ok(css.includes('.elm-ops-send-modal-backdrop'), 'modal backdrop rule');
  assert.ok(/\.elm-ops-send-modal[\s\S]{0,120}max-width:\s*650px/.test(css), 'modal max-width 650px');

  const modalBlocked = ElmOpsUi.gestionSendModalHtml(previewBlocked(), CZ, false);
  assert.ok(modalBlocked.includes('elm-ops-send-modal-backdrop'));
  assert.ok(modalBlocked.includes('data-elm-ops-send-modal'));
  assert.ok(modalBlocked.includes('role="dialog"'));
  assert.ok(modalBlocked.includes('elm-ops-send-blocked'));
  assert.ok(!modalBlocked.includes('data-elm-ops-form="send-to-elm"'));
  assert.ok(!modalBlocked.includes('Confirmar envío'));
  assert.ok(modalBlocked.includes('18165244'));
  assert.ok(modalBlocked.includes('duplicado'));
  assert.ok(modalBlocked.includes(ElmOpsUi.gestionSendModeLabel(previewBlocked())));

  const form = ElmOpsUi.gestionSendFormHtml(previewAllowed(), CZ);
  assert.ok(form.includes('data-elm-ops-form="send-to-elm"'));
  assert.ok(form.includes('Confirmar envío'));
  assert.ok(form.includes('confirm_duplicate'));

  const row = ElmOpsUi.opportunityRowHtml(itemRow(), fmt, null, {
    tableMode: 'gestion',
    canAct: true,
    viewerMaySendElm: true,
  });
  assert.ok(row.includes('data-elm-ops-send-open="' + CZ + '"'));
  assert.ok(!row.includes('elm-ops-send-form'));
  assert.ok(!row.includes('elm-ops-send-modal'));
  assert.ok(!row.includes('send-to-elm'));

  console.log('unit-gestion-elm-send-modal: all passed');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
