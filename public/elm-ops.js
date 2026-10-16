/* ELM operations (Fase 3B): active referrals / uncertain ELM results + manual review queue.
 * Preaprobados mounts the C1/ELM tray with mount() in V1 read-only mode (GET only, canAct=false).
 * createProcessResolver ("Resolver ELM") stays in the solicitud detail; it is not the tray.
 * Every action sends the version the operator saw; the backend answers `stale` if anything
 * changed in between (postback, worker, another operator). Nothing here sends to ELM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ElmOps = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND_LABELS = Object.freeze({
    referral: 'Derivación activa',
    s2_unknown: 'Derivación incierta (S2)',
    s1_unknown: 'Evaluación incierta (S1)',
  });
  const S2_ACCEPTED_KIND_LABEL = 'Aceptado ELM (S2, asignado a Copanel)';
  const S2_ACCEPTED_TECHNICAL_TEXT = 'S2 técnico: unknown · interpretado como Aceptado ELM';
  const CORRECTION_PREFIX = 'correction:';

  const PROCESS_RESOLUTION_LABELS = Object.freeze({
    provider_closed_no_loan: 'ELM cerró el caso sin préstamo',
    provider_loan_disbursed: 'ELM otorgó el préstamo (requiere Convertido)',
    customer_withdrew: 'El cliente desistió',
    provider_confirmed_not_received: 'ELM confirmó que no recibió el lead',
    provider_confirmed_no_referral: 'ELM confirmó que no hubo derivación',
    other: 'Otro (detallar en la nota)',
  });

  const CASE_RESOLUTION_LABELS = Object.freeze({
    resolved_with_provider: 'Resuelto con ELM',
    customer_contacted: 'Cliente contactado',
    no_action_required: 'No requiere acción',
    other: 'Otro (detallar en la nota)',
  });

  const CZ_OUTCOME_LABELS = Object.freeze({
    referred: 'Derivar a ventas en Credizona (14 → 13)',
    rejected: 'Rechazar en Credizona (14 → 3)',
    granted: 'Préstamo otorgado por ELM (14 → 16)',
    none: 'Sin cambio en Credizona (caso sin estado 14)',
  });

  const PROCESS_CZ_OUTCOME_LABELS = Object.freeze({
    none: 'Sin cambio en Credizona (no está derivada en 13)',
    rejected: 'Rechazo definitivo en Credizona (13 → 3)',
    granted: 'Préstamo otorgado por ELM (13 → 16, requiere Convertido)',
  });

  const REASON_LABELS = Object.freeze({
    elm_s1_unknown: 'Resultado incierto en evaluación ELM (S1)',
    elm_s2_unknown: 'Resultado incierto en derivación ELM (S2)',
    elm_s1_technical_error_retry_unsafe: 'Error técnico ELM en S1 sin reintento seguro',
    elm_s2_technical_error_retry_unsafe: 'Error técnico ELM en S2 sin reintento seguro',
    elm_s1_technical_error_retries_exhausted: 'Error técnico ELM en S1: reintentos agotados',
    elm_s2_technical_error_retries_exhausted: 'Error técnico ELM en S2: reintentos agotados',
    elm_config_incomplete: 'Configuración ELM incompleta',
    elm_mobilephone_needs_correction: 'Celular con formato inválido: pendiente de corrección (no es un rechazo comercial)',
    elm_mobilephone_invalid: 'Celular con formato inválido: pendiente de corrección (no es un rechazo comercial)',
    ci_prior_unknown: 'Otra solicitud de la CI tiene un resultado ELM incierto',
    ci_open_elm_process: 'Otra solicitud de la CI tiene un proceso ELM abierto',
    not_started_attempts_exhausted: 'No se pudo iniciar el envío tras varios intentos',
    elm_s1_bcu_error_repeated: 'ELM respondió "BCU error" dos veces (reintento de 24 h incluido)',
    elm_s1_rejection_not_definitive: 'Respuesta negativa ELM (S1) no confirmada como rechazo definitivo',
    elm_s2_rejection_not_definitive: 'Respuesta negativa ELM (S2) no confirmada como rechazo definitivo',
    elm_s1_duplicate_other_channel: 'Duplicado · Otro canal: ELM informa que el cliente ya está aprobado por otro canal',
    rejection_not_confirmed: 'Rechazo sin motivo definitivo confirmado',
    elm_solicitud_not_found: 'Solicitud no encontrada',
    elm_cdv_granted: 'CDV otorgó esta solicitud',
    elm_ci_mismatch: 'La CI de la solicitud no coincide con el proceso ELM',
    unexpected_state: 'Estado inesperado',
  });

  const PRIORITY_LABELS = Object.freeze({
    urgent: 'Urgente',
    high: 'Alta',
    normal: 'Normal',
    low: 'Baja',
  });

  const ACTION_ERRORS = Object.freeze({
    stale: 'El caso cambió mientras lo mirabas. Se recargó la cola; revisá y volvé a intentar.',
    already_resolved: 'Ya estaba resuelto.',
    in_flight: 'Hay un envío ELM en curso; esperá a que termine.',
    not_resolvable: 'Este proceso ya no admite resolución manual.',
    evidence_required: 'No hay evidencia de otorgamiento (postback Convertido) para este proceso.',
    invalid_resolution: 'Resolución no válida para este caso.',
    incompatible_with_accepted: 'ELM aceptó este lead: esa resolución lo contradice. Usá la corrección auditada si hay evidencia.',
    invalid_correction: 'Corrección no válida para este proceso.',
    correction_note_required: 'La corrección requiere una nota de al menos 30 caracteres con la evidencia.',
    invalid_cz_outcome: 'Elegí el resultado para Credizona.',
    cz_outcome_required: 'Credizona todavía tiene la solicitud abierta (13 derivada / 14 en revisión): elegí el resultado para Credizona. Sin evidencia definitiva, dejala pendiente.',
    cz_outcome_not_applicable: 'Esta solicitud no está abierta en Credizona: elegí "Sin cambio en Credizona".',
    cz_outcome_mismatch: 'Derivación activa (13): el rechazo requiere "ELM cerró el caso sin préstamo" y el otorgado "ELM otorgó el préstamo".',
    invalid_triage: 'Prioridad o vencimiento no válidos.',
    note_required: 'La nota es obligatoria (10 a 2000 caracteres).',
    invalid_assignee: 'Responsable no válido.',
    invalid_request: 'Solicitud inválida.',
    not_found: 'No encontrado.',
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtAge(hours) {
    if (hours == null) return '—';
    if (hours < 24) return hours + ' h';
    return Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
  }

  function reasonLabel(code) {
    return REASON_LABELS[code] || code || '—';
  }

  function actionErrorText(status) {
    return ACTION_ERRORS[status] || 'No se pudo completar la acción.';
  }

  /** Banner text for the alert counts, or '' when nothing needs attention. */
  function alertText(summary) {
    if (!summary) return '';
    const parts = [];
    if (summary.review_unassigned > 0) {
      parts.push(summary.review_unassigned + ' caso(s) de revisión sin asignar');
    }
    if (summary.review_overdue > 0) {
      parts.push(summary.review_overdue + ' caso(s) de revisión vencido(s)');
    }
    return parts.join(' · ');
  }

  function elmStateText(elm) {
    if (!elm) return '—';
    const parts = ['S1 ' + elm.s1_status, elm.s2_accepted === true ? S2_ACCEPTED_TECHNICAL_TEXT : 'S2 ' + elm.s2_status];
    if (elm.provider_status) parts.push('ELM: ' + elm.provider_status);
    if (elm.granted_elm) parts.push('Otorgado');
    return parts.join(' · ');
  }

  function optionsHtml(values, labels, selected) {
    return values
      .map(function (v) {
        return (
          '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' +
          esc(labels[v] || v) + '</option>'
        );
      })
      .join('');
  }

  function processKindLabel(p) {
    if (p.s2_accepted === true) return S2_ACCEPTED_KIND_LABEL;
    return KIND_LABELS[p.kind] || p.kind || '—';
  }

  function processRowHtml(p, fmtDate, canAct) {
    const blocked = (p.blocked_cz_solicitud_ids || []).join(', ');
    const ev = p.last_event;
    return (
      '<tr data-process-id="' + esc(p.process_id) + '">' +
      '<td>' + esc(p.cz_solicitud_id) + '</td>' +
      '<td>' + esc(p.ci || '—') + '</td>' +
      '<td>' + esc(processKindLabel(p)) + '</td>' +
      '<td>' + esc(fmtDate(p.since)) + '</td>' +
      '<td>' + esc(fmtAge(p.age_hours)) + '</td>' +
      '<td>' + esc(elmStateText(p.elm)) + '</td>' +
      '<td>' + (ev ? esc((ev.status || '—') + ' · ' + fmtDate(ev.received_at)) : 'Sin eventos') + '</td>' +
      '<td>' + esc(blocked || '—') + '</td>' +
      '<td>' + (canAct
        ? '<button type="button" class="btn btn-sm" data-elm-ops-action="resolve-process">Resolver</button>'
        : '') + '</td>' +
      '</tr>'
    );
  }

  const KPI_SEGMENTS = Object.freeze([
    ['total', 'Total'],
    ['janus_manual', 'Manual (JANUS)'],
    ['janus_batch', 'Lote (JANUS)'],
    ['cz_automatic', 'Automático (CZ)'],
  ]);

  const FLOW_LABELS = Object.freeze([
    ['started', 'Iniciados'],
    ['s1_executed', 'S1 ejecutados'],
    ['s1_favorable', 'S1 favorables'],
    ['referred_s2', 'Aceptados S2 (Aceptado ELM)'],
    ['rejected_definitive', 'Rechazos definitivos'],
    ['granted', 'Otorgados ELM'],
    ['pending_or_review', 'Pendientes / en revisión'],
    ['distinct_ci_started', 'CI distintas iniciadas'],
  ]);

  const CURRENT_LABELS = Object.freeze([
    ['in_evaluation', 'En evaluación'],
    ['referred', 'Aceptado ELM'],
    ['granted', 'Otorgado ELM'],
    ['rejected', 'Rechazado ELM'],
    ['review', 'Pendiente de revisión'],
    ['closed', 'Cerrado sin préstamo'],
  ]);

  const FOLLOWUP_KIND_LABELS = Object.freeze({
    in_evaluation: 'En evaluación',
    review: 'Pendiente de revisión',
    rejected_pending_cz: 'Rechazo sin reflejo en Credizona',
    queued: 'En cola',
  });

  function originLabel(origin) {
    for (const s of KPI_SEGMENTS) if (s[0] === origin) return s[1];
    return origin || '—';
  }

  /** One table: rows = indicators, columns = total + trigger origins. */
  function kpiTableHtml(block, labels) {
    if (!block) return '';
    return (
      '<table class="mcl-table elm-ops-kpi"><thead><tr><th></th>' +
      KPI_SEGMENTS.map(function (s) { return '<th class="num">' + esc(s[1]) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      labels.map(function (l) {
        return (
          '<tr><td>' + esc(l[1]) + '</td>' +
          KPI_SEGMENTS.map(function (s) {
            const seg = block[s[0]] || {};
            return '<td class="num">' + esc(seg[l[0]] != null ? seg[l[0]] : 0) + '</td>';
          }).join('') +
          '</tr>'
        );
      }).join('') +
      '</tbody></table>'
    );
  }

  function followupRowHtml(i, fmtDate) {
    return (
      '<tr>' +
      '<td>' + esc(i.cz_solicitud_id) + '</td>' +
      '<td>' + esc(i.ci || '—') + '</td>' +
      '<td>' + esc(originLabel(i.trigger_origin)) + '</td>' +
      '<td>' + esc(FOLLOWUP_KIND_LABELS[i.kind] || i.kind || '—') + '</td>' +
      '<td>' + esc(i.label || '—') + '</td>' +
      '<td>' + esc(i.provider_status || '—') + '</td>' +
      '<td>' + esc(fmtDate(i.since)) + '</td>' +
      '<td>' + esc(fmtAge(i.age_hours)) + '</td>' +
      '</tr>'
    );
  }

  function isEstado12Followup(i) {
    return i && (i.kind === 'in_evaluation' || i.kind === 'queued');
  }

  function c1ReferralRowHtml(r, fmtDate) {
    const ev = r.last_event;
    const commercial = r.granted_elm
      ? 'Otorgado ELM'
      : (r.provider_status || r.fallback_outcome || '—');
    const stale = r.stale
      ? '<span class="elm-ops-flag elm-ops-flag-danger">Sin señal reciente</span>'
      : '—';
    return (
      '<tr>' +
      '<td>' + esc(r.cz_solicitud_id) + '</td>' +
      '<td>' + esc(r.ci || '—') + '</td>' +
      '<td>' + esc(r.projected_estado) + '</td>' +
      '<td>' + esc(commercial) + '</td>' +
      '<td>' + (ev ? esc((ev.type || '—') + (ev.delivery_status ? ' · ' + ev.delivery_status : '')) : 'Sin eventos') + '</td>' +
      '<td>' + esc(fmtDate(r.referred_at || r.started_at)) + '</td>' +
      '<td>' + esc(fmtAge(r.age_hours)) + '</td>' +
      '<td>' + stale + '</td>' +
      '</tr>'
    );
  }

  function caseRowHtml(c, fmtDate, canAct) {
    const flags = [];
    if (c.unassigned) flags.push('<span class="elm-ops-flag">Sin asignar</span>');
    if (c.overdue) flags.push('<span class="elm-ops-flag elm-ops-flag-danger">Vencido</span>');
    return (
      '<tr data-case-id="' + esc(c.id) + '">' +
      '<td>' + esc(c.cz_solicitud_id) + (c.related_cz_solicitud_id
        ? ' <span class="preaprobados-muted">(rel. ' + esc(c.related_cz_solicitud_id) + ')</span>'
        : '') + '</td>' +
      '<td>' + esc(c.ci || '—') + '</td>' +
      '<td>' + esc(reasonLabel(c.reason_code)) + '</td>' +
      '<td>' + esc(fmtDate(c.created_at)) + '</td>' +
      '<td>' + esc(fmtAge(c.age_hours)) + '</td>' +
      '<td>' + esc(elmStateText(c.elm)) + '</td>' +
      '<td>' + esc(c.assigned_to ? c.assigned_to.email || c.assigned_to.id : '—') + '</td>' +
      '<td>' + esc(PRIORITY_LABELS[c.priority] || c.priority) + '</td>' +
      '<td>' + esc(fmtDate(c.due_at)) + ' ' + flags.join(' ') + '</td>' +
      '<td>' + (canAct && c.status === 'open'
        ? '<button type="button" class="btn btn-sm" data-elm-ops-action="assign">Asignar</button> ' +
          '<button type="button" class="btn btn-sm" data-elm-ops-action="triage">Prioridad</button> ' +
          '<button type="button" class="btn btn-sm" data-elm-ops-action="resolve-case">Resolver</button>'
        : '') + '</td>' +
      '</tr>'
    );
  }

  /** Select value of an audited correction ("correction:<code>"); the code otherwise. */
  function parseResolutionChoice(raw) {
    const s = String(raw || '');
    return s.indexOf(CORRECTION_PREFIX) === 0
      ? { resolution_code: s.slice(CORRECTION_PREFIX.length), correction: true }
      : { resolution_code: s, correction: false };
  }

  function correctionOptionsHtml(p, selected) {
    const codes = p.correction_resolutions || [];
    if (!codes.length) return '';
    return (
      '<optgroup label="Corrección auditada (contradice Aceptado ELM)">' +
      codes
        .map(function (c) {
          const value = CORRECTION_PREFIX + c;
          return (
            '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>Corrección: ' +
            esc(PROCESS_RESOLUTION_LABELS[c] || c) + '</option>'
          );
        })
        .join('') +
      '</optgroup>'
    );
  }

  /** Resolution options; "loan disbursed" stays visible but disabled without GRANTED evidence. */
  function resolutionOptionsHtml(p, selected) {
    const granted = Boolean(p.elm && p.elm.granted_elm === true);
    return (p.allowed_resolutions || [])
      .map(function (v) {
        const noEvidence = v === 'provider_loan_disbursed' && !granted;
        return (
          '<option value="' + esc(v) + '"' +
          (v === selected && !noEvidence ? ' selected' : '') +
          (noEvidence ? ' disabled' : '') + '>' +
          esc(PROCESS_RESOLUTION_LABELS[v] || v) +
          (noEvidence ? ' · sin evidencia de otorgamiento' : '') +
          '</option>'
        );
      })
      .join('');
  }

  /** @param {object} p open process view @param {{ choice?: string, cz_outcome?: string, note?: string }} [draft] */
  function resolveProcessFormHtml(p, draft) {
    const dr = draft || {};
    const correctionHint = (p.correction_resolutions || []).length
      ? '<p class="preaprobados-muted">ELM aceptó este lead (asignado a Copanel). Una corrección requiere ' +
        'una nota de al menos 30 caracteres con la evidencia y queda registrada como corrección en la auditoría.</p>'
      : '';
    return (
      '<form class="elm-ops-form" data-elm-ops-form="resolve-process">' +
      '<p class="preaprobados-muted">No envía nada a ELM ni marca el préstamo como otorgado. ' +
      'Queda auditada; el bloqueo de la CI se recalcula con las reglas vigentes (cupo mensual y ventana de reenvío).</p>' +
      correctionHint +
      '<label>Resolución <select name="resolution_code" required>' +
      resolutionOptionsHtml(p, dr.choice) +
      correctionOptionsHtml(p, dr.choice) +
      '</select></label>' +
      '<label>Resultado en Credizona <select name="cz_outcome" required>' +
      optionsHtml(['none', 'rejected', 'granted'], PROCESS_CZ_OUTCOME_LABELS, dr.cz_outcome || 'none') +
      '</select></label>' +
      '<label>Nota (obligatoria) <textarea name="note" minlength="10" maxlength="2000" required>' +
      esc(dr.note || '') + '</textarea></label>' +
      '<button type="submit" class="btn">Confirmar</button> ' +
      '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
      '</form>'
    );
  }

  function assignFormHtml(c, assignees) {
    const values = [''].concat(
      (assignees || []).map(function (u) {
        return u.id;
      }),
    );
    const labels = { '': 'Sin asignar' };
    (assignees || []).forEach(function (u) {
      labels[u.id] = u.email || u.id;
    });
    return (
      '<form class="elm-ops-form" data-elm-ops-form="assign">' +
      '<label>Responsable <select name="assignee_user_id">' +
      optionsHtml(values, labels, c.assigned_to ? c.assigned_to.id : '') +
      '</select></label>' +
      '<button type="submit" class="btn">Guardar</button> ' +
      '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
      '</form>'
    );
  }

  function toLocalInput(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  function triageFormHtml(c) {
    return (
      '<form class="elm-ops-form" data-elm-ops-form="triage">' +
      '<label>Prioridad <select name="priority">' +
      optionsHtml(['urgent', 'high', 'normal', 'low'], PRIORITY_LABELS, c.priority) +
      '</select></label>' +
      '<label>Vence <input type="datetime-local" name="due_at" value="' + esc(toLocalInput(c.due_at)) + '" required></label>' +
      '<button type="submit" class="btn">Guardar</button> ' +
      '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
      '</form>'
    );
  }

  function resolveCaseFormHtml() {
    return (
      '<form class="elm-ops-form" data-elm-ops-form="resolve-case">' +
      '<label>Resolución <select name="resolution_code" required>' +
      optionsHtml(Object.keys(CASE_RESOLUTION_LABELS), CASE_RESOLUTION_LABELS, null) +
      '</select></label>' +
      '<label>Resultado en Credizona <select name="cz_outcome" required>' +
      optionsHtml(Object.keys(CZ_OUTCOME_LABELS), CZ_OUTCOME_LABELS, null) +
      '</select></label>' +
      '<label>Nota (obligatoria) <textarea name="note" minlength="10" maxlength="2000" required></textarea></label>' +
      '<button type="submit" class="btn">Confirmar</button> ' +
      '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
      '</form>'
    );
  }

  /**
   * "Resolver ELM" inside one solicitud detail (Rechazados / Preaprobados). The action shows only
   * for the solicitud's own process and only when the backend lists resolutions for it (open
   * referral, uncertain S1 / S2, Aceptado ELM); blocking another solicitud of the CI is never a
   * reason by itself. The host re-renders its modal (onChange) and refreshes its data after a
   * resolution (onResolved); POST /processes/:id/resolve re-validates and audits everything.
   * @param {{ api?: string, fetch?: Function, onChange?: Function, onResolved?: Function }} opts
   */
  function createProcessResolver(opts) {
    const o = opts || {};
    const api = o.api || '';
    const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const onChange = o.onChange || function () {};
    const onResolved = o.onResolved || function () {};
    const state = {
      byCz: new Map(),
      canAct: null,
      openCz: null,
      busy: false,
      draft: {},
      notice: new Map(),
      seq: 0,
    };

    async function request(method, path, body) {
      const res = await fetchFn(api + '/preaprobados/elm-ops' + path, {
        method: method,
        headers: body
          ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(function () {
        return {};
      });
      return { status: res.status, data: data };
    }

    /** Re-reads the open processes (and, once, whether this user may act). */
    async function load() {
      const seq = ++state.seq;
      const byCz = new Map();
      try {
        const reads = [request('GET', '/processes?limit=200')];
        if (state.canAct === null) reads.push(request('GET', '/assignees'));
        const out = await Promise.all(reads);
        if (out[0].status === 200) {
          (out[0].data.items || []).forEach(function (v) {
            if ((v.allowed_resolutions || []).length) byCz.set(Number(v.cz_solicitud_id), v);
          });
        }
        if (out[1]) state.canAct = out[1].status === 200;
      } catch (_) {
        /* no process list → no action offered */
      }
      if (seq !== state.seq) return;
      state.byCz = byCz;
      if (state.openCz != null && !byCz.has(state.openCz)) state.openCz = null;
      onChange();
    }

    function reset() {
      state.seq += 1;
      state.byCz = new Map();
      state.openCz = null;
      state.busy = false;
      state.draft = {};
      state.notice = new Map();
    }

    function noticeHtml(czId) {
      const n = state.notice.get(czId);
      return n ? '<div class="rechazados-elm-msg is-' + esc(n.tone) + '">' + esc(n.text) + '</div>' : '';
    }

    /** HTML for one solicitud: '' when its process admits no manual resolution. */
    function html(czId) {
      const id = Number(czId);
      const p = state.byCz.get(id);
      const notice = noticeHtml(id);
      if (!p) return notice ? '<div class="elm-resolve" data-elm-resolve-cz="' + id + '">' + notice + '</div>' : '';
      let body =
        '<div class="elm-resolve-head"><strong>Resolución manual ELM</strong> · Sol. ' + esc(String(id)) +
        ' · ' + esc(processKindLabel(p)) + '</div>';
      if (state.canAct !== true) {
        body += '<p class="preaprobados-muted">Solo un administrador puede registrar la resolución.</p>';
      } else if (state.openCz === id) {
        body += resolveProcessFormHtml(p, state.draft);
      } else {
        body +=
          '<button type="button" class="btn preaprobados-cell-btn" data-elm-resolve-open="' + id + '">Resolver ELM</button>';
      }
      return '<div class="elm-resolve" data-elm-resolve-cz="' + id + '">' + notice + body + '</div>';
    }

    /** Keeps what the operator typed across host re-renders. */
    function handleInput(target) {
      if (!target || !target.closest || !target.closest('[data-elm-resolve-cz]')) return false;
      if (target.name === 'resolution_code') state.draft.choice = target.value;
      else if (target.name === 'cz_outcome') state.draft.cz_outcome = target.value;
      else if (target.name === 'note') state.draft.note = target.value;
      else return false;
      return true;
    }

    /** @returns {boolean} true when the click belonged to the resolver */
    function handleClick(target) {
      const box = target && target.closest ? target.closest('[data-elm-resolve-cz]') : null;
      if (!box) return false;
      const id = Number(box.getAttribute('data-elm-resolve-cz'));
      if (target.closest('[data-elm-resolve-open]')) {
        if (state.canAct !== true || !state.byCz.has(id) || state.busy) return true;
        state.openCz = id;
        state.draft = {};
        state.notice.delete(id);
        onChange();
        return true;
      }
      if (target.closest('[data-elm-ops-action="cancel"]')) {
        state.openCz = null;
        state.draft = {};
        onChange();
        return true;
      }
      return Boolean(target.closest('button, select, textarea, option, label'));
    }

    /** @returns {Promise<boolean>} true when the form belonged to the resolver */
    async function handleSubmit(form) {
      const box = form && form.closest ? form.closest('[data-elm-resolve-cz]') : null;
      if (!box || form.getAttribute('data-elm-ops-form') !== 'resolve-process') return false;
      const id = Number(box.getAttribute('data-elm-resolve-cz'));
      const p = state.byCz.get(id);
      if (!p || state.busy) return true;
      const choice = parseResolutionChoice(form.elements.resolution_code.value);
      state.busy = true;
      let out;
      try {
        out = await request('POST', '/processes/' + encodeURIComponent(p.process_id) + '/resolve', {
          expected_updated_at: p.version,
          resolution_code: choice.resolution_code,
          correction: choice.correction,
          cz_outcome: form.elements.cz_outcome.value,
          note: form.elements.note.value,
        });
      } catch (_) {
        out = { status: 0, data: {} };
      }
      state.busy = false;
      const status = out.data && out.data.status;
      if (out.status === 200) {
        state.openCz = null;
        state.draft = {};
        state.notice.set(id, {
          tone: 'ok',
          text: 'Resolución registrada y auditada: ' +
            (choice.correction ? 'Corrección: ' : '') +
            (PROCESS_RESOLUTION_LABELS[choice.resolution_code] || choice.resolution_code) + '.',
        });
        await onResolved(id);
        await load();
        return true;
      }
      state.notice.set(id, {
        tone: 'error',
        text: out.status === 0 ? 'No se pudo conectar.' : actionErrorText(status),
      });
      if (status === 'stale' || status === 'already_resolved' || status === 'not_resolvable') {
        state.openCz = null;
        state.draft = {};
        await onResolved(id);
        await load();
      } else {
        onChange();
      }
      return true;
    }

    return {
      load: load,
      reset: reset,
      html: html,
      handleClick: handleClick,
      handleInput: handleInput,
      handleSubmit: handleSubmit,
      viewFor: function (czId) { return state.byCz.get(Number(czId)) || null; },
    };
  }

  /**
   * C1/ELM tray in Preaprobados. V1 is strictly read-only: GET only, canAct always false,
   * no Resolver / Asignar / Reenviar, no assignees fetch, no POST.
   * @param {{ root: HTMLElement, api?: string, fmtDate?: Function, fetch?: Function, canAct?: boolean }} opts
   */
  function mount(opts) {
    const root = opts.root;
    const api = opts.api || '';
    const fmtDate = opts.fmtDate || function (iso) { return iso || '—'; };
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const state = {
      eval12: [],
      cases: [],
      referrals13: [],
      canAct: false,
      error: null,
    };

    async function request(method, path) {
      const m = String(method || 'GET').toUpperCase();
      if (m !== 'GET') {
        throw new Error('elm-ops tray v1 is read-only');
      }
      const res = await fetchFn(api + '/preaprobados/elm-ops' + path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(function () {
        return {};
      });
      return { status: res.status, data: data };
    }

    function sectionHtml(id, title, count, hint, table, empty) {
      return (
        '<details class="elm-ops-section" id="' + esc(id) + '"' + (count ? ' open' : '') + '>' +
        '<summary>' + esc(title) + ' (' + count + ')</summary>' +
        '<p class="preaprobados-muted">' + esc(hint) + '</p>' +
        (count ? table : '<p class="preaprobados-muted">' + esc(empty) + '</p>') +
        '</details>'
      );
    }

    function render() {
      let html =
        '<header class="elm-ops-head">' +
        '<h2 class="elm-ops-title">Bandeja C1 / ELM</h2>' +
        '<p class="preaprobados-muted">Solo lectura. No resuelve, no asigna y no reenvía a ELM. Independiente de la cohorte CDV de Preaprobados.</p>' +
        '</header>';
      if (state.error) html += '<div class="mcl-status mcl-error">' + esc(state.error) + '</div>';

      html += sectionHtml(
        'elm-ops-estado-12',
        'Estado 12 — En evaluación y procesos trabados',
        state.eval12.length,
        'Solicitudes C1 todavía en evaluación ELM y jobs automáticos en cola o trabados. No son rechazos.',
        '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Origen</th><th>Situación</th>' +
          '<th>Detalle</th><th>Estado ELM</th><th>Desde</th><th>Antigüedad</th></tr></thead><tbody>' +
          state.eval12.map(function (i) { return followupRowHtml(i, fmtDate); }).join('') +
          '</tbody></table>',
        'Sin solicitudes en evaluación ni trabadas.',
      );

      html += sectionHtml(
        'elm-ops-estado-14',
        'Estado 14 — Revisión pendiente',
        state.cases.length,
        'Requieren intervención operativa. Motivo, fecha de ingreso y antigüedad. V1 no asigna ni resuelve.',
        '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Motivo</th><th>Ingreso</th>' +
          '<th>Antigüedad</th><th>Estado ELM</th><th>Responsable</th><th>Prioridad</th><th>Vence</th><th></th></tr></thead><tbody>' +
          state.cases.map(function (c) { return caseRowHtml(c, fmtDate, false); }).join('') +
          '</tbody></table>',
        'Sin revisiones pendientes.',
      );

      html += sectionHtml(
        'elm-ops-estado-13',
        'Estado 13 — Derivados a ELM',
        state.referrals13.length,
        'Derivación vigente: seguimiento comercial (estado ELM, último evento, antigüedad). V1 no reenvía.',
        '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Estado CZ</th><th>Situación comercial</th>' +
          '<th>Último evento</th><th>Desde</th><th>Antigüedad</th><th>Seguimiento</th></tr></thead><tbody>' +
          state.referrals13.map(function (r) { return c1ReferralRowHtml(r, fmtDate); }).join('') +
          '</tbody></table>',
        'Sin derivaciones C1 activas.',
      );
      root.innerHTML = html;
    }

    async function load() {
      state.error = null;
      try {
        const [f, c, r] = await Promise.all([
          request('GET', '/followup'),
          request('GET', '/review-cases?status=open'),
          request('GET', '/c1/active-referrals'),
        ]);
        if (f.status >= 400 || c.status >= 400 || r.status >= 400) {
          state.error = 'No se pudieron cargar las colas C1 / ELM.';
          state.eval12 = [];
          state.cases = [];
          state.referrals13 = [];
        } else {
          const followup = f.data.items || [];
          state.eval12 = followup.filter(isEstado12Followup);
          state.cases = c.data.items || [];
          const referrals = r.data.items || [];
          state.referrals13 = referrals.filter(function (item) {
            return Number(item.projected_estado) === 13;
          });
        }
      } catch (_) {
        state.error = 'No se pudieron cargar las colas C1 / ELM.';
      }
      render();
    }

    return { load: load };
  }

  return {
    KIND_LABELS,
    PROCESS_RESOLUTION_LABELS,
    CASE_RESOLUTION_LABELS,
    CZ_OUTCOME_LABELS,
    PROCESS_CZ_OUTCOME_LABELS,
    REASON_LABELS,
    PRIORITY_LABELS,
    esc,
    fmtAge,
    reasonLabel,
    alertText,
    actionErrorText,
    elmStateText,
    processKindLabel,
    kpiTableHtml,
    followupRowHtml,
    c1ReferralRowHtml,
    FLOW_LABELS,
    CURRENT_LABELS,
    processRowHtml,
    caseRowHtml,
    resolveProcessFormHtml,
    parseResolutionChoice,
    resolveCaseFormHtml,
    createProcessResolver,
    mount,
  };
});
