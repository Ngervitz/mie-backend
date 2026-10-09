'use strict';

/**
 * Pure ELM UI helpers (browser + Node unit tests). No DOM / no fetch.
 * Renders the ELM cell computed server-side (src/services/elm/listView.js).
 * GRANTED CDV and GRANTED ELM are separate sources and are never merged here.
 * "Preaprobado ELM" (S2 referred) is never presented as a granted loan.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ElmUiHelpers = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var SEND_PENDING_HINT = 'Integración ELM pendiente de habilitación';
  var CDV_GRANTED_LABEL = 'GRANTED CDV';
  var ELM_GRANTED_LABEL = 'Otorgado ELM';
  var ORIGIN_LABELS = {
    janus_manual: 'Manual (JANUS)',
    janus_batch: 'Lote (JANUS)',
    cz_automatic: 'Automático (CZ)',
  };
  var BLOCKED_MESSAGES = {
    elm_send_not_ready: 'Envío a ELM no habilitado: configuración ELM incompleta.',
    elm_send_disabled: 'Envío a ELM deshabilitado.',
    elm_client_disabled: 'Envío a ELM deshabilitado.',
    elm_process_exists: 'La solicitud ya fue enviada a ELM.',
    elm_ci_lock_blocked: 'Hay un proceso ELM vigente o reciente para esta CI.',
    elm_ci_active: 'Hay un proceso ELM vigente para esta CI.',
    elm_solicitud_not_in_rejections: 'La solicitud no figura entre los rechazos de esta CI.',
    elm_cdv_granted: 'La solicitud tiene un préstamo CDV otorgado.',
    elm_missing_required_fields: 'Faltan datos obligatorios de la solicitud.',
    elm_trigger_origin_not_enabled: 'Envío manual a ELM no habilitado.',
    elm_persist_failed: 'No se pudo guardar el resultado ELM; queda para revisión.',
  };

  function esc(raw) {
    return String(raw == null ? '' : raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cellLabel(cell) {
    if (!cell) return '—';
    if (cell.granted_elm === true) return ELM_GRANTED_LABEL;
    return cell.label ? String(cell.label) : '—';
  }

  function originLabel(origin) {
    return ORIGIN_LABELS[origin] || (origin ? String(origin) : '—');
  }

  function cellTitle(cell) {
    var parts = [];
    if (cell.provider_status) parts.push('Estado ELM: ' + cell.provider_status);
    if (cell.trigger_origin) parts.push('Origen: ' + originLabel(cell.trigger_origin));
    if (cell.kind === 'not_sendable' && cell.action && cell.action.reason) {
      parts.push(cell.action.reason);
    }
    return parts.length ? ' title="' + esc(parts.join(' · ')) + '"' : '';
  }

  /**
   * "Enviar a ELM" is clickable (data-action="elm-send") only when the server enabled it
   * (send readiness + eligibility + no active ELM process for the CI); otherwise disabled.
   * @param {object|null|undefined} cell
   * @returns {string}
   */
  function elmCellHtml(cell) {
    if (!cell) return '<span class="preaprobados-elm is-unavailable">—</span>';
    var action = cell.action || {};
    if (action.show === true) {
      var czId = Number(cell.cz_solicitud_id);
      if (action.enabled === true && czId > 0) {
        return (
          '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send" data-action="elm-send" data-cz-id="' +
          esc(czId) +
          '">Enviar a ELM</button>'
        );
      }
      return (
        '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send" disabled aria-disabled="true" title="' +
        esc(action.hint || SEND_PENDING_HINT) +
        '">Enviar a ELM</button>'
      );
    }
    var kind = /^[a-z0-9_]+$/.test(String(cell.kind || '')) ? String(cell.kind) : 'unknown';
    return (
      '<span class="preaprobados-elm is-' +
      kind +
      (cell.granted_elm === true ? ' is-granted' : '') +
      '"' +
      cellTitle(cell) +
      '>' +
      esc(cellLabel(cell)) +
      '</span>'
    );
  }

  /** Rechazados list: ELM of the row's solicitud, else of another solicitud of the CI. */
  function rejectedRowElmHtml(elm) {
    if (!elm || elm.available !== true) {
      return '<span class="preaprobados-elm is-unavailable">—</span>';
    }
    if (elm.cell) return elmCellHtml(elm.cell);
    var other = elm.other_processes && elm.other_processes[0];
    if (other) {
      return (
        '<span class="preaprobados-elm is-' +
        esc(/^[a-z0-9_]+$/.test(String(other.state || '')) ? other.state : 'unknown') +
        ' is-other" title="' +
        esc('Solicitud ' + other.cz_solicitud_id + ' · ' + originLabel(other.trigger_origin)) +
        '">' +
        esc(other.label || '—') +
        ' (otra sol.)</span>'
      );
    }
    return '<span class="preaprobados-elm is-none">—</span>';
  }

  /**
   * Message for the POST /rechazados/:ci/elm/send answer.
   * @returns {{ tone: 'ok'|'warn'|'error', text: string }}
   */
  function sendResultMessage(body) {
    var b = body || {};
    var code = b.code ? String(b.code) : '';
    if (b.ok === false && b.outcome && b.outcome !== 'blocked') {
      return {
        tone: 'warn',
        text:
          'No se envió a ELM. ' +
          (BLOCKED_MESSAGES[code] || (code ? 'Código: ' + code + '.' : '')) +
          ' Estado actual: ' +
          cellLabel(b.cell) +
          '.',
      };
    }
    switch (b.outcome) {
      case 's1_rejected':
        return { tone: 'warn', text: 'ELM rechazó la solicitud en la evaluación inicial (S1). Queda como Rechazado ELM.' };
      case 'rejected':
        return { tone: 'warn', text: 'ELM rechazó la solicitud (Rechazado ELM).' };
      case 'referred':
        return {
          tone: 'ok',
          text: 'Preaprobado ELM: S1 favorable y derivado a ventas de ELM (S2). No es un préstamo otorgado.',
        };
      case 'granted':
        return { tone: 'ok', text: 'Otorgado ELM: ELM confirmó el desembolso.' };
      case 'pending':
        if (b.s2_blocked) {
          return {
            tone: 'warn',
            text:
              'S1 favorable; la derivación (S2) no se pudo iniciar' +
              (b.s2_blocked.code ? ' (' + b.s2_blocked.code + ')' : '') +
              '. Queda En evaluación ELM.',
          };
        }
        return { tone: 'warn', text: 'En evaluación ELM: resultado pendiente.' };
      case 'technical_error':
        return { tone: 'error', text: 'Error técnico ELM: queda pendiente de revisión (no es un rechazo).' };
      case 'review':
        return { tone: 'warn', text: 'Resultado ELM incierto: queda pendiente de revisión (no es un rechazo).' };
      case 'closed':
        return { tone: 'warn', text: 'Proceso ELM cerrado sin préstamo.' };
      default:
        return {
          tone: 'error',
          text: 'No se envió a ELM. ' + (BLOCKED_MESSAGES[code] || (code ? 'Código: ' + code : 'Error.')),
        };
    }
  }

  return {
    SEND_PENDING_HINT: SEND_PENDING_HINT,
    CDV_GRANTED_LABEL: CDV_GRANTED_LABEL,
    ELM_GRANTED_LABEL: ELM_GRANTED_LABEL,
    ORIGIN_LABELS: ORIGIN_LABELS,
    cellLabel: cellLabel,
    originLabel: originLabel,
    elmCellHtml: elmCellHtml,
    rejectedRowElmHtml: rejectedRowElmHtml,
    sendResultMessage: sendResultMessage,
  };
});
