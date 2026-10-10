/* ELM operations (Fase 3B): active referrals / uncertain ELM results + manual review queue.
 * The dashboard uses createProcessResolver ("Resolver ELM" in the Rechazados / Preaprobados
 * solicitud detail); mount() is no longer placed on any screen. Pure helpers are exported for
 * Node tests (UMD).
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
    const parts = ['S1 ' + elm.s1_status, 'S2 ' + elm.s2_status];
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

  /** DOM wiring. @param {{ root: HTMLElement, api: string, fmtDate: Function }} opts */
  function mount(opts) {
    const root = opts.root;
    const api = opts.api || '';
    const fmtDate = opts.fmtDate || function (iso) { return iso || '—'; };
    const state = {
      summary: null,
      processes: [],
      cases: [],
      kpis: null,
      followup: [],
      assignees: null,
      canAct: false,
      error: null,
      message: null,
      openForm: null,
    };

    async function request(method, path, body) {
      const res = await fetch(api + '/preaprobados/elm-ops' + path, {
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

    function render() {
      const alert = alertText(state.summary);
      let html = '';
      if (alert) html += '<div class="elm-ops-alert" role="alert">' + esc(alert) + '</div>';
      if (state.error) html += '<div class="mcl-status mcl-error">' + esc(state.error) + '</div>';
      if (state.message) html += '<div class="mcl-status">' + esc(state.message) + '</div>';

      if (state.kpis) {
        html +=
          '<details class="elm-ops-section">' +
          '<summary>KPI ELM (todos los procesos, por origen)</summary>' +
          '<p class="preaprobados-muted">Flujo: lo que pasó con los procesos iniciados (no baja si el estado cambia). ' +
          'Estado actual: dónde está hoy cada proceso. Un proceso por solicitud; sin datos CDV. ' +
          '"Aceptados S2" no son préstamos otorgados: solo "Otorgados ELM" confirma el desembolso.</p>' +
          '<h4>Flujo</h4>' + kpiTableHtml(state.kpis.flow, FLOW_LABELS) +
          '<h4>Estado actual</h4>' + kpiTableHtml(state.kpis.current, CURRENT_LABELS) +
          '</details>';
      }

      html +=
        '<details class="elm-ops-section"' + (state.followup.length ? ' open' : '') + '>' +
        '<summary>Seguimiento operativo ELM (' + state.followup.length + ')</summary>' +
        '<p class="preaprobados-muted">En evaluación (S1 favorable con S2 pendiente incluido), errores técnicos o resultados inciertos, ' +
        'rechazos automáticos todavía no reflejados en Credizona y solicitudes en cola. No cuentan como rechazos.</p>' +
        (state.followup.length
          ? '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Origen</th><th>Situación</th>' +
            '<th>Detalle</th><th>Estado ELM</th><th>Desde</th><th>Antigüedad</th></tr></thead><tbody>' +
            state.followup.map(function (i) { return followupRowHtml(i, fmtDate); }).join('') +
            '</tbody></table>'
          : '<p class="preaprobados-muted">Sin casos en seguimiento.</p>') +
        '</details>';

      html +=
        '<details class="elm-ops-section"' + (state.processes.length ? ' open' : '') + '>' +
        '<summary>Derivaciones ELM activas y resultados inciertos (' + state.processes.length + ')</summary>' +
        '<p class="preaprobados-muted">Mientras figuren acá, ninguna otra solicitud de la misma CI se envía a ELM. ' +
        'No vencen solas: se cierran con una resolución manual auditada.</p>' +
        (state.processes.length
          ? '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Tipo</th><th>Desde</th>' +
            '<th>Antigüedad</th><th>Estado ELM</th><th>Último evento</th><th>Solicitudes no enviadas</th><th></th></tr></thead><tbody>' +
            state.processes.map(function (p) {
              let row = processRowHtml(p, fmtDate, state.canAct);
              if (state.openForm && state.openForm.id === p.process_id) {
                row += '<tr><td colspan="9">' + resolveProcessFormHtml(p) + '</td></tr>';
              }
              return row;
            }).join('') +
            '</tbody></table>'
          : '<p class="preaprobados-muted">Sin derivaciones activas.</p>') +
        '</details>';

      html +=
        '<details class="elm-ops-section"' + (state.cases.length ? ' open' : '') + '>' +
        '<summary>Revisión manual ELM (' + state.cases.length + ')</summary>' +
        (state.cases.length
          ? '<table class="mcl-table"><thead><tr><th>Solicitud</th><th>CI</th><th>Motivo</th><th>Ingreso</th>' +
            '<th>Antigüedad</th><th>Estado ELM</th><th>Responsable</th><th>Prioridad</th><th>Vence</th><th></th></tr></thead><tbody>' +
            state.cases.map(function (c) {
              let row = caseRowHtml(c, fmtDate, state.canAct);
              if (state.openForm && state.openForm.id === c.id) {
                const f = state.openForm.kind;
                const form =
                  f === 'assign' ? assignFormHtml(c, state.assignees) :
                  f === 'triage' ? triageFormHtml(c) : resolveCaseFormHtml();
                row += '<tr><td colspan="10">' + form + '</td></tr>';
              }
              return row;
            }).join('') +
            '</tbody></table>'
          : '<p class="preaprobados-muted">Sin casos abiertos.</p>') +
        '</details>';
      root.innerHTML = html;
    }

    async function load() {
      state.error = null;
      try {
        const [s, p, c, k, f] = await Promise.all([
          request('GET', '/summary'),
          request('GET', '/processes'),
          request('GET', '/review-cases?status=open'),
          request('GET', '/kpis'),
          request('GET', '/followup'),
        ]);
        if (s.status >= 400 || p.status >= 400 || c.status >= 400) {
          state.error = 'No se pudieron cargar las colas ELM.';
        } else {
          state.summary = s.data.data;
          state.processes = p.data.items || [];
          state.cases = c.data.items || [];
        }
        state.kpis = k.status === 200 ? k.data.data : null;
        state.followup = f.status === 200 ? f.data.items || [] : [];
        if (state.assignees === null) {
          const a = await request('GET', '/assignees');
          state.canAct = a.status === 200;
          state.assignees = a.status === 200 ? a.data.items || [] : [];
        }
      } catch (_) {
        state.error = 'No se pudieron cargar las colas ELM.';
      }
      render();
    }

    function findProcess(id) {
      return state.processes.find(function (p) { return p.process_id === id; });
    }
    function findCase(id) {
      return state.cases.find(function (c) { return c.id === id; });
    }

    async function submit(kind, form) {
      const fd = new FormData(form);
      const target = state.openForm;
      let out;
      if (kind === 'resolve-process') {
        const p = findProcess(target.id);
        const choice = parseResolutionChoice(fd.get('resolution_code'));
        out = await request('POST', '/processes/' + encodeURIComponent(target.id) + '/resolve', {
          expected_updated_at: p ? p.version : null,
          resolution_code: choice.resolution_code,
          correction: choice.correction,
          cz_outcome: fd.get('cz_outcome'),
          note: fd.get('note'),
        });
      } else {
        const c = findCase(target.id);
        const base = { expected_version: c ? c.version : null };
        const path = '/review-cases/' + encodeURIComponent(target.id);
        if (kind === 'assign') {
          out = await request('POST', path + '/assign', Object.assign(base, {
            assignee_user_id: fd.get('assignee_user_id') || null,
          }));
        } else if (kind === 'triage') {
          const local = new Date(String(fd.get('due_at') || ''));
          out = await request('POST', path + '/triage', Object.assign(base, {
            priority: fd.get('priority'),
            due_at: Number.isFinite(local.getTime()) ? local.toISOString() : null,
          }));
        } else {
          out = await request('POST', path + '/resolve', Object.assign(base, {
            resolution_code: fd.get('resolution_code'),
            cz_outcome: fd.get('cz_outcome'),
            note: fd.get('note'),
          }));
        }
      }
      const status = out.data && out.data.status;
      if (out.status === 200) {
        state.openForm = null;
        state.message = 'Acción registrada.';
      } else {
        state.message = null;
        state.error = actionErrorText(status);
        if (status === 'stale') state.openForm = null;
      }
      await load();
      if (out.status !== 200) {
        state.error = actionErrorText(status);
        render();
      }
    }

    root.addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-elm-ops-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-elm-ops-action');
      state.message = null;
      state.error = null;
      if (action === 'cancel') {
        state.openForm = null;
      } else {
        const pr = btn.closest('[data-process-id]');
        const cr = btn.closest('[data-case-id]');
        const id = pr ? pr.getAttribute('data-process-id') : cr ? cr.getAttribute('data-case-id') : null;
        state.openForm = id ? { kind: action, id: id } : null;
      }
      render();
    });

    root.addEventListener('submit', function (ev) {
      const form = ev.target.closest('[data-elm-ops-form]');
      if (!form) return;
      ev.preventDefault();
      submit(form.getAttribute('data-elm-ops-form'), form).catch(function () {
        state.error = 'No se pudo completar la acción.';
        render();
      });
    });

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
