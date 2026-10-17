'use strict';

const { SEND_MODES, sendRowActionFromPlan } = require('./gestionElmSendPlan');
const { SITUATIONS } = require('./opportunityClassify');

const SEND_NEXT_BY_MODE = Object.freeze({
  [SEND_MODES.ADMIN_PROVIDER_RESEND]: {
    next_step: 'Reenvío completo S1+S2 (autorizado ELM)',
    next_step_key: 'admin_provider_resend',
  },
  [SEND_MODES.RESUME_S2]: {
    next_step: 'Enviar paso 2 (después de corregir el celular)',
    next_step_key: 'resume_s2',
  },
  [SEND_MODES.RETRY_S2]: {
    next_step: 'Reenviar paso 2',
    next_step_key: 'retry_s2',
  },
});

function applyGestionSendDisplay(item, preview) {
  if (!item || !preview) return;
  const mode = preview.intended_mode || preview.mode || null;
  const labels = mode ? SEND_NEXT_BY_MODE[mode] : null;
  if (labels) {
    item.next_step = labels.next_step;
    item.next_step_key = labels.next_step_key;
  }
  const sendAct = sendRowActionFromPlan(preview);
  if (sendAct) {
    item.allowed_actions = (item.allowed_actions || []).filter(function (a) {
      return a.id !== 'send_elm';
    });
    item.allowed_actions.push(sendAct);
    item.send_preview = {
      can_send: preview.can_send === true,
      mode: preview.mode || null,
      intended_mode: preview.intended_mode || preview.mode || null,
      duplicate_warning: preview.duplicate_warning || null,
      code: preview.code || null,
    };
  }
}

function gestionSendRowEligible(item) {
  if (!item) return false;
  if (item.situation === SITUATIONS.COMPLETE_SEND || item.situation === SITUATIONS.RECOVERABLE) {
    return true;
  }
  const tech = item.technical || {};
  return !!(tech.process_id || tech.s1_status);
}

function attachFallbackSendRow(item) {
  if (!gestionSendRowEligible(item)) return;
  item.allowed_actions = (item.allowed_actions || []).filter(function (a) {
    return a.id !== 'send_elm';
  });
  item.allowed_actions.push({
    id: 'send_elm',
    label: 'Enviar a ELM',
    enabled: false,
    block_code: 'preview_unavailable',
    explanation: 'No se pudo evaluar el envío. Recargue o abra la confirmación.',
  });
}

module.exports = {
  applyGestionSendDisplay,
  attachFallbackSendRow,
  gestionSendRowEligible,
  SEND_NEXT_BY_MODE,
};
