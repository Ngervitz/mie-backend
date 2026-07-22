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
    searchTerm: '',
  },
  adModal: {
    open: false,
    loading: false,
    error: null,
    event: null,
    detail: null,
  },
  entityModal: {
    open: false,
    entityId: null,
    busy: false,
    error: null,
  },
  addEntityModal: {
    open: false,
    busy: false,
    error: null,
    name: '',
    segment: 'prestamos',
    adLibraryUrl: '',
    websiteDomain: '',
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

async function supabaseRestPatch(pathAndQuery, payload) {
  const cfg = getSupabaseDatasourceConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error('Datasource Supabase no configurado');
  }
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/rest/v1/${pathAndQuery.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
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
  return res.json();
}

async function supabaseRestPost(pathAndQuery, payload) {
  const cfg = getSupabaseDatasourceConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error('Datasource Supabase no configurado');
  }
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/rest/v1/${pathAndQuery.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
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
  return res.json();
}

/** Competitor entities (is_self = false). Includes paused (active=false) for the chip grid. */
async function queryCompetitorEntities() {
  return supabaseRestGet(
    'monitored_entities?select=id,name,is_self,active,segment,sector,ad_library_url,slug,website_domain' +
      '&is_self=eq.false&order=name.asc',
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

function buildLastMovementByEntity(windowRows, historyRows) {
  const map = new Map();
  const push = (row) => {
    if (!row || !row.entity_id || !row.detected_at) return;
    const prev = map.get(row.entity_id);
    if (!prev || String(row.detected_at) > String(prev)) {
      map.set(row.entity_id, row.detected_at);
    }
  };
  (windowRows || []).forEach(push);
  (historyRows || []).forEach(push);
  return map;
}

function buildIntensityGaugeModels(entities, windowRows, historyRows, selectedDate) {
  const daily = countDailyMovementsByEntityDay(windowRows);
  const histDays = countDistinctHistoricalDaysByEntity(historyRows);
  const lastMovement = buildLastMovementByEntity(windowRows, historyRows);
  const baselineDates = [];
  for (let i = 7; i >= 1; i -= 1) {
    baselineDates.push(shiftDate(selectedDate, -i));
  }

  return (entities || []).map((entity) => {
    const entityId = entity.id;
    const historicalDays = histDays.get(entityId) || 0;
    const todayCount = daily.get(`${entityId}|${selectedDate}`) || 0;
    const meta = {
      active: entity.active !== false,
      segment: entity.segment || null,
      sector: entity.sector || null,
      adLibraryUrl: entity.ad_library_url || null,
      websiteDomain: entity.website_domain || null,
      lastMovementDate: lastMovement.get(entityId) || null,
    };

    if (historicalDays < 7) {
      return {
        entityId,
        entityName: entity.name || '—',
        mode: 'collecting',
        historicalDays,
        intensity: null,
        ...meta,
      };
    }

    const baselineCounts = baselineDates.map((day) => daily.get(`${entityId}|${day}`) || 0);
    return {
      entityId,
      entityName: entity.name || '—',
      mode: 'ready',
      historicalDays,
      intensity: calculateEntityIntensity(todayCount, baselineCounts),
      ...meta,
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

/** Display/sort helpers for intensity chips — presentation only; does not alter models. */
function getIntensityPctDisplay(intensity) {
  const today = Number(intensity && intensity.todayCount) || 0;
  const avg = Number(intensity && intensity.baselineAverage) || 0;
  if (avg <= 0) {
    return {
      sortValue: today <= 0 ? 0 : Number.POSITIVE_INFINITY,
      pctLabel: today <= 0 ? '0%' : '100%+',
    };
  }
  const sortValue = (today / avg) * 100;
  return {
    sortValue,
    pctLabel: `${Math.round(sortValue)}%`,
  };
}

/**
 * Sort by intensity descending across all chips.
 * Groups keep visual tiers (featured → ready → compact → paused).
 * Within each tier: numeric intensity desc (pct or día N/7); name only as tiebreaker.
 */
function getIntensityChipSortMeta(g) {
  const name = String(g.entityName || '');
  if (g.active === false) {
    return { group: 5, sortValue: -1, name };
  }
  if (g.mode === 'collecting') {
    const days = Math.min(7, Number(g.historicalDays) || 0);
    return { group: 4, sortValue: days, name };
  }
  if (g.mode === 'ready' && g.intensity) {
    const level = g.intensity.level;
    const { sortValue } = getIntensityPctDisplay(g.intensity);
    if (level === 'above') return { group: 0, sortValue, name };
    if (level === 'normal') return { group: 1, sortValue, name };
    if (level === 'below') return { group: 2, sortValue, name };
  }
  const sortValue = g.intensity ? getIntensityPctDisplay(g.intensity).sortValue : 0;
  return { group: 3, sortValue, name };
}

function compareIntensityChips(a, b) {
  const ma = getIntensityChipSortMeta(a);
  const mb = getIntensityChipSortMeta(b);
  if (ma.group !== mb.group) return ma.group - mb.group;
  if (mb.sortValue !== ma.sortValue) return mb.sortValue - ma.sortValue;
  return ma.name.localeCompare(mb.name, 'es', { sensitivity: 'base' });
}

/** Presentation-only: initials for favicon fallback. */
function getEntityInitials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const w = parts[0].replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9+]/g, '');
    return (w.slice(0, 2) || '?').toUpperCase();
  }
  const a = parts[0].replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9+]/g, '').charAt(0);
  const b = parts[1].replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9+]/g, '').charAt(0);
  return ((a || '?') + (b || '')).toUpperCase();
}

/** Presentation-only: stable hue from entity name. */
function getAvatarHue(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Presentation-only: corner avatar (favicon or initials). */
function renderGaugeAvatar(g) {
  const initials = escapeHtml(getEntityInitials(g.entityName));
  const hue = getAvatarHue(g.entityName);
  const domain = String(g.websiteDomain || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  const favicon = domain
    ? `<img class="gauge-chip-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
    : '';
  return `
    <span class="gauge-chip-avatar" style="--avatar-hue:${hue}" aria-hidden="true">
      <span class="gauge-chip-initials">${initials}</span>
      ${favicon}
    </span>
  `;
}

function renderIntensityChip(g, index, variant) {
  const delay = `${(index * 0.04).toFixed(2)}s`;
  const fullName = g.entityName || '—';
  const titleAttr = escapeHtml(fullName);
  const entityAttr = escapeHtml(String(g.entityId || ''));
  const avatar = renderGaugeAvatar(g);

  // Idle section: favicon + name only (no status emoji / día 0/7).
  if (variant === 'idle') {
    const pausedClass = g.active === false ? ' is-paused' : '';
    return `
      <button type="button" class="gauge-chip is-idle-row${pausedClass}" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
      </button>
    `;
  }

  if (g.active === false) {
    return `
      <button type="button" class="gauge-chip is-paused is-compact" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-emoji" aria-hidden="true">🚫</span>
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-value is-fallback-label">pausada</span>
      </button>
    `;
  }

  if (g.mode === 'collecting') {
    const n = Math.min(7, g.historicalDays || 0);
    return `
      <button type="button" class="gauge-chip is-collecting is-compact" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-emoji" aria-hidden="true">⏳</span>
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-value is-fallback-label">día ${escapeHtml(String(n))}/7</span>
      </button>
    `;
  }

  const meta = getIntensityChipSortMeta(g);
  if (meta.group === 3) {
    const pctLabel = g.intensity
      ? getIntensityPctDisplay(g.intensity).pctLabel
      : '—';
    return `
      <button type="button" class="gauge-chip is-unknown is-compact" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-emoji" aria-hidden="true">❔</span>
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-value">${escapeHtml(pctLabel)}</span>
      </button>
    `;
  }

  const intensity = g.intensity;
  const level = intensity.level;
  const { pctLabel } = getIntensityPctDisplay(intensity);
  let emoji = '✅';
  let chipClass = 'is-normal is-ready';
  if (level === 'above') {
    emoji = '🔥';
    chipClass = 'is-above is-featured';
  } else if (level === 'below') {
    emoji = '📉';
    chipClass = 'is-below is-ready';
  }

  return `
    <button type="button" class="gauge-chip ${chipClass}" style="--gauge-delay:${delay}"
      title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
      ${avatar}
      <span class="gauge-chip-emoji" aria-hidden="true">${emoji}</span>
      <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
      <span class="gauge-chip-value">${escapeHtml(pctLabel)}</span>
    </button>
  `;
}

function renderGaugeSection(title, gridClass, chipsHtml) {
  if (!chipsHtml) return '';
  return `
    <div class="gauge-section">
      <h3 class="gauge-section-title">${escapeHtml(title)}</h3>
      <div class="gauge-chip-grid ${gridClass}">${chipsHtml}</div>
    </div>
  `;
}

function formatSegmentLabel(segment) {
  const map = {
    prestamos: 'Préstamos',
    cooperativa: 'Cooperativa',
    deuda: 'Deuda',
  };
  if (!segment) return '—';
  return map[segment] || String(segment);
}

function slugifyEntityName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function looksLikeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function findGaugeEntity(entityId) {
  return (state.gauge.entities || []).find((g) => String(g.entityId) === String(entityId)) || null;
}

function openEntityModal(entityId) {
  state.entityModal = {
    open: true,
    entityId,
    busy: false,
    error: null,
  };
  state.addEntityModal.open = false;
  render();
}

function closeEntityModal() {
  state.entityModal = {
    open: false,
    entityId: null,
    busy: false,
    error: null,
  };
  render();
}

function openAddEntityModal() {
  state.addEntityModal = {
    open: true,
    busy: false,
    error: null,
    name: '',
    segment: 'prestamos',
    adLibraryUrl: '',
    websiteDomain: '',
  };
  state.entityModal.open = false;
  render();
}

function closeAddEntityModal() {
  state.addEntityModal.open = false;
  state.addEntityModal.busy = false;
  state.addEntityModal.error = null;
  render();
}

async function toggleEntityActive() {
  const entity = findGaugeEntity(state.entityModal.entityId);
  if (!entity || state.entityModal.busy) return;

  const nextActive = entity.active === false;
  state.entityModal.busy = true;
  state.entityModal.error = null;
  render();

  try {
    await supabaseRestPatch(
      `monitored_entities?id=eq.${encodeURIComponent(entity.entityId)}`,
      { active: nextActive },
    );
    await loadIntensityGauges(state.selectedDate);
    // Keep modal open on refreshed entity
    state.entityModal = {
      open: true,
      entityId: entity.entityId,
      busy: false,
      error: null,
    };
    render();
  } catch (err) {
    state.entityModal.busy = false;
    state.entityModal.error = err && err.message ? err.message : 'No se pudo actualizar';
    render();
  }
}

async function submitAddEntity() {
  if (state.addEntityModal.busy) return;

  const name = String(state.addEntityModal.name || '').trim();
  const segment = String(state.addEntityModal.segment || '').trim();
  const adLibraryUrl = String(state.addEntityModal.adLibraryUrl || '').trim();
  const websiteDomainRaw = String(state.addEntityModal.websiteDomain || '').trim();

  if (!name || !segment || !adLibraryUrl) {
    state.addEntityModal.error = 'Completá nombre, categoría y URL de Ad Library.';
    render();
    return;
  }
  if (!looksLikeUrl(adLibraryUrl)) {
    state.addEntityModal.error = 'La URL de Ad Library no parece válida (usá http:// o https://).';
    render();
    return;
  }

  const slug = slugifyEntityName(name);
  if (!slug) {
    state.addEntityModal.error = 'No se pudo generar un slug válido a partir del nombre.';
    render();
    return;
  }

  // Optional: normalize hostname (strip protocol/www) for exact SERP matching.
  let websiteDomain = null;
  if (websiteDomainRaw) {
    let candidate = websiteDomainRaw.toLowerCase();
    if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
    try {
      let host = new URL(candidate).hostname;
      if (host.startsWith('www.')) host = host.slice(4);
      websiteDomain = host || null;
    } catch (err) {
      state.addEntityModal.error =
        'Dominio web no válido. Usá algo como alprestamo.uy (sin ruta).';
      render();
      return;
    }
    if (!websiteDomain || !websiteDomain.includes('.')) {
      state.addEntityModal.error =
        'Dominio web no válido. Usá algo como alprestamo.uy (sin ruta).';
      render();
      return;
    }
  }

  state.addEntityModal.busy = true;
  state.addEntityModal.error = null;
  render();

  try {
    const payload = {
      name,
      slug,
      entity_type: 'marca',
      segment,
      sector: 'financiero',
      ad_library_url: adLibraryUrl,
      is_self: false,
      active: true,
    };
    if (websiteDomain) payload.website_domain = websiteDomain;

    await supabaseRestPost('monitored_entities', payload);
    closeAddEntityModal();
    await loadIntensityGauges(state.selectedDate);
  } catch (err) {
    state.addEntityModal.busy = false;
    state.addEntityModal.error = err && err.message ? err.message : 'No se pudo crear la entidad';
    render();
  }
}

function renderEntityModal() {
  if (!state.entityModal.open) return '';
  const entity = findGaugeEntity(state.entityModal.entityId);
  if (!entity) {
    return `
      <div class="ad-modal-backdrop" data-action="close-entity-modal" role="presentation">
        <div class="ad-modal" role="dialog" aria-modal="true" aria-label="Detalle de entidad">
          <div class="ad-modal-header">
            <h3 class="ad-modal-title">Entidad</h3>
            <button type="button" class="ad-modal-close" data-action="close-entity-modal" aria-label="Cerrar">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          </div>
          <div class="ad-modal-error">Entidad no encontrada.</div>
        </div>
      </div>
    `;
  }

  const isActive = entity.active !== false;
  const statusBadge = isActive
    ? '<span class="entity-status-badge is-active">Activa</span>'
    : '<span class="entity-status-badge is-paused">Pausada</span>';
  const toggleLabel = state.entityModal.busy
    ? 'Guardando…'
    : (isActive ? 'Pausar' : 'Reactivar');
  const libraryLink = entity.adLibraryUrl
    ? `<a class="btn" href="${escapeHtml(entity.adLibraryUrl)}" target="_blank" rel="noopener noreferrer">
         Abrir Ad Library <i class="ti ti-external-link" aria-hidden="true"></i>
       </a>`
    : '<span class="text-muted">Sin URL de Ad Library</span>';
  const errorHtml = state.entityModal.error
    ? `<div class="ad-modal-error">${escapeHtml(state.entityModal.error)}</div>`
    : '';

  return `
    <div class="ad-modal-backdrop" data-action="close-entity-modal" role="presentation">
      <div class="ad-modal entity-detail-modal" role="dialog" aria-modal="true" aria-label="Detalle de entidad">
        <div class="ad-modal-header">
          <h3 class="ad-modal-title">${escapeHtml(entity.entityName || '—')}</h3>
          <button type="button" class="ad-modal-close" data-action="close-entity-modal" aria-label="Cerrar">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="ad-modal-meta">${statusBadge}</div>
        <div class="ad-modal-block">
          <div class="ad-modal-label">Categoría</div>
          <div>${escapeHtml(formatSegmentLabel(entity.segment))} · ${escapeHtml(entity.sector || '—')}</div>
        </div>
        <div class="ad-modal-block">
          <div class="ad-modal-label">Días de historial</div>
          <div>${escapeHtml(String(entity.historicalDays || 0))}</div>
        </div>
        <div class="ad-modal-block">
          <div class="ad-modal-label">Último movimiento</div>
          <div>${escapeHtml(entity.lastMovementDate ? formatDate(entity.lastMovementDate) : '—')}</div>
        </div>
        <div class="ad-modal-actions" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${libraryLink}
          <button type="button" class="btn ${isActive ? 'btn-warn' : 'btn-primary'}"
            data-action="toggle-entity-active" ${state.entityModal.busy ? 'disabled' : ''}>
            ${escapeHtml(toggleLabel)}
          </button>
        </div>
        ${errorHtml}
      </div>
    </div>
  `;
}

function renderAddEntityModal() {
  if (!state.addEntityModal.open) return '';
  const m = state.addEntityModal;
  const errorHtml = m.error
    ? `<div class="ad-modal-error">${escapeHtml(m.error)}</div>`
    : '';
  const segmentOptions = [
    { value: 'prestamos', label: 'Préstamos' },
    { value: 'cooperativa', label: 'Cooperativa' },
    { value: 'deuda', label: 'Deuda' },
  ].map((opt) => {
    const selected = opt.value === m.segment ? ' selected' : '';
    return `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
  }).join('');

  return `
    <div class="ad-modal-backdrop" data-action="close-add-entity-modal" role="presentation">
      <div class="ad-modal entity-detail-modal" role="dialog" aria-modal="true" aria-label="Agregar entidad">
        <div class="ad-modal-header">
          <h3 class="ad-modal-title">Agregar entidad</h3>
          <button type="button" class="ad-modal-close" data-action="close-add-entity-modal" aria-label="Cerrar">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        <form id="add-entity-form" class="entity-form">
          <label class="entity-form-field">
            <span class="ad-modal-label">Nombre</span>
            <input class="input" type="text" name="name" id="add-entity-name"
              value="${escapeHtml(m.name)}" required ${m.busy ? 'disabled' : ''} />
          </label>
          <label class="entity-form-field">
            <span class="ad-modal-label">Categoría</span>
            <select class="select" name="segment" id="add-entity-segment" ${m.busy ? 'disabled' : ''}>
              ${segmentOptions}
            </select>
          </label>
          <label class="entity-form-field">
            <span class="ad-modal-label">Ad Library URL</span>
            <input class="input" type="url" name="adLibraryUrl" id="add-entity-url"
              value="${escapeHtml(m.adLibraryUrl)}" required ${m.busy ? 'disabled' : ''}
              placeholder="https://www.facebook.com/ads/library/..." />
          </label>
          <label class="entity-form-field">
            <span class="ad-modal-label">Dominio web <span class="text-muted">(opcional, para match SERP)</span></span>
            <input class="input" type="text" name="websiteDomain" id="add-entity-website-domain"
              value="${escapeHtml(m.websiteDomain || '')}" ${m.busy ? 'disabled' : ''}
              placeholder="ej. alprestamo.uy" autocomplete="off" />
          </label>
          ${errorHtml}
          <div class="ad-modal-actions">
            <button type="submit" class="btn btn-primary" ${m.busy ? 'disabled' : ''}>
              ${m.busy ? 'Guardando…' : 'Crear entidad'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderIntensityGauges() {
  let body;
  if (state.gauge.loading) {
    const skeletons = new Array(10)
      .fill('<div class="gauge-chip skeleton skeleton-gauge-chip"></div>')
      .join('');
    body = `<div class="gauge-chip-grid is-mixed">${skeletons}</div>`;
  } else if (state.gauge.error) {
    body = `<div class="empty-state">No se pudo cargar la intensidad: ${escapeHtml(state.gauge.error)}</div>`;
  } else if (!state.gauge.entities.length) {
    body = `<div class="empty-state">Sin entidades monitoreadas.</div>`;
  } else {
    const term = String(state.gauge.searchTerm || '').trim().toLowerCase();
    // Local copy only — never mutate state.gauge.entities (Array#sort is in-place).
    let sorted = [...state.gauge.entities].sort(compareIntensityChips);
    if (term) {
      sorted = sorted.filter((g) =>
        String(g.entityName || '').toLowerCase().includes(term));
    }
    if (!sorted.length) {
      body = `<div class="empty-state">Sin resultados</div>`;
    } else {
      const featured = [];
      const recent = [];
      const idle = [];
      sorted.forEach((g) => {
        if (g.active === false) {
          idle.push(g);
          return;
        }
        if (g.mode === 'ready' && g.intensity && g.intensity.level === 'above') {
          featured.push(g);
          return;
        }
        if (g.mode === 'collecting' && (Number(g.historicalDays) || 0) <= 0) {
          idle.push(g);
          return;
        }
        recent.push(g);
      });
      const parts = [];
      let idx = 0;
      if (featured.length) {
        parts.push(renderGaugeSection(
          'Alta actividad',
          'is-featured-row',
          featured.map((g) => renderIntensityChip(g, idx++)).join(''),
        ));
      }
      if (recent.length) {
        // Ready chips + collecting with día > 0/7 (keep día X/7 visible).
        const recentHtml = recent.map((g) => renderIntensityChip(g, idx++)).join('');
        const recentGrid = recent.every((g) => g.mode === 'ready' && g.intensity)
          ? 'is-ready-row'
          : 'is-recent-row';
        parts.push(renderGaugeSection('Actividad reciente', recentGrid, recentHtml));
      }
      if (idle.length) {
        parts.push(renderGaugeSection(
          'Sin movimiento (últimos 7 días)',
          'is-idle-row',
          idle.map((g) => renderIntensityChip(g, idx++, 'idle')).join(''),
        ));
      }
      body = parts.join('');
    }
  }

  return `
    <section class="section">
      <div class="section-title-row">
        <h2 class="section-title">
          <i class="ti ti-activity" aria-hidden="true"></i>
          Intensidad de mercado
          <span class="section-emoji" aria-hidden="true">📊</span>
        </h2>
        <button type="button" class="btn btn-primary" data-action="open-add-entity">
          + Agregar
        </button>
      </div>
      <div class="gauge-toolbar">
        <input
          class="input"
          type="search"
          id="gauge-search-input"
          placeholder="Buscar entidad…"
          value="${escapeHtml(state.gauge.searchTerm || '')}"
          autocomplete="off"
        />
      </div>
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
    {
      label: 'Movimientos',
      emoji: '🔥',
      value: stats.totalEvents || 0,
      tone: 'accent',
      icon: 'ti-activity',
    },
    {
      label: 'Anuncios nuevos',
      emoji: '✨',
      value: stats.newAds || 0,
      tone: 'accent',
      icon: 'ti-plus',
    },
    {
      label: 'Cambios de copy',
      emoji: '✏️',
      value: stats.copyChanges || 0,
      tone: 'neutral',
      icon: 'ti-edit',
    },
    {
      label: 'Reactivaciones',
      emoji: '🔁',
      value: stats.reactivations || 0,
      tone: 'success',
      icon: 'ti-refresh',
    },
    {
      label: 'Desactivaciones',
      emoji: '⛔',
      value: stats.deactivations || 0,
      tone: 'danger',
      icon: 'ti-power',
    },
    {
      label: 'Entidades con movimiento',
      emoji: '🏢',
      value: stats.activeEntities || 0,
      tone: 'neutral',
      icon: 'ti-building',
    },
  ];

  const cardsHtml = cards
    .map((card) => {
      const valueTone =
        card.tone === 'success' || card.tone === 'danger' ? ` is-${card.tone}` : '';
      return `
        <div class="kpi-card is-${escapeHtml(card.tone)}">
          <div class="kpi-value${valueTone}">${escapeHtml(String(card.value))}</div>
          <div class="kpi-label">
            <i class="ti ${escapeHtml(card.icon)}" aria-hidden="true"></i>
            <span class="kpi-emoji" aria-hidden="true">${card.emoji}</span>
            ${escapeHtml(card.label)}
          </div>
        </div>
      `;
    })
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
      <section class="section" id="entity-activity-section">
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
    <section class="section" id="entity-activity-section">
      <h2 class="section-title">Actividad de competidores</h2>
      <div class="table-wrap">
        <table data-table="entity-activity">
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
        <table data-table="events-of-day">
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
    <section class="section" id="events-of-day-section">
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
    root.innerHTML = `${renderLoadingSkeleton()}${renderAdModal()}${renderEntityModal()}${renderAddEntityModal()}`;
    bindEvents();
    return;
  }

  if (state.error) {
    root.innerHTML = `${renderError()}${renderAdModal()}${renderEntityModal()}${renderAddEntityModal()}`;
    bindEvents();
    return;
  }

  root.innerHTML = `
    ${renderHeader()}
    ${renderStatusLine()}
    ${renderContent()}
    ${renderAdModal()}
    ${renderEntityModal()}
    ${renderAddEntityModal()}
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

  // Entity aggregate rows: filter only — never open ad modal (no single ad_id).
  root.querySelectorAll('#entity-activity-section .entity-row').forEach((row) => {
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

  // Ad detail modal: Eventos del día rows only.
  root.querySelectorAll('#events-of-day-section .event-row').forEach((row) => {
    const openFromRow = () => {
      const idx = Number(row.getAttribute('data-event-index'));
      if (!Number.isFinite(idx) || idx < 0) return;
      const event = filteredEvents[idx];
      if (event && event.adId) loadAdDetailForEvent(event);
    };
    row.addEventListener('click', openFromRow);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFromRow();
      }
    });
  });

  root.querySelectorAll('.ad-modal').forEach((modalPanel) => {
    modalPanel.addEventListener('click', (e) => {
      e.stopPropagation();
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

  const gaugeSearch = root.querySelector('#gauge-search-input');
  if (gaugeSearch) {
    gaugeSearch.addEventListener('input', (e) => {
      state.gauge.searchTerm = e.target.value;
      const caret = e.target.selectionStart;
      render();
      const newSearch = root.querySelector('#gauge-search-input');
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

  const addForm = root.querySelector('#add-entity-form');
  if (addForm) {
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = root.querySelector('#add-entity-name');
      const segmentInput = root.querySelector('#add-entity-segment');
      const urlInput = root.querySelector('#add-entity-url');
      const domainInput = root.querySelector('#add-entity-website-domain');
      state.addEntityModal.name = nameInput ? nameInput.value : '';
      state.addEntityModal.segment = segmentInput ? segmentInput.value : 'prestamos';
      state.addEntityModal.adLibraryUrl = urlInput ? urlInput.value : '';
      state.addEntityModal.websiteDomain = domainInput ? domainInput.value : '';
      submitAddEntity();
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
    case 'open-entity-modal': {
      const entityId = e.currentTarget.getAttribute('data-entity-id');
      if (entityId) openEntityModal(entityId);
      break;
    }
    case 'close-entity-modal':
      closeEntityModal();
      break;
    case 'toggle-entity-active':
      toggleEntityActive();
      break;
    case 'open-add-entity':
      openAddEntityModal();
      break;
    case 'close-add-entity-modal':
      closeAddEntityModal();
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

/* ----------------------------------------------------------------------------
 * Competidores — mutually exclusive sub-views (meta | google)
 * Visibility toggles only; never rebuild #mie-market-root from this shell.
 * ------------------------------------------------------------------------- */
(function initMarketViews() {
  const marketRoot = document.getElementById('mie-market-root');
  const chrome = document.getElementById('market-chrome');
  const googleLanding = document.getElementById('serp-import-landing');
  const metaBtn = document.getElementById('market-meta-tab-btn');
  const googleBtn = document.getElementById('market-google-tab-btn');

  function setVisible(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  function setMarketView(view) {
    const v = view === 'google' ? 'google' : 'meta';
    setVisible(marketRoot, v === 'meta');
    setVisible(googleLanding, v === 'google');
    setVisible(chrome, true);
    if (metaBtn) metaBtn.classList.toggle('active', v === 'meta');
    if (googleBtn) googleBtn.classList.toggle('active', v === 'google');
    if (v === 'google' && typeof window.__openGoogleSerp === 'function') {
      window.__openGoogleSerp();
    }
  }

  window.__setMarketView = setMarketView;
  if (metaBtn) metaBtn.addEventListener('click', () => setMarketView('meta'));
  if (googleBtn) googleBtn.addEventListener('click', () => setMarketView('google'));
  setMarketView('meta');
})();

/* ----------------------------------------------------------------------------
 * Meta Ads — mutually exclusive views (agent | changes | own-ads)
 * Visibility toggles only; never rebuild #meta-ads-root.
 * ------------------------------------------------------------------------- */
(function initMetaAdsViews() {
  const agentRoot = document.getElementById('meta-ads-root');
  const chrome = document.getElementById('meta-ads-chrome');
  const changesLanding = document.getElementById('meta-changes-landing');
  const ownAdsLanding = document.getElementById('meta-own-ads-landing');
  const ownAdsBtn = document.getElementById('meta-own-ads-open-btn');
  const changesBtn = document.getElementById('meta-changes-open-btn');

  function setVisible(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  function setMetaAdsView(view) {
    const v = view === 'changes' || view === 'own-ads' ? view : 'agent';
    setVisible(agentRoot, v === 'agent');
    // The sub-row stays visible for every Meta Ads sub-view; only the active
    // sub-view button gets highlighted (none when the agent panel is shown).
    setVisible(chrome, true);
    setVisible(changesLanding, v === 'changes');
    setVisible(ownAdsLanding, v === 'own-ads');
    if (ownAdsBtn) ownAdsBtn.classList.toggle('active', v === 'own-ads');
    if (changesBtn) changesBtn.classList.toggle('active', v === 'changes');
  }

  window.__setMetaAdsView = setMetaAdsView;
  setMetaAdsView('agent');
})();

/* ----------------------------------------------------------------------------
 * Meta Ads — Historial de cambios (sibling of #meta-ads-root; visibility only)
 * Does not touch #mie-market-root or rebuild the Meta Ads agent DOM.
 * ------------------------------------------------------------------------- */
(function initMetaChangesLanding() {
  const landing = document.getElementById('meta-changes-landing');
  const openBtn = document.getElementById('meta-changes-open-btn');
  const backBtn = document.getElementById('meta-changes-back-btn');
  const eventTypeSelect = document.getElementById('mcl-event-type');
  const fromInput = document.getElementById('mcl-from');
  const toInput = document.getElementById('mcl-to');
  const statusEl = document.getElementById('mcl-status');
  const resultsEl = document.getElementById('mcl-results');
  const paginationEl = document.getElementById('mcl-pagination');

  if (
    !landing ||
    !openBtn ||
    !backBtn ||
    !eventTypeSelect ||
    !fromInput ||
    !toInput ||
    !statusEl ||
    !resultsEl ||
    !paginationEl ||
    typeof window.__setMetaAdsView !== 'function'
  ) {
    return;
  }

  const EMPTY_FILTERED = 'No se registraron cambios en este rango.';
  const EMPTY_NEVER = 'Todavía no se registraron cambios desde que comenzó la captura.';
  const PAGE_LIMIT = 50;

  const mclState = {
    page: 1,
    hasMore: false,
    rows: [],
    historyExists: null,
    eventTypesLoaded: false,
    loading: false,
  };

  let abortController = null;
  let requestSeq = 0;

  function shiftUtcDateOnly(dateStr, deltaDays) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().split('T')[0];
  }

  function todayUtcDateOnly() {
    return new Date().toISOString().split('T')[0];
  }

  function setDefaultDates() {
    const to = todayUtcDateOnly();
    const from = shiftUtcDateOnly(to, -29);
    toInput.value = to;
    fromInput.value = from;
  }

  function formatEventTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('es-UY', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hour12: false,
    }) + ' UTC';
  }

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function renderEventTypeOptions(types) {
    const previous = eventTypeSelect.value;
    eventTypeSelect.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'Todos los tipos';
    eventTypeSelect.appendChild(allOpt);

    (types || []).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.eventType;
      opt.textContent = t.label || t.eventType;
      eventTypeSelect.appendChild(opt);
    });

    if (previous && [...eventTypeSelect.options].some((o) => o.value === previous)) {
      eventTypeSelect.value = previous;
    }
  }

  function buildRowElement(row) {
    const el = document.createElement('article');
    el.className = 'mcl-row';
    const badgeLabel = row.translatedEventType || row.eventType || 'cambio';
    el.innerHTML =
      '<div class="mcl-row-time">' +
      escapeHtml(formatEventTime(row.eventTime)) +
      '</div>' +
      '<div><span class="mcl-badge" title="' +
      escapeHtml(row.eventType || '') +
      '">' +
      escapeHtml(badgeLabel) +
      '</span></div>' +
      '<div class="mcl-row-object">' +
      escapeHtml(row.objectName || '—') +
      '</div>' +
      '<div class="mcl-row-type">' +
      escapeHtml(row.objectType || '—') +
      '</div>' +
      '<div class="mcl-row-actor">' +
      escapeHtml(row.actorName || '—') +
      '</div>';
    return el;
  }

  function renderEmptyState() {
    resultsEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'mcl-empty';
    empty.textContent =
      mclState.historyExists === false ? EMPTY_NEVER : EMPTY_FILTERED;
    resultsEl.appendChild(empty);
  }

  function renderRows(rows, append) {
    if (!append) resultsEl.innerHTML = '';
    if (!rows.length && !append) {
      renderEmptyState();
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((row) => {
      frag.appendChild(buildRowElement(row));
    });
    resultsEl.appendChild(frag);
  }

  function renderPagination() {
    paginationEl.innerHTML = '';
    if (!mclState.hasMore) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mcl-more-btn';
    btn.textContent = mclState.loading ? 'Cargando…' : 'Cargar más';
    btn.disabled = mclState.loading;
    btn.addEventListener('click', () => {
      if (mclState.loading || !mclState.hasMore) return;
      loadChanges({ page: mclState.page + 1, append: true });
    });
    paginationEl.appendChild(btn);
  }

  async function loadEventTypes() {
    try {
      const res = await fetch(API_BASE + '/reports/own-ad-changes/event-types', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('event-types ' + res.status);
      const types = await res.json();
      const list = Array.isArray(types) ? types : [];
      mclState.historyExists = list.length > 0;
      renderEventTypeOptions(list);
      mclState.eventTypesLoaded = true;
    } catch (err) {
      mclState.historyExists = null;
      renderEventTypeOptions([]);
      mclState.eventTypesLoaded = true;
    }
  }

  async function loadChanges({ page, append }) {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) {
      setStatus('Indicá un rango de fechas válido.', true);
      return;
    }

    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const seq = ++requestSeq;
    const signal = abortController.signal;

    mclState.loading = true;
    mclState.page = page;
    setStatus(append ? 'Cargando más…' : 'Cargando…', false);
    renderPagination();

    const params = new URLSearchParams({
      from,
      to,
      page: String(page),
      limit: String(PAGE_LIMIT),
    });
    const eventType = eventTypeSelect.value;
    if (eventType) params.set('eventType', eventType);

    try {
      const res = await fetch(
        API_BASE + '/reports/own-ad-changes?' + params.toString(),
        { headers: { Accept: 'application/json' }, signal },
      );

      if (seq !== requestSeq) return;

      let body = null;
      try {
        body = await res.json();
      } catch (parseErr) {
        body = null;
      }

      if (seq !== requestSeq) return;

      if (!res.ok) {
        const msg =
          (body && body.error) ||
          'No se pudo cargar el historial de cambios.';
        setStatus(msg, true);
        if (!append) {
          mclState.rows = [];
          resultsEl.innerHTML = '';
        }
        mclState.hasMore = false;
        mclState.loading = false;
        renderPagination();
        return;
      }

      const nextRows = Array.isArray(body.rows) ? body.rows : [];
      const pagination = body.pagination || {};
      mclState.hasMore = Boolean(pagination.hasMore);
      mclState.page = pagination.page || page;
      mclState.rows = append ? mclState.rows.concat(nextRows) : nextRows;

      if (!mclState.rows.length) {
        renderEmptyState();
      } else {
        renderRows(nextRows, append);
      }

      setStatus(
        mclState.rows.length
          ? mclState.rows.length +
            (pagination.total != null ? ' de ' + pagination.total : '') +
            ' cambios'
          : '',
        false,
      );
      mclState.loading = false;
      renderPagination();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== requestSeq) return;
      setStatus('No se pudo conectar con el servidor.', true);
      mclState.loading = false;
      renderPagination();
    }
  }

  function onFiltersChanged() {
    mclState.page = 1;
    mclState.rows = [];
    loadChanges({ page: 1, append: false });
  }

  openBtn.addEventListener('click', async () => {
    window.__setMetaAdsView('changes');
    if (!fromInput.value || !toInput.value) setDefaultDates();
    if (!mclState.eventTypesLoaded) await loadEventTypes();
    mclState.page = 1;
    mclState.rows = [];
    loadChanges({ page: 1, append: false });
  });

  backBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
    window.__setMetaAdsView('agent');
  });

  eventTypeSelect.addEventListener('change', onFiltersChanged);
  fromInput.addEventListener('change', onFiltersChanged);
  toInput.addEventListener('change', onFiltersChanged);

  setDefaultDates();
})();

/* ----------------------------------------------------------------------------
 * Meta Ads — Análisis IA (Own Ads brief, day-by-day)
 * Consumes GET /hugo/knowledge-own-ads via the same API_BASE pattern.
 * Renderer reads ONLY normalizeOwnAdsKnowledge() output.
 * ------------------------------------------------------------------------- */
(function initMetaOwnAdsLanding() {
  const landing = document.getElementById('meta-own-ads-landing');
  const openBtn = document.getElementById('meta-own-ads-open-btn');
  const backBtn = document.getElementById('meta-own-ads-back-btn');
  const prevBtn = document.getElementById('moa-prev-date');
  const nextBtn = document.getElementById('moa-next-date');
  const dateLabel = document.getElementById('moa-date-label');
  const bodyEl = document.getElementById('moa-body');
  const footerEl = document.getElementById('moa-footer');

  if (
    !landing ||
    !openBtn ||
    !backBtn ||
    !prevBtn ||
    !nextBtn ||
    !dateLabel ||
    !bodyEl ||
    !footerEl ||
    typeof window.__setMetaAdsView !== 'function'
  ) {
    return;
  }

  const KNOWN_STATES = {
    has_data: true,
    no_campaigns_found: true,
    collection_failed: true,
    collection_in_progress: true,
    no_metrics_for_date: true,
    no_successful_run: true,
  };

  const moaState = {
    date: null,
    loading: false,
  };

  let abortController = null;
  let requestSeq = 0;

  function maxReportingDate() {
    // Own Ads briefs are keyed by reporting date (= yesterday convention).
    return shiftDate(getLocalToday(), -1);
  }

  function formatMetricDisplay(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return String(n);
  }

  function asStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => (item == null ? '' : String(item).trim()))
      .filter(Boolean);
  }

  function asNullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Single normalizer: live GET /hugo/knowledge-own-ads → flat internal object.
   * Authoritative map (Phase 0 audit 2026-07-12):
   * - state: top-level knowledge.state (also mirrored in brief.state)
   * - headline/summary/metrics/lists/confidence: brief.*
   * - generatedAt: top-level
   * - modelArchitect/modelAuditor: meta.*
   * HTTP 404 → notFound: true (no fabricated no_successful_run).
   */
  function normalizeOwnAdsKnowledge(payload, httpStatus) {
    if (httpStatus === 404 || !payload || typeof payload !== 'object') {
      return {
        notFound: true,
        httpStatus: httpStatus || null,
        date: '',
        state: null,
        headline: '',
        summary: '',
        metrics: {
          spend: null,
          impressions: null,
          clicks: null,
          frequency: null,
          ctr: null,
          cpc: null,
          cpm: null,
        },
        highlights: [],
        alerts: [],
        recommendations: [],
        confidence: 'none',
        generatedAt: '',
        modelArchitect: null,
        modelAuditor: null,
        errorMessage: '',
      };
    }

    const brief =
      payload.brief && typeof payload.brief === 'object' ? payload.brief : {};
    const meta =
      payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
    const metricsIn =
      brief.metrics && typeof brief.metrics === 'object' ? brief.metrics : {};

    const topState =
      payload.state != null && String(payload.state).trim()
        ? String(payload.state).trim()
        : '';
    const briefState =
      brief.state != null && String(brief.state).trim()
        ? String(brief.state).trim()
        : '';
    const state = topState || briefState || 'unknown';

    const architect =
      meta.modelArchitect != null && String(meta.modelArchitect).trim()
        ? String(meta.modelArchitect).trim()
        : null;
    const auditor =
      meta.modelAuditor != null && String(meta.modelAuditor).trim()
        ? String(meta.modelAuditor).trim()
        : null;

    let confidence =
      brief.confidence != null && String(brief.confidence).trim()
        ? String(brief.confidence).trim().toLowerCase()
        : 'none';
    if (!['none', 'low', 'medium', 'high'].includes(confidence)) {
      confidence = 'none';
    }

    return {
      notFound: false,
      httpStatus: httpStatus || 200,
      date: payload.date != null ? String(payload.date) : '',
      state,
      headline: brief.headline != null ? String(brief.headline) : '',
      summary: brief.summary != null ? String(brief.summary) : '',
      metrics: {
        spend: asNullableNumber(metricsIn.spend),
        impressions: asNullableNumber(metricsIn.impressions),
        clicks: asNullableNumber(metricsIn.clicks),
        frequency: asNullableNumber(metricsIn.frequency),
        // Backend sends ctr as a ratio (0.023); percentage is display-only.
        ctr: asNullableNumber(metricsIn.ctr),
        cpc: asNullableNumber(metricsIn.cpc),
        cpm: asNullableNumber(metricsIn.cpm),
      },
      highlights: asStringArray(brief.highlights),
      alerts: asStringArray(brief.alerts),
      recommendations: asStringArray(brief.recommendations),
      confidence,
      generatedAt: payload.generatedAt != null ? String(payload.generatedAt) : '',
      modelArchitect: architect,
      modelAuditor: auditor,
      errorMessage: '',
    };
  }

  function confidenceBadgeClass(confidence) {
    if (confidence === 'high') return 'moa-conf moa-conf-high';
    if (confidence === 'medium') return 'moa-conf moa-conf-medium';
    if (confidence === 'low') return 'moa-conf moa-conf-low';
    return 'moa-conf moa-conf-none';
  }

  function renderListSection(title, items, className) {
    if (!items.length) return '';
    return (
      '<section class="moa-section ' +
      className +
      '">' +
      '<h2 class="moa-section-title">' +
      escapeHtml(title) +
      '</h2>' +
      '<ul class="moa-list">' +
      items
        .map((item) => '<li>' + escapeHtml(item) + '</li>')
        .join('') +
      '</ul>' +
      '</section>'
    );
  }

  // Display-only formatters: null stays "—", never a fabricated 0.
  function formatPercentDisplay(ratio) {
    if (ratio === null || ratio === undefined) return '—';
    const n = Number(ratio);
    if (!Number.isFinite(n)) return '—';
    return (n * 100).toFixed(2) + '%';
  }

  function formatCurrencyDisplay(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }

  function renderMetricsRow(metrics) {
    const cells = [
      { label: 'Spend', value: metrics.spend },
      { label: 'Impressions', value: metrics.impressions },
      { label: 'Clicks', value: metrics.clicks },
      { label: 'Frequency', value: metrics.frequency },
      { label: 'CTR', value: metrics.ctr, format: formatPercentDisplay },
      { label: 'CPC', value: metrics.cpc, format: formatCurrencyDisplay },
      { label: 'CPM', value: metrics.cpm, format: formatCurrencyDisplay },
    ];
    return (
      '<div class="moa-metrics">' +
      cells
        .map(
          (c) =>
            '<div class="moa-metric">' +
            '<div class="moa-metric-label">' +
            escapeHtml(c.label) +
            '</div>' +
            '<div class="moa-metric-value">' +
            escapeHtml((c.format || formatMetricDisplay)(c.value)) +
            '</div>' +
            '</div>',
        )
        .join('') +
      '</div>'
    );
  }

  function renderFooter(normalized) {
    if (normalized.modelArchitect && normalized.modelAuditor) {
      footerEl.textContent =
        normalized.modelArchitect + ' · ' + normalized.modelAuditor;
      return;
    }
    footerEl.textContent = 'Modelos no informados';
  }

  function renderNormalized(normalized) {
    renderFooter(normalized);

    if (normalized.notFound) {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-empty">' +
        '<p class="moa-panel-title">Sin brief para esta fecha</p>' +
        '<p class="moa-panel-text">No hay un Own Ads Daily Knowledge persistido para esta fecha de reporting. ' +
        'Esto es esperable antes de que existiera el pipeline o si aún no se generó el brief.</p>' +
        '</div>';
      return;
    }

    if (normalized.errorMessage) {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-error">' +
        '<p class="moa-panel-title">No se pudo cargar el brief</p>' +
        '<p class="moa-panel-text">' +
        escapeHtml(normalized.errorMessage) +
        '</p>' +
        '</div>';
      return;
    }

    const state = normalized.state;
    if (!KNOWN_STATES[state]) {
      console.warn('[own-ads] Unknown state:', state);
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-neutral">' +
        '<p class="moa-panel-title">Estado no reconocido</p>' +
        '<p class="moa-panel-text">El brief devolvió un estado que esta pantalla aún no interpreta' +
        (state ? ' (' + escapeHtml(state) + ')' : '') +
        '. No se muestra un análisis incompleto.</p>' +
        '</div>';
      return;
    }

    if (state === 'collection_in_progress') {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-progress">' +
        '<p class="moa-panel-title">Recolección en curso</p>' +
        '<p class="moa-panel-text">' +
        escapeHtml(
          normalized.summary ||
            normalized.headline ||
            'La recolección de métricas Own Ads está en curso. Todavía no hay resultados para mostrar.',
        ) +
        '</p>' +
        '</div>';
      return;
    }

    if (state === 'collection_failed') {
      const technical =
        [normalized.headline, normalized.summary]
          .filter(Boolean)
          .join('\n\n') ||
        'Falló la recolección Own Ads.';
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-error">' +
        '<div class="moa-panel-top">' +
        '<p class="moa-panel-title">Falla de recolección</p>' +
        '<span class="' +
        confidenceBadgeClass(normalized.confidence) +
        '">' +
        escapeHtml(normalized.confidence) +
        '</span>' +
        '</div>' +
        '<p class="moa-panel-text moa-technical">' +
        escapeHtml(technical) +
        '</p>' +
        '</div>';
      return;
    }

    if (state === 'no_successful_run') {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-empty">' +
        '<p class="moa-panel-title">' +
        escapeHtml(normalized.headline || 'Sin recolección exitosa') +
        '</p>' +
        '<p class="moa-panel-text">' +
        escapeHtml(
          normalized.summary ||
            'Todavía no existe una recolección Own Ads exitosa para esta fecha. No se puede inferir el estado de las campañas.',
        ) +
        '</p>' +
        '</div>';
      return;
    }

    if (state === 'no_metrics_for_date') {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-empty">' +
        '<div class="moa-panel-top">' +
        '<p class="moa-panel-title">' +
        escapeHtml(normalized.headline || 'Sin métricas para esta fecha') +
        '</p>' +
        '<span class="' +
        confidenceBadgeClass(normalized.confidence) +
        '">' +
        escapeHtml(normalized.confidence) +
        '</span>' +
        '</div>' +
        '<p class="moa-panel-text">' +
        escapeHtml(
          normalized.summary ||
            'Hay datos Own Ads en otras fechas de la ventana, pero no para esta fecha de reporting.',
        ) +
        '</p>' +
        renderMetricsRow(normalized.metrics) +
        '</div>';
      return;
    }

    if (state === 'no_campaigns_found') {
      bodyEl.innerHTML =
        '<div class="moa-panel moa-panel-info">' +
        '<div class="moa-panel-top">' +
        '<p class="moa-panel-title">' +
        escapeHtml(normalized.headline || 'Sin campañas activas') +
        '</p>' +
        '<span class="' +
        confidenceBadgeClass(normalized.confidence) +
        '">' +
        escapeHtml(normalized.confidence) +
        '</span>' +
        '</div>' +
        '<p class="moa-panel-text">' +
        escapeHtml(
          normalized.summary ||
            'La recolección finalizó exitosamente y no encontró campañas activas.',
        ) +
        '</p>' +
        renderMetricsRow(normalized.metrics) +
        renderListSection('Alertas', normalized.alerts, 'moa-alerts') +
        renderListSection(
          'Highlights',
          normalized.highlights,
          'moa-highlights',
        ) +
        renderListSection(
          'Recomendaciones',
          normalized.recommendations,
          'moa-recs',
        ) +
        '</div>';
      return;
    }

    // has_data
    bodyEl.innerHTML =
      '<div class="moa-panel moa-panel-data">' +
      '<div class="moa-panel-top">' +
      '<p class="moa-panel-title">' +
      escapeHtml(normalized.headline || 'Own Ads') +
      '</p>' +
      '<span class="' +
      confidenceBadgeClass(normalized.confidence) +
      '">' +
      escapeHtml(normalized.confidence) +
      '</span>' +
      '</div>' +
      '<p class="moa-panel-text">' +
      escapeHtml(normalized.summary || '') +
      '</p>' +
      renderMetricsRow(normalized.metrics) +
      renderListSection('Highlights', normalized.highlights, 'moa-highlights') +
      renderListSection('Alertas', normalized.alerts, 'moa-alerts') +
      renderListSection(
        'Recomendaciones',
        normalized.recommendations,
        'moa-recs',
      ) +
      '</div>';
  }

  function updateDateChrome() {
    const maxDate = maxReportingDate();
    dateLabel.textContent = moaState.date || '—';
    nextBtn.disabled = !moaState.date || moaState.date >= maxDate;
  }

  async function loadBrief(date) {
    const maxDate = maxReportingDate();
    let target = date;
    if (!target || target > maxDate) target = maxDate;
    moaState.date = target;
    updateDateChrome();

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const seq = ++requestSeq;
    const signal = abortController.signal;

    moaState.loading = true;
    bodyEl.innerHTML =
      '<div class="moa-panel moa-panel-neutral"><p class="moa-panel-text">Cargando brief…</p></div>';
    footerEl.textContent = '';

    try {
      const res = await fetch(
        API_BASE +
          '/hugo/knowledge-own-ads?date=' +
          encodeURIComponent(target),
        { headers: { Accept: 'application/json' }, signal },
      );

      if (seq !== requestSeq) return;

      let body = null;
      try {
        body = await res.json();
      } catch (parseErr) {
        body = null;
      }

      if (seq !== requestSeq) return;

      if (res.status === 404) {
        renderNormalized(normalizeOwnAdsKnowledge(null, 404));
        moaState.loading = false;
        return;
      }

      if (!res.ok) {
        const msg =
          (body && body.error) ||
          'No se pudo cargar el Own Ads Daily Knowledge.';
        renderNormalized({
          ...normalizeOwnAdsKnowledge(null, res.status),
          notFound: false,
          errorMessage: String(msg),
        });
        moaState.loading = false;
        return;
      }

      renderNormalized(normalizeOwnAdsKnowledge(body, res.status));
      moaState.loading = false;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== requestSeq) return;
      renderNormalized({
        ...normalizeOwnAdsKnowledge(null, null),
        notFound: false,
        errorMessage: 'No se pudo conectar con el servidor.',
      });
      moaState.loading = false;
    }
  }

  openBtn.addEventListener('click', () => {
    window.__setMetaAdsView('own-ads');
    loadBrief(maxReportingDate());
  });

  backBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
    window.__setMetaAdsView('agent');
  });

  prevBtn.addEventListener('click', () => {
    if (!moaState.date || moaState.loading) return;
    loadBrief(shiftDate(moaState.date, -1));
  });

  nextBtn.addEventListener('click', () => {
    if (!moaState.date || moaState.loading) return;
    const maxDate = maxReportingDate();
    const next = shiftDate(moaState.date, 1);
    if (next > maxDate) return;
    loadBrief(next);
  });
})();

/* ----------------------------------------------------------------------------
 * Coverage suggestions landing (Inteligencia de mercado tab) — additive IIFE.
 * Reads GET /reports/coverage-suggestions (DB-backed, never a live Trends
 * call) and GET /reports/seo-landing-drafts. Decisions go through
 * POST /reports/coverage-suggestions/decide.
 * ------------------------------------------------------------------------- */
(function initCoverageLanding() {
  const statusEl = document.getElementById('cov-status');
  const suggestionsEl = document.getElementById('cov-suggestions');
  const applyBtn = document.getElementById('cov-apply-btn');
  const feedbackEl = document.getElementById('cov-apply-feedback');
  const draftsEl = document.getElementById('cov-drafts');

  if (!statusEl || !suggestionsEl || !applyBtn || !draftsEl) {
    return;
  }

  const covState = {
    suggestions: [],
    decisions: {}, // term -> decision value
    applying: false,
    pollTimer: null,
    pollAttempts: 0,
  };

  // Human judgment aid only — always overridable by the dropdown choice.
  function suggestKind(term) {
    const t = String(term || '').trim();
    const isSingleCapitalizedWord = !/\s/.test(t) && /^[A-ZÁÉÍÓÚÑ]/.test(t);
    return isSingleCapitalizedWord
      ? { label: 'posible marca sin monitorear', cls: 'is-brand' }
      : { label: 'frase de intención', cls: 'is-intent' };
  }

  function storagePublicUrl(storagePath) {
    const ds = window.__META_AGENT_DATASOURCE__ || {};
    if (!ds.supabaseUrl || !storagePath) return null;
    return `${String(ds.supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/${storagePath}`;
  }

  function renderSuggestions() {
    if (!covState.suggestions.length) {
      suggestionsEl.innerHTML =
        '<div class="cov-empty">No hay sugerencias pendientes. Corré un discovery (' +
        '<code>/jobs/discover-search-terms?seed=…</code>) para poblar esta lista.</div>';
      applyBtn.disabled = true;
      return;
    }

    const rows = covState.suggestions
      .map((s, idx) => {
        const kind = suggestKind(s.term);
        const sourceLabel =
          s.queryType === 'serp'
            ? `📥 SERP import · dominio sin match · seed: ${escapeHtml(s.seed)}`
            : `${s.queryType === 'rising' ? '📈 Rising' : '🔝 Top'} · ${escapeHtml(
                s.formattedValue || String(s.score ?? '—'),
              )} · seed: ${escapeHtml(s.seed)}`;
        const covered = s.alreadyCovered
          ? `<span class="cov-badge is-covered" title="Ya existe en monitored_entities: ${escapeHtml(
              (s.coveredByEntity && s.coveredByEntity.name) || '',
            )}">ya monitoreada</span>`
          : '';
        const selected = covState.decisions[s.term] || '';
        return `
          <tr>
            <td class="cov-term">${escapeHtml(s.term)}</td>
            <td class="cov-source">${sourceLabel}</td>
            <td><span class="cov-badge ${kind.cls}">${kind.label}</span> ${covered}</td>
            <td>
              <select class="cov-decision mcl-select" data-cov-idx="${idx}" ${covState.applying ? 'disabled' : ''}>
                <option value="" ${selected === '' ? 'selected' : ''}>— Sin decisión —</option>
                <option value="added_as_competitor" ${selected === 'added_as_competitor' ? 'selected' : ''}>Monitorear competidor</option>
                <option value="monitor_trends" ${selected === 'monitor_trends' ? 'selected' : ''}>Generar landing SEO</option>
                <option value="discarded" ${selected === 'discarded' ? 'selected' : ''}>Descartar</option>
              </select>
            </td>
          </tr>`;
      })
      .join('');

    suggestionsEl.innerHTML = `
      <table class="cov-table">
        <thead>
          <tr><th>Término</th><th>Fuente</th><th>Tipo sugerido</th><th>Decisión</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    suggestionsEl.querySelectorAll('.cov-decision').forEach((sel) => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.getAttribute('data-cov-idx'));
        const suggestion = covState.suggestions[idx];
        if (!suggestion) return;
        if (sel.value) {
          covState.decisions[suggestion.term] = sel.value;
        } else {
          delete covState.decisions[suggestion.term];
        }
        applyBtn.disabled = covState.applying || !Object.keys(covState.decisions).length;
      });
    });

    applyBtn.disabled = covState.applying || !Object.keys(covState.decisions).length;
  }

  function draftStatusBadge(draft) {
    const map = {
      draft: ['Borrador', 'is-draft'],
      reviewed: ['Revisado', 'is-reviewed'],
      published: ['Publicado', 'is-published'],
      failed: ['Falló', 'is-failed'],
    };
    const [label, cls] = map[draft.status] || [draft.status, ''];
    return `<span class="cov-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function renderDrafts(drafts) {
    if (!drafts.length) {
      draftsEl.innerHTML = '<div class="cov-empty">Sin borradores generados todavía.</div>';
      return;
    }
    draftsEl.innerHTML = drafts
      .map((d) => {
        const when = d.generatedAt ? String(d.generatedAt).slice(0, 16).replace('T', ' ') : '—';
        const publishedWhen = d.publishedAt
          ? String(d.publishedAt).slice(0, 16).replace('T', ' ')
          : null;
        const downloadUrl = storagePublicUrl(d.storagePath);
        const previewLink =
          d.status !== 'failed'
            ? `<a class="cov-link" href="${API_BASE}/reports/seo-landing-drafts/${encodeURIComponent(d.id)}/html" target="_blank" rel="noopener">Vista previa</a>`
            : '';
        const downloadLink = downloadUrl
          ? `<a class="cov-link" href="${downloadUrl}" target="_blank" rel="noopener" download>Descargar HTML</a>`
          : '';
        const errorNote = d.generationError
          ? `<div class="cov-draft-error">${escapeHtml(d.generationError)}</div>`
          : '';
        const publishedNote =
          d.status === 'published' && publishedWhen
            ? `<span class="cov-draft-date">Publicado ${escapeHtml(publishedWhen)}</span>`
            : '';
        let statusAction = '';
        if (d.status === 'draft') {
          statusAction = `<button type="button" class="btn cov-status-btn" data-draft-id="${escapeHtml(d.id)}" data-next-status="reviewed">Marcar revisado</button>`;
        } else if (d.status === 'reviewed') {
          statusAction = `<button type="button" class="btn btn-primary cov-status-btn" data-draft-id="${escapeHtml(d.id)}" data-next-status="published">Publicar</button>`;
        }
        return `
          <div class="cov-draft-card">
            <div class="cov-draft-main">
              <span class="cov-draft-term">${escapeHtml(d.term || '(término desconocido)')}</span>
              ${draftStatusBadge(d)}
              <span class="cov-draft-date">${escapeHtml(when)}</span>
              ${publishedNote}
            </div>
            ${errorNote}
            <div class="cov-draft-actions">
              ${previewLink}
              ${downloadLink}
              ${statusAction}
              <button type="button" class="btn cov-regenerate-btn" data-draft-id="${escapeHtml(d.id)}"
                title="Vuelve a generar el contenido con los prompts actuales (el borrador vuelve a revisión)">
                Regenerar
              </button>
            </div>
          </div>`;
      })
      .join('');

    draftsEl.querySelectorAll('.cov-regenerate-btn').forEach((btn) => {
      btn.addEventListener('click', () => regenerateDraft(btn));
    });
    draftsEl.querySelectorAll('.cov-status-btn').forEach((btn) => {
      btn.addEventListener('click', () => updateDraftStatus(btn));
    });
  }

  // Regeneration runs async server-side (same fire-and-forget pattern as the
  // decide trigger) — disable the button and reuse the drafts poll to pick up
  // the refreshed row when it lands.
  async function regenerateDraft(btn) {
    const draftId = btn.getAttribute('data-draft-id');
    if (!draftId || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Regenerando…';
    try {
      const res = await fetch(
        `${API_BASE}/reports/seo-landing-drafts/${encodeURIComponent(draftId)}/regenerate`,
        { method: 'POST', headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      schedulePoll();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Regenerar';
    }
  }

  async function updateDraftStatus(btn) {
    const draftId = btn.getAttribute('data-draft-id');
    const nextStatus = btn.getAttribute('data-next-status');
    if (!draftId || !nextStatus || btn.disabled) return;

    if (nextStatus === 'published') {
      const ok = window.confirm(
        '¿Publicar esta landing?\n\nPor ahora solo marca el estado como Publicado. La subida automática al hosting real se conectará cuando haya credenciales.',
      );
      if (!ok) return;
    }

    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = nextStatus === 'published' ? 'Publicando…' : 'Guardando…';
    try {
      const res = await fetch(
        `${API_BASE}/reports/seo-landing-drafts/${encodeURIComponent(draftId)}/status`,
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await loadDrafts();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      window.alert(err && err.message ? err.message : 'No se pudo actualizar el estado.');
    }
  }

  async function loadSuggestions() {
    statusEl.textContent = 'Cargando sugerencias…';
    try {
      const res = await fetch(`${API_BASE}/reports/search-discoveries?view=pending`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      covState.suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
      covState.decisions = {};
      statusEl.textContent = covState.suggestions.length
        ? `${covState.suggestions.length} sugerencias pendientes de decisión`
        : '';
      renderSuggestions();
    } catch (err) {
      statusEl.textContent = 'No se pudieron cargar las sugerencias.';
      suggestionsEl.innerHTML = '';
    }
  }

  async function loadDrafts() {
    try {
      const res = await fetch(`${API_BASE}/reports/seo-landing-drafts`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      renderDrafts(Array.isArray(body.drafts) ? body.drafts : []);
      return body.drafts || [];
    } catch (err) {
      draftsEl.innerHTML = '<div class="cov-empty">No se pudieron cargar los borradores.</div>';
      return [];
    }
  }

  // Generation runs async server-side (~8-15s) — poll the drafts list a few
  // times after a monitor_trends decision so the new draft shows up alone.
  function schedulePoll() {
    if (covState.pollTimer) clearTimeout(covState.pollTimer);
    covState.pollAttempts = 0;
    const poll = async () => {
      covState.pollAttempts += 1;
      await loadDrafts();
      if (covState.pollAttempts < 8) {
        covState.pollTimer = setTimeout(poll, 5000);
      } else {
        covState.pollTimer = null;
      }
    };
    covState.pollTimer = setTimeout(poll, 5000);
  }

  async function applyDecisions() {
    const entries = Object.entries(covState.decisions);
    if (!entries.length || covState.applying) return;

    covState.applying = true;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Aplicando…';
    feedbackEl.textContent = '';
    renderSuggestions();

    let ok = 0;
    let failed = 0;
    let landingsStarted = 0;

    for (const [term, decision] of entries) {
      const suggestion = covState.suggestions.find((s) => s.term === term);
      try {
        const res = await fetch(`${API_BASE}/reports/coverage-suggestions/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            term,
            decision,
            termType:
              suggestion && suggestion.termType === 'competitor_candidate'
                ? 'competitor_candidate'
                : suggestion && suggestKind(term).cls === 'is-brand'
                  ? 'competitor_candidate'
                  : 'generic',
            sourceSeed:
              suggestion && suggestion.sourceSeed ? suggestion.sourceSeed : suggestion ? suggestion.seed : null,
            discoveredScore: suggestion ? suggestion.score : null,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        ok += 1;
        if (body.landingGeneration === 'started') landingsStarted += 1;
      } catch (err) {
        failed += 1;
      }
    }

    covState.applying = false;
    applyBtn.textContent = 'Aplicar decisiones';

    const parts = [`${ok} decisión(es) registradas`];
    if (failed) parts.push(`${failed} fallaron`);
    if (landingsStarted) {
      parts.push(
        `${landingsStarted} borrador(es) de landing en generación — aparecerán abajo en "Borradores de landing SEO" en unos segundos`,
      );
      schedulePoll();
    }
    feedbackEl.textContent = parts.join(' · ');

    await loadSuggestions();
    await loadDrafts();
  }

  applyBtn.addEventListener('click', applyDecisions);

  // Loading and teardown are driven by the unified discoveries controller.
  window.__discPending = {
    load: () => {
      loadSuggestions();
      loadDrafts();
    },
    stop: () => {
      if (covState.pollTimer) {
        clearTimeout(covState.pollTimer);
        covState.pollTimer = null;
      }
    },
  };
})();

/* ----------------------------------------------------------------------------
 * Keyword research landing (Inteligencia de mercado tab) — additive IIFE.
 * Read-only view over GET /reports/keyword-research. All parsing of Google's
 * formatted_value happens server-side (growth_percent / is_breakout come
 * pre-computed) — this UI never parses that string.
 * Directional Trends data only: no volume / competition / CPC claims.
 * ------------------------------------------------------------------------- */
(function initKeywordLanding() {
  const statusEl = document.getElementById('kw-status');
  const seedFilter = document.getElementById('kw-seed-filter');
  const topList = document.getElementById('kw-top-list');
  const risingList = document.getElementById('kw-rising-list');

  if (!statusEl || !seedFilter || !topList || !risingList) {
    return;
  }

  const kwState = {
    keywords: [],
    seeds: [],
    seed: '',
    loaded: false,
  };

  // Tooltip text is fixed by spec — never mention competencia/pujas/costo/
  // CPC/volumen mensual anywhere near these badges.
  const BADGE_TOOLTIP = 'Candidato a investigar en Keyword Planner de Google Ads';

  function badgeFor(row) {
    if (row.isBreakout === true) {
      return `<span class="kw-badge is-breakout" title="${BADGE_TOOLTIP}">Tendencia emergente (Aumento puntual)</span>`;
    }
    if (typeof row.growthPercent === 'number' && row.growthPercent > 500) {
      return `<span class="kw-badge is-fast" title="${BADGE_TOOLTIP}">Crecimiento acelerado</span>`;
    }
    return '';
  }

  const DECISION_BADGES = {
    monitor_trends: ['Landing generada', 'is-monitored'],
    added_as_competitor: ['Competidor', 'is-competitor'],
    discarded: ['Descartado', 'is-discarded'],
    pending: ['Pendiente', 'is-pending'],
  };

  function decisionBadgeFor(row) {
    const [label, cls] = DECISION_BADGES[row.decision] || DECISION_BADGES.pending;
    return `<span class="kw-badge kw-decision ${cls}">${label}</span>`;
  }

  function filteredRows(queryType) {
    return kwState.keywords.filter(
      (k) => k.queryType === queryType && (!kwState.seed || k.seed === kwState.seed),
    );
  }

  function renderTopColumn() {
    const rows = filteredRows('top').sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!rows.length) {
      topList.innerHTML = '<div class="kw-empty">Sin términos top para este filtro.</div>';
      return;
    }
    topList.innerHTML = rows
      .map(
        (r) => `
        <div class="kw-row">
          <div class="kw-row-main">
            <span class="kw-term">${escapeHtml(r.term)}</span>
            <span class="kw-score" title="Índice de interés relativo de Google Trends (0-100)">${escapeHtml(
              r.formattedValue || String(r.score ?? '—'),
            )}</span>
            ${decisionBadgeFor(r)}
          </div>
          <div class="kw-row-meta">seed: ${escapeHtml(r.seed)}</div>
        </div>`,
      )
      .join('');
  }

  function renderRisingColumn() {
    const rows = filteredRows('rising').sort((a, b) => {
      const aBreak = a.isBreakout === true ? 1 : 0;
      const bBreak = b.isBreakout === true ? 1 : 0;
      if (aBreak !== bBreak) return bBreak - aBreak;
      return (b.growthPercent || 0) - (a.growthPercent || 0);
    });
    if (!rows.length) {
      risingList.innerHTML = '<div class="kw-empty">Sin tendencias en alza para este filtro.</div>';
      return;
    }
    risingList.innerHTML = rows
      .map((r) => {
        const growth =
          r.isBreakout === true
            ? ''
            : `<span class="kw-score">${escapeHtml(r.formattedValue || '—')}</span>`;
        return `
        <div class="kw-row">
          <div class="kw-row-main">
            <span class="kw-term">${escapeHtml(r.term)}</span>
            ${growth}
            ${badgeFor(r)}
            ${decisionBadgeFor(r)}
          </div>
          <div class="kw-row-meta">seed: ${escapeHtml(r.seed)}</div>
        </div>`;
      })
      .join('');
  }

  function renderSeedFilter() {
    const current = kwState.seed;
    seedFilter.innerHTML =
      '<option value="">Todos los seeds</option>' +
      kwState.seeds
        .map(
          (s) =>
            `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`,
        )
        .join('');
  }

  function renderAll() {
    renderSeedFilter();
    renderTopColumn();
    renderRisingColumn();
  }

  async function loadKeywords() {
    statusEl.textContent = 'Cargando términos…';
    try {
      const res = await fetch(`${API_BASE}/reports/search-discoveries?view=research`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      kwState.keywords = Array.isArray(body.keywords) ? body.keywords : [];
      kwState.seeds = Array.isArray(body.seeds) ? body.seeds : [];
      kwState.loaded = true;
      statusEl.textContent = kwState.keywords.length
        ? `${kwState.keywords.length} términos descubiertos`
        : 'Sin datos de discovery todavía — corré el discovery refresh primero.';
      renderAll();
    } catch (err) {
      statusEl.textContent = 'No se pudieron cargar los términos.';
      topList.innerHTML = '';
      risingList.innerHTML = '';
    }
  }

  seedFilter.addEventListener('change', () => {
    kwState.seed = seedFilter.value;
    renderTopColumn();
    renderRisingColumn();
  });

  // Loading is driven by the unified discoveries controller.
  window.__discResearch = { load: loadKeywords };
})();

/* ----------------------------------------------------------------------------
 * Unified discoveries landing controller: one entry point, internal
 * Pendientes / Investigación toggle. Owns landing visibility and delegates
 * data loading to the two pane modules above.
 * ------------------------------------------------------------------------- */
(function initDiscoveriesLanding() {
  const landing = document.getElementById('discoveries-landing');
  const tabPending = document.getElementById('disc-tab-pending');
  const tabResearch = document.getElementById('disc-tab-research');
  const panePending = document.getElementById('disc-pane-pending');
  const paneResearch = document.getElementById('disc-pane-research');

  if (!landing || !tabPending || !tabResearch || !panePending || !paneResearch) {
    return;
  }

  function activateTab(name) {
    const isPending = name === 'pending';
    tabPending.classList.toggle('active', isPending);
    tabResearch.classList.toggle('active', !isPending);
    tabPending.setAttribute('aria-selected', isPending ? 'true' : 'false');
    tabResearch.setAttribute('aria-selected', isPending ? 'false' : 'true');

    panePending.classList.toggle('hidden', !isPending);
    paneResearch.classList.toggle('hidden', isPending);
    if (isPending) {
      panePending.removeAttribute('hidden');
      paneResearch.setAttribute('hidden', '');
      if (window.__discPending) window.__discPending.load();
    } else {
      paneResearch.removeAttribute('hidden');
      panePending.setAttribute('hidden', '');
      if (window.__discPending) window.__discPending.stop();
      if (window.__discResearch) window.__discResearch.load();
    }
  }

  tabPending.addEventListener('click', () => activateTab('pending'));
  tabResearch.addEventListener('click', () => activateTab('research'));

  // Enter/leave hooks for the top-level tab controller (the section is now a
  // primary panel — visibility itself is handled by the dashboard tabs).
  window.__openDiscoveries = () => activateTab('pending');
  window.__leaveDiscoveries = () => {
    if (window.__discPending) window.__discPending.stop();
  };
})();

/* ----------------------------------------------------------------------------
 * GA4 traffic viewer (Inteligencia de mercado) — read-only table over
 * GET /reports/ga4-metrics. Same AbortController/request-token pattern as
 * "Historial de cambios" for race protection on filter changes.
 * ------------------------------------------------------------------------- */
(function initGa4Landing() {
  const landing = document.getElementById('ga4-landing');
  const fromInput = document.getElementById('ga4-from');
  const toInput = document.getElementById('ga4-to');
  const statusEl = document.getElementById('ga4-status');
  const resultsEl = document.getElementById('ga4-results');

  if (!landing || !fromInput || !toInput || !statusEl || !resultsEl) {
    return;
  }

  let abortController = null;
  let requestSeq = 0;

  function shiftUtcDateOnly(dateStr, deltaDays) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(year, month - 1, day));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().split('T')[0];
  }

  function setDefaultDates() {
    const to = new Date().toISOString().split('T')[0];
    toInput.value = to;
    fromInput.value = shiftUtcDateOnly(to, -29);
  }

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function formatMetric(value) {
    return value === null || value === undefined ? '—' : String(value);
  }

  // Same percentage convention as CTR in the own-ads metrics row:
  // ratio -> (ratio * 100).toFixed(2) + '%'; null/absent -> '—'.
  function formatRatePercent(ratio) {
    if (ratio === null || ratio === undefined) return '—';
    const n = Number(ratio);
    if (!Number.isFinite(n)) return '—';
    return (n * 100).toFixed(2) + '%';
  }

  function renderEmptyState(firstAvailableDate) {
    resultsEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'mcl-empty';
    empty.textContent = firstAvailableDate
      ? 'Sin datos para este rango — la captura arrancó el ' + firstAvailableDate + '.'
      : 'Todavía no hay datos capturados.';
    resultsEl.appendChild(empty);
  }

  function renderTable(rows) {
    resultsEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'ga4-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Fecha</th><th>Canal</th><th>Landing</th><th>Source</th><th>Medium</th>' +
      '<th class="ga4-num">Sesiones</th><th class="ga4-num">Usuarios</th><th class="ga4-num">Key events</th>' +
      '<th class="ga4-num">Conversión</th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(row.date || '—') + '</td>' +
        '<td>' + escapeHtml(row.channel_group || '—') + '</td>' +
        '<td class="ga4-landing-cell">' + escapeHtml(row.landing_page || '—') + '</td>' +
        '<td>' + escapeHtml(row.source || '—') + '</td>' +
        '<td>' + escapeHtml(row.medium || '—') + '</td>' +
        '<td class="ga4-num">' + escapeHtml(formatMetric(row.sessions)) + '</td>' +
        '<td class="ga4-num">' + escapeHtml(formatMetric(row.total_users)) + '</td>' +
        '<td class="ga4-num">' + escapeHtml(formatMetric(row.key_events)) + '</td>' +
        '<td class="ga4-num">' + escapeHtml(formatRatePercent(row.conversion_rate)) + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    resultsEl.appendChild(table);
  }

  async function loadMetrics() {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) {
      setStatus('Indicá un rango de fechas válido.', true);
      return;
    }

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const seq = ++requestSeq;
    const signal = abortController.signal;

    setStatus('Cargando…', false);

    try {
      const params = new URLSearchParams({ from, to });
      const res = await fetch(API_BASE + '/reports/ga4-metrics?' + params.toString(), {
        headers: { Accept: 'application/json' },
        signal,
      });

      if (seq !== requestSeq) return;

      let body = null;
      try {
        body = await res.json();
      } catch (parseErr) {
        body = null;
      }

      if (seq !== requestSeq) return;

      if (!res.ok) {
        setStatus((body && body.error) || 'No se pudieron cargar los datos de GA4.', true);
        resultsEl.innerHTML = '';
        return;
      }

      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) {
        setStatus('', false);
        renderEmptyState(body.firstAvailableDate || null);
        return;
      }

      renderTable(rows);
      setStatus(rows.length + ' filas', false);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== requestSeq) return;
      setStatus('No se pudo conectar con el servidor.', true);
    }
  }

  fromInput.addEventListener('change', loadMetrics);
  toInput.addEventListener('change', loadMetrics);

  // Enter hook for the top-level tab controller (the section is now a
  // primary panel — visibility itself is handled by the dashboard tabs).
  window.__openGa4 = () => {
    if (!fromInput.value || !toInput.value) setDefaultDates();
    loadMetrics();
  };

  setDefaultDates();
})();

/* ----------------------------------------------------------------------------
 * Google SERP manual import — Competidores › Google subtab
 * Visibility toggles only; never touches #mie-market-root render().
 * ------------------------------------------------------------------------- */
(function initSerpImport() {
  const landing = document.getElementById('serp-import-landing');
  const form = document.getElementById('serp-import-form');
  const fileInput = document.getElementById('serp-file-input');
  const termInput = document.getElementById('serp-search-term');
  const statusEl = document.getElementById('serp-import-status');
  const summaryEl = document.getElementById('serp-import-summary');
  const listEl = document.getElementById('serp-imports-list');
  const detailSection = document.getElementById('serp-ads-detail');
  const adsTableEl = document.getElementById('serp-ads-table');
  const organicTableEl = document.getElementById('serp-organic-table');
  const uploadBtn = document.getElementById('serp-upload-btn');
  const presenceStatusEl = document.getElementById('serp-presence-status');
  const presenceListEl = document.getElementById('serp-presence-list');
  const uploadPanel = document.getElementById('serp-upload-panel');
  const toggleImportBtn = document.getElementById('serp-toggle-import-btn');
  const dropzone = document.getElementById('serp-dropzone');
  const selectedFilesEl = document.getElementById('serp-selected-files');

  if (!landing || !form) return;

  let selectedPath = null;
  let busy = false;
  let importsCache = [];
  let formExpanded = false;
  /** @type {File[]} Shared selection for picker + drag-and-drop. */
  let selectedFiles = [];

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function setPresenceStatus(text, isError) {
    if (!presenceStatusEl) return;
    presenceStatusEl.textContent = text || '';
    presenceStatusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function formatPresenceDate(isoDate) {
    if (!isoDate) return '—';
    const parts = String(isoDate).split('-');
    if (parts.length !== 3) return String(isoDate);
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  /** Centralized parse_status → badge label/tone. Does not alter stored values. */
  function serpParseStatusMeta(parseStatus) {
    const raw = parseStatus == null ? '' : String(parseStatus);
    if (raw === 'success') {
      return { label: 'Procesada', tone: 'success' };
    }
    if (raw === 'no_ads_found') {
      return { label: 'Sin resultados', tone: 'muted' };
    }
    if (raw === 'failed') {
      return { label: 'Fallida', tone: 'warn' };
    }
    return { label: raw || '—', tone: 'muted' };
  }

  function isHtmlFile(file) {
    if (!file || !file.name) return false;
    const name = String(file.name).toLowerCase();
    if (name.endsWith('.html') || name.endsWith('.htm')) return true;
    const type = String(file.type || '').toLowerCase();
    return type === 'text/html';
  }

  function syncFileInputFromSelection() {
    if (!fileInput) return;
    try {
      const dt = new DataTransfer();
      selectedFiles.forEach((f) => dt.items.add(f));
      fileInput.files = dt.files;
    } catch (_err) {
      // Some browsers block programmatic FileList writes; selection still drives submit.
    }
  }

  function updateSelectedFilesUi() {
    if (!selectedFilesEl) return;
    if (!selectedFiles.length) {
      selectedFilesEl.textContent = 'Ningún archivo seleccionado';
      selectedFilesEl.classList.remove('has-files');
    } else if (selectedFiles.length === 1) {
      selectedFilesEl.textContent = selectedFiles[0].name;
      selectedFilesEl.classList.add('has-files');
    } else {
      selectedFilesEl.textContent =
        selectedFiles.length +
        ' archivos: ' +
        selectedFiles.map((f) => f.name).join(', ');
      selectedFilesEl.classList.add('has-files');
    }
  }

  function updateSubmitEnabled() {
    if (!uploadBtn) return;
    uploadBtn.disabled = busy || selectedFiles.length === 0;
  }

  function setSelectedFiles(files, opts) {
    const options = opts || {};
    const incoming = Array.from(files || []).filter(Boolean);
    const valid = [];
    const rejected = [];
    incoming.forEach((f) => {
      if (isHtmlFile(f)) valid.push(f);
      else rejected.push(f.name || 'archivo');
    });

    selectedFiles = valid;
    syncFileInputFromSelection();
    updateSelectedFilesUi();
    updateSubmitEnabled();

    if (rejected.length) {
      setStatus(
        'Tipo no soportado: solo .html / .htm. Se ignoró: ' + rejected.join(', '),
        true,
      );
      return false;
    }
    if (!options.silentStatus) {
      if (valid.length) setStatus('', false);
      else if (incoming.length) setStatus('Seleccioná al menos un archivo .html.', true);
    }
    return rejected.length === 0;
  }

  function clearSelectedFiles() {
    selectedFiles = [];
    if (fileInput) fileInput.value = '';
    updateSelectedFilesUi();
    updateSubmitEnabled();
  }

  function setFormExpanded(expanded) {
    formExpanded = Boolean(expanded);
    if (uploadPanel) {
      if (formExpanded) uploadPanel.removeAttribute('hidden');
      else uploadPanel.setAttribute('hidden', '');
    }
    if (toggleImportBtn) {
      toggleImportBtn.textContent = formExpanded
        ? 'Cerrar importación'
        : '+ Nueva importación';
    }
  }

  if (toggleImportBtn) {
    toggleImportBtn.addEventListener('click', () => {
      setFormExpanded(!formExpanded);
    });
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', (e) => {
      if (e.target === fileInput) return;
      fileInput.click();
    });
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    ['dragenter', 'dragover'].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'dragend'].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('is-dragover');
      });
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('is-dragover');
      const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
      setSelectedFiles(files);
    });

    fileInput.addEventListener('change', () => {
      setSelectedFiles(fileInput.files);
    });
  }

  setFormExpanded(false);
  updateSelectedFilesUi();
  updateSubmitEnabled();

  function renderPresence(payload) {
    if (!presenceListEl) return;
    const entities = Array.isArray(payload.entities) ? payload.entities : [];
    const total = payload.totalCaptures != null ? Number(payload.totalCaptures) : 0;
    if (!entities.length) {
      presenceListEl.innerHTML =
        '<div class="mcl-empty">No hay entidades con dominio web configurado.</div>';
      return;
    }

    const rows = entities
      .map((e) => {
        const appeared = Number(e.appearedCaptureCount || 0);
        const totalForRow =
          e.totalCaptureCount != null ? Number(e.totalCaptureCount) : total;
        const presenceText =
          appeared > 0
            ? 'Apareció en ' +
              appeared +
              ' de ' +
              totalForRow +
              ' capturas realizadas.'
            : 'No apareció en ninguna de las ' +
              totalForRow +
              ' capturas realizadas.';
        const lastText =
          'Última aparición: ' + formatPresenceDate(e.mostRecentAppearanceDate);
        return (
          '<div class="serp-presence-row">' +
          '<div class="serp-presence-main">' +
          '<span class="serp-presence-name">' +
          escapeHtml(e.entityName || '—') +
          '</span>' +
          '<span class="serp-presence-domain">' +
          escapeHtml(e.websiteDomain || '—') +
          '</span>' +
          '</div>' +
          '<div class="serp-presence-copy">' +
          escapeHtml(presenceText) +
          '</div>' +
          '<div class="serp-presence-last">' +
          escapeHtml(lastText) +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    presenceListEl.innerHTML =
      '<div class="serp-presence-header">' +
      '<span>Competidor</span><span>Dominio</span><span>Presencia</span><span>Última aparición</span>' +
      '</div>' +
      rows;
  }

  async function loadPresence() {
    setPresenceStatus('Cargando presencia…', false);
    try {
      const res = await fetch(API_BASE + '/reports/google-serp-competitor-presence', {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPresenceStatus(body.error || 'No se pudo cargar la presencia.', true);
        if (presenceListEl) presenceListEl.innerHTML = '';
        return;
      }
      renderPresence(body);
      setPresenceStatus(
        body.totalCaptures != null
          ? body.totalCaptures + ' captura(s) consideradas'
          : '',
        false,
      );
    } catch (err) {
      setPresenceStatus('No se pudo conectar con el servidor.', true);
    }
  }

  function renderSummary(body) {
    if (!summaryEl) return;
    summaryEl.hidden = false;
    summaryEl.classList.toggle(
      'is-error',
      Boolean(body.parserFoundNoResults || body.parserFoundNoAdMarkers) || body.ok === false,
    );

    const unmatched = Array.isArray(body.unmatchedAdvertisers) ? body.unmatchedAdvertisers : [];
    const matched = Array.isArray(body.matchedAdvertisers) ? body.matchedAdvertisers : [];
    const advertisers = Array.isArray(body.advertisers) ? body.advertisers : [];
    const queued = body.queuedUnmatchedDomains || {};

    let advertisersHtml = '';
    if (advertisers.length) {
      advertisersHtml =
        '<p class="serp-summary-title">Anunciantes / sitios</p><div>' +
        advertisers
          .map((a) => {
            const label = escapeHtml(a.advertiserName || a.advertiserDomain || '—');
            const domain = a.advertiserDomain
              ? ' <span class="meta">(' + escapeHtml(a.advertiserDomain) + ')</span>'
              : '';
            if (a.matchedEntity) {
              return (
                '<span class="serp-badge is-matched" title="Coincide con monitored_entities">' +
                label +
                domain +
                ' → ' +
                escapeHtml(a.matchedEntity.name) +
                '</span>'
              );
            }
            return (
              '<span class="serp-badge is-unmatched" title="No coincide con monitored_entities">' +
              label +
              domain +
              ' · sin match</span>'
            );
          })
          .join('') +
        '</div>';
    }

    const queuedNote =
      queued.queued > 0
        ? '<p style="margin-top:10px;color:var(--text-muted);font-size:13px;">' +
          queued.queued +
          ' dominio(s) sin match encolados en Pendientes (google_serp_import).</p>'
        : '';
    const unmatchedNote = unmatched.length
      ? '<p style="margin-top:10px;color:var(--text-muted);font-size:13px;">' +
        unmatched.length +
        ' dominio(s) sin match en monitored_entities.</p>'
      : matched.length
        ? '<p style="margin-top:10px;color:var(--text-muted);font-size:13px;">Todos los dominios matchearon una entidad monitoreada.</p>'
        : '';

    summaryEl.innerHTML =
      '<p class="serp-summary-title">' +
      escapeHtml(body.message || (body.ok ? 'Importación OK' : 'Importación con alerta')) +
      '</p>' +
      '<div style="color:var(--text-muted);font-size:13px;">' +
      'Término: <strong style="color:var(--text)">' +
      escapeHtml(body.searchTerm || '—') +
      '</strong> (' +
      escapeHtml(body.searchTermSource || '—') +
      ') · Ads: ' +
      escapeHtml(String(body.adsFound != null ? body.adsFound : 0)) +
      ' · Orgánicos: ' +
      escapeHtml(String(body.organicFound != null ? body.organicFound : 0)) +
      (body.rawHtmlStoragePath
        ? ' · Archivo: <code>' + escapeHtml(body.rawHtmlStoragePath) + '</code>'
        : '') +
      '</div>' +
      advertisersHtml +
      queuedNote +
      unmatchedNote;
  }

  function classifyImportOutcome(res, body) {
    // Prefer HTTP status: 422 = loud parse empty; other non-OK = hard failure.
    if (res.status === 422) return 'no_results';
    if (!res.ok) return 'failed';
    if (body.parserFoundNoResults || body.parserFoundNoAdMarkers) return 'no_results';
    if (body.ok === false) return 'failed';
    if (body.duplicate) return 'duplicate';
    return 'success';
  }

  function outcomeLabel(kind) {
    if (kind === 'success') return 'OK';
    if (kind === 'duplicate') return 'Duplicado';
    if (kind === 'no_results') return 'Sin resultados';
    return 'Error';
  }

  function renderBatchSummary(results) {
    if (!summaryEl) return;
    const total = results.length;
    const okCount = results.filter((r) => r.kind === 'success').length;
    const dupCount = results.filter((r) => r.kind === 'duplicate').length;
    const noResCount = results.filter((r) => r.kind === 'no_results').length;
    const failCount = results.filter((r) => r.kind === 'failed').length;
    const hasProblem = noResCount > 0 || failCount > 0;

    summaryEl.hidden = false;
    summaryEl.classList.toggle('is-error', hasProblem);

    const terms = [];
    const seenTerms = new Set();
    results.forEach((r) => {
      const t = r.body && r.body.searchTerm ? String(r.body.searchTerm).trim() : '';
      if (t && !seenTerms.has(t.toLowerCase())) {
        seenTerms.add(t.toLowerCase());
        terms.push(t);
      }
    });

    const rowsHtml = results
      .map((r) => {
        const term = (r.body && r.body.searchTerm) || '—';
        const detail =
          r.kind === 'success'
            ? (r.body.adsFound || 0) +
              ' ad(s), ' +
              (r.body.organicFound || 0) +
              ' orgánico(s)'
            : r.kind === 'duplicate'
              ? 'ya importada'
              : r.kind === 'no_results'
                ? 'parser sin ads/orgánicos'
                : r.error ||
                  (r.body && (r.body.error || r.body.message)) ||
                  'falló';
        return (
          '<li class="serp-batch-item is-' +
          escapeHtml(r.kind) +
          '">' +
          '<strong>' +
          escapeHtml(r.fileName) +
          '</strong> · ' +
          escapeHtml(outcomeLabel(r.kind)) +
          ' · término: ' +
          escapeHtml(term) +
          ' · ' +
          escapeHtml(detail) +
          '</li>'
        );
      })
      .join('');

    summaryEl.innerHTML =
      '<p class="serp-summary-title">Lote: ' +
      escapeHtml(String(total)) +
      ' archivo(s)</p>' +
      '<div style="color:var(--text-muted);font-size:13px;">' +
      'OK: <strong style="color:var(--text)">' +
      escapeHtml(String(okCount)) +
      '</strong> · Duplicados: <strong style="color:var(--text)">' +
      escapeHtml(String(dupCount)) +
      '</strong> · Sin resultados: <strong style="color:var(--text)">' +
      escapeHtml(String(noResCount)) +
      '</strong> · Errores: <strong style="color:var(--text)">' +
      escapeHtml(String(failCount)) +
      '</strong>' +
      (terms.length
        ? '<br/>Términos: ' + escapeHtml(terms.join(', '))
        : '') +
      '</div>' +
      '<ul class="serp-batch-list">' +
      rowsHtml +
      '</ul>';
  }

  function safeUserError(body, fallback) {
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
    if (body && typeof body.message === 'string' && body.message.trim()) return body.message;
    return fallback || 'Error al importar.';
  }

  async function uploadOneSerpFile(file, sharedFields) {
    const fd = new FormData();
    fd.append('file', file);
    if (sharedFields.searchTerm) fd.append('searchTerm', sharedFields.searchTerm);

    const res = await fetch(API_BASE + '/reports/import-google-serp', {
      method: 'POST',
      body: fd,
    });
    const body = await res.json().catch(() => ({}));
    const kind = classifyImportOutcome(res, body);
    return {
      fileName: file.name,
      kind,
      status: res.status,
      body,
      error: kind === 'failed' ? safeUserError(body, 'Error al importar.') : null,
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!selectedFiles.length) {
      setStatus('Seleccioná uno o más archivos .html.', true);
      updateSubmitEnabled();
      return;
    }

    busy = true;
    updateSubmitEnabled();
    if (summaryEl) {
      summaryEl.hidden = true;
      summaryEl.innerHTML = '';
    }

    const sharedFields = {
      searchTerm: termInput && termInput.value.trim() ? termInput.value.trim() : '',
    };
    const fileList = selectedFiles.slice();

    const results = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      setStatus(
        'Importando ' + (i + 1) + ' de ' + fileList.length + '… (' + file.name + ')',
        false,
      );
      try {
        const outcome = await uploadOneSerpFile(file, sharedFields);
        results.push(outcome);
      } catch (err) {
        results.push({
          fileName: file.name,
          kind: 'failed',
          status: 0,
          body: {},
          error: 'No se pudo conectar con el servidor.',
        });
      }
    }

    if (fileList.length === 1 && results[0] && results[0].kind !== 'failed') {
      renderSummary(results[0].body);
    } else {
      renderBatchSummary(results);
    }

    const okish = results.filter(
      (r) => r.kind === 'success' || r.kind === 'duplicate',
    ).length;
    const failedish = results.filter(
      (r) => r.kind === 'failed' || r.kind === 'no_results',
    ).length;
    const anySuccess = results.some((r) => r.kind === 'success');

    const lastOk = [...results]
      .reverse()
      .find((r) => r.body && r.body.rawHtmlStoragePath);
    selectedPath = lastOk ? lastOk.body.rawHtmlStoragePath : null;

    // Refresh history/presence once, then set the batch status (loadImports
    // also writes status — keep the lote message as the final one).
    await loadImports({ silent: true });
    await loadPresence();
    if (selectedPath) await loadCaptureDetail(selectedPath);

    setStatus(
      'Lote terminado: ' +
        okish +
        ' ok/duplicado(s), ' +
        failedish +
        ' con alerta/error, de ' +
        results.length +
        ' archivo(s).',
      failedish > 0 && okish === 0,
    );

    if (anySuccess || okish > 0) {
      clearSelectedFiles();
      setFormExpanded(false);
    }

    busy = false;
    updateSubmitEnabled();
  });

  function renderImportsList(imports) {
    if (!listEl) return;
    if (!imports.length) {
      listEl.innerHTML = '<div class="mcl-empty">Todavía no hay importaciones.</div>';
      return;
    }

    const bodyRows = imports
      .map((item) => {
        const ads = Number(item.adsCount || 0);
        const organic = Number(item.organicCount || 0);
        const total = ads + organic;
        const statusMeta = serpParseStatusMeta(item.parseStatus);
        const path = item.rawHtmlStoragePath || '';
        const selected =
          path && path === selectedPath ? ' is-selected' : '';
        return (
          '<tr class="serp-capture-row' +
          selected +
          '" data-path="' +
          escapeHtml(path) +
          '">' +
          '<td>' +
          escapeHtml(formatPresenceDate(item.date)) +
          '</td>' +
          '<td class="serp-capture-term">' +
          escapeHtml(item.searchTerm || '—') +
          '</td>' +
          '<td><span class="serp-status-badge is-' +
          escapeHtml(statusMeta.tone) +
          '">' +
          escapeHtml(statusMeta.label) +
          '</span></td>' +
          '<td class="serp-num">' +
          escapeHtml(String(ads)) +
          '</td>' +
          '<td class="serp-num">' +
          escapeHtml(String(organic)) +
          '</td>' +
          '<td class="serp-num">' +
          escapeHtml(String(total)) +
          '</td>' +
          '<td><button type="button" class="btn serp-detail-btn" data-path="' +
          escapeHtml(path) +
          '">Ver detalle</button></td>' +
          '</tr>'
        );
      })
      .join('');

    listEl.innerHTML =
      '<table class="serp-captures-table">' +
      '<thead><tr>' +
      '<th>Fecha</th><th>Término</th><th>Estado</th>' +
      '<th>Anuncios</th><th>Orgánicos</th><th>Total</th><th>Acción</th>' +
      '</tr></thead><tbody>' +
      bodyRows +
      '</tbody></table>';

    listEl.querySelectorAll('.serp-detail-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const path = btn.getAttribute('data-path') || '';
        if (!path) return;
        selectedPath = path;
        renderImportsList(importsCache);
        loadCaptureDetail(path);
      });
    });
  }

  function renderResultTable(rows, tableEl, emptyLabel) {
    if (!tableEl) return;
    if (!rows.length) {
      tableEl.innerHTML = '<div class="mcl-empty">' + escapeHtml(emptyLabel) + '</div>';
      return;
    }

    const bodyRows = rows
      .map((row) => {
        const matchBadge = row.matchedEntity
          ? '<span class="serp-badge is-matched">' + escapeHtml(row.matchedEntity.name) + '</span>'
          : row.unmatched
            ? '<span class="serp-badge is-unmatched">sin match</span>'
            : '—';
        const url = row.destination_url
          ? '<a class="serp-url-cell" href="' +
            escapeHtml(row.destination_url) +
            '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(row.destination_url) +
            '</a>'
          : '—';
        return (
          '<tr>' +
          '<td>' +
          escapeHtml(String(row.position || '')) +
          '</td>' +
          '<td>' +
          escapeHtml(row.advertiser_name || '—') +
          '<div style="color:var(--text-muted);font-size:12px;">' +
          escapeHtml(row.advertiser_domain || '') +
          '</div></td>' +
          '<td>' +
          escapeHtml(row.ad_title || '—') +
          '<div style="color:var(--text-muted);font-size:12px;margin-top:4px;">' +
          escapeHtml(row.ad_description || '') +
          '</div></td>' +
          '<td class="serp-url-cell">' +
          url +
          '</td>' +
          '<td>' +
          matchBadge +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    tableEl.innerHTML =
      '<table class="serp-ads-table"><thead><tr>' +
      '<th>#</th><th>Sitio</th><th>Título / descripción</th><th>URL destino</th><th>Entidad</th>' +
      '</tr></thead><tbody>' +
      bodyRows +
      '</tbody></table>';
  }

  function renderCaptureDetail(payload) {
    if (!detailSection) return;
    detailSection.hidden = false;
    const ads = Array.isArray(payload.ads) ? payload.ads : [];
    const organic = Array.isArray(payload.organicResults) ? payload.organicResults : [];
    renderResultTable(ads, adsTableEl, 'Sin anuncios de pago en esta importación.');
    renderResultTable(organic, organicTableEl, 'Sin resultados orgánicos en esta importación.');
  }

  async function loadImports(opts) {
    const silent = opts && opts.silent;
    if (!silent) setStatus('Cargando importaciones…', false);
    try {
      const res = await fetch(API_BASE + '/reports/google-serp-imports', {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(body.error || 'No se pudo listar importaciones.', true);
        return;
      }
      importsCache = Array.isArray(body.imports) ? body.imports : [];
      renderImportsList(importsCache);
      if (!silent) {
        setStatus(
          body.total ? body.total + ' importación(es)' : 'Sin importaciones aún',
          false,
        );
      }
    } catch (err) {
      setStatus('No se pudo conectar con el servidor.', true);
    }
  }

  async function loadCaptureDetail(path) {
    if (!path) return;
    try {
      const res = await fetch(
        API_BASE + '/reports/google-serp-imports/ads?path=' + encodeURIComponent(path),
        { headers: { Accept: 'application/json' } },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body.error === 'string'
            ? body.error
            : 'No se pudo cargar el detalle.';
        setStatus(msg, true);
        return;
      }
      renderCaptureDetail(body);
    } catch (err) {
      setStatus('No se pudo conectar con el servidor.', true);
    }
  }

  window.__openGoogleSerp = () => {
    loadImports();
    loadPresence();
  };
})();
