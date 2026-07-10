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
  // Additive UI state (intensity gauge + ad modal) — does not alter report contract.
  gauge: {
    loading: false,
    error: null,
    entities: [],
  },
  adModal: {
    open: false,
    loading: false,
    error: null,
    event: null,
    detail: null,
  },
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
  loadIntensityGauges(date);
}

/* ----------------------------------------------------------------------------
 * Intensity gauge + ad modal (additive only — new helpers / queries)
 *
 * Event-type audit (movements):
 *   Included: new_ad, copy_changed, ad_reactivated, ad_deactivated
 *   Excluded: none
 *   Justification: src/steps/events.js only writes these four types; the
 *   dashboard "Movimientos" KPI counts all of them. Every event row is a
 *   competitive movement.
 *
 * Date grouping: events.detected_at is DATE (YYYY-MM-DD). Group by
 *   entity_id + detected_at as stored (no extra timezone conversion).
 *   Calendar navigation reuses getLocalToday() / shiftDate() (local parts).
 *
 * events → ad_snapshots lookup:
 *   events.ad_id → ads.id → ads.snapshot_id → ad_snapshots.id → raw_json[]
 *   Match item via ads.ad_archive_id ↔ raw item adArchiveId / variants.
 * ------------------------------------------------------------------------- */

const MOVEMENT_EVENT_TYPES = ['new_ad', 'copy_changed', 'ad_reactivated', 'ad_deactivated'];

function getSupabaseDatasourceConfig() {
  const injected = typeof window !== 'undefined' ? window.__META_AGENT_DATASOURCE__ : null;
  if (!injected || typeof injected !== 'object') {
    return { url: '', anonKey: '' };
  }
  return {
    url: String(injected.supabaseUrl || '').trim(),
    anonKey: String(injected.supabaseAnonKey || '').trim(),
  };
}

async function supabaseRestGet(pathAndQuery) {
  const cfg = getSupabaseDatasourceConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error('Datasource Supabase no configurado');
  }
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/rest/v1/${pathAndQuery.replace(/^\//, '')}`;
  const pageSize = 1000;
  let from = 0;
  const all = [];

  while (true) {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        Accept: 'application/json',
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch (ignore) {
        body = '';
      }
      throw new Error(`Supabase HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const chunk = await res.json();
    if (!Array.isArray(chunk)) {
      throw new Error('Respuesta inesperada de Supabase');
    }
    for (let i = 0; i < chunk.length; i += 1) {
      all.push(chunk[i]);
    }
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Read-only: competitor entities (is_self = false). */
async function queryCompetitorEntities() {
  return supabaseRestGet(
    'monitored_entities?select=id,name,is_self&is_self=eq.false&order=name.asc',
  );
}

/**
 * Read-only gauge events query.
 * Grouping expression (client): entity_id + detected_at (DATE column as-is).
 * Window: [selectedDate - 7, selectedDate] inclusive for today + baseline days.
 * Baseline uses only [selectedDate - 7, selectedDate - 1] (seven complete days).
 */
async function queryEventsForIntensityGauge(selectedDate, entityIds) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return [];
  const rangeStart = shiftDate(selectedDate, -7);
  const inList = entityIds.map((id) => encodeURIComponent(id)).join(',');
  const typeList = MOVEMENT_EVENT_TYPES.map((t) => encodeURIComponent(t)).join(',');
  return supabaseRestGet(
    `events?select=entity_id,detected_at,event_type` +
      `&entity_id=in.(${inList})` +
      `&event_type=in.(${typeList})` +
      `&detected_at=gte.${encodeURIComponent(rangeStart)}` +
      `&detected_at=lte.${encodeURIComponent(selectedDate)}` +
      `&order=detected_at.asc`,
  );
}

/**
 * Read-only: distinct historical calendar days before selectedDate (for N/7).
 * Same event_type filter; detected_at < selectedDate (complete days only).
 */
async function queryHistoricalMovementDays(selectedDate, entityIds) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return [];
  const inList = entityIds.map((id) => encodeURIComponent(id)).join(',');
  const typeList = MOVEMENT_EVENT_TYPES.map((t) => encodeURIComponent(t)).join(',');
  return supabaseRestGet(
    `events?select=entity_id,detected_at` +
      `&entity_id=in.(${inList})` +
      `&event_type=in.(${typeList})` +
      `&detected_at=lt.${encodeURIComponent(selectedDate)}` +
      `&order=detected_at.asc`,
  );
}

function countDailyMovementsByEntityDay(eventRows) {
  const map = new Map();
  (eventRows || []).forEach((row) => {
    const entityId = row.entity_id;
    const day = row.detected_at;
    if (!entityId || !day) return;
    const key = `${entityId}|${day}`;
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function countDistinctHistoricalDaysByEntity(historyRows) {
  const sets = new Map();
  (historyRows || []).forEach((row) => {
    const entityId = row.entity_id;
    const day = row.detected_at;
    if (!entityId || !day) return;
    if (!sets.has(entityId)) sets.set(entityId, new Set());
    sets.get(entityId).add(String(day));
  });
  const out = new Map();
  sets.forEach((daySet, entityId) => {
    out.set(entityId, daySet.size);
  });
  return out;
}

/**
 * Compare today vs mean of previous 7 complete days (zeros for quiet days).
 * Never uses fixed thresholds or cross-entity comparison.
 */
function calculateEntityIntensity(todayCount, baselineDayCounts) {
  const days = Array.isArray(baselineDayCounts) ? baselineDayCounts : [];
  const sum = days.reduce((acc, n) => acc + (Number(n) || 0), 0);
  const avg = days.length > 0 ? sum / days.length : 0;
  const today = Number(todayCount) || 0;

  let level = 'normal';
  let label = 'Normal';
  if (today < avg) {
    level = 'below';
    label = 'Por debajo de lo normal';
  } else if (today > avg) {
    level = 'above';
    label = 'Por encima de lo normal';
  }

  return {
    todayCount: today,
    baselineAverage: avg,
    level,
    label,
  };
}

function buildIntensityGaugeModels(entities, windowRows, historyRows, selectedDate) {
  const daily = countDailyMovementsByEntityDay(windowRows);
  const histDays = countDistinctHistoricalDaysByEntity(historyRows);
  const baselineDates = [];
  for (let i = 7; i >= 1; i -= 1) {
    baselineDates.push(shiftDate(selectedDate, -i));
  }

  return (entities || []).map((entity) => {
    const entityId = entity.id;
    const historicalDays = histDays.get(entityId) || 0;
    const todayCount = daily.get(`${entityId}|${selectedDate}`) || 0;

    if (historicalDays < 7) {
      return {
        entityId,
        entityName: entity.name || '—',
        mode: 'collecting',
        historicalDays,
        intensity: null,
      };
    }

    const baselineCounts = baselineDates.map((day) => daily.get(`${entityId}|${day}`) || 0);
    return {
      entityId,
      entityName: entity.name || '—',
      mode: 'ready',
      historicalDays,
      intensity: calculateEntityIntensity(todayCount, baselineCounts),
    };
  });
}

async function loadIntensityGauges(selectedDate) {
  state.gauge.loading = true;
  state.gauge.error = null;
  render();

  try {
    const entities = await queryCompetitorEntities();
    const entityIds = entities.map((e) => e.id).filter(Boolean);
    const [windowRows, historyRows] = await Promise.all([
      queryEventsForIntensityGauge(selectedDate, entityIds),
      queryHistoricalMovementDays(selectedDate, entityIds),
    ]);
    state.gauge.entities = buildIntensityGaugeModels(
      entities,
      windowRows,
      historyRows,
      selectedDate,
    );
    state.gauge.loading = false;
    state.gauge.error = null;
    render();
  } catch (err) {
    state.gauge.loading = false;
    state.gauge.error = err && err.message ? err.message : 'Error al cargar intensidad';
    state.gauge.entities = [];
    render();
  }
}

function renderIntensityGauges() {
  let body;
  if (state.gauge.loading) {
    const skeletons = new Array(4)
      .fill('<div class="gauge-card skeleton skeleton-gauge"></div>')
      .join('');
    body = `<div class="gauge-grid">${skeletons}</div>`;
  } else if (state.gauge.error) {
    body = `<div class="empty-state">No se pudo cargar la intensidad: ${escapeHtml(state.gauge.error)}</div>`;
  } else if (!state.gauge.entities.length) {
    body = `<div class="empty-state">Sin entidades monitoreadas.</div>`;
  } else {
    body = `<div class="gauge-grid">${state.gauge.entities
      .map((g) => {
        if (g.mode === 'collecting') {
          const n = Math.min(7, g.historicalDays || 0);
          return `
            <div class="gauge-card">
              <div class="gauge-entity">${escapeHtml(g.entityName)}</div>
              <div class="gauge-fallback">Recopilando histórico (día ${escapeHtml(String(n))}/7)</div>
            </div>
          `;
        }
        const level = g.intensity ? g.intensity.level : 'normal';
        const label = g.intensity ? g.intensity.label : 'Normal';
        return `
          <div class="gauge-card">
            <div class="gauge-entity">${escapeHtml(g.entityName)}</div>
            <div class="gauge-track"><div class="gauge-fill is-${escapeHtml(level)}"></div></div>
            <div class="gauge-label">${escapeHtml(label)}</div>
          </div>
        `;
      })
      .join('')}</div>`;
  }

  return `
    <section class="section">
      <h2 class="section-title">
        <i class="ti ti-activity" aria-hidden="true"></i>
        Intensidad de mercado
      </h2>
      ${body}
    </section>
  `;
}

function getRawAdArchiveId(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.adArchiveId ?? item.adArchiveID ?? item.ad_archive_id ?? item.id;
  if (id === null || id === undefined || id === '') return null;
  return String(id);
}

function extractDistinctCreativeBodies(rawItem) {
  const bodies = [];
  const push = (v) => {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (!s) return;
    if (!bodies.includes(s)) bodies.push(s);
  };
  if (!rawItem || typeof rawItem !== 'object') return bodies;
  if (Array.isArray(rawItem.adCreativeBodies)) {
    rawItem.adCreativeBodies.forEach(push);
  } else if (Array.isArray(rawItem.ad_creative_bodies)) {
    rawItem.ad_creative_bodies.forEach(push);
  } else if (rawItem.ad_text) {
    push(rawItem.ad_text);
  } else if (rawItem.adText) {
    push(rawItem.adText);
  } else if (rawItem.body) {
    push(rawItem.body);
  }
  return bodies;
}

function extractPublisherPlatforms(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return [];
  const platforms =
    rawItem.publisherPlatforms ?? rawItem.publisher_platforms ?? rawItem.platforms;
  if (Array.isArray(platforms)) {
    return platforms.map((p) => String(p)).filter(Boolean);
  }
  if (typeof platforms === 'string' && platforms.trim()) {
    return [platforms.trim()];
  }
  return [];
}

function extractAdLibraryUrl(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  return (
    rawItem.adLibraryURL ||
    rawItem.ad_library_url ||
    rawItem.adLibraryUrl ||
    null
  );
}

function extractAdStartDate(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  return (
    rawItem.startDate ||
    rawItem.start_date ||
    rawItem.startDateFormatted ||
    null
  );
}

function extractAdStatus(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  return rawItem.adStatus ?? rawItem.ad_status ?? null;
}

/** Read-only: ads row by primary key (events.ad_id). */
async function queryAdById(adId) {
  if (!adId) return null;
  const rows = await supabaseRestGet(
    `ads?select=id,entity_id,snapshot_id,ad_archive_id&id=eq.${encodeURIComponent(adId)}&limit=1`,
  );
  return rows[0] || null;
}

/** Read-only: ad_snapshots.raw_json by snapshot id. */
async function queryAdSnapshotRawJson(snapshotId) {
  if (!snapshotId) return null;
  const rows = await supabaseRestGet(
    `ad_snapshots?select=id,raw_json&id=eq.${encodeURIComponent(snapshotId)}&limit=1`,
  );
  return rows[0] || null;
}

function findRawAdInSnapshot(rawJson, adArchiveId) {
  const list = Array.isArray(rawJson) ? rawJson : [];
  const target = String(adArchiveId);
  for (let i = 0; i < list.length; i += 1) {
    const found = getRawAdArchiveId(list[i]);
    if (found && found === target) return list[i];
  }
  return null;
}

function buildAdDetailFromRaw(event, rawItem) {
  return {
    entityName: (event && event.entityName) || '—',
    eventType: (event && event.eventType) || null,
    eventTypeLabel: formatEventType(event && event.eventType),
    adStatus: extractAdStatus(rawItem),
    bodies: extractDistinctCreativeBodies(rawItem),
    startDate: extractAdStartDate(rawItem),
    platforms: extractPublisherPlatforms(rawItem),
    adLibraryURL: extractAdLibraryUrl(rawItem),
  };
}

async function loadAdDetailForEvent(event) {
  state.adModal.open = true;
  state.adModal.loading = true;
  state.adModal.error = null;
  state.adModal.event = event;
  state.adModal.detail = null;
  render();

  try {
    if (!event || !event.adId) {
      throw new Error('Este evento no tiene ad_id');
    }
    const ad = await queryAdById(event.adId);
    if (!ad) {
      throw new Error('No se encontró el anuncio en ads');
    }
    if (!ad.snapshot_id) {
      throw new Error('El anuncio no tiene snapshot_id');
    }
    const snapshot = await queryAdSnapshotRawJson(ad.snapshot_id);
    if (!snapshot) {
      throw new Error('No se encontró el snapshot');
    }
    const rawItem = findRawAdInSnapshot(snapshot.raw_json, ad.ad_archive_id);
    if (!rawItem) {
      throw new Error('El anuncio no aparece en raw_json del snapshot');
    }
    state.adModal.detail = buildAdDetailFromRaw(event, rawItem);
    state.adModal.loading = false;
    state.adModal.error = null;
    render();
  } catch (err) {
    state.adModal.loading = false;
    state.adModal.error = err && err.message ? err.message : 'Error al cargar el anuncio';
    state.adModal.detail = null;
    render();
  }
}

function closeAdModal() {
  state.adModal.open = false;
  state.adModal.loading = false;
  state.adModal.error = null;
  state.adModal.event = null;
  state.adModal.detail = null;
  render();
}

function renderAdModal() {
  if (!state.adModal.open) return '';

  let content;
  if (state.adModal.loading) {
    content = `<div class="ad-modal-loading">Cargando detalle del anuncio…</div>`;
  } else if (state.adModal.error) {
    content = `<div class="ad-modal-error">${escapeHtml(state.adModal.error)}</div>`;
  } else if (state.adModal.detail) {
    const d = state.adModal.detail;
    const bodiesHtml =
      d.bodies.length === 0
        ? `<div class="ad-modal-copy">—</div>`
        : d.bodies.length === 1
          ? `<div class="ad-modal-copy">${escapeHtml(d.bodies[0])}</div>`
          : d.bodies
              .map(
                (body, idx) => `
              <div class="ad-modal-block">
                <div class="ad-modal-label">Variante ${idx + 1}</div>
                <div class="ad-modal-copy">${escapeHtml(body)}</div>
              </div>
            `,
              )
              .join('');
    const platforms =
      d.platforms.length > 0 ? d.platforms.join(', ') : '—';
    const libraryBtn = d.adLibraryURL
      ? `<a class="btn btn-primary" href="${escapeHtml(d.adLibraryURL)}" target="_blank" rel="noopener noreferrer">
           <i class="ti ti-external-link" aria-hidden="true"></i>
           Ver en Facebook Ad Library
         </a>`
      : '';

    content = `
      <div class="ad-modal-meta">
        <span class="badge evt-${escapeHtml(d.eventType || '')}">${escapeHtml(d.eventTypeLabel)}</span>
        <span>Estado: ${escapeHtml(d.adStatus || '—')}</span>
      </div>
      <div class="ad-modal-block">
        <div class="ad-modal-label">Copy</div>
        ${bodiesHtml}
      </div>
      <div class="ad-modal-block">
        <div class="ad-modal-label">Fecha de inicio</div>
        <div>${escapeHtml(d.startDate || '—')}</div>
      </div>
      <div class="ad-modal-block">
        <div class="ad-modal-label">Plataformas</div>
        <div>${escapeHtml(platforms)}</div>
      </div>
      <div class="ad-modal-actions">${libraryBtn}</div>
    `;
  } else {
    content = `<div class="ad-modal-error">Sin datos</div>`;
  }

  const title =
    (state.adModal.detail && state.adModal.detail.entityName) ||
    (state.adModal.event && state.adModal.event.entityName) ||
    'Detalle del anuncio';

  return `
    <div class="ad-modal-backdrop" data-action="close-ad-modal" role="presentation">
      <div class="ad-modal" role="dialog" aria-modal="true" aria-label="Detalle del anuncio">
        <div class="ad-modal-header">
          <h3 class="ad-modal-title">${escapeHtml(title)}</h3>
          <button type="button" class="ad-modal-close" data-action="close-ad-modal" aria-label="Cerrar">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        ${content}
      </div>
    </div>
  `;
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
      .map((event, idx) => {
        const evtClass = `badge evt-${escapeHtml(event.eventType)}`;
        const newValue = event.newValue === null || event.newValue === undefined || event.newValue === ''
          ? '—'
          : event.newValue;
        return `
          <tr class="event-row" data-event-index="${escapeHtml(String(idx))}" tabindex="0" role="button">
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
    ${renderIntensityGauges()}
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
      ${renderIntensityGauges()}
      ${renderExecutiveSummary()}
      <section class="section">
        <div class="empty-state">Sin movimientos registrados para esta fecha.</div>
      </section>
    `;
  }

  return `
    ${renderKpis()}
    ${renderIntensityGauges()}
    ${renderExecutiveSummary()}
    ${renderEntityActivity()}
    ${renderEventsTable()}
  `;
}

function render() {
  if (state.loading) {
    root.innerHTML = `${renderLoadingSkeleton()}${renderAdModal()}`;
    bindEvents();
    return;
  }

  if (state.error) {
    root.innerHTML = `${renderError()}${renderAdModal()}`;
    bindEvents();
    return;
  }

  root.innerHTML = `
    ${renderHeader()}
    ${renderStatusLine()}
    ${renderContent()}
    ${renderAdModal()}
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

  const data = state.reportData;
  const allEvents = data && Array.isArray(data.events) ? data.events : [];
  const filteredEvents = applyFilters(allEvents);

  root.querySelectorAll('.event-row').forEach((row) => {
    const openFromRow = () => {
      const idx = Number(row.getAttribute('data-event-index'));
      const event = filteredEvents[idx];
      if (event) loadAdDetailForEvent(event);
    };
    row.addEventListener('click', openFromRow);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFromRow();
      }
    });
  });

  const modalPanel = root.querySelector('.ad-modal');
  if (modalPanel) {
    modalPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

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
      loadIntensityGauges(state.selectedDate);
      break;
    case 'clear-filters':
      state.selectedEntityId = null;
      state.selectedEventType = 'all';
      state.searchTerm = '';
      render();
      break;
    case 'close-ad-modal':
      closeAdModal();
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
  loadIntensityGauges(state.selectedDate);
}

init();
