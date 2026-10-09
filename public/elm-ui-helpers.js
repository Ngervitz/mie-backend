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
    elm_solicitud_not_found: 'Solicitud no encontrada en el funnel CZ.',
    elm_process_not_found: 'La solicitud no tiene proceso ELM para reintentar.',
    elm_retry_stale: 'El proceso ELM cambió desde que se cargó la pantalla: actualizá e intentá de nuevo.',
    elm_retry_not_pre_reception:
      'No se puede reintentar: no está probado que ELM no haya recibido la solicitud.',
    elm_retry_attempts_exhausted: 'Se agotaron los intentos técnicos de esta solicitud.',
    elm_retry_not_allowed: 'Reintento ELM no permitido para este proceso.',
  };
  var CI_HOLD_REASONS = [
    'elm_ci_active',
    'elm_ci_send_in_progress',
    'elm_ci_history_unverifiable',
    'elm_ci_recent_send',
    'elm_ci_monthly_quota_used',
    'elm_ci_lock_blocked',
  ];
  var DISABLED_REASONS = ['elm_client_disabled', 'elm_send_disabled', 'elm_transport_not_implemented'];
  var CONFIG_PENDING_LABELS = {
    elm_activity_type_mapping_missing: 'mapeo de actividad',
    elm_date_of_birth_format_unconfirmed: 'formato de fecha de nacimiento',
    elm_mobilephone_format_unconfirmed: 'formato de celular',
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
      parts.push(BLOCKED_MESSAGES[cell.action.reason] || cell.action.reason);
    }
    return parts.length ? ' title="' + esc(parts.join(' · ')) + '"' : '';
  }

  /**
   * Short tooltip for a disabled "Enviar a ELM" (action computed server-side).
   * @param {{ reason?: string, reasons?: string[], hint?: string }|null|undefined} action
   * @returns {string}
   */
  function sendBlockedHint(action) {
    var a = action || {};
    var reasons = Array.isArray(a.reasons) && a.reasons.length ? a.reasons : a.reason ? [a.reason] : [];
    for (var h = 0; h < CI_HOLD_REASONS.length; h += 1) {
      if (reasons.indexOf(CI_HOLD_REASONS[h]) >= 0) return ciHoldText(CI_HOLD_REASONS[h], a.hold || a);
    }
    for (var i = 0; i < reasons.length; i += 1) {
      if (DISABLED_REASONS.indexOf(reasons[i]) >= 0) {
        return 'Envío a ELM deshabilitado: la integración no está activada.';
      }
    }
    if (reasons.indexOf('elm_transport_config_incomplete') >= 0) {
      return 'Configuración ELM incompleta: faltan credenciales o URLs.';
    }
    var pending = [];
    for (var j = 0; j < reasons.length; j += 1) {
      if (CONFIG_PENDING_LABELS[reasons[j]]) pending.push(CONFIG_PENDING_LABELS[reasons[j]]);
    }
    if (pending.length) return 'Configuración ELM pendiente: ' + pending.join(', ') + '.';
    for (var k = 0; k < reasons.length; k += 1) {
      if (BLOCKED_MESSAGES[reasons[k]]) return BLOCKED_MESSAGES[reasons[k]];
    }
    return a.hint || SEND_PENDING_HINT;
  }

  /** "2026-09-12T10:00:00" → "12/09/2026" (source date as stored, no timezone shift). */
  function shortDate(raw) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  /**
   * Why a new solicitud of the CI cannot be sent (rejectedElmResendGuard hold, or the DB CI lock).
   * @param {string} reason
   * @param {{ related_cz_solicitud_id?: number|null, until?: string|null }} [hold]
   */
  function ciHoldText(reason, hold) {
    var h = hold || {};
    var rel = Number(h.related_cz_solicitud_id) > 0 ? ' (sol. ' + Number(h.related_cz_solicitud_id) + ')' : '';
    var until = shortDate(h.until);
    switch (reason) {
      case 'elm_ci_active':
        if (h.retry_pending === true) {
          return (
            'La solicitud' +
            (rel ? ' ' + Number(h.related_cz_solicitud_id) : '') +
            ' tuvo un error técnico antes de que ELM la recibiera: corresponde «Reintentar ELM», no un envío nuevo. ' +
            'Mientras tanto no se puede enviar otra solicitud de esta CI.'
          );
        }
        return 'Hay un proceso ELM vigente para esta CI' + rel + '.';
      case 'elm_ci_send_in_progress':
        return 'Hay un envío ELM en curso para esta CI' + rel + '.';
      case 'elm_ci_recent_send':
        return (
          'ELM no admite otro envío de esta CI dentro de los 30 días del anterior' +
          rel +
          (until ? '; disponible desde el ' + until : '') +
          '.'
        );
      case 'elm_ci_monthly_quota_used':
        return 'La CI ya tuvo un envío ELM este mes' + rel + (until ? '; disponible desde el ' + until : '') + '.';
      case 'elm_ci_history_unverifiable':
        return 'No se pudo verificar el historial ELM de la CI: envío bloqueado.';
      default:
        return BLOCKED_MESSAGES[reason] || 'Envío a ELM bloqueado para esta CI.';
    }
  }

  function sendButtonHtml(czId, opts) {
    var o = opts || {};
    var attrs = ' data-action="elm-send" data-cz-id="' + esc(czId) + '"';
    if (o.ci) attrs += ' data-ci="' + esc(o.ci) + '"';
    var date = shortDate(o.rejectedAt);
    if (date) attrs += ' data-rejected-at="' + esc(date) + '"';
    var title = 'Enviar la solicitud ' + czId + (date ? ' (rechazada ' + date + ')' : '') + ' a ELM';
    return (
      '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send' +
      (o.extraClass ? ' ' + o.extraClass : '') +
      '"' +
      attrs +
      ' title="' +
      esc(title) +
      '">Enviar a ELM</button>'
    );
  }

  function disabledSendButtonHtml(title, extraClass) {
    return (
      '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send' +
      (extraClass ? ' ' + extraClass : '') +
      '" disabled aria-disabled="true" title="' +
      esc(title) +
      '">Enviar a ELM</button>'
    );
  }

  /**
   * "Enviar a ELM" is clickable (data-action="elm-send") only when the server enabled it
   * (send readiness + eligibility + no active ELM process for the CI); otherwise disabled.
   * @param {object|null|undefined} cell
   * @param {{ ci?: number|string, rejectedAt?: string }} [opts]
   * @returns {string}
   */
  function elmCellHtml(cell, opts) {
    if (!cell) return '<span class="preaprobados-elm is-unavailable">—</span>';
    var action = cell.action || {};
    if (action.show === true) {
      var czId = Number(cell.cz_solicitud_id);
      if (action.enabled === true && czId > 0) {
        return sendButtonHtml(czId, opts);
      }
      return disabledSendButtonHtml(sendBlockedHint(action));
    }
    var kind = /^[a-z0-9_]+$/.test(String(cell.kind || '')) ? String(cell.kind) : 'unknown';
    var label =
      '<span class="preaprobados-elm is-' +
      kind +
      (cell.granted_elm === true ? ' is-granted' : '') +
      '"' +
      cellTitle(cell) +
      '>' +
      esc(cellLabel(cell)) +
      '</span>';
    var o = opts || {};
    if (cell.retry && cell.retry.show === true && o.retryCi != null) {
      var retry = Object.assign({ cz_solicitud_id: cell.cz_solicitud_id }, cell.retry);
      return '<div class="rechazados-elm-stack">' + label + retryButtonHtml(retry, o.retryCi) + '</div>';
    }
    return label;
  }

  /**
   * Rechazados list send control (`elm.send` from the server). One sendable solicitud: button
   * bound to it, with the solicitud number shown. Several: a picker and a button that stays
   * disabled until one is chosen (the dashboard binds data-cz-id on change). None sendable:
   * disabled button with the reason as tooltip.
   */
  function rejectedSendHtml(ci, send) {
    if (!send || send.available !== true) return '<span class="preaprobados-elm is-unavailable">—</span>';
    var candidates = Array.isArray(send.candidates) ? send.candidates : [];
    if (!candidates.length) {
      if (send.not_sendable) {
        var reason = send.not_sendable.reason;
        return (
          '<span class="preaprobados-elm is-not_sendable" title="' +
          esc('Solicitud ' + send.not_sendable.cz_solicitud_id + ' · ' + (BLOCKED_MESSAGES[reason] || reason || 'No enviable')) +
          '">No enviable</span>'
        );
      }
      return '<span class="preaprobados-elm is-none">—</span>';
    }
    var enabled = candidates.filter(function (c) {
      return c.enabled === true;
    });
    if (!enabled.length) {
      var first = candidates[0];
      return disabledSendButtonHtml(
        sendBlockedHint({ reasons: first.reasons, reason: first.reason, hint: first.hint, hold: send.hold || { until: first.until } }),
        'rechazados-elm-send',
      );
    }
    var targetId = Number(send.target_cz_id);
    if (send.needs_selection !== true && enabled.length === 1 && targetId === Number(enabled[0].cz_solicitud_id)) {
      return (
        '<div class="rechazados-elm-action">' +
        sendButtonHtml(targetId, { ci: ci, rejectedAt: enabled[0].rejected_at, extraClass: 'rechazados-elm-send' }) +
        '<span class="rechazados-elm-target">Sol. ' +
        esc(targetId) +
        '</span></div>'
      );
    }
    var options = enabled
      .map(function (c) {
        var id = Number(c.cz_solicitud_id);
        var date = shortDate(c.rejected_at);
        return (
          '<option value="' +
          esc(id) +
          '" data-rejected-at="' +
          esc(date) +
          '">Sol. ' +
          esc(id) +
          (date ? ' · ' + esc(date) : '') +
          '</option>'
        );
      })
      .join('');
    return (
      '<div class="rechazados-elm-action is-pick">' +
      '<select class="rechazados-elm-pick" data-elm-pick="1" data-ci="' +
      esc(ci) +
      '" aria-label="Solicitud a enviar a ELM" title="' +
      esc(enabled.length + ' solicitudes enviables: elegí cuál enviar') +
      '"><option value="">Elegir sol. (' +
      enabled.length +
      ')</option>' +
      options +
      '</select>' +
      '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send rechazados-elm-send" data-action="elm-send" data-ci="' +
      esc(ci) +
      '" data-needs-pick="1" disabled aria-disabled="true" title="Elegí primero la solicitud a enviar">Enviar a ELM</button>' +
      '</div>'
    );
  }

  /**
   * "Reintentar ELM" for a solicitud whose S1 failed before ELM received the lead. Clickable
   * (data-action="elm-retry") only when the server enabled it.
   */
  function retryButtonHtml(candidate, ci) {
    var c = candidate || {};
    var czId = Number(c.cz_solicitud_id);
    var expected = Number(c.expected_attempts);
    if (c.enabled === true && czId > 0 && expected > 0 && ci != null) {
      return (
        '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send rechazados-elm-retry"' +
        ' data-action="elm-retry" data-ci="' +
        esc(ci) +
        '" data-cz-id="' +
        esc(czId) +
        '" data-expected-attempts="' +
        esc(expected) +
        '" title="' +
        esc('Reintentar el envío a ELM de la solicitud ' + czId + ' (intento ' + (expected + 1) + ')') +
        '">Reintentar ELM</button>'
      );
    }
    return (
      '<button type="button" class="btn preaprobados-cell-btn preaprobados-elm-send rechazados-elm-retry"' +
      ' disabled aria-disabled="true" title="' +
      esc(sendBlockedHint({ reasons: c.reasons, reason: c.reason, hint: c.hint, hold: c.hold })) +
      '">Reintentar ELM</button>'
    );
  }

  /** Rechazados: "Reintentar ELM" controls (`elm.send.retry_candidates`), '' when none. */
  function rejectedRetryHtml(ci, send) {
    var list = send && send.available === true && Array.isArray(send.retry_candidates) ? send.retry_candidates : [];
    if (!list.length) return '';
    return list
      .map(function (c) {
        return (
          '<div class="rechazados-elm-action">' +
          retryButtonHtml(c, ci) +
          '<span class="rechazados-elm-target">Sol. ' +
          esc(Number(c.cz_solicitud_id)) +
          '</span></div>'
        );
      })
      .join('');
  }

  function historyHtml(elm) {
    if (elm.cell) return elmCellHtml(elm.cell);
    var other = elm.other_processes && elm.other_processes[0];
    if (!other) return '';
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

  /**
   * Rechazados list: ELM history of the CI (the row's solicitud, else another one) and, when a
   * rejected solicitud without its own process exists, the send control under it (enabled or
   * disabled with the reason, decided server-side).
   */
  function rejectedRowElmHtml(elm, ci) {
    if (!elm || elm.available !== true) {
      return '<span class="preaprobados-elm is-unavailable">—</span>';
    }
    var history = historyHtml(elm);
    var send = elm.send;
    var offered = send && send.available === true && Array.isArray(send.candidates) && send.candidates.length > 0;
    var retry = ci != null ? rejectedRetryHtml(ci, send) : '';
    if (history) {
      if ((!offered || ci == null) && !retry) return history;
      return (
        '<div class="rechazados-elm-stack">' +
        history +
        retry +
        (offered && ci != null ? rejectedSendHtml(ci, send) : '') +
        '</div>'
      );
    }
    if (retry) {
      return '<div class="rechazados-elm-stack">' + retry + (offered ? rejectedSendHtml(ci, send) : '') + '</div>';
    }
    if (send && ci != null) return rejectedSendHtml(ci, send);
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
        if (CI_HOLD_REASONS.indexOf(code) >= 0) {
          return { tone: 'warn', text: 'No se envió a ELM. ' + ciHoldText(code, b) };
        }
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
    sendBlockedHint: sendBlockedHint,
    ciHoldText: ciHoldText,
    shortDate: shortDate,
    elmCellHtml: elmCellHtml,
    rejectedSendHtml: rejectedSendHtml,
    retryButtonHtml: retryButtonHtml,
    rejectedRetryHtml: rejectedRetryHtml,
    rejectedRowElmHtml: rejectedRowElmHtml,
    sendResultMessage: sendResultMessage,
  };
});
