'use strict';

/**
 * MIE — Market Intelligence Center (Dashboard v1)
 * Frontend only. Consumes GET /reports/daily-summary?date=YYYY-MM-DD.
 * No LLM, no build tools, no dependencies.
 */

// When opened directly as a file:// the relative path cannot reach the API,
// so fall back to the production backend. Otherwise use relative paths.
const API_BASE = window.location.protocol === 'file:'
  ? 'https://mie-backend-production.up.railway.app'
  : '';

const EVENT_TYPE_LABELS = {
  new_ad: 'Anuncio nuevo',
  copy_changed: 'Cambio de copy',
  ad_reactivated: 'Reactivado',
  ad_deactivated: 'Desactivado',
};

const EVENT_TYPE_OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'new_ad', label: 'Anuncio nuevo' },
  { value: 'copy_changed', label: 'Cambio de copy' },
  { value: 'ad_reactivated', label: 'Reactivado' },
  { value: 'ad_deactivated', label: 'Desactivado' },
];

const state = {
  selectedDate: null,
  reportData: null,
  selectedEntityId: null,
  selectedEventType: 'all',
  searchTerm: '',
  loading: false,
  error: null,
};

// Root is #mie-market-root (sibling of #meta-ads-root and .dashboard-tabs).
// Never write outside this node — tab bar and Meta Ads panel must survive render().
const root = document.getElementById('mie-market-root');

/* ----------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------- */

function getLocalToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(dateStr, deltaDays) {
  // Parse as local date parts to avoid UTC drift.
  const parts = String(dateStr).split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return String(dateStr);
}

function formatEventType(eventType) {
  return EVENT_TYPE_LABELS[eventType] || eventType || '—';
}

function shortenId(id) {
  if (!id) return '—';
  const str = String(id);
  if (str.length <= 8) return str;
  return `${str.slice(0, 8)}…`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ----------------------------------------------------------------------------
 * Data fetching
 * ------------------------------------------------------------------------- */

async function fetchReport(date) {
  state.loading = true;
  state.error = null;
  render();

  try {
    const url = `${API_BASE}/reports/daily-summary?date=${encodeURIComponent(date)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    state.reportData = data;
    state.loading = false;
    render();
  } catch (err) {
    state.reportData = null;
    state.loading = false;
    state.error = err && err.message ? err.message : 'Error desconocido';
    render();
  }
}

function setSelectedDate(date) {
  state.selectedDate = date;
  state.selectedEntityId = null;
  state.selectedEventType = 'all';
  state.searchTerm = '';
  fetchReport(date);
}

/* ----------------------------------------------------------------------------
 * Filtering (deterministic UI only)
 * ------------------------------------------------------------------------- */

function applyFilters(events) {
  const list = Array.isArray(events) ? events : [];
  const term = state.searchTerm.trim().toLowerCase();

  return list.filter((event) => {
    if (state.selectedEntityId && event.entityId !== state.selectedEntityId) {
      return false;
    }
    if (state.selectedEventType !== 'all' && event.eventType !== state.selectedEventType) {
      return false;
    }
    if (term) {
      const haystack = [
        event.entityName,
        formatEventType(event.eventType),
        event.adId,
        event.newValue,
        event.previousValue,
      ]
        .map((v) => String(v === null || v === undefined ? '' : v).toLowerCase())
        .join(' ');
      if (!haystack.includes(term)) {
        return false;
      }
    }
    return true;
  });
}

/* ----------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */

function renderHeader() {
  return `
    <header class="header">
      <div class="brand">
        <div class="brand-mark">
          <span class="logo">MIE</span>
          <span class="product">Market Intelligence Center</span>
        </div>
        <div class="brand-sub">Monitoreo competitivo de anuncios</div>
      </div>
      <div class="header-right">
        <span class="current-date">${escapeHtml(formatDate(state.selectedDate))}</span>
        <button class="btn" data-action="prev">Día anterior</button>
        <button class="btn" data-action="today">Hoy</button>
        <button class="btn" data-action="next">Día siguiente</button>
        <button class="btn btn-primary" data-action="reload">Recargar</button>
      </div>
    </header>
  `;
}

function renderStatusLine() {
  let pillClass = 'pill';
  let pillText = 'Sin datos';

  if (state.loading) {
    pillClass = 'pill is-loading';
    pillText = 'Cargando';
  } else if (state.error) {
    pillClass = 'pill is-error';
    pillText = 'Error';
  } else if (state.reportData) {
    const total = state.reportData.stats ? state.reportData.stats.totalEvents : 0;
    if (total > 0) {
      pillClass = 'pill is-loaded';
      pillText = 'Datos cargados';
    } else {
      pillClass = 'pill is-empty';
      pillText = 'Sin movimientos';
    }
  }

  let meta = '';
  if (state.reportData && !state.loading && !state.error) {
    const apiDate = formatDate(state.reportData.date);
    const total = state.reportData.stats ? state.reportData.stats.totalEvents : 0;
    meta = `
      <span class="meta">Fecha API: ${escapeHtml(apiDate)}</span>
      <span class="meta">Eventos: ${escapeHtml(String(total))}</span>
    `;
  }

  return `
    <div class="statusline">
      <span class="${pillClass}">${escapeHtml(pillText)}</span>
      ${meta}
    </div>
  `;
}

function renderKpis() {
  const stats = (state.reportData && state.reportData.stats) || {};
  const cards = [
    { label: 'Movimientos', value: stats.totalEvents || 0 },
    { label: 'Anuncios nuevos', value: stats.newAds || 0 },
    { label: 'Cambios de copy', value: stats.copyChanges || 0 },
    { label: 'Reactivaciones', value: stats.reactivations || 0 },
    { label: 'Desactivaciones', value: stats.deactivations || 0 },
    { label: 'Entidades con movimiento', value: stats.activeEntities || 0 },
  ];

  const cardsHtml = cards
    .map(
      (card) => `
        <div class="kpi-card">
          <div class="kpi-value">${escapeHtml(String(card.value))}</div>
          <div class="kpi-label">${escapeHtml(card.label)}</div>
        </div>
      `,
    )
    .join('');

  return `<section class="section"><div class="kpi-grid">${cardsHtml}</div></section>`;
}

function renderExecutiveSummary() {
  const data = state.reportData;
  const stats = (data && data.stats) || {};
  const total = stats.totalEvents || 0;

  let text;
  if (total === 0) {
    text = 'Sin movimientos registrados para la fecha seleccionada.';
  } else {
    const activeEntities = stats.activeEntities || 0;
    const sentences = [
      `El ${formatDate(data.date)} se detectaron ${total} movimientos en ${activeEntities} entidades.`,
    ];

    const byEntity = Array.isArray(data.byEntity) ? data.byEntity.slice() : [];
    byEntity.sort((a, b) => (b.totalEvents || 0) - (a.totalEvents || 0));
    byEntity.slice(0, 2).forEach((entity) => {
      sentences.push(`${entity.entityName || 'Entidad'} concentró ${entity.totalEvents || 0} movimientos.`);
    });

    text = sentences.join(' ');
  }

  return `
    <section class="section">
      <h2 class="section-title">Resumen ejecutivo</h2>
      <div class="summary-box">${escapeHtml(text)}</div>
    </section>
  `;
}

function renderEntityActivity() {
  const data = state.reportData;
  const byEntity = (data && Array.isArray(data.byEntity)) ? data.byEntity.slice() : [];

  if (byEntity.length === 0) {
    return `
      <section class="section">
        <h2 class="section-title">Actividad de competidores</h2>
        <div class="empty-state">Sin actividad por entidad para esta fecha.</div>
      </section>
    `;
  }

  byEntity.sort((a, b) => {
    const diff = (b.totalEvents || 0) - (a.totalEvents || 0);
    if (diff !== 0) return diff;
    return String(a.entityName || '').localeCompare(String(b.entityName || ''));
  });

  const rows = byEntity
    .map((entity) => {
      const selected = entity.entityId === state.selectedEntityId ? ' is-selected' : '';
      return `
        <tr class="entity-row${selected}" data-entity-id="${escapeHtml(entity.entityId)}">
          <td>${escapeHtml(entity.entityName || '—')}</td>
          <td class="num">${escapeHtml(String(entity.totalEvents || 0))}</td>
          <td class="num">${escapeHtml(String(entity.newAds || 0))}</td>
          <td class="num">${escapeHtml(String(entity.copyChanges || 0))}</td>
          <td class="num">${escapeHtml(String(entity.reactivations || 0))}</td>
          <td class="num">${escapeHtml(String(entity.deactivations || 0))}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <section class="section">
      <h2 class="section-title">Actividad de competidores</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Entidad</th>
              <th class="num">Total</th>
              <th class="num">Nuevos</th>
              <th class="num">Copy</th>
              <th class="num">Reactivados</th>
              <th class="num">Desactivados</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFilters() {
  const options = EVENT_TYPE_OPTIONS
    .map((opt) => {
      const selected = opt.value === state.selectedEventType ? ' selected' : '';
      return `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
    })
    .join('');

  return `
    <div class="filters">
      <input
        class="input"
        type="text"
        id="search-input"
        placeholder="Buscar por entidad, evento o ID"
        value="${escapeHtml(state.searchTerm)}"
      />
      <select class="select" id="event-type-select">${options}</select>
      <button class="btn" data-action="clear-filters">Limpiar filtros</button>
    </div>
  `;
}

function renderEventsTable() {
  const data = state.reportData;
  const allEvents = (data && Array.isArray(data.events)) ? data.events : [];
  const filtered = applyFilters(allEvents);

  let body;
  if (filtered.length === 0) {
    body = `<div class="empty-state">No hay eventos que coincidan con los filtros.</div>`;
  } else {
    const rows = filtered
      .map((event) => {
        const evtClass = `badge evt-${escapeHtml(event.eventType)}`;
        const newValue = event.newValue === null || event.newValue === undefined || event.newValue === ''
          ? '—'
          : event.newValue;
        return `
          <tr>
            <td>${escapeHtml(event.entityName || '—')}</td>
            <td><span class="${evtClass}">${escapeHtml(formatEventType(event.eventType))}</span></td>
            <td class="num"><span class="sev">${escapeHtml(String(event.severity === null || event.severity === undefined ? '—' : event.severity))}</span></td>
            <td class="mono" title="${escapeHtml(event.adId || '')}">${escapeHtml(shortenId(event.adId))}</td>
            <td class="mono">${escapeHtml(newValue)}</td>
          </tr>
        `;
      })
      .join('');

    body = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Entidad</th>
              <th>Evento</th>
              <th class="num">Severidad</th>
              <th>Ad ID</th>
              <th>Nuevo valor</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  return `
    <section class="section">
      <h2 class="section-title">Eventos del día</h2>
      ${renderFilters()}
      ${body}
    </section>
  `;
}

function renderLoadingSkeleton() {
  const kpis = new Array(6).fill('<div class="kpi-card skeleton skeleton-kpi"></div>').join('');
  return `
    ${renderHeader()}
    ${renderStatusLine()}
    <section class="section"><div class="kpi-grid">${kpis}</div></section>
    <section class="section">
      <h2 class="section-title">Resumen ejecutivo</h2>
      <div class="summary-box">
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">Actividad de competidores</h2>
      <div class="skeleton skeleton-block"></div>
    </section>
  `;
}

function renderError() {
  return `
    ${renderHeader()}
    ${renderStatusLine()}
    <section class="section">
      <div class="error-box">
        <h3>No se pudo cargar el reporte</h3>
        <p>Ocurrió un error al consultar el resumen diario (${escapeHtml(state.error || '')}).</p>
        <button class="btn btn-primary" data-action="reload">Reintentar</button>
      </div>
    </section>
  `;
}

function renderContent() {
  const stats = (state.reportData && state.reportData.stats) || {};
  const total = stats.totalEvents || 0;

  // Empty day: KPIs (zeros) + summary, no events table.
  if (total === 0) {
    return `
      ${renderKpis()}
      ${renderExecutiveSummary()}
      <section class="section">
        <div class="empty-state">Sin movimientos registrados para esta fecha.</div>
      </section>
    `;
  }

  return `
    ${renderKpis()}
    ${renderExecutiveSummary()}
    ${renderEntityActivity()}
    ${renderEventsTable()}
  `;
}

function render() {
  if (state.loading) {
    root.innerHTML = renderLoadingSkeleton();
    bindEvents();
    return;
  }

  if (state.error) {
    root.innerHTML = renderError();
    bindEvents();
    return;
  }

  root.innerHTML = `
    ${renderHeader()}
    ${renderStatusLine()}
    ${renderContent()}
  `;
  bindEvents();
}

/* ----------------------------------------------------------------------------
 * Event binding
 * ------------------------------------------------------------------------- */

function bindEvents() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', onActionClick);
  });

  root.querySelectorAll('.entity-row').forEach((row) => {
    row.addEventListener('click', () => {
      const entityId = row.getAttribute('data-entity-id');
      if (state.selectedEntityId === entityId) {
        state.selectedEntityId = null;
      } else {
        state.selectedEntityId = entityId;
      }
      render();
    });
  });

  const search = root.querySelector('#search-input');
  if (search) {
    search.addEventListener('input', (e) => {
      state.searchTerm = e.target.value;
      // Re-render only the events section would be ideal; full render keeps it simple
      // and preserves focus via re-binding below.
      const caret = e.target.selectionStart;
      render();
      const newSearch = root.querySelector('#search-input');
      if (newSearch) {
        newSearch.focus();
        try {
          newSearch.setSelectionRange(caret, caret);
        } catch (err) {
          /* ignore */
        }
      }
    });
  }

  const select = root.querySelector('#event-type-select');
  if (select) {
    select.addEventListener('change', (e) => {
      state.selectedEventType = e.target.value;
      render();
    });
  }
}

function onActionClick(e) {
  const action = e.currentTarget.getAttribute('data-action');

  switch (action) {
    case 'prev':
      setSelectedDate(shiftDate(state.selectedDate, -1));
      break;
    case 'next':
      setSelectedDate(shiftDate(state.selectedDate, 1));
      break;
    case 'today':
      setSelectedDate(getLocalToday());
      break;
    case 'reload':
      fetchReport(state.selectedDate);
      break;
    case 'clear-filters':
      state.selectedEntityId = null;
      state.selectedEventType = 'all';
      state.searchTerm = '';
      render();
      break;
    default:
      break;
  }
}

/* ----------------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------------- */

function init() {
  if (!root) {
    console.error('[mie-dashboard] #mie-market-root not found');
    return;
  }
  state.selectedDate = getLocalToday();
  render();
  fetchReport(state.selectedDate);
}

init();
