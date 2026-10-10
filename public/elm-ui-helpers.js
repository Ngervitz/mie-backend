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
    elm_date_of_birth_invalid: 'Fecha de nacimiento inválida.',
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

  var OPS_RESOLUTION_LABELS = {
    provider_closed_no_loan: 'ELM cerró el caso sin préstamo',
    provider_loan_disbursed: 'ELM otorgó el préstamo',
    customer_withdrew: 'El cliente desistió',
    provider_confirmed_not_received: 'ELM confirmó que no recibió el lead',
    provider_confirmed_no_referral: 'ELM confirmó que no hubo derivación',
    other: 'Otro (ver nota en ELM Ops)',
  };

  /**
   * ELM's original answer (`elm_answer` of a cell or process summary). "Motivo ELM" for an open
   * rejection, "Resultado original ELM" once ELM Ops closed the process, "Respuesta ELM" otherwise.
   * `withStep` adds (S1)/(S2).
   * @param {{ elm_answer?: { step?: string, message?: string }|null, state?: string|null,
   *   ops_resolution?: object|null }|null|undefined} item
   * @param {boolean} [withStep]
   * @returns {string} plain text, '' when there is no answer
   */
  function elmAnswerText(item, withStep) {
    var answer = item && item.elm_answer;
    if (!answer || typeof answer.message !== 'string' || !answer.message) return '';
    var step = answer.step === 's1' || answer.step === 's2' ? answer.step.toUpperCase() : '';
    var prefix = item.ops_resolution
      ? 'Resultado original ELM'
      : item.state === 'rejected'
        ? 'Motivo ELM'
        : 'Respuesta ELM';
    return prefix + (withStep && step ? ' (' + step + ')' : '') + ': ' + answer.message;
  }

  /** Administrative closure from ELM Ops (`ops_resolution`), '' when there is none. */
  function opsResolutionText(item) {
    var r = item && item.ops_resolution;
    if (!r) return '';
    var code = r.code ? String(r.code) : '';
    var date = shortDate(r.resolved_at);
    return (
      'Resolución ELM Ops: ' +
      (OPS_RESOLUTION_LABELS[code] || code || 'sin código') +
      (date ? ' (' + date + ')' : '')
    );
  }

  /** 'full' (CI detail): ELM's answer with its step, then the ELM Ops resolution if any. */
  function elmAnswerHtml(item, mode) {
    if (mode !== 'full') return '';
    var parts = [];
    var text = elmAnswerText(item, true);
    if (text) parts.push('<span class="elm-answer" title="' + esc(text) + '">' + esc(text) + '</span>');
    var resolution = opsResolutionText(item);
    if (resolution) parts.push('<span class="elm-answer elm-ops-resolution">' + esc(resolution) + '</span>');
    return parts.join('');
  }

  var COMPACT_STATE_LABELS = {
    in_evaluation: 'En evaluación',
    referred: 'Aceptado',
    granted: 'Otorgado',
    rejected: 'Rechazado',
    review: 'En revisión',
    closed: 'Cerrado',
  };
  var COMPACT_DETAIL_LABELS = {
    s1_unknown: 'Incierto',
    s2_unknown: 'Incierto',
    s1_rejection_not_definitive: 'Incierto',
    s2_rejection_not_definitive: 'Incierto',
    s1_technical_error: 'Error técnico',
    s2_technical_error: 'Error técnico',
    s1_duplicate_other_channel: 'Duplicado · Otro canal',
    cz_already_referred: 'Derivado en otra sol.',
    post_referral_status: 'Rechazado · Tras derivación',
    ops_closed_no_loan: 'Rechazado · Sin préstamo',
    ops_customer_withdrew: 'Cerrado · Desistió',
    ops_provider_confirmed_not_received: 'Cerrado · No recibido',
    ops_provider_confirmed_no_referral: 'Cerrado · Sin derivación',
    ops_other: 'Cerrado · Ver nota',
  };

  /**
   * Visible reason: ELM's answer without a bare "Rechazado" the state already says
   * ("Repetido. Rechazado" → "Repetido"); every other sentence is kept
   * ("Repetido. Aprobado" stays "Repetido. Aprobado"). The original text stays in the data,
   * the tooltip and the CI detail.
   */
  function compactReason(message) {
    var parts = String(message || '')
      .split(/[.;]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s && !/^rechazad[oa]$/i.test(s);
      });
    return parts.join('. ');
  }

  /**
   * One-line Rechazados label: "Rechazado · Repetido", "Incierto · Repetido", "Aceptado".
   * Cells without an ELM process keep their label ("Sin enviar", "No enviable", …).
   */
  function compactCellText(item) {
    if (!item) return '—';
    if (item.granted_elm === true) return COMPACT_STATE_LABELS.granted;
    var base = COMPACT_DETAIL_LABELS[item.detail] || COMPACT_STATE_LABELS[item.state];
    if (!base) return cellLabel(item);
    var reason =
      item.ops_resolution || base.indexOf(' · ') >= 0 ? '' : compactReason(item.elm_answer && item.elm_answer.message);
    return reason ? base + ' · ' + reason : base;
  }

  function cellTitleParts(cell) {
    var parts = [];
    if (cell.provider_status) parts.push('Estado ELM: ' + cell.provider_status);
    if (cell.trigger_origin) parts.push('Origen: ' + originLabel(cell.trigger_origin));
    if (cell.kind === 'not_sendable' && cell.action && cell.action.reason) {
      parts.push(BLOCKED_MESSAGES[cell.action.reason] || cell.action.reason);
    }
    return parts;
  }

  function titleAttr(parts) {
    return parts.length ? ' title="' + esc(parts.join(' · ')) + '"' : '';
  }

  /** Tooltip of a compact label: full ELM label and original answer, then the usual details. */
  function compactTitleParts(item) {
    var parts = [cellLabel(item)];
    var answer = elmAnswerText(item, true);
    if (answer) parts.push(answer);
    return parts;
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

  /** Rechazados picker button once a solicitud is chosen (the picker row has no "Sol. N" of its own). */
  function rejectedSendLabel(czId) {
    return 'Enviar sol. ' + Number(czId);
  }

  /** Rechazados picker button while no solicitud is chosen (disabled). */
  var REJECTED_PICK_LABEL = 'Seleccionar solicitud';

  /**
   * One row of the Rechazados ELM grid: "Sol. N" in the fixed-width left column (empty for a
   * continuation row), state / result / hold / button in the right one.
   */
  function gridRowHtml(czId, valueHtml) {
    var id = Number(czId);
    return (
      '<span class="rechazados-elm-target">' +
      (id > 0 ? 'Sol. ' + esc(id) : '') +
      '</span><span class="rechazados-elm-value">' +
      valueHtml +
      '</span>'
    );
  }

  function gridHtml(rows) {
    return '<div class="rechazados-elm-grid">' + rows.join('') + '</div>';
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
      '">' +
      esc(o.label || 'Enviar a ELM') +
      '</button>'
    );
  }

  /**
   * Rechazados: a solicitud without ELM process whose send is held. Grey text, never a button;
   * the reason goes in the tooltip and the availability date is shown when there is one.
   * List grid (czIds given; "Sol. N" is in the left column): "Envío desde 08/11" or "Sin enviar".
   * CI detail (no czIds, the row already names the solicitud): "Sin enviar · disponible desde 08/11/2026".
   * @param {number[]} czIds the held solicitud
   * @param {string} hint
   * @param {string|null|undefined} until
   */
  function blockedUnsentHtml(czIds, hint, until) {
    var ids = (czIds || []).map(Number).filter(function (n) {
      return n > 0;
    });
    var date = shortDate(until);
    var text;
    var title = hint;
    if (ids.length) {
      text = date ? 'Envío desde ' + date.slice(0, 5) : 'Sin enviar';
      title = 'Sin enviar (sol. ' + ids.join(', ') + '). ' + hint;
    } else {
      text = 'Sin enviar' + (date ? ' · disponible desde ' + date : '');
    }
    return '<span class="rechazados-elm-blocked" title="' + esc(title) + '">' + esc(text) + '</span>';
  }

  function candidateHint(c, send) {
    return sendBlockedHint({
      reasons: c.reasons,
      reason: c.reason,
      hint: c.hint,
      hold: (send && send.hold) || { until: c.until },
    });
  }

  function candidateUntil(c, send) {
    return c.until || (send && send.hold && send.hold.until) || null;
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
    var o = opts || {};
    var compact = o.compact === true;
    var kind = /^[a-z0-9_]+$/.test(String(cell.kind || '')) ? String(cell.kind) : 'unknown';
    var label =
      '<span class="preaprobados-elm is-' +
      kind +
      (cell.granted_elm === true ? ' is-granted' : '') +
      (compact ? ' is-compact' : '') +
      '"' +
      titleAttr(compact ? compactTitleParts(cell).concat(cellTitleParts(cell)) : cellTitleParts(cell)) +
      '>' +
      esc(compact ? compactCellText(cell) : cellLabel(cell)) +
      '</span>';
    var answer = compact ? '' : elmAnswerHtml(cell, o.answer);
    if (cell.retry && cell.retry.show === true && o.retryCi != null) {
      var retry = Object.assign({ cz_solicitud_id: cell.cz_solicitud_id }, cell.retry);
      return '<div class="rechazados-elm-stack">' + label + answer + retryButtonHtml(retry, o.retryCi) + '</div>';
    }
    return answer ? '<div class="rechazados-elm-stack">' + label + answer + '</div>' : label;
  }

  /**
   * Rechazados CI detail, one cell per rejected solicitud (the row already shows its number).
   * Not sent and enabled: "Enviar a ELM" bound to it. Not sent and held: grey text with the reason
   * as tooltip, never a button. With an ELM process: same as elmCellHtml (state, answer, retry).
   * @param {object|null|undefined} cell
   * @param {{ rejectedAt?: string, retryCi?: number|string, answer?: string }} [opts]
   */
  function rejectedDetailCellHtml(cell, opts) {
    var action = (cell && cell.action) || {};
    if (cell && cell.kind === 'not_sent' && action.show === true) {
      var czId = Number(cell.cz_solicitud_id);
      if (action.enabled === true && czId > 0) {
        return sendButtonHtml(czId, { rejectedAt: opts && opts.rejectedAt });
      }
      return blockedUnsentHtml([], sendBlockedHint(action), action.hold && action.hold.until);
    }
    return elmCellHtml(cell, opts);
  }

  /**
   * Rechazados list send controls (`elm.send` from the server) as grid rows, one per solicitud
   * without ELM process. Held: grey text, never a button. One enabled: "Enviar a ELM" bound to it.
   * Several enabled: a picker and a button that stays disabled until one is chosen (the
   * dashboard binds data-cz-id and the label on change).
   */
  function rejectedSendRows(ci, send) {
    if (!send || send.available !== true) return [gridRowHtml(null, '<span class="preaprobados-elm is-unavailable">—</span>')];
    var candidates = Array.isArray(send.candidates) ? send.candidates : [];
    if (!candidates.length) {
      if (send.not_sendable) {
        var reason = send.not_sendable.reason;
        return [
          gridRowHtml(
            send.not_sendable.cz_solicitud_id,
            '<span class="preaprobados-elm is-not_sendable is-compact" title="' +
              esc('Solicitud ' + send.not_sendable.cz_solicitud_id + ' · ' + (BLOCKED_MESSAGES[reason] || reason || 'No enviable')) +
              '">No enviable</span>',
          ),
        ];
      }
      return [gridRowHtml(null, '<span class="preaprobados-elm is-none">—</span>')];
    }
    var enabled = candidates.filter(function (c) {
      return c.enabled === true;
    });
    return (enabled.length ? [enabledSendRowHtml(ci, send, enabled)] : []).concat(blockedCandidateRows(send, candidates));
  }

  /** Same controls as rejectedSendRows, wrapped in the grid. */
  function rejectedSendHtml(ci, send) {
    return gridHtml(rejectedSendRows(ci, send));
  }

  /** Held candidates, one row each, input order kept; the reason is in the tooltip. */
  function blockedCandidateRows(send, candidates) {
    return candidates
      .filter(function (c) {
        return c.enabled !== true;
      })
      .map(function (c) {
        var id = Number(c.cz_solicitud_id);
        return gridRowHtml(id, blockedUnsentHtml([id], candidateHint(c, send), candidateUntil(c, send)));
      });
  }

  function enabledSendRowHtml(ci, send, enabled) {
    var targetId = Number(send.target_cz_id);
    if (send.needs_selection !== true && enabled.length === 1 && targetId === Number(enabled[0].cz_solicitud_id)) {
      return gridRowHtml(
        targetId,
        sendButtonHtml(targetId, { ci: ci, rejectedAt: enabled[0].rejected_at, extraClass: 'rechazados-elm-send' }),
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
    return gridRowHtml(
      null,
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
        '" data-needs-pick="1" disabled aria-disabled="true" title="Elegí primero la solicitud a enviar">' +
        REJECTED_PICK_LABEL +
        '</button>' +
        '</div>',
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

  function retryCandidatesOf(send) {
    return send && send.available === true && Array.isArray(send.retry_candidates) ? send.retry_candidates : [];
  }

  function retryRowHtml(c, ci) {
    return gridRowHtml(c.cz_solicitud_id, retryButtonHtml(c, ci));
  }

  /** Rechazados: "Reintentar ELM" controls (`elm.send.retry_candidates`) as a grid, '' when none. */
  function rejectedRetryHtml(ci, send) {
    var rows = retryCandidatesOf(send).map(function (c) {
      return retryRowHtml(c, ci);
    });
    return rows.length ? gridHtml(rows) : '';
  }

  /** Compact state + result pill of one ELM process; full label and original answer in the tooltip. */
  function processPillHtml(item) {
    var kind = String(item.kind || item.state || '');
    kind = /^[a-z0-9_]+$/.test(kind) ? kind : 'unknown';
    var text = compactCellText(item);
    return (
      '<span class="preaprobados-elm is-' +
      kind +
      (item.granted_elm === true ? ' is-granted' : '') +
      ' is-compact' +
      (text.indexOf('. ') >= 0 ? ' is-wrap' : '') +
      '"' +
      titleAttr(compactTitleParts(item).concat(cellTitleParts(item))) +
      '>' +
      esc(text) +
      '</span>'
    );
  }

  /**
   * Every ELM process of the CI (the row's solicitud first) as grid rows, each followed by its own
   * "Reintentar ELM" row when the server offers it. Retry candidates without a process follow.
   */
  function processRows(elm, ci) {
    var items = (elm.cell ? [elm.cell] : []).concat(Array.isArray(elm.other_processes) ? elm.other_processes : []);
    var retries = ci != null ? retryCandidatesOf(elm.send).slice() : [];
    var rows = [];
    items.forEach(function (item) {
      var id = Number(item.cz_solicitud_id);
      rows.push(gridRowHtml(id, processPillHtml(item)));
      for (var i = retries.length - 1; i >= 0; i -= 1) {
        if (Number(retries[i].cz_solicitud_id) === id) {
          rows.push(gridRowHtml(null, retryButtonHtml(retries[i], ci)));
          retries.splice(i, 1);
        }
      }
    });
    return rows.concat(
      retries.map(function (c) {
        return retryRowHtml(c, ci);
      }),
    );
  }

  /**
   * CI detail, ELM processes of solicitudes outside the rejections table: same grid as the list,
   * "Sol. N" then the compact state, then origin and ELM's answer (truncated, full in tooltip).
   */
  function rejectedOtherProcessesHtml(processes) {
    var rows = (Array.isArray(processes) ? processes : []).map(function (p) {
      var note = [originLabel(p.trigger_origin)];
      if (p.elm_answer) note.push(elmAnswerText(p, true));
      if (p.ops_resolution) note.push(opsResolutionText(p));
      var noteText = note.join(' · ');
      return gridRowHtml(
        p.cz_solicitud_id,
        '<span class="rechazados-elm-detail-line">' +
          processPillHtml(p) +
          '<span class="rechazados-elm-note" title="' +
          esc(noteText) +
          '">' +
          esc(noteText) +
          '</span></span>',
      );
    });
    return rows.length ? gridHtml(rows) : '';
  }

  function isProcessCell(cell) {
    var kind = cell && cell.kind;
    return Boolean(kind) && kind !== 'not_sent' && kind !== 'not_sendable' && kind !== 'unavailable';
  }

  /**
   * List-row `elm` rebuilt from the CI detail block (GET /rechazados/:ci), so one row can be
   * refreshed after a send without reloading the list. Same data as the list builds: the row's
   * solicitud process as `cell`, every other process of the CI in `other_processes`, same `send`.
   * @param {object|null|undefined} detailElm `elm` of the CI detail
   * @param {number|string|null} focusCzId the row's solicitud (latest rejection)
   */
  function rejectedListElmFromDetail(detailElm, focusCzId) {
    var d = detailElm || {};
    if (d.available !== true) return { available: false };
    var focus = Number(focusCzId);
    var cell = null;
    var others = [];
    (Array.isArray(d.solicitudes) ? d.solicitudes : []).forEach(function (s) {
      if (!isProcessCell(s && s.cell)) return;
      if (Number(s.cz_solicitud_id) === focus && !cell) cell = s.cell;
      else others.push(s.cell);
    });
    return {
      available: true,
      cell: cell,
      other_processes: others.concat(Array.isArray(d.other_processes) ? d.other_processes : []),
      ci_active: d.ci_active || null,
      send: d.send || { available: false },
    };
  }

  /**
   * Rechazados list (one row per CI): a two-column grid, one row per solicitud. Left "Sol. N"
   * (fixed width, so every table row lines up); right the state and result of a sent solicitud
   * (never a send button), or for one without ELM process "Enviar a ELM" when the server enabled
   * the send and grey text with the reason when it is held.
   */
  function rejectedRowElmHtml(elm, ci) {
    if (!elm || elm.available !== true) {
      return gridHtml([gridRowHtml(null, '<span class="preaprobados-elm is-unavailable">—</span>')]);
    }
    var rows = processRows(elm, ci);
    var send = elm.send;
    var offered = send && send.available === true && Array.isArray(send.candidates) && send.candidates.length > 0;
    if (ci != null && send && (offered || !rows.length)) rows = rows.concat(rejectedSendRows(ci, send));
    if (!rows.length) rows.push(gridRowHtml(null, '<span class="preaprobados-elm is-none">—</span>'));
    return gridHtml(rows);
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
      case 'duplicate_other_channel':
        return {
          tone: 'warn',
          text: 'Duplicado · Otro canal: ELM informa que el cliente ya está aprobado por otro canal. No hay derivación por Copanel.',
        };
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
    elmAnswerText: elmAnswerText,
    opsResolutionText: opsResolutionText,
    elmAnswerHtml: elmAnswerHtml,
    compactReason: compactReason,
    compactCellText: compactCellText,
    sendBlockedHint: sendBlockedHint,
    ciHoldText: ciHoldText,
    shortDate: shortDate,
    elmCellHtml: elmCellHtml,
    rejectedDetailCellHtml: rejectedDetailCellHtml,
    rejectedSendLabel: rejectedSendLabel,
    REJECTED_PICK_LABEL: REJECTED_PICK_LABEL,
    rejectedListElmFromDetail: rejectedListElmFromDetail,
    rejectedSendHtml: rejectedSendHtml,
    retryButtonHtml: retryButtonHtml,
    rejectedRetryHtml: rejectedRetryHtml,
    rejectedRowElmHtml: rejectedRowElmHtml,
    rejectedOtherProcessesHtml: rejectedOtherProcessesHtml,
    sendResultMessage: sendResultMessage,
  };
});
