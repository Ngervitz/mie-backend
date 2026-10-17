/* ELM operations (Fase 3B): active referrals / uncertain ELM results + manual review queue.
 * «Gestión ELM» is a transitory tab (mount() → GET /gestion). Preaprobados and Rechazados
 * stay unchanged. mountRecoverable() remains as a read helper; the dashboard does not
 * mount it. createProcessResolver stays in the solicitud detail.
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
    confirm_required: 'Confirmá la acción antes de continuar.',
    not_definitive: 'No hay evidencia de rechazo comercial definitivo. No se cierra.',
    no_review_case: 'No hay un caso de revisión abierto en Credizona (estado 14) para cerrar.',
    retry_not_allowed: 'Este caso no admite reintento: no está demostrado que ELM no haya recibido la solicitud.',
    retry_failed: 'El reintento no se pudo completar.',
    elm_retry_not_pre_reception: 'ELM pudo haber recibido la solicitud. No se reenvía.',
    elm_retry_stale: 'El conteo de intentos cambió. Se recargó la mesa; revisá y volvé a intentar.',
    elm_ci_active: 'Otra solicitud de esta CI bloquea el reenvío.',
    elm_ci_send_in_progress: 'Hay un envío ELM en curso para esta CI.',
    elm_ci_recent_send: 'Esta CI ya tuvo un envío ELM reciente.',
    elm_ci_monthly_quota_used: 'Esta CI ya usó el cupo mensual de envío ELM.',
    elm_ci_history_unverifiable: 'No se pudo verificar el historial de la CI. Sin reenvío.',
    confirm_duplicate_required: 'Confirmá que entendés el riesgo de duplicación en ELM.',
    provider_reference_required: 'Indicá la referencia de autorización de ELM (ticket, mail, etc.).',
    send_not_allowed: 'Este caso no admite envío a ELM en este momento.',
    send_failed: 'El envío no se completó. Revisá el resultado en la tabla.',
    gestion_send_reconcile_required: 'Requiere conciliación con ELM antes de reenviar.',
    gestion_send_use_close_reject: 'Use «Cerrar como rechazado»; no reenvíe a ELM.',
    elm_gestion_full_resend_unavailable:
      'Reenvío completo bloqueado: hace falta RPC elm_admin_provider_resend en base de datos.',
    elm_mobilephone_needs_correction: 'Corregí el celular en Credizona antes de enviar.',
    missing_required_fields: 'Faltan datos obligatorios para ELM.',
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
    if (hours == null || hours === '') return '—';
    const h = Math.floor(Number(hours));
    if (!Number.isFinite(h) || h < 0) return '—';
    if (h < 24) return h + ' h';
    const d = Math.floor(h / 24);
    const rem = h % 24;
    return rem ? d + ' d ' + rem + ' h' : d + ' d';
  }

  function defaultFmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('es-UY', {
      timeZone: 'America/Montevideo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
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

  const GESTION_TAB_ENABLED = true;

  function opportunityMatches(item, ciQuery, situation, vintage, lane) {
    if (situation && item.situation !== situation) return false;
    if (vintage && item.vintage !== vintage) return false;
    if (lane && item.lane !== lane) return false;
    const q = String(ciQuery || '').replace(/\D/g, '');
    if (!q) return true;
    const ci = String(item.ci || '').replace(/\D/g, '');
    const cz = String(item.cz_solicitud_id || '');
    return ci.indexOf(q) !== -1 || cz.indexOf(q) !== -1;
  }

  function gestionActionFormHtml(action) {
    if (!action) return '';
    if (action.id === 'close_reject') {
      return (
        '<form class="elm-ops-form" data-elm-ops-form="close-reject">' +
        '<p>' + esc(action.explanation) + '</p>' +
        '<label>Nota (obligatoria) <textarea name="note" minlength="10" maxlength="2000" required></textarea></label>' +
        '<label class="elm-ops-confirm"><input type="checkbox" name="confirm" value="1" required> ' +
        'Confirmo que existe evidencia de rechazo definitivo de ELM y que esta acción no envía nada a ELM.</label>' +
        '<button type="submit" class="btn">Cerrar como rechazado</button> ' +
        '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
        '</form>'
      );
    }
    if (action.id === 'retry_s1') {
      return (
        '<form class="elm-ops-form" data-elm-ops-form="retry-s1">' +
        '<p>' + esc(action.explanation) + '</p>' +
        '<label class="elm-ops-confirm"><input type="checkbox" name="confirm" value="1" required> ' +
        'Confirmo que ELM no recibió este envío y que reintento el mismo paso 1 del proceso existente. ' +
        'No se crea otra solicitud.</label>' +
        '<button type="submit" class="btn">Reintentar S1</button> ' +
        '<button type="button" class="btn" data-elm-ops-action="cancel">Cancelar</button>' +
        '</form>'
      );
    }
    return '';
  }

  function gestionSendFormHtml(preview, cz) {
    if (!preview) return '';
    const dup = preview.duplicate_warning
      ? '<p class="elm-ops-warn">' + esc(preview.duplicate_warning) + '</p>'
      : '';
    const refRequired =
      preview.provider_reference_required_for_hold || preview.requires_provider_reference === true;
    const holdRef = refRequired
      ? '<label>Referencia ELM (obligatoria) <input name="provider_reference" minlength="4" maxlength="200" required></label>'
      : '<label>Referencia ELM (si ELM autorizó reenvío) <input name="provider_reference" maxlength="200"></label>';
    const versionField =
      preview.expected_updated_at
        ? '<input type="hidden" name="expected_updated_at" value="' + esc(String(preview.expected_updated_at)) + '">'
        : '';
    return (
      '<form class="elm-ops-form elm-ops-send-form" data-elm-ops-form="send-to-elm" data-elm-cz="' +
      esc(String(cz)) +
      '">' +
      '<p><strong>CI</strong> ' +
      esc(preview.ci || '—') +
      ' · <strong>Solicitud</strong> ' +
      esc(String(cz)) +
      '</p>' +
      '<p>S1: ' +
      esc(preview.s1_status || '—') +
      ' · S2: ' +
      esc(preview.s2_status || '—') +
      ' · Último envío: ' +
      esc(preview.last_send_at ? preview.last_send_at : '—') +
      '</p>' +
      dup +
      holdRef +
      versionField +
      '<label class="elm-ops-confirm"><input type="checkbox" name="confirm" value="1" required> Confirmo enviar o reenviar a ELM desde Gestión ELM.</label>' +
      (preview.duplicate_warning
        ? '<label class="elm-ops-confirm"><input type="checkbox" name="confirm_duplicate" value="1" required> Confirmo el riesgo de duplicación.</label>'
        : '') +
      '<button type="submit" class="btn">Enviar a ELM</button> ' +
      '<button type="button" class="btn" data-elm-ops-action="cancel-send">Cancelar</button>' +
      '</form>'
    );
  }

  function gestionSendBlockedHtml(preview, cz) {
    if (!preview) return '';
    const code = preview.code || preview.status || 'send_not_allowed';
    const modeHint = preview.intended_mode || preview.mode || null;
    const intentLine =
      modeHint === 'admin_provider_resend'
        ? '<p><strong>Acción prevista:</strong> reenvío completo S1+S2 autorizado por ELM ' +
          '(referencia ELM y confirmación de duplicados al habilitarse).</p>'
        : '';
    const warns = (preview.warnings || []).map(function (w) {
      return '<p class="elm-ops-warn">' + esc(w) + '</p>';
    }).join('');
    const dup = preview.duplicate_warning
      ? '<p class="elm-ops-warn">' + esc(preview.duplicate_warning) + '</p>'
      : '';
    return (
      '<div class="elm-ops-send-blocked" data-elm-cz="' +
      esc(String(cz)) +
      '">' +
      '<p><strong>CI</strong> ' +
      esc(preview.ci || '—') +
      ' · <strong>Solicitud</strong> ' +
      esc(String(cz)) +
      '</p>' +
      intentLine +
      '<p class="elm-ops-warn"><strong>No se puede enviar:</strong> ' +
      esc(actionErrorText(code)) +
      '</p>' +
      dup +
      warns +
      '<p class="preaprobados-muted">S1: ' +
      esc(preview.s1_status || '—') +
      ' · S2: ' +
      esc(preview.s2_status || '—') +
      '</p>' +
      '<button type="button" class="btn" data-elm-ops-action="cancel-send">Cerrar</button>' +
      '</div>'
    );
  }

  function gestionSendPreviewHtml(preview, cz) {
    if (!preview) return '';
    if (preview.can_send === true) return gestionSendFormHtml(preview, cz);
    return gestionSendBlockedHtml(preview, cz);
  }

  function gestionAdminSlotHtml(item, opts) {
    const o = opts || {};
    const actions = item.allowed_actions || [];
    const stageActions = actions.filter(function (a) {
      return a.id !== 'send_elm';
    });
    const subclass = item.s1_subclass;
    const notice = o.notice;
    let html = '<div class="elm-ops-admin-slot" data-elm-ops-admin-slot data-elm-cz="' +
      esc(String(item.cz_solicitud_id)) + '">';
    if (notice) {
      html += '<div class="rechazados-elm-msg is-' + esc(notice.tone) + '">' + esc(notice.text) + '</div>';
    }
    if (subclass === 'uncertain') {
      html +=
        '<p class="elm-ops-reconcile"><strong>Requiere conciliación con ELM.</strong> ' +
        'No sabemos si ELM recibió o procesó esta solicitud. El reenvío está bloqueado hasta resolver la incertidumbre.</p>';
    } else if (subclass === 'tech_not_processed' && !stageActions.length) {
      html +=
        '<p class="preaprobados-muted">Hay evidencia de que ELM no ejecutó el RESTlet, ' +
        'pero el reintento existente no aplica a este origen. Sin reenvío hasta una autorización específica.</p>';
    }
    if (o.canAct !== true) {
      if (stageActions.length) {
        html += '<p class="preaprobados-muted">Solo un administrador puede ejecutar estas acciones.</p>';
      } else if (subclass !== 'uncertain' && subclass !== 'tech_not_processed') {
        html += '<p class="preaprobados-muted">No hay acciones administrativas válidas para esta solicitud.</p>';
      }
      return html + '</div>';
    }
    if (o.openAction) {
      const action = actions.filter(function (a) { return a.id === o.openAction; })[0];
      html += gestionActionFormHtml(action);
      return html + '</div>';
    }
    for (let i = 0; i < stageActions.length; i += 1) {
      const a = stageActions[i];
      html +=
        '<button type="button" class="btn btn-sm" data-elm-ops-action="' + esc(a.id) +
        '" title="' + esc(a.explanation) + '">' + esc(a.label) + '</button> ';
    }
    if (!stageActions.length && subclass !== 'uncertain' && subclass !== 'tech_not_processed') {
      html += '<p class="preaprobados-muted">No hay acciones administrativas válidas para esta solicitud.</p>';
    }
    return html + '</div>';
  }

  function opportunityRowHtml(item, fmtDate, openId, opts) {
    const o = opts || {};
    const gestion = o.tableMode === 'gestion';
    const cz = String(item.cz_solicitud_id);
    const open = String(openId) === cz;
    const tech = item.technical || {};
    const related = item.related_cz_solicitud_id
      ? '<p>Otra solicitud: ' + esc(item.related_cz_solicitud_id) + '</p>'
      : '';
    const sendAct = (item.allowed_actions || []).filter(function (a) {
      return a.id === 'send_elm';
    })[0];
    const sendEnabled = sendAct && sendAct.enabled !== false;
    const canSendBtn =
      gestion && o.canAct === true && sendAct
        ? '<button type="button" class="btn btn-sm btn-primary' +
          (sendEnabled ? '' : ' is-muted') +
          '" data-elm-ops-send-open="' +
          esc(cz) +
          '" title="' +
          esc(sendAct.explanation || 'Enviar a ELM') +
          '">Enviar a ELM</button> '
        : '';
    const sendOpen = gestion && String(o.openSendCz) === cz;
    const sendBlock = sendOpen
      ? '<div class="elm-ops-send-slot">' +
        (o.sendPreviewLoading
          ? '<p class="preaprobados-muted">Cargando confirmación…</p>'
          : gestionSendPreviewHtml(o.sendPreview, cz)) +
        '</div>'
      : '';
    const extraCols = gestion
      ? '<td>' +
        esc(item.last_send_action || '—') +
        '</td><td>' +
        esc(item.last_send_at ? fmtDate(item.last_send_at) : '—') +
        '</td><td>' +
        esc(item.last_send_result || '—') +
        '</td><td>' +
        esc(item.elm_commercial_label || item.last_elm || '—') +
        '</td>'
      : '';
    const colSpan = gestion ? 15 : 11;
    return (
      '<tr data-elm-cz="' + esc(cz) + '"' + (open ? ' class="is-open"' : '') + '>' +
      '<td>' + esc(item.ci || '—') + '</td>' +
      '<td>' + esc(cz) + '</td>' +
      '<td><span class="elm-ops-flag">' +
        esc(item.vintage_label || '—') + '</span></td>' +
      '<td><span class="elm-ops-flag' +
        (item.attention ? ' elm-ops-flag-danger' : '') + '">' +
        esc(item.lane_label || item.situation_label || '—') + '</span></td>' +
      '<td>' + esc(item.situation_label || '—') + '</td>' +
      '<td>' + esc(item.reason_label || '—') + '</td>' +
      '<td>' + esc(fmtDate(item.since)) + '</td>' +
      '<td>' + esc(fmtAge(item.age_hours)) + '</td>' +
      '<td>' + esc(item.last_elm || '—') + '</td>' +
      '<td>' + esc(item.next_step || '—') + '</td>' +
      extraCols +
      '<td class="elm-ops-actions" data-elm-ops-actions data-elm-next="' +
        esc(item.next_step_key || 'none') + '">' +
      canSendBtn +
      sendBlock +
      '<button type="button" class="btn btn-sm" data-elm-ops-open-detail="' + esc(cz) + '">' +
      (open ? 'Ocultar' : 'Ver detalle') + '</button></td></tr>' +
      (open
        ? '<tr class="elm-ops-detail-row"><td colspan="' +
          colSpan +
          '"><div class="elm-ops-detail">' +
          '<p class="preaprobados-muted">Historial técnico (diagnóstico). Las acciones de envío usan el mismo circuito manual que Preaprobados/Rechazados.</p>' +
          related +
          '<dl class="preaprobados-dl">' +
          '<div><dt>Paso 1</dt><dd>' + esc(tech.s1_status || '—') + '</dd></div>' +
          '<div><dt>Paso 2</dt><dd>' + esc(tech.s2_status || '—') + '</dd></div>' +
          '<div><dt>Motivo interno</dt><dd>' + esc(tech.review_reason || tech.followup_kind || '—') + '</dd></div>' +
          '<div><dt>Estado ELM</dt><dd>' + esc(tech.provider_status || '—') + '</dd></div>' +
          '<div><dt>Origen</dt><dd>' + esc(tech.trigger_origin || '—') + '</dd></div>' +
          (item.s1_subclass_label
            ? '<div><dt>Clasificación S1</dt><dd>' + esc(item.s1_subclass_label) + '</dd></div>'
            : '') +
          (tech.s1_result_message
            ? '<div><dt>Texto S1</dt><dd>' + esc(tech.s1_result_message) + '</dd></div>'
            : '') +
          '</dl>' +
          gestionAdminSlotHtml(item, opts) +
          '</div></td></tr>'
        : '')
    );
  }

  function opportunitiesTableHtml(items, fmtDate, openId, opts) {
    if (!items.length) {
      return '<p class="preaprobados-muted">No hay casos ELM con ese filtro.</p>';
    }
    const gestion = opts && opts.tableMode === 'gestion';
    const headExtra = gestion
      ? '<th>Última acción</th><th>Fecha envío</th><th>Resultado</th><th>Estado comercial ELM</th>'
      : '';
    return (
      '<div class="table-wrap"><table class="mcl-table elm-ops-opportunities">' +
      '<thead><tr><th>CI</th><th>Solicitud</th><th>Origen</th><th>Carril</th><th>Situación</th><th>Motivo</th>' +
      '<th>Desde</th><th>Antigüedad</th><th>Última respuesta ELM</th><th>Próximo paso</th>' +
      headExtra +
      '<th></th></tr></thead><tbody>' +
      items.map(function (i) {
        const rowOpts = opts || {};
        const mine = String(rowOpts.openCz) === String(i.cz_solicitud_id);
        const sendCz = String(rowOpts.openSendCz) === String(i.cz_solicitud_id);
        return opportunityRowHtml(i, fmtDate, openId, {
          canAct: rowOpts.canAct,
          openAction: mine ? rowOpts.openAction : null,
          notice: mine ? rowOpts.notice : null,
          tableMode: rowOpts.tableMode,
          openSendCz: sendCz ? rowOpts.openSendCz : null,
          sendPreview: sendCz ? rowOpts.sendPreview : null,
          sendPreviewLoading: sendCz ? rowOpts.sendPreviewLoading : false,
        });
      }).join('') +
      '</tbody></table></div>'
    );
  }

  function bindReadOnlyUi(root, state, render) {
    if (state.bound) return;
    state.bound = true;
    root.addEventListener('input', function (ev) {
      const t = ev.target;
      if (!t || t.getAttribute('data-elm-ops-search') == null) return;
      state.ciQuery = t.value || '';
      render();
    });
    root.addEventListener('change', function (ev) {
      const t = ev.target;
      if (!t || t.getAttribute('data-elm-ops-filter') == null) return;
      const which = t.getAttribute('data-elm-ops-filter');
      if (which === 'vintage') state.vintage = t.value || '';
      else if (which === 'lane') state.lane = t.value || '';
      else state.situation = t.value || '';
      render();
    });
    root.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      const cancelSend = t.closest('[data-elm-ops-action="cancel-send"]');
      if (cancelSend) {
        state.openSendCz = null;
        state.sendPreview = null;
        state.sendPreviewLoading = false;
        render();
        return;
      }
      const cancel = t.closest('[data-elm-ops-action="cancel"]');
      if (cancel && cancel.getAttribute && cancel.getAttribute('data-elm-ops-action') === 'cancel') {
        state.openAction = null;
        render();
        return;
      }
      const sendOpen = t.closest('[data-elm-ops-send-open]');
      if (sendOpen && state.onSendOpen) {
        state.onSendOpen(sendOpen.getAttribute('data-elm-ops-send-open'));
        return;
      }
      const actBtn = t.closest('[data-elm-ops-action]');
      if (
        actBtn &&
        state.onActionClick &&
        actBtn.getAttribute &&
        actBtn.getAttribute('data-elm-ops-action') &&
        actBtn.getAttribute('data-elm-ops-action') !== 'cancel'
      ) {
        state.onActionClick(actBtn);
        return;
      }
      const btn = t.closest('[data-elm-ops-open-detail]');
      const cz = btn && btn.getAttribute ? btn.getAttribute('data-elm-ops-open-detail') : null;
      if (!cz) return;
      state.openId = String(state.openId) === String(cz) ? null : cz;
      state.openAction = null;
      render();
    });
    root.addEventListener('submit', function (ev) {
      const form = ev.target;
      if (!form || !form.getAttribute || !form.getAttribute('data-elm-ops-form')) return;
      ev.preventDefault();
      if (state.onActionSubmit) state.onActionSubmit(form);
    });
  }

  /**
   * Transitory «Gestión ELM» desk: GET /gestion. Admin actions (close / retry) only
   * for the solicitudes that the backend listed as valid; one at a time; confirmation required.
   */
  function mount(opts) {
    const root = opts.root;
    const api = opts.api || '';
    const fmtDate = opts.fmtDate || defaultFmtDate;
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const state = {
      items: [],
      situations: [],
      vintages: [],
      lanes: [],
      ciQuery: '',
      situation: '',
      vintage: '',
      lane: 'attention',
      openId: null,
      openAction: null,
      openSendCz: null,
      sendPreview: null,
      sendPreviewLoading: false,
      notice: null,
      canAct: opts.canAct === true ? true : false,
      busy: false,
      error: null,
      bound: false,
      onActionClick: null,
      onActionSubmit: null,
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

    function optionList(items, current, emptyLabel) {
      return ['<option value="">' + esc(emptyLabel) + '</option>'].concat(
        (items || []).map(function (s) {
          return (
            '<option value="' + esc(s.id) + '"' +
            (current === s.id ? ' selected' : '') + '>' +
            esc(s.label) + '</option>'
          );
        }),
      );
    }

    function visibleItems() {
      return state.items.filter(function (i) {
        return opportunityMatches(i, state.ciQuery, state.situation, state.vintage, state.lane);
      });
    }

    function render() {
      const vis = visibleItems();
      let html =
        '<header class="elm-ops-head">' +
        '<h2 class="elm-ops-title">Gestión ELM</h2>' +
        '<p class="preaprobados-muted">Mesa transitoria para pendientes C1/ELM. ' +
        'Por defecto se listan solo los casos que requieren gestión. ' +
        'Seguimiento y préstamos otorgados se consultan con el filtro de carril; no son un error. ' +
        'Las acciones administrativas aparecen solo cuando hay evidencia; una solicitud a la vez, con confirmación. ' +
        'Un resultado S1 unknown no significa que ELM no haya recibido la solicitud.</p>' +
        '</header>' +
        '<div class="elm-ops-toolbar">' +
        '<label class="elm-ops-search">CI o solicitud ' +
        '<input type="search" data-elm-ops-search value="' + esc(state.ciQuery) +
        '" placeholder="Buscar CI" autocomplete="off"></label>' +
        '<label class="elm-ops-filter">Origen <select data-elm-ops-filter="vintage">' +
        optionList(state.vintages, state.vintage, 'Todos los orígenes').join('') +
        '</select></label>' +
        '<label class="elm-ops-filter">Carril <select data-elm-ops-filter="lane">' +
        optionList(state.lanes, state.lane, 'Todos los carriles').join('') +
        '</select></label>' +
        '<label class="elm-ops-filter">Situación <select data-elm-ops-filter="situation">' +
        optionList(state.situations, state.situation, 'Todas las situaciones').join('') +
        '</select></label>' +
        '<span class="preaprobados-muted">' + vis.length + ' de ' + state.items.length + '</span>' +
        '</div>';
      if (state.error) html += '<div class="mcl-status mcl-error">' + esc(state.error) + '</div>';
      html += opportunitiesTableHtml(vis, fmtDate, state.openId, {
        canAct: state.canAct,
        openCz: state.openId,
        openAction: state.openAction,
        notice: state.notice,
        tableMode: 'gestion',
        openSendCz: state.openSendCz,
        sendPreview: state.sendPreview,
        sendPreviewLoading: state.sendPreviewLoading,
      });
      root.innerHTML = html;
      bindReadOnlyUi(root, state, render);
    }

    function itemByCz(cz) {
      return state.items.filter(function (i) {
        return String(i.cz_solicitud_id) === String(cz);
      })[0] || null;
    }

    state.onSendOpen = async function (cz) {
      if (state.canAct !== true || state.busy) return;
      state.openSendCz = String(cz);
      state.sendPreview = null;
      state.sendPreviewLoading = true;
      state.notice = null;
      render();
      let out;
      try {
        out = await request('GET', '/gestion/' + encodeURIComponent(cz) + '/send-preview');
      } catch (_) {
        out = { status: 0, data: {} };
      }
      state.sendPreviewLoading = false;
      if (out.status === 200 && out.data) {
        state.sendPreview = out.data;
      } else {
        state.openSendCz = null;
        state.notice = {
          tone: 'error',
          text:
            out.status === 0
              ? 'No se pudo cargar la confirmación.'
              : actionErrorText((out.data && out.data.code) || (out.data && out.data.status)),
        };
      }
      render();
    };

    state.onActionClick = function (btn) {
      if (state.canAct !== true || state.busy) return;
      const id = btn.getAttribute('data-elm-ops-action');
      if (!id || id === 'cancel') return;
      const slot = btn.closest('[data-elm-ops-admin-slot]');
      const cz = slot && slot.getAttribute('data-elm-cz');
      const item = itemByCz(cz);
      if (!item || !(item.allowed_actions || []).some(function (a) { return a.id === id; })) return;
      state.openId = String(cz);
      state.openAction = id;
      state.notice = null;
      render();
    };

    state.onActionSubmit = async function (form) {
      if (state.canAct !== true || state.busy) return;
      const kind = form.getAttribute('data-elm-ops-form');
      if (kind === 'send-to-elm') {
        if (!state.sendPreview || state.sendPreview.can_send !== true) {
          state.notice = {
            tone: 'error',
            text: actionErrorText(
              (state.sendPreview && state.sendPreview.code) || 'send_not_allowed',
            ),
          };
          render();
          return;
        }
        const czSend = form.getAttribute('data-elm-cz');
        const confirmElSend = form.elements.confirm;
        if (!confirmElSend || !confirmElSend.checked) {
          state.notice = { tone: 'error', text: actionErrorText('confirm_required') };
          render();
          return;
        }
        const bodySend = { confirm: true };
        if (form.elements.provider_reference && form.elements.provider_reference.value) {
          bodySend.provider_reference = form.elements.provider_reference.value;
        }
        if (form.elements.confirm_duplicate && form.elements.confirm_duplicate.checked) {
          bodySend.confirm_duplicate = true;
        }
        if (form.elements.expected_updated_at && form.elements.expected_updated_at.value) {
          bodySend.expected_updated_at = form.elements.expected_updated_at.value;
        }
        state.busy = true;
        let sendOut;
        try {
          sendOut = await request(
            'POST',
            '/gestion/' + encodeURIComponent(czSend) + '/send-to-elm',
            bodySend,
          );
        } catch (_) {
          sendOut = { status: 0, data: {} };
        }
        state.busy = false;
        if (sendOut.status === 200) {
          state.openSendCz = null;
          state.sendPreview = null;
          state.notice = {
            tone: 'ok',
            text:
              'Envío registrado. Resultado: ' +
              String((sendOut.data && sendOut.data.outcome) || 'ok'),
          };
          await load();
          return;
        }
        state.notice = {
          tone: 'error',
          text:
            sendOut.status === 0
              ? 'No se pudo conectar.'
              : actionErrorText((sendOut.data && sendOut.data.status) || (sendOut.data && sendOut.data.code)),
        };
        render();
        return;
      }
      const slot = form.closest('[data-elm-ops-admin-slot]');
      const cz = slot && slot.getAttribute('data-elm-cz');
      const item = itemByCz(cz);
      if (!item) return;
      const action = (item.allowed_actions || []).filter(function (a) {
        return (kind === 'close-reject' && a.id === 'close_reject') ||
          (kind === 'retry-s1' && a.id === 'retry_s1');
      })[0];
      if (!action) return;
      const confirmEl = form.elements.confirm;
      if (!confirmEl || !confirmEl.checked) {
        state.notice = { tone: 'error', text: actionErrorText('confirm_required') };
        render();
        return;
      }
      const body = { confirm: true };
      let path = '/gestion/' + encodeURIComponent(cz);
      if (action.id === 'close_reject') {
        body.note = form.elements.note ? form.elements.note.value : '';
        body.expected_version = action.expected_version;
        if (action.expected_updated_at) body.expected_updated_at = action.expected_updated_at;
        path += '/close-reject';
      } else {
        body.expected_attempts = action.expected_attempts;
        path += '/retry-s1';
      }
      state.busy = true;
      let out;
      try {
        out = await request('POST', path, body);
      } catch (_) {
        out = { status: 0, data: {} };
      }
      state.busy = false;
      const status = out.data && out.data.status;
      if (out.status === 200) {
        state.openAction = null;
        state.notice = {
          tone: 'ok',
          text: action.id === 'close_reject'
            ? 'Rechazo registrado y auditado. No se envió nada a ELM.'
            : 'Reintento S1 ejecutado sobre el proceso existente.',
        };
        await load();
        return;
      }
      state.notice = {
        tone: 'error',
        text: out.status === 0 ? 'No se pudo conectar.' : actionErrorText(status || (out.data && out.data.code)),
      };
      if (status === 'stale' || status === 'already_resolved' || status === 'retry_not_allowed') {
        state.openAction = null;
        await load();
      } else {
        render();
      }
    };

    function applyViewerMaySendElm(flag) {
      if (typeof flag === 'boolean') state.canAct = flag;
    }

    async function resolveCanAct() {
      if (opts.canAct === true) {
        state.canAct = true;
        return;
      }
      if (typeof window !== 'undefined' && window.__janusDashboardIsAdmin === true) {
        state.canAct = true;
        return;
      }
      try {
        const assignees = await request('GET', '/assignees');
        if (assignees.status === 200) {
          state.canAct = true;
          return;
        }
      } catch (_) {
        /* fall through */
      }
      try {
        const me = await fetchFn((api || '') + '/api/auth/me', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (me.status === 200) {
          const data = await me.json().catch(function () {
            return {};
          });
          state.canAct = !!(data.user && data.user.is_admin === true);
        }
      } catch (_) {
        state.canAct = false;
      }
    }

    async function load() {
      state.error = null;
      try {
        await resolveCanAct();
        const res = await request('GET', '/gestion');
        if (res.status >= 400) {
          state.error = 'No se pudo cargar Gestión ELM.';
          state.items = [];
          state.situations = [];
          state.vintages = [];
          state.lanes = [];
        } else {
          applyViewerMaySendElm(res.data.viewer_may_send_elm);
          state.items = res.data.items || [];
          state.situations = res.data.situations || [];
          state.vintages = res.data.vintages || [];
          state.lanes = res.data.lanes || [];
        }
      } catch (_) {
        state.error = 'No se pudo cargar Gestión ELM.';
        state.items = [];
      }
      render();
    }

    bindReadOnlyUi(root, state, render);
    return {
      load: load,
      syncAdminAccess: function (isAdmin) {
        applyViewerMaySendElm(isAdmin === true);
        render();
      },
    };
  }

  /** Rechazados strip: C1 recuperables in estado 3. GET only. */
  function mountRecoverable(opts) {
    const root = opts.root;
    const api = opts.api || '';
    const fmtDate = opts.fmtDate || defaultFmtDate;
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    const state = { items: [], openId: null, error: null, bound: false, ciQuery: '', situation: '' };

    function render() {
      let html =
        '<header class="elm-ops-head">' +
        '<h2 class="elm-ops-title">Recuperables ELM</h2>' +
        '<p class="preaprobados-muted">Casos C1 en Rechazados que todavía se pueden completar en ELM. ' +
        'No cambian los KPIs ni el listado de rechazos. Etapa A: lectura.</p>' +
        '</header>';
      if (state.error) html += '<div class="mcl-status mcl-error">' + esc(state.error) + '</div>';
      if (!state.items.length && !state.error) {
        html += '<p class="preaprobados-muted">No hay recuperables ELM en este momento.</p>';
      } else {
        html += opportunitiesTableHtml(state.items, fmtDate, state.openId);
      }
      root.innerHTML = html;
      bindReadOnlyUi(root, state, render);
    }

    async function load() {
      state.error = null;
      try {
        const res = await fetchFn(api + '/rechazados/elm-recoverable', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        const data = await res.json().catch(function () { return {}; });
        if (res.status >= 400) {
          state.error = 'No se pudieron cargar los recuperables ELM.';
          state.items = [];
        } else {
          state.items = data.items || [];
        }
      } catch (_) {
        state.error = 'No se pudieron cargar los recuperables ELM.';
        state.items = [];
      }
      render();
    }

    bindReadOnlyUi(root, state, render);
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
    mountRecoverable,
    opportunityRowHtml,
    gestionAdminSlotHtml,
    gestionActionFormHtml,
    gestionSendFormHtml,
    defaultFmtDate,
    GESTION_TAB_ENABLED,
  };
});
