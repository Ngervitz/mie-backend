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

/**
 * Display-only axis label for competitor-activity weeks.
 * Internal week_of stays Monday; the X axis shows the Sunday close (Mon + 6).
 * Uses shiftDate (Y/M/D parts) — never new Date('YYYY-MM-DD').
 */
function formatWeekOfAxisLabel(weekOfMonday) {
  if (!weekOfMonday) return '';
  return shiftDate(String(weekOfMonday), 6);
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

/** Theme-accessible palette for deterministic string→color mapping. */
const STRING_COLOR_PALETTE = [
  '#5b7fad', // --accent-info
  '#5a9a72', // --accent-success
  '#b0894a', // --accent-warn
  '#a66b6b', // --accent-danger
  '#60a5fa',
  '#38bdf8',
  '#a78bfa',
  '#22c55e',
  '#f59e0b',
  '#f472b6',
];

/**
 * Deterministic hash of a string → palette index.
 * Reusable across modules that need stable colors by name (not array index).
 */
function hashStringToPaletteIndex(value, paletteLength) {
  const str = String(value == null ? '' : value);
  const len = Math.max(1, Number(paletteLength) || STRING_COLOR_PALETTE.length);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash + str.charCodeAt(i) * (i + 1)) % 2147483647;
  }
  return Math.abs(hash) % len;
}

function colorForString(value, palette) {
  const colors =
    Array.isArray(palette) && palette.length ? palette : STRING_COLOR_PALETTE;
  return colors[hashStringToPaletteIndex(value, colors.length)];
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

/** Confirmed scrape outcomes (same set as activity pipeline VALID_SNAPSHOT_STATUSES). */
const CONFIRMED_SNAPSHOT_STATUSES = ['success', 'empty_confirmed'];

/**
 * Max calendar days since last confirmed snapshot to count as "Monitoreo al día".
 * Audit 2026-08-07 (37 active): days-since last success min=0 median=0 max=4 (20/21 at 0);
 * with success|empty_confirmed, 30/31 at 0. Threshold 1 = same day or 1-day lag.
 */
const MONITORING_FRESH_MAX_DAYS = 1;

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

/**
 * Read-only: ad_snapshots coverage per entity (any row + last confirmed date).
 * Confirmed = success | empty_confirmed. Used only for the monitoring signal.
 */
async function queryAdSnapshotCoverage(entityIds) {
  const coverage = new Map();
  (entityIds || []).forEach((id) => {
    if (id) coverage.set(id, { hasAny: false, lastConfirmedDate: null });
  });
  if (!coverage.size) return coverage;

  const inList = [...coverage.keys()].map((id) => encodeURIComponent(id)).join(',');
  const rows = await supabaseRestGet(
    `ad_snapshots?select=entity_id,snapshot_date,status` +
      `&entity_id=in.(${inList})` +
      `&order=snapshot_date.desc`,
  );
  (rows || []).forEach((row) => {
    const entityId = row && row.entity_id;
    if (!entityId || !coverage.has(entityId)) return;
    const entry = coverage.get(entityId);
    entry.hasAny = true;
    if (
      !entry.lastConfirmedDate
      && CONFIRMED_SNAPSHOT_STATUSES.includes(String(row.status || ''))
      && row.snapshot_date
    ) {
      entry.lastConfirmedDate = String(row.snapshot_date);
    }
  });
  return coverage;
}

/** Calendar-day difference (asOfYmd - fromYmd). Null if either date missing. */
function calendarDaysBetween(fromYmd, asOfYmd) {
  if (!fromYmd || !asOfYmd) return null;
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const asOf = Date.parse(`${asOfYmd}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(asOf)) return null;
  return Math.round((asOf - from) / 86400000);
}

/**
 * Independent monitoring signal from ad_snapshots (not events / días con cambios).
 * @returns {{ status: 'ok'|'delayed'|'unconfigured', label: string, lastConfirmedDate: string|null, daysSince: number|null }}
 */
function buildMonitoringSignal(coverageEntry, selectedDate) {
  const entry = coverageEntry || { hasAny: false, lastConfirmedDate: null };
  if (!entry.hasAny) {
    return {
      status: 'unconfigured',
      label: 'Sin monitoreo configurado',
      lastConfirmedDate: null,
      daysSince: null,
    };
  }
  const daysSince = calendarDaysBetween(entry.lastConfirmedDate, selectedDate);
  const fresh = daysSince != null && daysSince <= MONITORING_FRESH_MAX_DAYS;
  if (fresh) {
    return {
      status: 'ok',
      label: 'Monitoreo al día',
      lastConfirmedDate: entry.lastConfirmedDate,
      daysSince,
    };
  }
  return {
    status: 'delayed',
    label: 'Monitoreo con demora',
    lastConfirmedDate: entry.lastConfirmedDate,
    daysSince,
  };
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

function buildIntensityGaugeModels(entities, windowRows, historyRows, selectedDate, snapshotCoverage) {
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
    const monitoring = buildMonitoringSignal(
      snapshotCoverage && snapshotCoverage.get(entityId),
      selectedDate,
    );
    const meta = {
      active: entity.active !== false,
      segment: entity.segment || null,
      sector: entity.sector || null,
      adLibraryUrl: entity.ad_library_url || null,
      websiteDomain: entity.website_domain || null,
      lastMovementDate: lastMovement.get(entityId) || null,
      monitoring,
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
    const [windowRows, historyRows, snapshotCoverage] = await Promise.all([
      queryEventsForIntensityGauge(selectedDate, entityIds),
      queryHistoricalMovementDays(selectedDate, entityIds),
      queryAdSnapshotCoverage(entityIds),
    ]);
    state.gauge.entities = buildIntensityGaugeModels(
      entities,
      windowRows,
      historyRows,
      selectedDate,
      snapshotCoverage,
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

/** Presentation-only: color class for percentage value text. */
function getPctValueColorClass(pctLabel, sortValue) {
  const raw = String(pctLabel || '').trim();
  if (
    /^día\s*0\s*\/\s*7$/i.test(raw)
    || /^días con cambios:\s*0\s*\/\s*7$/i.test(raw)
    || raw === '0%'
  ) {
    return 'is-pct-zero';
  }
  let n = Number(sortValue);
  if (!Number.isFinite(n)) {
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*%/);
    n = m ? Number(m[1]) : NaN;
  }
  if (!Number.isFinite(n) || n <= 0) return 'is-pct-zero';
  if (n > 50) return 'is-pct-high';
  return 'is-pct-mid';
}

/** Presentation-only: change-days counter label (same N/7 math). */
function formatChangeDaysLabel(historicalDays) {
  const n = Math.min(7, Number(historicalDays) || 0);
  return `Días con cambios: ${n}/7`;
}

/** Presentation-only: monitoring badge next to change-days (independent signal). */
function renderMonitoringBadge(monitoring) {
  const m = monitoring || { status: 'unconfigured', label: 'Sin monitoreo configurado' };
  const status = m.status === 'ok' || m.status === 'delayed' ? m.status : 'unconfigured';
  const label = m.label || 'Sin monitoreo configurado';
  let detail = '';
  if (status === 'ok' || status === 'delayed') {
    if (m.lastConfirmedDate) {
      detail = m.daysSince === 0
        ? `Último snapshot confirmado: ${m.lastConfirmedDate} (hoy)`
        : `Último snapshot confirmado: ${m.lastConfirmedDate} (hace ${m.daysSince} d)`;
    } else if (status === 'delayed') {
      detail = 'Hay intentos de captura, pero ninguno confirmado recientemente';
    }
  } else {
    detail = 'Sin filas en ad_snapshots (no configurado para monitoreo)';
  }
  const title = detail ? `${label}. ${detail}` : label;
  return `<span class="gauge-chip-monitor is-${status}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function renderIntensityChip(g, index, variant) {
  const delay = `${(index * 0.04).toFixed(2)}s`;
  const fullName = g.entityName || '—';
  const titleAttr = escapeHtml(fullName);
  const entityAttr = escapeHtml(String(g.entityId || ''));
  const avatar = renderGaugeAvatar(g);
  const monitorBadge = renderMonitoringBadge(g.monitoring);

  // Idle section: name + both signals (change-days + monitoring).
  if (variant === 'idle') {
    const pausedClass = g.active === false ? ' is-paused' : '';
    const dayLabel = formatChangeDaysLabel(g.historicalDays);
    return `
      <button type="button" class="gauge-chip is-idle-row${pausedClass}" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-signals">
          <span class="gauge-chip-value is-fallback-label is-pct-zero">${escapeHtml(dayLabel)}</span>
          ${monitorBadge}
        </span>
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
        ${monitorBadge}
      </button>
    `;
  }

  if (g.mode === 'collecting') {
    const dayLabel = formatChangeDaysLabel(g.historicalDays);
    const n = Math.min(7, Number(g.historicalDays) || 0);
    const dayColor = n <= 0 ? ' is-pct-zero' : '';
    return `
      <button type="button" class="gauge-chip is-collecting is-compact" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-emoji" aria-hidden="true">⏳</span>
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-value is-fallback-label${dayColor}">${escapeHtml(dayLabel)}</span>
        ${monitorBadge}
      </button>
    `;
  }

  const meta = getIntensityChipSortMeta(g);
  if (meta.group === 3) {
    const pct = g.intensity
      ? getIntensityPctDisplay(g.intensity)
      : { pctLabel: '—', sortValue: 0 };
    const colorClass = getPctValueColorClass(pct.pctLabel, pct.sortValue);
    return `
      <button type="button" class="gauge-chip is-unknown is-compact" style="--gauge-delay:${delay}"
        title="${titleAttr}" data-action="open-entity-modal" data-entity-id="${entityAttr}">
        ${avatar}
        <span class="gauge-chip-emoji" aria-hidden="true">❔</span>
        <span class="gauge-chip-name">${escapeHtml(fullName)}</span>
        <span class="gauge-chip-value ${colorClass}">${escapeHtml(pct.pctLabel)}</span>
        ${monitorBadge}
      </button>
    `;
  }

  const intensity = g.intensity;
  const level = intensity.level;
  const pct = getIntensityPctDisplay(intensity);
  const { pctLabel } = pct;
  const colorClass = getPctValueColorClass(pctLabel, pct.sortValue);
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
      <span class="gauge-chip-value ${colorClass}">${escapeHtml(pctLabel)}</span>
      ${monitorBadge}
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
    billetera_digital: 'Billetera digital',
    tarjeta_de_credito: 'Tarjeta de crédito',
    comparador_marketplace: 'Comparador/Marketplace',
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

const ENTITY_SEGMENT_OPTIONS = [
  { value: 'prestamos', label: 'Préstamos' },
  { value: 'cooperativa', label: 'Cooperativa' },
  { value: 'deuda', label: 'Deuda' },
  { value: 'billetera_digital', label: 'Billetera digital' },
  { value: 'tarjeta_de_credito', label: 'Tarjeta de crédito' },
  { value: 'comparador_marketplace', label: 'Comparador/Marketplace' },
];

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

function normalizeWebsiteDomainInput(raw) {
  const websiteDomainRaw = String(raw || '').trim();
  if (!websiteDomainRaw) return { ok: true, domain: null };
  let candidate = websiteDomainRaw.toLowerCase();
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    let host = new URL(candidate).hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host || !host.includes('.')) {
      return {
        ok: false,
        error: 'Dominio web no válido. Usá algo como alprestamo.uy (sin ruta).',
      };
    }
    return { ok: true, domain: host };
  } catch {
    return {
      ok: false,
      error: 'Dominio web no válido. Usá algo como alprestamo.uy (sin ruta).',
    };
  }
}

function termLooksLikeHostname(term) {
  const raw = String(term || '').trim();
  if (!raw || /\s/.test(raw)) return false;
  const normalized = normalizeWebsiteDomainInput(raw);
  return Boolean(normalized.ok && normalized.domain);
}

function hostnamePrefillFromTerm(term) {
  if (!termLooksLikeHostname(term)) return '';
  const normalized = normalizeWebsiteDomainInput(term);
  return normalized.ok && normalized.domain ? normalized.domain : '';
}

function validateMonitoredEntityFields({
  name: nameRaw,
  segment: segmentRaw,
  adLibraryUrl: adLibraryUrlRaw,
  websiteDomain: websiteDomainRaw,
} = {}) {
  const name = String(nameRaw || '').trim();
  const segment = String(segmentRaw || '').trim();
  const adLibraryUrl = String(adLibraryUrlRaw || '').trim();
  if (!name || !segment || !adLibraryUrl) {
    return {
      ok: false,
      error: 'Completá nombre, categoría y URL de Ad Library.',
    };
  }
  if (!looksLikeUrl(adLibraryUrl)) {
    return {
      ok: false,
      error: 'La URL de Ad Library no parece válida (usá http:// o https://).',
    };
  }
  const slug = slugifyEntityName(name);
  if (!slug) {
    return {
      ok: false,
      error: 'No se pudo generar un slug válido a partir del nombre.',
    };
  }
  const domain = normalizeWebsiteDomainInput(websiteDomainRaw);
  if (!domain.ok) return { ok: false, error: domain.error };
  return {
    ok: true,
    error: null,
    name,
    segment,
    adLibraryUrl,
    slug,
    websiteDomain: domain.domain,
  };
}

/**
 * Shared create for "+ Agregar" and Pendientes "Monitorear competidor".
 * @returns {Promise<{ id: string, name?: string, slug?: string }>}
 */
async function createMonitoredEntity({
  name,
  segment,
  adLibraryUrl,
  websiteDomain,
} = {}) {
  const checked = validateMonitoredEntityFields({
    name,
    segment,
    adLibraryUrl,
    websiteDomain,
  });
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const payload = {
    name: checked.name,
    slug: checked.slug,
    entity_type: 'marca',
    segment: checked.segment,
    sector: 'financiero',
    ad_library_url: checked.adLibraryUrl,
    is_self: false,
    active: true,
  };
  if (checked.websiteDomain) payload.website_domain = checked.websiteDomain;

  let rows;
  try {
    rows = await supabaseRestPost('monitored_entities', payload);
  } catch (err) {
    const msg = String(err && err.message ? err.message : '');
    const isSlugUniqueConflict =
      /HTTP\s*409/.test(msg) && /23505/.test(msg) && /slug/i.test(msg);
    throw new Error(
      isSlugUniqueConflict
        ? 'Ya existe una entidad con ese nombre'
        : 'No se pudo crear la entidad. Intentá de nuevo o revisá los datos.',
    );
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || row.id == null) {
    throw new Error('No se pudo crear la entidad');
  }
  return row;
}

window.__mieCreateMonitoredEntity = createMonitoredEntity;

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

  const checked = validateMonitoredEntityFields({
    name: state.addEntityModal.name,
    segment: state.addEntityModal.segment,
    adLibraryUrl: state.addEntityModal.adLibraryUrl,
    websiteDomain: state.addEntityModal.websiteDomain,
  });
  if (!checked.ok) {
    state.addEntityModal.error = checked.error;
    render();
    return;
  }

  state.addEntityModal.busy = true;
  state.addEntityModal.error = null;
  render();

  try {
    await createMonitoredEntity({
      name: checked.name,
      segment: checked.segment,
      adLibraryUrl: checked.adLibraryUrl,
      websiteDomain: checked.websiteDomain,
    });
    closeAddEntityModal();
    await loadIntensityGauges(state.selectedDate);
  } catch (err) {
    state.addEntityModal.busy = false;
    state.addEntityModal.error =
      err && err.message ? err.message : 'No se pudo crear la entidad';
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
          <div class="ad-modal-label">Días con cambios (historial)</div>
          <div>${escapeHtml(String(entity.historicalDays || 0))}</div>
        </div>
        <div class="ad-modal-block">
          <div class="ad-modal-label">Monitoreo (ad_snapshots)</div>
          <div>${escapeHtml((entity.monitoring && entity.monitoring.label) || '—')}</div>
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
  const segmentOptions = ENTITY_SEGMENT_OPTIONS.map((opt) => {
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
          <label class="mcl-field entity-form-field" for="add-entity-name">
            <span class="mcl-field-label">Nombre</span>
            <input
              class="mcl-input"
              type="text"
              name="name"
              id="add-entity-name"
              value="${escapeHtml(m.name)}"
              required
              ${m.busy ? 'disabled' : ''}
              autocomplete="organization"
              placeholder="Ej. Credifast" />
          </label>
          <label class="mcl-field entity-form-field" for="add-entity-segment">
            <span class="mcl-field-label">Categoría</span>
            <select
              class="mcl-select"
              name="segment"
              id="add-entity-segment"
              ${m.busy ? 'disabled' : ''}>
              ${segmentOptions}
            </select>
          </label>
          <label class="mcl-field entity-form-field" for="add-entity-url">
            <span class="mcl-field-label">Ad Library URL</span>
            <input
              class="mcl-input"
              type="url"
              name="adLibraryUrl"
              id="add-entity-url"
              value="${escapeHtml(m.adLibraryUrl)}"
              required
              ${m.busy ? 'disabled' : ''}
              placeholder="https://www.facebook.com/ads/library/..." />
          </label>
          <label class="mcl-field entity-form-field" for="add-entity-website-domain">
            <span class="mcl-field-label">Dominio web (opcional, match SERP)</span>
            <input
              class="mcl-input"
              type="text"
              name="websiteDomain"
              id="add-entity-website-domain"
              value="${escapeHtml(m.websiteDomain || '')}"
              ${m.busy ? 'disabled' : ''}
              placeholder="ej. alprestamo.uy"
              autocomplete="off" />
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
        // Ready chips + collecting with días con cambios > 0/7.
        const recentHtml = recent.map((g) => renderIntensityChip(g, idx++)).join('');
        const recentGrid = recent.every((g) => g.mode === 'ready' && g.intensity)
          ? 'is-ready-row'
          : 'is-recent-row';
        parts.push(renderGaugeSection('Actividad reciente', recentGrid, recentHtml));
      }
      if (idle.length) {
        parts.push(renderGaugeSection(
          'Sin cambios detectados',
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
    ${renderCompetitorActivityWeeklySection()}
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
      ${renderCompetitorActivityWeeklySection()}
      ${renderIntensityGauges()}
      ${renderExecutiveSummary()}
      <section class="section">
        <div class="empty-state">Sin movimientos registrados para esta fecha.</div>
      </section>
    `;
  }

  return `
    ${renderKpis()}
    ${renderCompetitorActivityWeeklySection()}
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

  // Market root is fully replaced via innerHTML on every render(), so this
  // button is always a fresh node — no duplicate-listener guard needed.
  const weeklyToggle = document.getElementById(
    'competitor-activity-weekly-toggle',
  );
  if (weeklyToggle) {
    weeklyToggle.addEventListener('click', function () {
      activityWeeklyShowAll = !activityWeeklyShowAll;
      mountCompetitorActivityWeeklyChart();
    });
  }

  const weeklyFrom = document.getElementById(
    'competitor-activity-weekly-from',
  );
  const weeklyTo = document.getElementById('competitor-activity-weekly-to');
  function onWeeklyRangeChange() {
    if (!weeklyFrom || !weeklyTo) return;
    activityWeeklyFrom = weeklyFrom.value || '';
    activityWeeklyTo = weeklyTo.value || '';
    if (!activityWeeklyFrom || !activityWeeklyTo) return;
    loadCompetitorActivityWeekly();
  }
  if (weeklyFrom) weeklyFrom.addEventListener('change', onWeeklyRangeChange);
  if (weeklyTo) weeklyTo.addEventListener('change', onWeeklyRangeChange);

  const weeklySegment = document.getElementById(
    'competitor-activity-weekly-segment',
  );
  if (weeklySegment) {
    weeklySegment.addEventListener('change', function () {
      activityWeeklySegmentFilter = String(weeklySegment.value || '');
      if (activityWeeklyData) mountCompetitorActivityWeeklyChart();
    });
  }

  const weeklySelectAll = document.getElementById(
    'competitor-activity-weekly-select-all',
  );
  if (weeklySelectAll) {
    weeklySelectAll.addEventListener('click', function () {
      toggleActivityWeeklySelectAllVisible();
    });
  }

  if (document.getElementById('competitor-activity-weekly-canvas')) {
    if (activityWeeklyData) mountCompetitorActivityWeeklyChart();
    else loadCompetitorActivityWeekly();
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
 * Competitor activity weekly line chart (below KPIs, above Intensidad)
 * ------------------------------------------------------------------------- */
let activityWeeklyChart = null;
let activityWeeklyData = null;
/** @type {object|null} body de GET /competitor-activity-predictions */
let activityWeeklyPredictions = null;
let activityWeeklyShowAll = false;
/** @type {Record<string, boolean>} entity_id / zafra → checkbox checked */
let activityWeeklyChecked = Object.create(null);
let activityWeeklyLoadPromise = null;
let activityWeeklyFrom = '';
let activityWeeklyTo = '';
/** '' = Todas; '__none__' = Sin categoría; else segment slug */
let activityWeeklySegmentFilter = '';
let activityWeeklyHighlightId = null;
let activityWeeklyRequestSeq = 0;

const ACTIVITY_WEEKLY_TYPE_LABELS = {
  new_ad: 'Nuevos',
  copy_changed: 'Cambios de copy',
  ad_reactivated: 'Reactivados',
  ad_deactivated: 'Desactivados',
};
const ACTIVITY_WEEKLY_PHASE_LABELS = {
  alta_demanda: 'Alta demanda',
  mitad_mes: 'Mitad de mes',
  cierre_mes: 'Cierre de mes',
};
const ACTIVITY_WEEKLY_PHASE_ID = 'zafra';

const ACTIVITY_WEEKLY_PREDICTION_ZONE_PLUGIN = {
  id: 'activityWeeklyPredictionZone',
  beforeDraw: function (chart) {
    const opts =
      chart.options.plugins &&
      chart.options.plugins.activityWeeklyPredictionZone;
    if (!opts || !opts.enabled) return;
    const idx = opts.lastRealIndex;
    if (idx == null || !Number.isFinite(Number(idx))) return;
    const xScale = chart.scales.x;
    const area = chart.chartArea;
    if (!xScale || !area) return;
    const x0 = xScale.getPixelForValue(Number(idx));
    if (!Number.isFinite(x0)) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(x0, area.top, area.right - x0, area.bottom - area.top);
    ctx.restore();
  },
};

function syncActivityWeeklyPredictionCaption(lastRealWeek, predictionWeek) {
  const el = document.getElementById('competitor-activity-weekly-caption');
  if (!el) return;
  if (!lastRealWeek || !predictionWeek) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML =
    '💡 Los datos hasta ' +
    escapeHtml(lastRealWeek) +
    ' son reales. ' +
    escapeHtml(predictionWeek) +
    ' es la semana en curso — la línea punteada muestra la proyección del modelo de ML, no un dato observado.';
}

function isActivityWeeklyPredictionDatasetId(id) {
  return String(id || '').endsWith('-prediction');
}

function isActivityWeeklyPartialDatasetId(id) {
  return String(id || '').endsWith('-partial');
}

function setActivityWeeklyEntityDatasetsHidden(entityId, hidden) {
  if (!activityWeeklyChart) return;
  const ids = [
    String(entityId),
    String(entityId) + '-prediction',
    String(entityId) + '-partial',
  ];
  ids.forEach(function (id) {
    const datasetIndex = activityWeeklyChart.data.datasets.findIndex(
      function (dataset) {
        return dataset.id === id;
      },
    );
    if (datasetIndex === -1) return;
    activityWeeklyChart.getDatasetMeta(datasetIndex).hidden = hidden;
  });
}

/**
 * Auxiliary dashed prediction segments for entities with a valid ML row
 * when root predicted_week_of matches nextWeek (exact string).
 */
function buildActivityWeeklyPredictionDatasets(allEntities, nextWeek) {
  const preds =
    activityWeeklyPredictions &&
    Array.isArray(activityWeeklyPredictions.predictions)
      ? activityWeeklyPredictions.predictions
      : [];
  const rootPredictedWeekOf =
    activityWeeklyPredictions &&
    activityWeeklyPredictions.predicted_week_of != null
      ? activityWeeklyPredictions.predicted_week_of
      : null;
  if (
    rootPredictedWeekOf == null ||
    String(rootPredictedWeekOf) !== String(nextWeek)
  ) {
    return [];
  }

  const byEntity = new Map();
  preds.forEach(function (p) {
    if (!p || p.entity_id == null) return;
    byEntity.set(String(p.entity_id), p);
  });

  const out = [];
  (allEntities || []).forEach(function (ent) {
    const id = String(ent.entity_id);
    const pred = byEntity.get(id);
    if (!pred) return;
    if (pred.eligibility_status === 'ineligible') return;

    const hist = Number(pred.historical_avg);
    const prob = Number(pred.predicted_probability);
    if (!Number.isFinite(hist) || !Number.isFinite(prob)) return;
    if (prob < 0 || prob > 1) return;

    const series = Array.isArray(ent.series) ? ent.series : [];
    let lastPoint = null;
    series.forEach(function (p) {
      if (!p || !p.week_of) return;
      if (!lastPoint || String(p.week_of) > String(lastPoint.week_of)) {
        lastPoint = p;
      }
    });
    if (!lastPoint) return;

    const color = colorForString(ent.name || id);
    const alertColor = pred.predicted_label === true ? '#f97316' : '#94a3b8';
    const endRadius = Math.min(10, Math.max(4, 4 + prob * 6));

    out.push({
      id: id + '-prediction',
      label: (ent.name || 'Entidad') + ' (predicción)',
      data: [
        { x: String(lastPoint.week_of), y: Number(lastPoint.count) || 0 },
        { x: String(nextWeek), y: hist },
      ],
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      borderDash: [6, 4],
      tension: 0,
      spanGaps: true,
      pointRadius: [0, endRadius],
      pointHoverRadius: [0, endRadius + 1],
      pointBackgroundColor: [color, alertColor],
      pointBorderColor: [color, color],
      yAxisID: 'y',
      hidden: activityWeeklyChecked[id] === false,
      _predictionMeta: {
        historical_avg: hist,
        predicted_probability: prob,
      },
    });
  });
  return out;
}

/**
 * Hollow "en curso" point at the prediction week X — only when
 * current_week_partial.week_of === predictionWeek.
 * Same entity scope as -prediction / real lines (visible set): counts_by_entity
 * may include non-visible actives; those must not get orphan datasets.
 * 0 is a valid count.
 */
function buildActivityWeeklyPartialDatasets(predictionWeek) {
  const partial =
    activityWeeklyData && activityWeeklyData.current_week_partial
      ? activityWeeklyData.current_week_partial
      : null;
  if (!partial || !predictionWeek) return [];
  if (String(partial.week_of) !== String(predictionWeek)) return [];
  const counts = partial.counts_by_entity;
  if (!counts || typeof counts !== 'object') return [];

  const visibleIds = new Set(
    getActivityWeeklyVisibleEntities(activityWeeklyData).map(function (ent) {
      return String(ent.entity_id);
    }),
  );

  const nameById = Object.create(null);
  (Array.isArray(activityWeeklyData.entities)
    ? activityWeeklyData.entities
    : []
  ).forEach(function (ent) {
    if (!ent || ent.entity_id == null) return;
    nameById[String(ent.entity_id)] = ent.name || '';
  });

  const out = [];
  Object.keys(counts).forEach(function (entityId) {
    if (!Object.prototype.hasOwnProperty.call(counts, entityId)) return;
    if (!visibleIds.has(entityId)) return;
    const count = Number(counts[entityId]);
    if (!Number.isFinite(count)) return;

    const name = nameById[entityId] || '';
    // Same key as real series / toggles: colorForString(ent.name || id)
    const color = colorForString(name || entityId);

    out.push({
      id: entityId + '-partial',
      label: (name || 'Entidad') + ' (en curso)',
      data: [{ x: String(predictionWeek), y: count }],
      showLine: false,
      borderColor: color,
      backgroundColor: '#ffffff',
      pointRadius: 5,
      pointHoverRadius: 6,
      pointBackgroundColor: '#ffffff',
      pointBorderColor: color,
      pointBorderWidth: 2,
      yAxisID: 'y',
      hidden: activityWeeklyChecked[entityId] === false,
      _partialMeta: { count: count },
    });
  });
  return out;
}

function phasePointColor(phase) {
  if (phase === 'alta_demanda') return '#ef4444';
  if (phase === 'mitad_mes') return '#38bdf8';
  if (phase === 'cierre_mes') return '#a78bfa';
  return '#94a3b8';
}

function colorWithAlpha(hex, alpha) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return hex;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function applyActivityWeeklyHighlightStyles() {
  if (!activityWeeklyChart) return;
  const highlightId = activityWeeklyHighlightId;
  activityWeeklyChart.data.datasets.forEach(function (dataset) {
    if (typeof dataset._baseColor !== 'string') return;
    const base = dataset._baseColor;
    const isHi = highlightId && dataset.id === highlightId;
    const dimmed =
      highlightId &&
      highlightId !== ACTIVITY_WEEKLY_PHASE_ID &&
      !isHi;
    dataset.borderColor = dimmed ? colorWithAlpha(base, 0.18) : base;
    dataset.backgroundColor = dataset.borderColor;
    dataset.borderWidth = isHi ? 3.5 : 2;
    dataset.pointRadius = isHi ? 4 : 3;
  });
  activityWeeklyChart.update('none');
}

function destroyActivityWeeklyChart() {
  if (activityWeeklyChart) {
    activityWeeklyChart.destroy();
    activityWeeklyChart = null;
  }
}

function countWeeksWithAnyEvents(data) {
  const weeks = Array.isArray(data && data.weeks) ? data.weeks : [];
  const entities = Array.isArray(data && data.entities) ? data.entities : [];
  let n = 0;
  weeks.forEach(function (week) {
    let sum = 0;
    entities.forEach(function (ent) {
      const point = (Array.isArray(ent.series) ? ent.series : []).find(
        function (p) {
          return p && p.week_of === week;
        },
      );
      sum += Number(point && point.count) || 0;
    });
    if (sum > 0) n += 1;
  });
  return n;
}

function getActivityWeeklySegmentFilteredEntities(data) {
  const entities = Array.isArray(data && data.entities) ? data.entities : [];
  const filter = activityWeeklySegmentFilter;
  if (!filter) return entities;
  if (filter === '__none__') {
    return entities.filter(function (ent) {
      return ent.segment == null || String(ent.segment).trim() === '';
    });
  }
  return entities.filter(function (ent) {
    return String(ent.segment || '') === filter;
  });
}

function getActivityWeeklyVisibleEntities(data) {
  const entities = getActivityWeeklySegmentFilteredEntities(data);
  if (activityWeeklyShowAll) {
    return entities.slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), 'es');
    });
  }
  if (entities.length <= 5) return entities;
  return entities.slice(0, 5);
}

function ensureActivityWeeklyCheckedDefaults(entities) {
  (entities || []).forEach(function (ent) {
    const id = String(ent.entity_id);
    if (activityWeeklyChecked[id] === undefined) {
      activityWeeklyChecked[id] = true;
    }
  });
  if (activityWeeklyChecked[ACTIVITY_WEEKLY_PHASE_ID] === undefined) {
    activityWeeklyChecked[ACTIVITY_WEEKLY_PHASE_ID] = true;
  }
}

function renderCompetitorActivityWeeklySection() {
  const segmentOpts = [
    { value: '', label: 'Todas' },
    { value: 'prestamos', label: 'Préstamos' },
    { value: 'cooperativa', label: 'Cooperativa' },
    { value: 'deuda', label: 'Deuda' },
    { value: 'billetera_digital', label: 'Billetera digital' },
    { value: 'tarjeta_de_credito', label: 'Tarjeta de crédito' },
    { value: 'comparador_marketplace', label: 'Comparador/Marketplace' },
    { value: '__none__', label: 'Sin categoría' },
  ]
    .map(function (opt) {
      const selected =
        opt.value === activityWeeklySegmentFilter ? ' selected' : '';
      return (
        '<option value="' +
        escapeHtml(opt.value) +
        '"' +
        selected +
        '>' +
        escapeHtml(opt.label) +
        '</option>'
      );
    })
    .join('');

  return (
    '<section class="section competitor-activity-weekly" id="competitor-activity-weekly-section">' +
    '<div class="section-title-row">' +
    '<h2 class="section-title">' +
    '<i class="ti ti-chart-line" aria-hidden="true"></i> ' +
    'Actividad semanal de competidores' +
    '</h2>' +
    '<button type="button" class="btn btn-secondary" id="competitor-activity-weekly-toggle" hidden>' +
    'Mostrar todos' +
    '</button>' +
    '<button type="button" class="btn btn-secondary" id="competitor-activity-weekly-select-all" hidden>' +
    'Deseleccionar todos' +
    '</button>' +
    '</div>' +
    '<p id="competitor-activity-weekly-caption" class="ga4-summary-note text-muted competitor-activity-weekly-caption" hidden></p>' +
    '<div class="mcl-filters competitor-activity-weekly-filters">' +
    '<label class="mcl-field"><span class="mcl-field-label">Desde</span>' +
    '<input type="date" id="competitor-activity-weekly-from" class="mcl-input" value="' +
    escapeHtml(activityWeeklyFrom) +
    '" /></label>' +
    '<label class="mcl-field"><span class="mcl-field-label">Hasta</span>' +
    '<input type="date" id="competitor-activity-weekly-to" class="mcl-input" value="' +
    escapeHtml(activityWeeklyTo) +
    '" /></label>' +
    '<label class="mcl-field" for="competitor-activity-weekly-segment">' +
    '<span class="mcl-field-label">Categoría</span>' +
    '<select id="competitor-activity-weekly-segment" class="mcl-select">' +
    segmentOpts +
    '</select></label>' +
    '</div>' +
    '<div id="competitor-activity-weekly-status" class="text-muted" aria-live="polite"></div>' +
    '<div id="competitor-activity-weekly-toggles" class="competitor-activity-weekly-toggles"></div>' +
    '<div class="competitor-activity-weekly-chart-wrap">' +
    '<canvas id="competitor-activity-weekly-canvas"></canvas>' +
    '</div>' +
    '</section>'
  );
}

function setActivityWeeklyStatus(text) {
  const el = document.getElementById('competitor-activity-weekly-status');
  if (el) el.textContent = text || '';
}

function syncActivityWeeklyToggleButton(entityCount) {
  const btn = document.getElementById('competitor-activity-weekly-toggle');
  if (!btn) return;
  if (!(entityCount > 5)) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = activityWeeklyShowAll ? 'Mostrar top 5' : 'Mostrar todos';
}

function getActivityWeeklyVisibleCompetitorIds() {
  if (!activityWeeklyData) return [];
  return getActivityWeeklyVisibleEntities(activityWeeklyData).map(
    function (ent) {
      return String(ent.entity_id);
    },
  );
}

function activityWeeklyAllVisibleUnchecked(ids) {
  return (
    ids.length > 0 &&
    ids.every(function (id) {
      return activityWeeklyChecked[id] === false;
    })
  );
}

function syncActivityWeeklySelectAllButton() {
  const btn = document.getElementById(
    'competitor-activity-weekly-select-all',
  );
  if (!btn) return;
  const ids = getActivityWeeklyVisibleCompetitorIds();
  if (!ids.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = activityWeeklyAllVisibleUnchecked(ids)
    ? 'Seleccionar todos'
    : 'Deseleccionar todos';
}

function toggleActivityWeeklySelectAllVisible() {
  const ids = getActivityWeeklyVisibleCompetitorIds();
  if (!ids.length) return;
  const selectAll = activityWeeklyAllVisibleUnchecked(ids);
  ids.forEach(function (id) {
    activityWeeklyChecked[id] = selectAll;
  });
  const host = document.getElementById('competitor-activity-weekly-toggles');
  if (host) {
    host.querySelectorAll('input[data-series]').forEach(function (checkbox) {
      const seriesKey = checkbox.getAttribute('data-series');
      if (!seriesKey || seriesKey === ACTIVITY_WEEKLY_PHASE_ID) return;
      if (ids.indexOf(seriesKey) === -1) return;
      checkbox.checked = selectAll;
    });
  }
  if (activityWeeklyChart) {
    ids.forEach(function (id) {
      setActivityWeeklyEntityDatasetsHidden(id, !selectAll);
    });
    activityWeeklyChart.update();
  }
  syncActivityWeeklySelectAllButton();
}

function renderActivityWeeklyToggles(visibleEntities) {
  const host = document.getElementById('competitor-activity-weekly-toggles');
  if (!host) return;
  const phaseChecked =
    activityWeeklyChecked[ACTIVITY_WEEKLY_PHASE_ID] !== false;
  const phaseToggle =
    '<label class="competitor-activity-weekly-toggle">' +
    '<input type="checkbox" data-series="' +
    ACTIVITY_WEEKLY_PHASE_ID +
    '"' +
    (phaseChecked ? ' checked' : '') +
    ' />' +
    '<span class="competitor-activity-weekly-swatch" style="background:#94a3b8"></span>' +
    'Fase de Zafra</label>';
  host.innerHTML =
    phaseToggle +
    visibleEntities
      .map(function (ent) {
        const id = String(ent.entity_id);
        const checked = activityWeeklyChecked[id] !== false;
        const color = colorForString(ent.name || id);
        return (
          '<label class="competitor-activity-weekly-toggle">' +
          '<input type="checkbox" data-series="' +
          escapeHtml(id) +
          '"' +
          (checked ? ' checked' : '') +
          ' />' +
          '<span class="competitor-activity-weekly-swatch" style="background:' +
          escapeHtml(color) +
          '"></span>' +
          escapeHtml(ent.name || 'Entidad') +
          '</label>'
        );
      })
      .join('');

  host.querySelectorAll('input[data-series]').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      const seriesKey = checkbox.getAttribute('data-series');
      if (!seriesKey) return;
      activityWeeklyChecked[seriesKey] = checkbox.checked;
      if (!activityWeeklyChart) return;
      if (seriesKey === ACTIVITY_WEEKLY_PHASE_ID) {
        const datasetIndex = activityWeeklyChart.data.datasets.findIndex(
          function (dataset) {
            return dataset.id === seriesKey;
          },
        );
        if (datasetIndex !== -1) {
          activityWeeklyChart.getDatasetMeta(datasetIndex).hidden =
            !checkbox.checked;
        }
      } else {
        setActivityWeeklyEntityDatasetsHidden(seriesKey, !checkbox.checked);
      }
      activityWeeklyChart.update();
      if (seriesKey !== ACTIVITY_WEEKLY_PHASE_ID) {
        syncActivityWeeklySelectAllButton();
      }
    });
  });
}

function mountCompetitorActivityWeeklyChart() {
  destroyActivityWeeklyChart();
  const canvas = document.getElementById('competitor-activity-weekly-canvas');
  const wrap = canvas && canvas.parentElement;
  if (!canvas || typeof window.Chart !== 'function') return;

  const data = activityWeeklyData;
  if (!data) {
    setActivityWeeklyStatus('Cargando actividad semanal…');
    if (wrap) wrap.hidden = true;
    syncActivityWeeklyPredictionCaption(null, null);
    return;
  }

  const weeks = Array.isArray(data.weeks) ? data.weeks : [];
  const segmentPool = getActivityWeeklySegmentFilteredEntities(data);
  syncActivityWeeklyToggleButton(segmentPool.length);

  if (countWeeksWithAnyEvents(data) < 2) {
    setActivityWeeklyStatus(
      'Todavía no hay suficiente historial semanal para graficar (se necesitan al menos 2 semanas con actividad).',
    );
    const toggles = document.getElementById(
      'competitor-activity-weekly-toggles',
    );
    if (toggles) toggles.innerHTML = '';
    if (wrap) wrap.hidden = true;
    const selectAllBtn = document.getElementById(
      'competitor-activity-weekly-select-all',
    );
    if (selectAllBtn) selectAllBtn.hidden = true;
    syncActivityWeeklyPredictionCaption(null, null);
    return;
  }

  setActivityWeeklyStatus('');
  if (wrap) wrap.hidden = false;

  const visible = getActivityWeeklyVisibleEntities(data);
  ensureActivityWeeklyCheckedDefaults(visible);
  renderActivityWeeklyToggles(visible);
  syncActivityWeeklySelectAllButton();

  const phaseByWeek = {};
  (Array.isArray(data.phase_by_week) ? data.phase_by_week : []).forEach(
    function (row) {
      if (row && row.week_of) {
        phaseByWeek[row.week_of] = row.dominant_phase || null;
      }
    },
  );

  const nextWeek =
    weeks.length > 0 ? shiftDate(weeks[weeks.length - 1], 7) : null;
  const predictionDatasets = nextWeek
    ? buildActivityWeeklyPredictionDatasets(visible, nextWeek)
    : [];
  const chartLabels =
    predictionDatasets.length > 0 && nextWeek
      ? weeks.concat([nextWeek])
      : weeks.slice();
  const hasPredictionWeek = predictionDatasets.length > 0 && !!nextWeek;
  const lastRealWeek = weeks.length ? weeks[weeks.length - 1] : null;
  syncActivityWeeklyPredictionCaption(
    hasPredictionWeek ? lastRealWeek : null,
    hasPredictionWeek ? nextWeek : null,
  );
  const partialDatasets = hasPredictionWeek
    ? buildActivityWeeklyPartialDatasets(nextWeek)
    : [];

  const phaseColors = chartLabels.map(function (w) {
    if (weeks.indexOf(w) === -1) return 'transparent';
    return phaseByWeek[w] ? phasePointColor(phaseByWeek[w]) : 'transparent';
  });
  const phaseValues = chartLabels.map(function (w) {
    if (weeks.indexOf(w) === -1) return null;
    return phaseByWeek[w] ? 0.5 : null;
  });

  const datasets = visible.map(function (ent) {
    const id = String(ent.entity_id);
    const color = colorForString(ent.name || id);
    const weekMeta = {};
    (Array.isArray(ent.series) ? ent.series : []).forEach(function (p) {
      if (!p || !p.week_of) return;
      weekMeta[p.week_of] = {
        count: Number(p.count) || 0,
        by_type:
          p.by_type && typeof p.by_type === 'object' ? p.by_type : {},
      };
    });
    return {
      id: id,
      label: ent.name || 'Entidad',
      _baseColor: color,
      weekMeta: weekMeta,
      data: chartLabels.map(function (w) {
        if (weeks.indexOf(w) === -1) return null;
        return weekMeta[w] ? weekMeta[w].count : 0;
      }),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 3,
      yAxisID: 'y',
      spanGaps: false,
      hidden: activityWeeklyChecked[id] === false,
    };
  });

  predictionDatasets.forEach(function (ds) {
    datasets.push(ds);
  });
  partialDatasets.forEach(function (ds) {
    datasets.push(ds);
  });

  datasets.push({
    id: ACTIVITY_WEEKLY_PHASE_ID,
    label: 'Fase de Zafra',
    data: phaseValues,
    borderColor: 'transparent',
    backgroundColor: phaseColors,
    pointBackgroundColor: phaseColors,
    showLine: false,
    spanGaps: false,
    pointRadius: 5,
    pointHoverRadius: 6,
    yAxisID: 'y1',
    hidden: activityWeeklyChecked[ACTIVITY_WEEKLY_PHASE_ID] === false,
  });

  activityWeeklyChart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: chartLabels, datasets: datasets },
    plugins: [ACTIVITY_WEEKLY_PREDICTION_ZONE_PLUGIN],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: function (_evt, elements) {
        if (!elements || !elements.length) {
          if (activityWeeklyHighlightId) {
            activityWeeklyHighlightId = null;
            applyActivityWeeklyHighlightStyles();
          }
          return;
        }
        const ds =
          activityWeeklyChart.data.datasets[elements[0].datasetIndex];
        if (!ds || !ds.id) return;
        if (isActivityWeeklyPredictionDatasetId(ds.id)) return;
        if (isActivityWeeklyPartialDatasetId(ds.id)) return;
        activityWeeklyHighlightId =
          activityWeeklyHighlightId === ds.id ? null : ds.id;
        applyActivityWeeklyHighlightStyles();
      },
      plugins: {
        activityWeeklyPredictionZone: {
          enabled: hasPredictionWeek,
          lastRealIndex: hasPredictionWeek ? weeks.length - 1 : null,
        },
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function (items) {
              if (!items || !items.length) return '';
              const week = String(items[0].label || '');
              const ds = items[0].dataset || {};
              if (isActivityWeeklyPartialDatasetId(ds.id)) {
                return week;
              }
              if (isActivityWeeklyPredictionDatasetId(ds.id)) {
                return items[0].dataIndex === 1 ? week : '';
              }
              if (ds.id === ACTIVITY_WEEKLY_PHASE_ID) {
                return week;
              }
              const meta = ds.weekMeta && ds.weekMeta[week];
              const total = meta ? meta.count : items[0].parsed.y;
              return (
                (ds.label || 'Competidor') +
                ' · ' +
                week +
                ' · ' +
                total +
                ' eventos'
              );
            },
            label: function (item) {
              const week = String(item.label || '');
              const ds = item.dataset || {};
              if (isActivityWeeklyPartialDatasetId(ds.id)) {
                const meta = ds._partialMeta || {};
                const n = Number(meta.count);
                return (
                  'En curso (hasta hoy): ' +
                  (Number.isFinite(n) ? n : item.parsed.y) +
                  ' eventos'
                );
              }
              if (isActivityWeeklyPredictionDatasetId(ds.id)) {
                if (item.dataIndex !== 1) return null;
                const meta = ds._predictionMeta || {};
                return (
                  'Promedio histórico: ' +
                  meta.historical_avg +
                  ' · Probabilidad de superarlo: ' +
                  Math.round(Number(meta.predicted_probability) * 100) +
                  '%'
                );
              }
              if (ds.id === ACTIVITY_WEEKLY_PHASE_ID) {
                const phase = phaseByWeek[week];
                if (!phase) return null;
                return (
                  'Fase: ' +
                  (ACTIVITY_WEEKLY_PHASE_LABELS[phase] || phase)
                );
              }
              const meta = ds.weekMeta && ds.weekMeta[week];
              const byType = (meta && meta.by_type) || {};
              const lines = [];
              Object.keys(byType).forEach(function (type) {
                const n = Number(byType[type]) || 0;
                if (n <= 0) return;
                const label = ACTIVITY_WEEKLY_TYPE_LABELS[type] || type;
                lines.push(label + ': ' + n);
              });
              return lines.length ? lines : ['Sin desglose'];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#2a2f3a' },
          ticks: {
            color: '#9aa3b2',
            maxRotation: 0,
            // Labels array stays Monday week_of (matching / tooltips / prediction x).
            // Tick text only: Sunday close for every weekly slot including prediction.
            callback: function (value) {
              return formatWeekOfAxisLabel(this.getLabelForValue(value));
            },
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#2a2f3a' },
          ticks: {
            color: '#9aa3b2',
            precision: 0,
          },
        },
        y1: {
          display: false,
          min: 0,
          max: 5,
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
  applyActivityWeeklyHighlightStyles();
}

async function loadCompetitorActivityWeekly() {
  const seq = ++activityWeeklyRequestSeq;
  activityWeeklyLoadPromise = (async function () {
    try {
      setActivityWeeklyStatus('Cargando actividad semanal…');
      let url = API_BASE + '/reports/competitor-activity-weekly';
      if (activityWeeklyFrom && activityWeeklyTo) {
        url +=
          '?from=' +
          encodeURIComponent(activityWeeklyFrom) +
          '&to=' +
          encodeURIComponent(activityWeeklyTo);
      }

      const weeklyPromise = fetch(url, {
        headers: { Accept: 'application/json' },
      }).then(async function (response) {
        const body = await response.json().catch(function () {
          return {};
        });
        return { response: response, body: body };
      });

      const predsPromise = fetch(
        API_BASE + '/competitor-activity-predictions',
        { headers: { Accept: 'application/json' } },
      )
        .then(async function (response) {
          if (!response.ok) return null;
          return response.json().catch(function () {
            return null;
          });
        })
        .catch(function () {
          return null;
        });

      const pair = await Promise.all([weeklyPromise, predsPromise]);
      if (seq !== activityWeeklyRequestSeq) return;

      const weeklyResult = pair[0];
      if (!weeklyResult.response.ok) {
        throw new Error(
          weeklyResult.body && weeklyResult.body.error
            ? String(weeklyResult.body.error)
            : 'No se pudo cargar la actividad semanal.',
        );
      }

      activityWeeklyData = weeklyResult.body;
      activityWeeklyPredictions = pair[1];
      activityWeeklyHighlightId = null;
      if (
        !activityWeeklyFrom &&
        Array.isArray(weeklyResult.body.weeks) &&
        weeklyResult.body.weeks.length
      ) {
        activityWeeklyFrom = weeklyResult.body.weeks[0];
        activityWeeklyTo =
          weeklyResult.body.weeks[weeklyResult.body.weeks.length - 1];
        const fromEl = document.getElementById(
          'competitor-activity-weekly-from',
        );
        const toEl = document.getElementById('competitor-activity-weekly-to');
        if (fromEl) fromEl.value = activityWeeklyFrom;
        if (toEl) toEl.value = activityWeeklyTo;
      }
      mountCompetitorActivityWeeklyChart();
    } catch (err) {
      if (seq !== activityWeeklyRequestSeq) return;
      activityWeeklyData = null;
      activityWeeklyPredictions = null;
      destroyActivityWeeklyChart();
      setActivityWeeklyStatus(
        'Error: ' +
          (err && err.message ? err.message : 'Error desconocido'),
      );
    } finally {
      if (seq === activityWeeklyRequestSeq) {
        activityWeeklyLoadPromise = null;
      }
    }
  })();
  return activityWeeklyLoadPromise;
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
  loadCompetitorActivityWeekly();
}

init();

/* ----------------------------------------------------------------------------
 * Competidores — mutually exclusive sub-views (meta | google | ml)
 * Visibility toggles only; never rebuild #mie-market-root from this shell.
 * ------------------------------------------------------------------------- */
(function initMarketViews() {
  const marketRoot = document.getElementById('mie-market-root');
  const chrome = document.getElementById('market-chrome');
  const googleLanding = document.getElementById('serp-import-landing');
  const mlLanding = document.getElementById('ml-predictions-landing');
  const metaBtn = document.getElementById('market-meta-tab-btn');
  const googleBtn = document.getElementById('market-google-tab-btn');
  const mlBtn = document.getElementById('market-ml-tab-btn');
  const mlDisclaimer = document.getElementById('ml-predictions-disclaimer');
  const mlMeta = document.getElementById('ml-predictions-meta');
  const mlStatus = document.getElementById('ml-predictions-status');
  const mlTable = document.getElementById('ml-predictions-table');
  const mlRunNoteInput = document.getElementById('ml-run-note-input');
  const mlRunNoteCount = document.getElementById('ml-run-note-count');
  const mlRunNoteSave = document.getElementById('ml-run-note-save');
  const mlRunNoteStatus = document.getElementById('ml-run-note-status');
  const mlRunNotesList = document.getElementById('ml-run-notes-list');
  const mlRecentNotesStatus = document.getElementById(
    'ml-recent-notes-status',
  );
  const mlRecentNotesList = document.getElementById(
    'ml-recent-notes-list',
  );
  const mlMarketPatterns = document.getElementById('ml-market-patterns');

  let currentMlData = null;

  const PATTERN_STATUS_LABELS = {
    insufficient_support: 'Acumulando evidencia',
    candidate: 'En validación',
    validated: 'Patrón confirmado',
  };

  /** Same emoji system as ML explainer bullets (💡📊🧮🔎) — no new icon format. */
  const PATTERN_STATUS_ICONS = {
    insufficient_support: '⏳',
    candidate: '🔬',
    validated: '✅',
  };

  /** email-badge variants already used on this screen for competitor prediction pills. */
  const PATTERN_STATUS_BADGE_CLASS = {
    insufficient_support: 'email-badge',
    candidate: 'email-badge email-badge--sending',
    validated: 'email-badge email-badge--completed',
  };

  function hideMarketPatterns() {
    if (!mlMarketPatterns) return;
    mlMarketPatterns.hidden = true;
    mlMarketPatterns.innerHTML = '';
  }

  /** Pause copy for active=false — never implies statistical failure. */
  function patternPauseReason(hypothesis) {
    const cj =
      hypothesis && hypothesis.condition_json && typeof hypothesis.condition_json === 'object'
        ? hypothesis.condition_json
        : null;
    const fromJson =
      (cj && (cj.pause_reason || cj.inactive_reason || cj.paused_reason || cj.pauseReason)) ||
      null;
    if (typeof fromJson === 'string' && fromJson.trim()) {
      const raw = fromJson.trim();
      return raw.toLowerCase().startsWith('pausado') ? raw : 'Pausado: ' + raw;
    }
    return 'Pausado: fuente de datos no disponible';
  }

  function pickLatestEvaluation(evals) {
    const list = Array.isArray(evals) ? evals.slice() : [];
    list.sort(function (a, b) {
      const ta = Date.parse(a && a.evaluated_at) || 0;
      const tb = Date.parse(b && b.evaluated_at) || 0;
      if (tb !== ta) return tb - ta;
      return (Number(b && b.run_version) || 0) - (Number(a && a.run_version) || 0);
    });
    return list[0] || null;
  }

  function formatPatternLift(lift) {
    const n = Number(lift);
    if (!Number.isFinite(n)) return null;
    const rounded = Math.round(n * 10) / 10;
    const text = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(1);
    return text + '× más probable';
  }

  function renderMarketPatternCard(hypothesis, evaluation) {
    const name = escapeHtml(hypothesis.hypothesis_name || '—');
    const hypothesisCode =
      hypothesis && hypothesis.id != null ? 'H' + String(hypothesis.id) : null;
    const codeHtml = hypothesisCode
      ? '<span class="ml-pattern-code">' +
        escapeHtml(hypothesisCode) +
        '</span>'
      : '';
    const isActive = hypothesis.active !== false;

    if (!isActive) {
      return (
        '<article class="ml-pattern-card is-paused">' +
        '<h3 class="ml-pattern-name">' +
        codeHtml +
        name +
        '</h3>' +
        '<p class="ml-pattern-pause">' +
        escapeHtml(patternPauseReason(hypothesis)) +
        '</p>' +
        '</article>'
      );
    }

    const statusKey =
      evaluation && PATTERN_STATUS_LABELS[evaluation.validation_status]
        ? evaluation.validation_status
        : 'insufficient_support';
    const statusLabel = PATTERN_STATUS_LABELS[statusKey];
    const statusIcon = PATTERN_STATUS_ICONS[statusKey] || '⏳';
    const badgeClass =
      PATTERN_STATUS_BADGE_CLASS[statusKey] || 'email-badge';
    const supportCount = evaluation
      ? Number(evaluation.support_count) || 0
      : 0;
    const minSupport = Number(hypothesis.min_support_required) || 0;
    const supportPlain =
      escapeHtml(String(supportCount)) +
      ' de ' +
      escapeHtml(String(minSupport)) +
      ' semanas mínimas';

    let bodyHtml =
      '<p class="ml-pattern-support">' + supportPlain + '</p>';

    if (statusKey === 'validated' && evaluation) {
      const liftText = formatPatternLift(evaluation.lift);
      const periodStart = evaluation.data_period_start || '—';
      const periodEnd = evaluation.data_period_end || '—';
      // Lift and support share one line at equal visual weight — never lift alone.
      const validatedLine = liftText
        ? liftText +
          ' — observado en ' +
          supportCount +
          ' casos · validado sobre ' +
          periodStart +
          '–' +
          periodEnd
        : 'Observado en ' +
          supportCount +
          ' casos · validado sobre ' +
          periodStart +
          '–' +
          periodEnd;
      bodyHtml =
        '<p class="ml-pattern-validated">' +
        escapeHtml(validatedLine) +
        '</p>';
    }

    return (
      '<article class="ml-pattern-card is-' +
      escapeHtml(statusKey) +
      '">' +
      '<h3 class="ml-pattern-name">' +
      codeHtml +
      '<span class="ml-pattern-status-icon" aria-hidden="true">' +
      statusIcon +
      '</span>' +
      name +
      '</h3>' +
      '<span class="' +
      badgeClass +
      '">' +
      escapeHtml(statusLabel) +
      '</span>' +
      bodyHtml +
      '</article>'
    );
  }

  async function loadMarketPatterns() {
    if (!mlMarketPatterns) return;
    hideMarketPatterns();
    try {
      const response = await fetch(API_BASE + '/market-patterns', {
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(function () {
        return {};
      });
      if (!response.ok) {
        throw new Error(
          data && data.error
            ? String(data.error)
            : 'No se pudieron cargar los patrones de mercado.',
        );
      }

      const hypotheses = Array.isArray(data.hypotheses) ? data.hypotheses : [];
      if (!hypotheses.length) return;

      const cardsHtml = hypotheses
        .map(function (h) {
          // Backend already merges latest evaluation (or explicit null).
          const evaluation =
            h && Object.prototype.hasOwnProperty.call(h, 'evaluation')
              ? h.evaluation
              : null;
          return renderMarketPatternCard(h, evaluation);
        })
        .join('');

      if (!cardsHtml) return;

      mlMarketPatterns.innerHTML =
        '<h2 class="ml-market-patterns-title">Patrones de mercado</h2>' +
        '<div class="ml-market-patterns-explainer">' +
        '<p class="ga4-summary-note text-muted">' +
        '💡 Un patrón de mercado es una hipótesis que el sistema evalúa con ' +
        'evidencia acumulada semana a semana (por ejemplo, si la visibilidad ' +
        'en IA se asocia a más tráfico orgánico).' +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '📊 Acumulando evidencia = todavía no llega al soporte mínimo. ' +
        'En validación = hay señales, pero aún no confirma. ' +
        'Patrón confirmado = pasó el umbral de soporte y lift.' +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '🧮 Hoy no hay ningún patrón confirmado: el sistema recién empieza a ' +
        'acumular datos y las hipótesis aparecen en progreso a propósito.' +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '🔎 Esta vista muestra los tres estados para ver cómo crece la ' +
        'evidencia; no es un resumen ejecutivo de patrones ya validados.' +
        '</p>' +
        '</div>' +
        '<div class="ml-pattern-card-grid">' +
        cardsHtml +
        '</div>';
      mlMarketPatterns.hidden = false;
    } catch (ignore) {
      // Missing tables or empty catalog → clean absence (no decorative empty state).
      hideMarketPatterns();
    }
  }

  function formatMlNoteDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return date.toLocaleString('es-UY');
  }

  function renderMlNotes(notes, container, includeEntity) {
    if (!container) return;
    const rows = Array.isArray(notes) ? notes : [];

    if (!rows.length) {
      container.innerHTML =
        '<p class="text-muted">Todavía no hay notas.</p>';
      return;
    }

    container.innerHTML = rows
      .map(function (item) {
        const context = includeEntity
          ? '<div class="ml-note-context">' +
            escapeHtml(item.name || 'Entidad') +
            ' · semana ' +
            escapeHtml(item.week_of || '—') +
            '</div>'
          : '';

        return (
          '<article class="ml-note-item">' +
          context +
          '<div class="ml-note-date">' +
          escapeHtml(formatMlNoteDate(item.created_at)) +
          '</div>' +
          '<div class="ml-note-text">' +
          escapeHtml(item.note || '') +
          '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  async function readMlJson(response) {
    const data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(
        data && data.error
          ? String(data.error)
          : 'Error HTTP ' + response.status,
      );
    }
    return data;
  }

  function setVisible(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  function renderMlPredictions(data) {
    currentMlData = data || {};
    const predictions = Array.isArray(data && data.predictions)
      ? data.predictions
      : [];
    const trainingRows = Number(data && data.training_rows_used) || 0;

    if (mlDisclaimer) {
      mlDisclaimer.textContent =
        '⚠️ Piloto experimental de Machine Learning — entrenado con ' +
        trainingRows +
        ' filas de datos históricos, todavía insuficientes para confiar en ' +
        'estas predicciones como certeza. Sirve para validar el proceso, no ' +
        'para tomar decisiones de negocio todavía.';
      mlDisclaimer.hidden = false;
    }

    if (mlMeta) {
      mlMeta.innerHTML =
        '<p class="ga4-summary-note text-muted">' +
        '💡 Prediciendo semana del ' +
        escapeHtml(data.predicted_week_of || '—') +
        ', en base a datos hasta el ' +
        escapeHtml(data.features_week_of || '—') +
        ' · modelo ' +
        escapeHtml(data.model_version || '—') +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '📊 Para cada competidor, el modelo mira 3 datos de la semana ' +
        'anterior: cuántos anuncios tuvo, su promedio histórico, y hace ' +
        'cuánto no publicaba. Con eso calcula una probabilidad de que tenga ' +
        'actividad inusualmente alta esta semana (más de 1.5x su promedio).' +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '🧮 Es una regresión logística: combina esos 3 datos con pesos ' +
        'aprendidos de ' +
        escapeHtml(String(trainingRows)) +
        ' casos históricos, y convierte el ' +
        'resultado en un porcentaje entre 0% y 100%.' +
        '</p>' +
        '<p class="ga4-summary-note text-muted">' +
        '🔎 Antes de mostrar una predicción, el modelo chequea si tiene ' +
        'suficiente información sobre ese competidor. Si nunca vio ningún ' +
        'aviso de esa entidad, no inventa un número — muestra "Sin datos ' +
        'suficientes". Si vio actividad pero esa entidad nunca tuvo un pico ' +
        'histórico, la predicción se muestra igual pero marcada como "baja ' +
        'confianza", porque hay poca evidencia todavía.' +
        '</p>';
    }

    if (!predictions.length) {
      if (mlStatus) mlStatus.textContent = 'Todavía no hay predicciones.';
      if (mlTable) mlTable.innerHTML = '';
      return;
    }

    if (mlStatus) mlStatus.textContent = '';
    if (!mlTable) return;

    const rows = predictions
      .map(function (prediction) {
        const name = prediction && prediction.name
          ? String(prediction.name)
          : 'Entidad';
        const status =
          prediction && prediction.eligibility_status != null
            ? String(prediction.eligibility_status)
            : null;
        const isIneligible = status === 'ineligible';
        const isLowConfidence = status === 'low_confidence';

        let percentage;
        let badgeHtml;
        if (isIneligible) {
          percentage = 'Sin datos suficientes';
          badgeHtml =
            '<span class="email-badge">Sin datos suficientes</span>';
        } else {
          const probability = Number(prediction.predicted_probability);
          percentage = Number.isFinite(probability)
            ? Math.round(probability * 100) + '%'
            : '—';
          const possiblePeak = prediction.predicted_label === true;
          const badgeClass = possiblePeak ? ' email-badge--sending' : '';
          const badgeText = possiblePeak
            ? 'Posible pico'
            : 'Sin cambios esperados';
          badgeHtml =
            '<span class="email-badge' +
            badgeClass +
            '">' +
            escapeHtml(badgeText) +
            '</span>';
          if (isLowConfidence) {
            badgeHtml +=
              ' <span class="email-badge email-badge--low-confidence">' +
              'Baja confianza</span>';
          }
        }
        const avatar = renderGaugeAvatar({
          entityName: name,
          websiteDomain: prediction.website_domain || null,
        });
        const entityId = String(prediction.entity_id || '');
        const predictedWeekOf = String(data.predicted_week_of || '');

        return (
          '<tr class="sms-row">' +
          '<td><span class="ml-prediction-entity">' +
          avatar +
          '<span>' +
          escapeHtml(name) +
          '</span></span></td>' +
          '<td>' +
          escapeHtml(percentage) +
          '</td>' +
          '<td>' +
          badgeHtml +
          '</td>' +
          '<td><button type="button" class="btn ml-note-toggle" ' +
          'data-entity-id="' +
          escapeHtml(entityId) +
          '">+ nota</button></td>' +
          '</tr>' +
          '<tr class="ml-entity-note-row" data-note-row-for="' +
          escapeHtml(entityId) +
          '" hidden><td colspan="4">' +
          '<form class="ml-entity-note-form" data-entity-id="' +
          escapeHtml(entityId) +
          '" data-week-of="' +
          escapeHtml(predictedWeekOf) +
          '">' +
          '<label>Nota para ' +
          escapeHtml(name) +
          ' · semana ' +
          escapeHtml(predictedWeekOf || '—') +
          '</label>' +
          '<textarea class="ml-note-textarea ml-entity-note-input" ' +
          'maxlength="1000" rows="3" required></textarea>' +
          '<div class="ml-note-actions">' +
          '<span class="text-muted ml-entity-note-count">0/1000</span>' +
          '<button type="submit" class="btn">Guardar nota</button>' +
          '</div><div class="mcl-status ml-entity-note-status" ' +
          'aria-live="polite"></div></form></td>' +
          '</tr>'
        );
      })
      .join('');

    mlTable.innerHTML =
      '<div class="sms-table-wrap">' +
      '<table class="sms-table">' +
      '<thead><tr><th>Competidor</th><th>Probabilidad</th>' +
      '<th>Etiqueta</th><th>Nota</th></tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody></table></div>';
  }

  async function loadRunNotes(modelVersion) {
    if (!mlRunNotesList || !mlRunNoteStatus) return;
    if (!modelVersion) {
      mlRunNoteStatus.textContent = '';
      renderMlNotes([], mlRunNotesList, false);
      return;
    }

    mlRunNoteStatus.textContent = 'Cargando notas de la corrida…';
    try {
      const response = await fetch(
        API_BASE +
          '/ml-notes/run?model_version=' +
          encodeURIComponent(modelVersion),
        { headers: { Accept: 'application/json' } },
      );
      const data = await readMlJson(response);
      mlRunNoteStatus.textContent = '';
      renderMlNotes(data.notes, mlRunNotesList, false);
    } catch (error) {
      mlRunNoteStatus.textContent =
        'Error: ' +
        (error && error.message ? error.message : 'Error desconocido');
    }
  }

  async function loadRecentMlNotes() {
    if (!mlRecentNotesList || !mlRecentNotesStatus) return;
    mlRecentNotesStatus.textContent = 'Cargando notas recientes…';
    try {
      const response = await fetch(API_BASE + '/ml-notes/entity-week', {
        headers: { Accept: 'application/json' },
      });
      const data = await readMlJson(response);
      mlRecentNotesStatus.textContent = '';
      renderMlNotes(data.notes, mlRecentNotesList, true);
    } catch (error) {
      mlRecentNotesStatus.textContent =
        'Error: ' +
        (error && error.message ? error.message : 'Error desconocido');
    }
  }

  async function loadMlPredictions() {
    if (mlStatus) mlStatus.textContent = 'Cargando predicciones…';
    if (mlTable) mlTable.innerHTML = '';
    try {
      const response = await fetch(
        API_BASE + '/competitor-activity-predictions',
        { headers: { Accept: 'application/json' } },
      );
      const data = await response.json().catch(function () {
        return {};
      });
      if (!response.ok) {
        throw new Error(
          data && data.error
            ? String(data.error)
            : 'No se pudieron cargar las predicciones.',
        );
      }
      renderMlPredictions(data);
      await Promise.all([
        loadRunNotes(data.model_version),
        loadRecentMlNotes(),
        loadMarketPatterns(),
      ]);
    } catch (error) {
      if (mlStatus) {
        mlStatus.textContent =
          'Error: ' +
          (error && error.message ? error.message : 'Error desconocido');
      }
      // Patterns are independent of the predictions endpoint.
      loadMarketPatterns();
    }
  }

  if (mlRunNoteInput && mlRunNoteCount) {
    mlRunNoteInput.addEventListener('input', function () {
      mlRunNoteCount.textContent =
        String(mlRunNoteInput.value.length) + '/1000';
    });
  }

  if (mlRunNoteSave) {
    mlRunNoteSave.addEventListener('click', async function () {
      const modelVersion =
        currentMlData && typeof currentMlData.model_version === 'string'
          ? currentMlData.model_version.trim()
          : '';
      const note = mlRunNoteInput ? mlRunNoteInput.value.trim() : '';

      if (!modelVersion) {
        if (mlRunNoteStatus) {
          mlRunNoteStatus.textContent =
            'No hay una versión de modelo disponible.';
        }
        return;
      }
      if (!note) {
        if (mlRunNoteStatus) {
          mlRunNoteStatus.textContent = 'Escribí una nota antes de guardar.';
        }
        return;
      }

      mlRunNoteSave.disabled = true;
      if (mlRunNoteStatus) mlRunNoteStatus.textContent = 'Guardando…';

      try {
        const response = await fetch(API_BASE + '/ml-notes/run', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model_version: modelVersion,
            note,
          }),
        });
        await readMlJson(response);
        mlRunNoteInput.value = '';
        if (mlRunNoteCount) mlRunNoteCount.textContent = '0/1000';
        if (mlRunNoteStatus) mlRunNoteStatus.textContent = 'Nota guardada.';
        await loadRunNotes(modelVersion);
      } catch (error) {
        if (mlRunNoteStatus) {
          mlRunNoteStatus.textContent =
            'Error: ' +
            (error && error.message ? error.message : 'Error desconocido');
        }
      } finally {
        mlRunNoteSave.disabled = false;
      }
    });
  }

  if (mlTable) {
    mlTable.addEventListener('click', function (event) {
      const button = event.target.closest('.ml-note-toggle');
      if (!button || !mlTable.contains(button)) return;

      const entityId = button.getAttribute('data-entity-id') || '';
      const row = mlTable.querySelector(
        '[data-note-row-for="' + CSS.escape(entityId) + '"]',
      );
      if (!row) return;

      const willOpen = row.hidden;
      mlTable
        .querySelectorAll('.ml-entity-note-row')
        .forEach(function (noteRow) {
          noteRow.hidden = true;
        });
      row.hidden = !willOpen;

      if (willOpen) {
        const textarea = row.querySelector('.ml-entity-note-input');
        if (textarea) textarea.focus();
      }
    });

    mlTable.addEventListener('input', function (event) {
      if (!event.target.matches('.ml-entity-note-input')) return;
      const form = event.target.closest('.ml-entity-note-form');
      const count = form && form.querySelector('.ml-entity-note-count');
      if (count) {
        count.textContent = String(event.target.value.length) + '/1000';
      }
    });

    mlTable.addEventListener('submit', async function (event) {
      const form = event.target.closest('.ml-entity-note-form');
      if (!form) return;
      event.preventDefault();

      const textarea = form.querySelector('.ml-entity-note-input');
      const submitButton = form.querySelector('button[type="submit"]');
      const status = form.querySelector('.ml-entity-note-status');
      const note = textarea ? textarea.value.trim() : '';
      const entityId = form.getAttribute('data-entity-id') || '';
      const weekOf = form.getAttribute('data-week-of') || '';

      if (!note) {
        if (status) status.textContent = 'Escribí una nota antes de guardar.';
        return;
      }

      if (submitButton) submitButton.disabled = true;
      if (status) status.textContent = 'Guardando…';

      try {
        const response = await fetch(API_BASE + '/ml-notes/entity-week', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            entity_id: entityId,
            week_of: weekOf,
            note,
          }),
        });
        await readMlJson(response);
        textarea.value = '';
        const count = form.querySelector('.ml-entity-note-count');
        if (count) count.textContent = '0/1000';
        if (status) status.textContent = 'Nota guardada.';
        await loadRecentMlNotes();
      } catch (error) {
        if (status) {
          status.textContent =
            'Error: ' +
            (error && error.message ? error.message : 'Error desconocido');
        }
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  function setMarketView(view) {
    const v = view === 'google' || view === 'ml' ? view : 'meta';
    window.__mieMarketView = v;
    setVisible(marketRoot, v === 'meta');
    setVisible(googleLanding, v === 'google');
    setVisible(mlLanding, v === 'ml');
    setVisible(chrome, true);
    if (metaBtn) metaBtn.classList.toggle('active', v === 'meta');
    if (googleBtn) googleBtn.classList.toggle('active', v === 'google');
    if (mlBtn) mlBtn.classList.toggle('active', v === 'ml');
    if (v === 'google' && typeof window.__openGoogleSerp === 'function') {
      window.__openGoogleSerp();
    }
    if (v === 'ml') {
      loadMlPredictions();
    }
  }

  window.__setMarketView = setMarketView;
  if (metaBtn) metaBtn.addEventListener('click', () => setMarketView('meta'));
  if (googleBtn) googleBtn.addEventListener('click', () => setMarketView('google'));
  if (mlBtn) mlBtn.addEventListener('click', () => setMarketView('ml'));
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
  const runAnalysisEl = document.getElementById('cov-run-analysis');

  if (!statusEl || !suggestionsEl || !applyBtn || !draftsEl) {
    return;
  }

  const covState = {
    suggestions: [],
    decisions: {}, // term -> decision value
    applying: false,
    pollTimer: null,
    pollAttempts: 0,
    cancelWizard: null,
    /** sync_run_id of the Comparativo analysis currently shown (or null). */
    analysisSyncRunId: null,
    /**
     * CPC estimates for analysisSyncRunId, keyed by trim().toLowerCase(term).
     * null = analysis not loaded; object = use for Comparativo only.
     */
    analysisEstimatesByTerm: null,
  };

  /** Session-only hide after successful "Medir ahora" (cleared on reload). */
  const hiddenMeasuredSuggestionKeys = new Set();
  let cpcMeasureFeedback = null;

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

  function formatDiscoveryCpcDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso);
    return d.toLocaleDateString('es-UY');
  }

  function formatDiscoveryCompetition(level) {
    if (level == null || level === '') return '—';
    const key = String(level).toUpperCase();
    if (key === 'LOW') return 'Baja';
    if (key === 'MEDIUM') return 'Media';
    if (key === 'HIGH') return 'Alta';
    if (key === 'UNSPECIFIED' || key === 'UNKNOWN') return '—';
    return String(level);
  }

  function competitionLevelToneClass(level) {
    const key = String(level == null ? '' : level).toUpperCase();
    if (key === 'LOW') return 'cpc-comp-low';
    if (key === 'MEDIUM') return 'cpc-comp-medium';
    if (key === 'HIGH') return 'cpc-comp-high';
    return '';
  }

  /** Escaped HTML for competition label; emptyLabel when level missing (default —). */
  function renderCompetitionLevelHtml(level, emptyLabel) {
    const label = formatDiscoveryCompetition(level);
    if (label === '—') {
      return escapeHtml(emptyLabel != null ? emptyLabel : '—');
    }
    const cls = competitionLevelToneClass(level);
    if (!cls) return escapeHtml(label);
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  function formatDiscoveryBidFromMicros(raw, currencyCode) {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    const amount = (n / 1000000).toFixed(2);
    if (currencyCode) return amount + ' ' + String(currencyCode);
    return amount + ' (moneda sin confirmar)';
  }

  function formatDiscoveryAvgSearches(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return String(Math.trunc(n));
  }

  /** Same visual pattern as Queries monitoreadas CPC meta. */
  function renderDiscoveryClassificationBadge(estimate) {
    const status =
      estimate && estimate.classificationStatus
        ? String(estimate.classificationStatus)
        : '';
    const map = {
      recommended: ['Recomendada', 'is-cpc-recommended'],
      evaluate: ['Evaluar', 'is-cpc-evaluate'],
      low_priority: ['Baja prioridad', 'is-cpc-low-priority'],
      discarded_high_competition: ['Competencia alta', 'is-cpc-high-comp'],
      discarded_low_volume: ['Volumen insuficiente', 'is-cpc-low-volume'],
      insufficient_bid_data: ['Sin datos de bid', 'is-cpc-no-bid'],
    };
    const entry = map[status];
    if (!entry) return '';
    if (
      status === 'discarded_high_competition' ||
      status === 'evaluate' ||
      status === 'discarded_low_volume'
    ) {
      return '';
    }
    return (
      '<span class="cov-badge cpc-class-badge ' +
      entry[1] +
      '">' +
      escapeHtml(entry[0]) +
      '</span>'
    );
  }

  function volumeSearchPrefixEmoji(estimate) {
    const status =
      estimate && estimate.classificationStatus
        ? String(estimate.classificationStatus)
        : '';
    let emoji = '⏩';
    let unclassified = true;
    if (status === 'recommended') {
      emoji = '🟢';
      unclassified = false;
    } else if (status === 'evaluate') {
      emoji = '🟡';
      unclassified = false;
    } else if (status === 'discarded_high_competition') {
      emoji = '🔴';
      unclassified = false;
    } else if (
      status === 'low_priority' ||
      status === 'discarded_low_volume' ||
      status === 'insufficient_bid_data'
    ) {
      emoji = '⚪';
      unclassified = false;
    }
    const cls = unclassified
      ? 'cpc-vol-emoji cov-badge cpc-class-badge is-cpc-unclassified'
      : 'cpc-vol-emoji';
    return '<span class="' + cls + '">' + emoji + '</span>';
  }

  function renderDiscoveryCpcMeta(estimate) {
    if (!estimate) {
      return (
        '<div class="cov-cpc-meta cov-cpc-empty">⏳ Sin datos de CPC todavía</div>'
      );
    }
    const vol = formatDiscoveryAvgSearches(estimate.avgMonthlySearches);
    const low = formatDiscoveryBidFromMicros(
      estimate.lowTopOfPageBidRaw,
      estimate.currencyCode,
    );
    const high = formatDiscoveryBidFromMicros(
      estimate.highTopOfPageBidRaw,
      estimate.currencyCode,
    );
    const fetched = formatDiscoveryCpcDate(estimate.fetchedAt);
    const badge = renderDiscoveryClassificationBadge(estimate);
    return (
      '<div class="cov-cpc-meta">' +
      (badge ? badge + ' ' : '') +
      volumeSearchPrefixEmoji(estimate) +
      ' Vol. búsquedas: ' +
      escapeHtml(vol) +
      ' · Competencia: ' +
      renderCompetitionLevelHtml(estimate.competitionLevel) +
      ' · Bid bajo: <span class="cpc-bid-low">' +
      escapeHtml(low) +
      '</span> · Bid alto: <span class="cpc-bid-high">' +
      escapeHtml(high) +
      '</span> · CPC al ' +
      escapeHtml(fetched) +
      '</div>'
    );
  }

  async function copyDiscoveryTerm(term, btn) {
    const text = term != null ? String(term) : '';
    if (!text) return;
    const prev = btn.textContent;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      btn.textContent = 'Copiado';
      window.setTimeout(function () {
        btn.textContent = prev;
      }, 1200);
    } catch (err) {
      btn.textContent = 'Error';
      window.setTimeout(function () {
        btn.textContent = prev;
      }, 1200);
    }
  }

  /** Split free-form Claude summary into bullets; keep decimals like 14.8K intact. */
  function splitAnalysisSummaryBullets(text) {
    const s = String(text || '').trim();
    if (!s) return [];
    const rawParts = s.split('. ');
    const merged = [];
    for (let i = 0; i < rawParts.length; i++) {
      let part = rawParts[i];
      // Re-join false splits from decimals like "12. 5" (digit stub + digit stub).
      while (
        i + 1 < rawParts.length &&
        /\d$/.test(part) &&
        /^\d/.test(rawParts[i + 1])
      ) {
        part = part + '. ' + rawParts[i + 1];
        i += 1;
      }
      merged.push(part);
    }
    return merged
      .map(function (part) {
        return part.replace(/\.$/, '').trim();
      })
      .filter(Boolean);
  }

  function renderAnalysisSummaryHtml(summaryText) {
    const bullets = splitAnalysisSummaryBullets(summaryText);
    if (!bullets.length) return '';
    return (
      '<ul class="cpc-run-analysis-summary-list">' +
      bullets
        .map(function (b) {
          return '<li>' + escapeHtml(b) + '</li>';
        })
        .join('') +
      '</ul>'
    );
  }

  function relationshipLabel(rel) {
    if (rel === 'same_intent') return 'misma intención';
    if (rel === 'related_intent') return 'intención relacionada';
    if (rel === 'possible_redundancy') return 'posible redundancia';
    return rel || '—';
  }

  function comparisonTerm(c, which) {
    if (which === 'a') return c.term_a || c.termA || '';
    return c.term_b || c.termB || '';
  }

  function comparisonPreferred(c) {
    return c.preferred_measured_term || c.preferredMeasuredTerm || null;
  }

  /** same_intent with no preferred term = identical measured data (LLM signal). */
  function isExactDuplicateComparison(c) {
    return String(c.relationship || '') === 'same_intent' && !comparisonPreferred(c);
  }

  function estimateForMeasuredTerm(term) {
    const key = String(term || '').trim().toLowerCase();
    if (!key) return null;
    // Comparativo only: require the analysis-run map. While null/undefined
    // (still loading / failed), return null — never suggestions / other runs.
    const byTerm = covState.analysisEstimatesByTerm;
    if (!byTerm || typeof byTerm !== 'object') return null;
    return byTerm[key] || null;
  }

  function formatEfficiencyScore(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n));
  }

  /** Same term shown twice (literal or case-insensitive). Not accent variants. */
  function isSelfTermComparison(termA, termB) {
    const a = String(termA || '').trim().toLowerCase();
    const b = String(termB || '').trim().toLowerCase();
    return Boolean(a) && a === b;
  }

  function renderComparisonMetricCell(est, field) {
    if (!est) return 'Sin estimate en esta corrida';
    if (field === 'vol') {
      const vol = formatDiscoveryAvgSearches(est.avgMonthlySearches);
      const text = vol === '—' ? 'Sin dato' : vol;
      return volumeSearchPrefixEmoji(est) + ' ' + escapeHtml(text);
    }
    if (field === 'comp') {
      // Already escaped HTML (may include tone span) — callers must not escapeHtml.
      return renderCompetitionLevelHtml(est.competitionLevel, 'Sin dato');
    }
    if (field === 'eff') {
      const status =
        est.classificationStatus != null
          ? String(est.classificationStatus)
          : '';
      if (status === 'insufficient_bid_data') return 'Sin datos de bid';
      if (status === 'discarded_high_competition') {
        return 'No aplica (descartado)';
      }
      const eff = formatEfficiencyScore(est.efficiencyScore);
      if (!eff) return 'Sin dato';
      return eff;
    }
    return 'Sin dato';
  }

  function renderComparisonTermColumnHead(term, est, isPreferred) {
    const termHtml = isPreferred
      ? '<strong class="cpc-compare-pref">' + escapeHtml(term) + '</strong>'
      : escapeHtml(term);
    const classBadge = renderDiscoveryClassificationBadge(est);
    return (
      '<div class="cpc-compare-term-head">' +
      '<span class="cpc-compare-term-label">' +
      termHtml +
      '</span>' +
      (classBadge ? ' ' + classBadge : '') +
      '</div>'
    );
  }

  function formatCompactComparisonMetrics(est, opts) {
    const options = opts || {};
    if (!est) return escapeHtml('Sin estimate en esta corrida');
    const volRaw = formatDiscoveryAvgSearches(est.avgMonthlySearches);
    const vol =
      volRaw === '—'
        ? 'Sin dato'
        : Number(est.avgMonthlySearches).toLocaleString('es-UY') +
          ' búsquedas';
    const parts = [
      volumeSearchPrefixEmoji(est) + ' ' + escapeHtml(vol),
    ];
    if (!options.omitCompetition) {
      const compRaw = formatDiscoveryCompetition(est.competitionLevel);
      if (compRaw === '—') {
        parts.push(escapeHtml('Sin dato'));
      } else {
        const cls = competitionLevelToneClass(est.competitionLevel);
        const word = compRaw.toLowerCase();
        parts.push(
          escapeHtml('Competencia ') +
            (cls
              ? '<span class="' + cls + '">' + escapeHtml(word) + '</span>'
              : escapeHtml(word)),
        );
      }
    }
    let eff;
    const status =
      est.classificationStatus != null
        ? String(est.classificationStatus)
        : '';
    if (status === 'insufficient_bid_data') eff = 'Sin datos de bid';
    else if (status === 'discarded_high_competition') {
      eff = 'No aplica (descartado)';
    } else {
      const n = formatEfficiencyScore(est.efficiencyScore);
      eff = n
        ? 'Eficiencia ' + Number(n).toLocaleString('es-UY')
        : 'Sin dato';
    }
    parts.push(escapeHtml(eff));
    return parts.join(' · ');
  }

  function renderComparisonCard(c) {
    const termA = comparisonTerm(c, 'a');
    const termB = comparisonTerm(c, 'b');
    const pref = comparisonPreferred(c);
    const exactDup = isExactDuplicateComparison(c);
    const selfDup = isSelfTermComparison(termA, termB);
    const rel = c.relationship || '';
    const badgeCls = exactDup || selfDup ? 'is-covered' : 'is-intent';
    const estA = estimateForMeasuredTerm(termA);
    const estB = estimateForMeasuredTerm(termB);

    const reason = c.reason ? String(c.reason) : '';
    const reasonHtml = reason
      ? '<p class="text-muted cpc-compare-reason">' + escapeHtml(reason) + '</p>'
      : '';

    const relBadge =
      '<span class="cov-badge ' +
      badgeCls +
      '">' +
      escapeHtml(relationshipLabel(rel)) +
      '</span>';

    // Preventivo: mismo término dos veces en el analysis (no es “consolidar variantes”).
    if (selfDup) {
      return (
        '<div class="cov-draft-card cpc-compare-card cpc-compare-self">' +
        '<div class="cov-draft-main">' +
        relBadge +
        '</div>' +
        '<p class="cpc-compare-self-warn">Este término aparece duplicado en el análisis — revisar datos de origen</p>' +
        '<p class="cpc-compare-dup-title">' +
        escapeHtml(termA) +
        '</p>' +
        (renderDiscoveryClassificationBadge(estA)
          ? '<div class="cpc-compare-compact-badges">' +
            renderDiscoveryClassificationBadge(estA) +
            '</div>'
          : '') +
        '<p class="cpc-compare-compact-metrics">' +
        formatCompactComparisonMetrics(estA, { omitCompetition: true }) +
        '</p>' +
        reasonHtml +
        '</div>'
      );
    }

    // Duplicado exacto legítimo (variantes distintas, métricas iguales vía LLM signal).
    if (exactDup) {
      const statusA =
        estA && estA.classificationStatus != null
          ? String(estA.classificationStatus)
          : '';
      const statusB =
        estB && estB.classificationStatus != null
          ? String(estB.classificationStatus)
          : '';
      const statusesDiffer = statusA !== statusB;
      let classBadgesHtml = '';
      if (statusesDiffer) {
        const badgeA = renderDiscoveryClassificationBadge(estA);
        const badgeB = renderDiscoveryClassificationBadge(estB);
        const parts = [];
        if (badgeA) {
          parts.push(
            '<span class="cpc-compare-dup-status-pair">' +
              '<span class="cpc-compare-dup-status-term">' +
              escapeHtml(termA) +
              '</span> ' +
              badgeA +
              '</span>',
          );
        }
        if (badgeB) {
          parts.push(
            '<span class="cpc-compare-dup-status-pair">' +
              '<span class="cpc-compare-dup-status-term">' +
              escapeHtml(termB) +
              '</span> ' +
              badgeB +
              '</span>',
          );
        }
        classBadgesHtml = parts.length
          ? '<div class="cpc-compare-compact-badges">' +
            parts.join(' ') +
            '</div>'
          : '';
      } else {
        const classBadge =
          renderDiscoveryClassificationBadge(estA) ||
          renderDiscoveryClassificationBadge(estB);
        classBadgesHtml = classBadge ? ' ' + classBadge : '';
      }
      return (
        '<div class="cov-draft-card cpc-compare-card cpc-compare-exact-dup">' +
        '<div class="cov-draft-main">' +
        relBadge +
        (statusesDiffer ? '' : classBadgesHtml) +
        '</div>' +
        (statusesDiffer ? classBadgesHtml : '') +
        '<p class="cpc-compare-dup-title">Duplicado exacto — ' +
        escapeHtml(termA) +
        ' ↔ ' +
        escapeHtml(termB) +
        '</p>' +
        '<p class="cpc-compare-compact-metrics">' +
        formatCompactComparisonMetrics(estA || estB) +
        '</p>' +
        '<p class="cpc-compare-action">🔁 Consolidar</p>' +
        reasonHtml +
        '</div>'
      );
    }

    // Comparación side-by-side (related / preferred / etc.).
    const headHtml = relBadge;
    const actionHtml = pref
      ? '<p class="cpc-compare-action">🎯 Priorizar <strong>' +
        escapeHtml(pref) +
        '</strong></p>'
      : '';

    const thA = renderComparisonTermColumnHead(termA, estA, pref === termA);
    const thB = renderComparisonTermColumnHead(termB, estB, pref === termB);

    return (
      '<div class="cov-draft-card cpc-compare-card">' +
      '<div class="cov-draft-main">' +
      headHtml +
      '</div>' +
      actionHtml +
      '<table class="ga4-table cpc-compare-table">' +
      '<thead><tr><th></th><th>' +
      thA +
      '</th><th>' +
      thB +
      '</th></tr></thead>' +
      '<tbody>' +
      '<tr><td class="text-muted">Volumen</td><td class="ga4-num">' +
      renderComparisonMetricCell(estA, 'vol') +
      '</td><td class="ga4-num">' +
      renderComparisonMetricCell(estB, 'vol') +
      '</td></tr>' +
      '<tr><td class="text-muted">Competencia</td><td>' +
      renderComparisonMetricCell(estA, 'comp') +
      '</td><td>' +
      renderComparisonMetricCell(estB, 'comp') +
      '</td></tr>' +
      '<tr><td class="text-muted">Eficiencia</td><td class="ga4-num">' +
      escapeHtml(renderComparisonMetricCell(estA, 'eff')) +
      '</td><td class="ga4-num">' +
      escapeHtml(renderComparisonMetricCell(estB, 'eff')) +
      '</td></tr>' +
      '</tbody></table>' +
      reasonHtml +
      '</div>'
    );
  }

  function renderComparisonGroup(title, items) {
    if (!items.length) return '';
    return (
      '<h4 class="cpc-run-analysis-subtitle">' +
      escapeHtml(title) +
      '</h4>' +
      items.map(renderComparisonCard).join('')
    );
  }

  function renderCpcRunAnalysis(el, summary, sourceLabel) {
    if (!el) return;
    if (!summary) {
      el.hidden = true;
      el.innerHTML = '';
      el.__mieCpcSummary = null;
      el.__mieCpcSourceLabel = null;
      return;
    }
    el.__mieCpcSummary = summary;
    el.__mieCpcSourceLabel = sourceLabel;
    const comps = Array.isArray(summary.comparativeAnalysis)
      ? summary.comparativeAnalysis
      : [];
    const suggestions = Array.isArray(summary.suggestedNewTerms)
      ? summary.suggestedNewTerms
      : [];
    const visibleSuggestions = suggestions.filter(function (s) {
      const key = String(s.term || '').trim().toLowerCase();
      return !hiddenMeasuredSuggestionKeys.has(key);
    });
    const when = summary.generatedAt
      ? String(summary.generatedAt).slice(0, 16).replace('T', ' ')
      : '—';

    const exactDups = [];
    const related = [];
    comps.forEach(function (c) {
      if (isExactDuplicateComparison(c)) exactDups.push(c);
      else related.push(c);
    });
    const compsHtml = comps.length
      ? renderComparisonGroup('🔁 Duplicados exactos', exactDups) +
        renderComparisonGroup('🔀 Términos relacionados', related)
      : '<p class="text-muted cpc-run-analysis-empty">Sin relaciones comparativas destacadas en esta corrida.</p>';

    const suggHtml = visibleSuggestions.length
      ? '<ul class="cpc-run-analysis-list cpc-unmeasured-list">' +
        visibleSuggestions
          .map(function (s, idx) {
            const related = Array.isArray(s.related_to_terms)
              ? s.related_to_terms
              : Array.isArray(s.relatedToTerms)
                ? s.relatedToTerms
                : [];
            const relatedNote = related.length
              ? ' <span class="text-muted">(relacionado a: ' +
                escapeHtml(related.join(', ')) +
                ')</span>'
              : '';
            return (
              '<li class="cpc-unmeasured-item">' +
              '<div class="cov-term-row">' +
              '<strong class="cov-term-text">' +
              escapeHtml(s.term || '') +
              '</strong>' +
              '<button type="button" class="btn cov-copy-term-btn cpc-suggest-copy-btn" data-suggest-idx="' +
              idx +
              '" title="Copiar término">Copiar</button>' +
              '<button type="button" class="btn cov-copy-term-btn cpc-suggest-measure-btn" data-suggest-idx="' +
              idx +
              '" title="Medir con Keyword Planner">Medir ahora</button>' +
              '</div>' +
              '<div class="text-muted">' +
              escapeHtml(s.reason || '') +
              relatedNote +
              '</div>' +
              '</li>'
            );
          })
          .join('') +
        '</ul>'
      : '<p class="text-muted cpc-run-analysis-empty">Sin sugerencias nuevas en esta corrida.</p>';

    const measureFeedbackHtml = cpcMeasureFeedback
      ? '<p class="cpc-measure-feedback' +
        (cpcMeasureFeedback.isError ? ' mcl-error' : '') +
        '">' +
        escapeHtml(cpcMeasureFeedback.text) +
        '</p>'
      : '';

    el.hidden = false;
    el.innerHTML =
      '<div class="cpc-run-analysis-head">' +
      '<strong>Análisis Claude</strong> · ' +
      escapeHtml(sourceLabel || '') +
      ' · corrida ' +
      escapeHtml(String(summary.syncRunId || '').slice(0, 8)) +
      '… · ' +
      escapeHtml(when) +
      '</div>' +
      renderAnalysisSummaryHtml(summary.summaryText) +
      '<h3 class="cpc-run-analysis-subtitle">Comparativo</h3>' +
      compsHtml +
      '<h3 class="cpc-run-analysis-subtitle">Sugerencias sin medir</h3>' +
      '<p class="text-muted cpc-unmeasured-disclaimer">Hipótesis para medir después con Keyword Planner. Aún no tienen CPC, volumen ni competencia.</p>' +
      measureFeedbackHtml +
      suggHtml;

    el.querySelectorAll('.cpc-suggest-copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const idx = Number(btn.getAttribute('data-suggest-idx'));
        const item = visibleSuggestions[idx];
        if (!item) return;
        copyDiscoveryTerm(item.term, btn);
      });
    });
    el.querySelectorAll('.cpc-suggest-measure-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        measureSuggestedTermNow(btn, visibleSuggestions);
      });
    });
  }

  window.__mieRenderCpcRunAnalysis = renderCpcRunAnalysis;
  window.__mieCopyDiscoveryTerm = copyDiscoveryTerm;

  async function loadDiscoveredRunAnalysis() {
    if (!runAnalysisEl) return;
    try {
      const res = await fetch(
        API_BASE +
          '/reports/sync-run-summaries?sourceTable=discovered_term_cpc_estimates',
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      const summary = body && body.summary ? body.summary : null;
      if (summary) {
        covState.analysisSyncRunId =
          summary.syncRunId != null ? String(summary.syncRunId) : null;
        covState.analysisEstimatesByTerm =
          summary.estimatesByTerm &&
          typeof summary.estimatesByTerm === 'object' &&
          !Array.isArray(summary.estimatesByTerm)
            ? summary.estimatesByTerm
            : {};
      } else {
        covState.analysisSyncRunId = null;
        covState.analysisEstimatesByTerm = null;
      }
      renderCpcRunAnalysis(runAnalysisEl, summary, 'Pendientes / Trends');
    } catch (err) {
      covState.analysisSyncRunId = null;
      covState.analysisEstimatesByTerm = null;
      renderCpcRunAnalysis(runAnalysisEl, null);
    }
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
            : s.queryType === 'serp_monitored'
              ? '📥 Query SERP · candidato a landing'
              : `${s.queryType === 'rising' ? '📈 Rising' : '🔝 Top'} · ${escapeHtml(
                  s.formattedValue || String(s.score ?? '—'),
                )} · seed: ${escapeHtml(s.seed)}`;
        const covered = s.alreadyCovered
          ? `<span class="cov-badge is-covered" title="Ya existe en monitored_entities: ${escapeHtml(
              (s.coveredByEntity && s.coveredByEntity.name) || '',
            )}">ya monitoreada</span>`
          : '';
        const selected = covState.decisions[s.term] || '';
        const alreadySerp = Boolean(s.alreadyMonitoredInSerp);
        return `
          <tr>
            <td class="cov-term">
              <div class="cov-term-row">
                <span class="cov-term-text">${escapeHtml(s.term)}</span>
                <button type="button" class="btn cov-copy-term-btn" data-cov-idx="${idx}" title="Copiar término">Copiar</button>
                <button type="button" class="btn cov-copy-term-btn cov-serp-monitor-btn" data-cov-idx="${idx}"${
                  alreadySerp ? ' disabled' : ''
                } title="${alreadySerp ? 'Ya en SERP' : 'Agregar a monitoreo SERP'}">${
                  alreadySerp ? 'Ya en SERP' : 'Monitorear SERP'
                }</button>
              </div>
              ${renderDiscoveryCpcMeta(s.cpcEstimate || null)}
            </td>
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

    suggestionsEl.querySelectorAll('.cov-copy-term-btn:not(.cov-serp-monitor-btn)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-cov-idx'));
        const suggestion = covState.suggestions[idx];
        if (!suggestion) return;
        copyDiscoveryTerm(suggestion.term, btn);
      });
    });

    suggestionsEl.querySelectorAll('.cov-serp-monitor-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        addPendingTermToSerp(btn);
      });
    });

    applyBtn.disabled = covState.applying || !Object.keys(covState.decisions).length;
  }

  function setCovStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function suggestionMeasureKey(term) {
    return String(term || '').trim().toLowerCase();
  }

  async function refreshPendingSuggestionsPreserveUi() {
    const res = await fetch(
      API_BASE + '/reports/search-discoveries?view=pending',
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const prev = covState.decisions || {};
    covState.suggestions = Array.isArray(body.suggestions)
      ? body.suggestions
      : [];
    const keep = {};
    covState.suggestions.forEach(function (s) {
      if (s && s.term && prev[s.term]) keep[s.term] = prev[s.term];
    });
    covState.decisions = keep;
    const count = covState.suggestions.length;
    statusEl.textContent = count
      ? count + ' sugerencias pendientes de decisión'
      : '';
    renderSuggestions();
  }

  function rerenderCpcRunAnalysisPanels() {
    document.querySelectorAll('.cpc-run-analysis').forEach(function (node) {
      if (!node || !node.__mieCpcSummary) return;
      renderCpcRunAnalysis(
        node,
        node.__mieCpcSummary,
        node.__mieCpcSourceLabel,
      );
    });
  }

  function formatSerpCreateOutcome(body) {
    const planner = body && body.plannerStatus === 'ok' ? 'ok' : 'error';
    const serper = body && body.serperStatus === 'ok' ? 'ok' : 'error';
    let msg = 'Query agregada. CPC: ' + planner + '. SERP: ' + serper;
    if (planner === 'ok' && serper === 'ok') return msg + '.';
    const bits = [];
    if (planner !== 'ok' && body && body.plannerError) {
      bits.push(String(body.plannerError));
    }
    if (serper !== 'ok' && body && body.serperError) {
      bits.push(String(body.serperError));
    }
    if (bits.length) return msg + ' (' + bits.join('; ') + ').';
    return msg + ' (ver logs).';
  }

  async function measureSuggestedTermNow(btn, visibleSuggestions) {
    if (!btn || btn.disabled) return;
    const idx = Number(btn.getAttribute('data-suggest-idx'));
    const item = visibleSuggestions && visibleSuggestions[idx];
    if (!item || !item.term) return;
    const term = String(item.term);
    const ok = window.confirm(
      '¿Medir «' + term + '» ahora con Keyword Planner?\n\nEsto puede tardar hasta un minuto.',
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = 'Midiendo…';
    cpcMeasureFeedback = {
      isError: false,
      text: 'Midiendo «' + term + '»… esto puede tardar hasta un minuto.',
    };
    const feedbackEl = btn.closest('.cpc-run-analysis');
    if (feedbackEl) {
      let note = feedbackEl.querySelector('.cpc-measure-feedback');
      if (!note) {
        note = document.createElement('p');
        note.className = 'cpc-measure-feedback';
        const disclaimer = feedbackEl.querySelector('.cpc-unmeasured-disclaimer');
        if (disclaimer && disclaimer.parentNode) {
          disclaimer.parentNode.insertBefore(note, disclaimer.nextSibling);
        } else {
          feedbackEl.appendChild(note);
        }
      }
      note.classList.remove('mcl-error');
      note.textContent = cpcMeasureFeedback.text;
    }
    try {
      const res = await fetch(
        API_BASE + '/reports/search-discoveries/measure-suggestion',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            term: term,
            reason: item.reason || undefined,
          }),
        },
      );
      const body = await res.json().catch(function () {
        return {};
      });
      if (res.ok && body && body.ok === true && body.measured === true) {
        hiddenMeasuredSuggestionKeys.add(suggestionMeasureKey(term));
        cpcMeasureFeedback = {
          isError: false,
          text: 'Medido «' + term + '» — buscalo en Pendientes',
        };
        try {
          await refreshPendingSuggestionsPreserveUi();
        } catch (refreshErr) {
          cpcMeasureFeedback = {
            isError: false,
            text:
              'Medido «' +
              term +
              '» — recargá Pendientes si no aparece en la lista',
          };
        }
        rerenderCpcRunAnalysisPanels();
        return;
      }
      cpcMeasureFeedback = {
        isError: true,
        text:
          body && body.error
            ? String(body.error)
            : 'No se pudo medir el término.',
      };
      rerenderCpcRunAnalysisPanels();
    } catch (err) {
      cpcMeasureFeedback = {
        isError: true,
        text:
          err && err.message ? err.message : 'No se pudo medir el término.',
      };
      rerenderCpcRunAnalysisPanels();
    }
  }

  async function addPendingTermToSerp(btn) {
    if (!btn || btn.disabled) return;
    const idx = Number(btn.getAttribute('data-cov-idx'));
    const suggestion = covState.suggestions[idx];
    if (!suggestion || !suggestion.term) return;
    const term = String(suggestion.term);
    const ok = window.confirm(
      '¿Agregar «' + term + '» a monitoreo SERP?\n\nEl término sigue pendiente de decisión acá.',
    );
    if (!ok) return;

    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Agregando y midiendo…';
    setCovStatus(
      'Agregando y midiendo… esto puede tardar hasta un minuto',
      false,
    );
    try {
      const res = await fetch(API_BASE + '/reports/serp-queries', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ queryText: term }),
      });
      const body = await res.json().catch(function () {
        return {};
      });
      if (res.status === 201) {
        suggestion.alreadyMonitoredInSerp = true;
        setCovStatus(formatSerpCreateOutcome(body), false);
        if (typeof window.__loadSerpQueries === 'function') {
          window.__loadSerpQueries();
        }
        return;
      }
      if (res.status === 409 && body && body.code === 'QUERY_DUPLICATE') {
        suggestion.alreadyMonitoredInSerp = true;
        setCovStatus('Ya se está monitoreando este término en SERP', false);
        return;
      }
      throw new Error(
        body && body.error
          ? String(body.error)
          : 'No se pudo agregar a monitoreo SERP.',
      );
    } catch (err) {
      setCovStatus(
        err && err.message
          ? err.message
          : 'No se pudo agregar a monitoreo SERP.',
        true,
      );
    } finally {
      if (suggestion.alreadyMonitoredInSerp) {
        btn.disabled = true;
        btn.textContent = 'Ya en SERP';
        btn.title = 'Ya en SERP';
      } else {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    }
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
          <div class="cov-draft-card" data-draft-card="${escapeHtml(d.id)}">
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
            <label class="cov-regen-instructions">
              <span class="cov-regen-instructions-label">Instrucciones para esta regeneración (opcional)</span>
              <textarea
                class="input cov-regen-instructions-input"
                rows="5"
                data-draft-id="${escapeHtml(d.id)}"
                placeholder="Instrucciones para esta regeneración (opcional): describí los cambios específicos que necesitás"
              ></textarea>
            </label>
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
    const card = btn.closest('.cov-draft-card');
    const instructionsEl = card
      ? card.querySelector('.cov-regen-instructions-input')
      : null;
    const customInstructions = instructionsEl
      ? String(instructionsEl.value || '').trim()
      : '';
    btn.disabled = true;
    btn.textContent = 'Regenerando…';
    try {
      const res = await fetch(
        `${API_BASE}/reports/seo-landing-drafts/${encodeURIComponent(draftId)}/regenerate`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            customInstructions ? { customInstructions } : {},
          ),
        },
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
      loadDiscoveredRunAnalysis();
    } catch (err) {
      statusEl.textContent = 'No se pudieron cargar las sugerencias.';
      suggestionsEl.innerHTML = '';
      covState.analysisSyncRunId = null;
      covState.analysisEstimatesByTerm = null;
      if (runAnalysisEl) {
        runAnalysisEl.hidden = true;
        runAnalysisEl.innerHTML = '';
      }
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

  function coveredEntityId(suggestion) {
    if (!suggestion || !suggestion.alreadyCovered) return null;
    const id = suggestion.coveredByEntity && suggestion.coveredByEntity.id;
    return id ? String(id) : null;
  }

  function decideTermType(term, suggestion) {
    if (suggestion && suggestion.termType === 'competitor_candidate') {
      return 'competitor_candidate';
    }
    if (suggestion && suggestKind(term).cls === 'is-brand') {
      return 'competitor_candidate';
    }
    return 'generic';
  }

  function promptCompetitorWizard(terms) {
    return new Promise((resolve) => {
      const host = document.getElementById('mie-dashboard-app') || document.body;
      const previous = document.getElementById('cov-competitor-wizard-root');
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

      const root = document.createElement('div');
      root.id = 'cov-competitor-wizard-root';
      host.appendChild(root);

      const draftsByTerm = Object.create(null);
      let step = 0;
      let formError = '';
      let settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        covState.cancelWizard = null;
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve(result);
      }

      covState.cancelWizard = function cancelWizard() {
        finish(null);
      };

      function readForm(form) {
        const fd = new FormData(form);
        return {
          name: String(fd.get('name') || ''),
          segment: String(fd.get('segment') || ''),
          adLibraryUrl: String(fd.get('adLibraryUrl') || ''),
          websiteDomain: String(fd.get('websiteDomain') || ''),
        };
      }

      function renderStep() {
        const term = terms[step];
        const saved = draftsByTerm[term];
        const values = saved || {
          name: term,
          segment: 'prestamos',
          adLibraryUrl: '',
          websiteDomain: hostnamePrefillFromTerm(term),
        };
        const total = terms.length;
        const isLast = step === total - 1;
        const segmentOptions = ENTITY_SEGMENT_OPTIONS.map((opt) => {
          const selected = opt.value === values.segment ? ' selected' : '';
          return (
            '<option value="' +
            escapeHtml(opt.value) +
            '"' +
            selected +
            '>' +
            escapeHtml(opt.label) +
            '</option>'
          );
        }).join('');
        const errorHtml = formError
          ? '<div class="ad-modal-error">' + escapeHtml(formError) + '</div>'
          : '';

        root.innerHTML =
          '<div class="ad-modal-backdrop" data-action="cov-wizard-cancel" role="presentation">' +
          '<div class="ad-modal" role="dialog" aria-modal="true" aria-labelledby="cov-wizard-title">' +
          '<div class="ad-modal-header">' +
          '<h3 class="ad-modal-title" id="cov-wizard-title">Alta de competidor ' +
          (step + 1) +
          ' de ' +
          total +
          '</h3>' +
          '<button type="button" class="ad-modal-close" data-action="cov-wizard-cancel" aria-label="Cancelar">' +
          '<i class="ti ti-x" aria-hidden="true"></i>' +
          '</button>' +
          '</div>' +
          '<p class="cov-wizard-term">Término: <strong>' +
          escapeHtml(term) +
          '</strong></p>' +
          '<form id="cov-competitor-wizard-form" class="entity-form">' +
          '<label class="mcl-field entity-form-field" for="cov-wizard-name">' +
          '<span class="mcl-field-label">Nombre</span>' +
          '<input class="mcl-input" type="text" name="name" id="cov-wizard-name" value="' +
          escapeHtml(values.name) +
          '" required autocomplete="organization" placeholder="Ej. Credifast" />' +
          '</label>' +
          '<label class="mcl-field entity-form-field" for="cov-wizard-segment">' +
          '<span class="mcl-field-label">Categoría</span>' +
          '<select class="mcl-select" name="segment" id="cov-wizard-segment">' +
          segmentOptions +
          '</select>' +
          '</label>' +
          '<label class="mcl-field entity-form-field" for="cov-wizard-url">' +
          '<span class="mcl-field-label">Ad Library URL</span>' +
          '<input class="mcl-input" type="url" name="adLibraryUrl" id="cov-wizard-url" value="' +
          escapeHtml(values.adLibraryUrl) +
          '" required placeholder="https://www.facebook.com/ads/library/..." />' +
          '</label>' +
          '<label class="mcl-field entity-form-field" for="cov-wizard-website-domain">' +
          '<span class="mcl-field-label">Dominio web (opcional, match SERP)</span>' +
          '<input class="mcl-input" type="text" name="websiteDomain" id="cov-wizard-website-domain" value="' +
          escapeHtml(values.websiteDomain || '') +
          '" placeholder="ej. alprestamo.uy" autocomplete="off" />' +
          '</label>' +
          errorHtml +
          '<div class="ad-modal-actions cov-wizard-actions">' +
          '<button type="button" class="btn" data-action="cov-wizard-cancel">Cancelar</button>' +
          '<button type="submit" class="btn btn-primary">' +
          (isLast ? 'Continuar y aplicar' : 'Siguiente') +
          '</button>' +
          '</div>' +
          '</form>' +
          '</div>' +
          '</div>';

        const backdrop = root.querySelector('.ad-modal-backdrop');
        const modal = root.querySelector('.ad-modal');
        const form = root.querySelector('#cov-competitor-wizard-form');
        if (!form) return;
        if (modal) {
          modal.addEventListener('click', (ev) => ev.stopPropagation());
        }
        if (backdrop) {
          backdrop.addEventListener('click', (ev) => {
            if (ev.target === backdrop) finish(null);
          });
        }
        root.querySelectorAll('[data-action="cov-wizard-cancel"]').forEach((el) => {
          if (el === backdrop) return;
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            finish(null);
          });
        });
        form.addEventListener('submit', (ev) => {
          ev.preventDefault();
          const raw = readForm(form);
          const checked = validateMonitoredEntityFields(raw);
          if (!checked.ok) {
            formError = checked.error;
            draftsByTerm[term] = raw;
            renderStep();
            return;
          }
          formError = '';
          draftsByTerm[term] = {
            name: checked.name,
            segment: checked.segment,
            adLibraryUrl: checked.adLibraryUrl,
            websiteDomain: checked.websiteDomain || '',
          };
          if (step + 1 >= total) {
            finish(draftsByTerm);
            return;
          }
          step += 1;
          renderStep();
        });

        const urlInput = form.querySelector('#cov-wizard-url');
        if (urlInput) urlInput.focus();
      }

      renderStep();
    });
  }

  function resetApplyUi() {
    covState.applying = false;
    applyBtn.textContent = 'Aplicar decisiones';
    applyBtn.disabled = !Object.keys(covState.decisions).length;
  }

  async function applyDecisions() {
    const entries = Object.entries(covState.decisions);
    if (!entries.length || covState.applying) return;

    const needWizard = entries
      .filter(([, decision]) => decision === 'added_as_competitor')
      .map(([term]) => term)
      .filter((term) => {
        const suggestion = covState.suggestions.find((s) => s.term === term);
        return !coveredEntityId(suggestion);
      });

    covState.applying = true;
    applyBtn.disabled = true;
    applyBtn.textContent = needWizard.length ? 'Alta de competidores…' : 'Aplicando…';
    feedbackEl.textContent = '';
    renderSuggestions();

    try {
      let draftsByTerm = Object.create(null);
      if (needWizard.length) {
        const drafts = await promptCompetitorWizard(needWizard);
        if (!drafts) {
          feedbackEl.textContent =
            'No se aplicó ninguna decisión (alta de competidores cancelada).';
          return;
        }
        draftsByTerm = drafts;
      }

      applyBtn.textContent = 'Aplicando…';

      let ok = 0;
      let failed = 0;
      let createdCount = 0;
      let landingsStarted = 0;
      const extraNotes = [];

      for (const [term, decision] of entries) {
        const suggestion = covState.suggestions.find((s) => s.term === term);
        let entityId = null;
        let createdThis = false;

        if (decision === 'added_as_competitor') {
          entityId = coveredEntityId(suggestion);
          if (!entityId) {
            const draft = draftsByTerm[term];
            if (!draft) {
              failed += 1;
              extraNotes.push('«' + term + '» sin datos de alta');
              continue;
            }
            try {
              const row = await createMonitoredEntity(draft);
              entityId = row && row.id != null ? String(row.id) : '';
              if (!entityId) throw new Error('Sin id de entidad');
              createdThis = true;
              createdCount += 1;
            } catch (err) {
              failed += 1;
              extraNotes.push(
                '«' +
                  term +
                  '» no se creó el competidor' +
                  (err && err.message ? ': ' + err.message : ''),
              );
              continue;
            }
          }
        }

        try {
          const payload = {
            term,
            decision,
            termType: decideTermType(term, suggestion),
            sourceSeed:
              suggestion && suggestion.sourceSeed
                ? suggestion.sourceSeed
                : suggestion
                  ? suggestion.seed
                  : null,
            discoveredScore: suggestion ? suggestion.score : null,
          };
          if (entityId) payload.entityId = entityId;
          const res = await fetch(`${API_BASE}/reports/coverage-suggestions/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          ok += 1;
          if (body.landingGeneration === 'started') landingsStarted += 1;
        } catch (err) {
          failed += 1;
          if (createdThis) {
            extraNotes.push('«' + term + '» creado pero la decisión no se registró');
          }
        }
      }

      const parts = [
        `${ok} decisión(es) registradas`,
        `${createdCount} competidor(es) creados`,
        `${failed} fallaron`,
      ];
      if (landingsStarted) {
        parts.push(
          `${landingsStarted} borrador(es) de landing en generación — aparecerán abajo en "Borradores de landing SEO" en unos segundos`,
        );
        schedulePoll();
      }
      feedbackEl.textContent = extraNotes.length
        ? parts.join(' · ') + ' · ' + extraNotes.join('; ')
        : parts.join(' · ');

      if (createdCount) {
        try {
          await loadIntensityGauges(state.selectedDate);
        } catch (ignore) {
          /* gauges are independent of the decision batch */
        }
      }
      await loadSuggestions();
      await loadDrafts();
    } finally {
      resetApplyUi();
      if (covState.suggestions.length) renderSuggestions();
    }
  }

  applyBtn.addEventListener('click', applyDecisions);

  // Loading and teardown are driven by the unified discoveries controller.
  window.__discPending = {
    load: () => {
      loadSuggestions();
      loadDrafts();
    },
    stop: () => {
      if (typeof covState.cancelWizard === 'function') {
        covState.cancelWizard();
      }
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
  const serpList = document.getElementById('kw-serp-list');
  const serpColumn = document.getElementById('kw-serp-column');
  const columnsEl = document.getElementById('kw-columns');

  if (!statusEl || !seedFilter || !topList || !risingList || !serpList || !serpColumn) {
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

  /** SERP unmatched domains (queryType=serp) — no Trends score/growth UI. */
  function renderSerpColumn() {
    const rows = filteredRows('serp').sort((a, b) =>
      String(a.term || '').localeCompare(String(b.term || ''), 'es'),
    );
    if (!rows.length) {
      serpColumn.hidden = true;
      if (columnsEl) columnsEl.classList.remove('has-serp-column');
      serpList.innerHTML = '';
      return;
    }
    serpColumn.hidden = false;
    if (columnsEl) columnsEl.classList.add('has-serp-column');
    serpList.innerHTML = rows
      .map(
        (r) => `
        <div class="kw-row">
          <div class="kw-row-main">
            <span class="kw-term">${escapeHtml(r.term)}</span>
            ${decisionBadgeFor(r)}
          </div>
          <div class="kw-row-meta">seed: ${escapeHtml(r.seed)} · candidato a competidor (SERP)</div>
        </div>`,
      )
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
    renderSerpColumn();
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
      const serpCount = kwState.keywords.filter(function (k) {
        return k && k.queryType === 'serp';
      }).length;
      statusEl.textContent = kwState.keywords.length
        ? `${kwState.keywords.length} términos descubiertos` +
          (serpCount ? ` · ${serpCount} dominios SERP sin matchear` : '')
        : 'Sin datos de discovery todavía — corré el discovery refresh primero.';
      renderAll();
    } catch (err) {
      statusEl.textContent = 'No se pudieron cargar los términos.';
      topList.innerHTML = '';
      risingList.innerHTML = '';
      serpList.innerHTML = '';
      serpColumn.hidden = true;
      if (columnsEl) columnsEl.classList.remove('has-serp-column');
    }
  }

  seedFilter.addEventListener('change', () => {
    kwState.seed = seedFilter.value;
    renderTopColumn();
    renderRisingColumn();
    renderSerpColumn();
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

  function formatInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('es-UY');
  }

  function emptySummary() {
    return {
      total_sessions: 0,
      total_users: 0,
      total_key_events: 0,
      overall_conversion_rate: 0,
      by_channel: [],
      true_unique_users: null,
    };
  }

  function topChannelsWithOthers(byChannel) {
    const rows = Array.isArray(byChannel) ? byChannel.slice() : [];
    if (rows.length <= 6) return rows;
    const top = rows.slice(0, 6);
    const rest = rows.slice(6);
    const others = {
      channel: 'Otros',
      sessions: 0,
      users: 0,
      key_events: 0,
      percentage: 0,
    };
    rest.forEach(function (row) {
      others.sessions += Number(row.sessions) || 0;
      others.users += Number(row.users) || 0;
      others.key_events += Number(row.key_events) || 0;
      others.percentage += Number(row.percentage) || 0;
    });
    others.percentage = Math.round(others.percentage * 100) / 100;
    top.push(others);
    return top;
  }

  function renderGa4Summary(summary) {
    const s = summary && typeof summary === 'object' ? summary : emptySummary();
    const wrap = document.createElement('section');
    wrap.className = 'ga4-summary';
    wrap.innerHTML = '<h2 class="section-title">Resumen del rango</h2>';

    if (!Number(s.total_sessions)) {
      const empty = document.createElement('div');
      empty.className = 'mcl-empty';
      empty.textContent = 'Sin datos en este rango';
      wrap.appendChild(empty);
      return wrap;
    }

    const cards = document.createElement('div');
    cards.className = 'kpi-grid ga4-summary-kpis';
    cards.innerHTML =
      '<div class="kpi-card is-accent">' +
      '<div class="kpi-value">' +
      escapeHtml(formatInt(s.total_sessions)) +
      '</div>' +
      '<div class="kpi-label">🖱️ Sesiones totales</div>' +
      '<div class="ga4-summary-note text-muted">' +
      'Cada visita cuenta aparte, aunque sea la misma persona en otro momento.' +
      '</div>' +
      '</div>' +
      '<div class="kpi-card is-neutral">' +
      '<div class="kpi-value">' +
      escapeHtml(formatInt(s.total_users)) +
      '</div>' +
      '<div class="kpi-label">👤 Usuarios (estimado)</div>' +
      '<div class="ga4-summary-note text-muted">' +
      'Suma de total_users por fila (día × canal × landing × source × medium). No son usuarios únicos.' +
      '</div>' +
      '</div>' +
      '<div class="kpi-card is-success">' +
      '<div class="kpi-value">' +
      escapeHtml(formatInt(s.total_key_events)) +
      '</div>' +
      '<div class="kpi-label">🎯 Key Events totales</div>' +
      '<div class="ga4-summary-note text-muted">' +
      'Veces que alguien completó una acción marcada como conversión (ej. envío de solicitud).' +
      '</div>' +
      '</div>' +
      '<div class="kpi-card is-warn">' +
      '<div class="kpi-value">' +
      escapeHtml(
        Number.isFinite(Number(s.overall_conversion_rate))
          ? Number(s.overall_conversion_rate).toFixed(2) + '%'
          : '—',
      ) +
      '</div>' +
      '<div class="kpi-label">📈 Tasa de conversión</div>' +
      '<div class="ga4-summary-note text-muted">' +
      'Key Events dividido sesiones — no es lo mismo que usuarios ni que leads.' +
      '</div>' +
      '</div>' +
      '<div class="kpi-card is-info">' +
      '<div class="kpi-value">' +
      escapeHtml(
        s.true_unique_users === null || s.true_unique_users === undefined
          ? '—'
          : formatInt(s.true_unique_users),
      ) +
      '</div>' +
      '<div class="kpi-label">🧍 Usuarios únicos según GA4</div>' +
      '<div class="ga4-summary-note text-muted">' +
      (s.true_unique_users === null || s.true_unique_users === undefined
        ? 'No se pudo consultar en este momento.'
        : Number(s.true_unique_users) === 0
          ? 'Sin tráfico único registrado en este rango.'
          : 'Consultado en vivo a GA4, deduplicado según su identidad de usuario — la referencia más confiable para comparar contra sesiones.') +
      '</div>' +
      '</div>';
    wrap.appendChild(cards);

    const channels = topChannelsWithOthers(s.by_channel);
    if (channels.length) {
      const list = document.createElement('div');
      list.className = 'ga4-channel-breakdown';
      list.innerHTML =
        '<h3 class="ga4-channel-title">Desglose por canal</h3>' +
        channels
          .map(function (row) {
            const pct = Number(row.percentage) || 0;
            const color = colorForString(row.channel);
            return (
              '<div class="ga4-channel-row">' +
              '<div class="ga4-channel-meta">' +
              '<span class="ga4-channel-name">' +
              escapeHtml(row.channel || 'Unassigned') +
              '</span>' +
              '<span class="ga4-channel-stats text-muted">' +
              escapeHtml(formatInt(row.sessions)) +
              ' sesiones · ' +
              escapeHtml(pct.toFixed(2) + '%') +
              '</span></div>' +
              '<div class="ga4-channel-bar-track">' +
              '<div class="ga4-channel-bar-fill" style="width:' +
              escapeHtml(String(Math.max(0, Math.min(100, pct)))) +
              '%;background:' +
              escapeHtml(color) +
              '"></div></div></div>'
            );
          })
          .join('');
      wrap.appendChild(list);
    }

    return wrap;
  }

  function renderTable(rows, targetEl) {
    const host = targetEl || resultsEl;
    host.innerHTML = '';
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
    host.appendChild(table);
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
      resultsEl.innerHTML = '';
      resultsEl.appendChild(
        renderGa4Summary(
          body && body.summary && typeof body.summary === 'object'
            ? body.summary
            : emptySummary(),
        ),
      );

      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'mcl-empty';
        empty.textContent = body.firstAvailableDate
          ? 'Sin filas para este rango — la captura arrancó el ' +
            body.firstAvailableDate +
            '.'
          : 'Todavía no hay datos capturados.';
        resultsEl.appendChild(empty);
        setStatus('', false);
        return;
      }

      const tableHost = document.createElement('div');
      tableHost.className = 'ga4-table-host';
      resultsEl.appendChild(tableHost);
      renderTable(rows, tableHost);
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
  const importsToggleBtn = document.getElementById('serp-imports-toggle');
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
  const queriesStatusEl = document.getElementById('serp-queries-status');
  const queriesListEl = document.getElementById('serp-queries-list');
  const serpRunAnalysisEl = document.getElementById('serp-run-analysis');
  const queryForm = document.getElementById('serp-query-form');
  const queryInput = document.getElementById('serp-query-input');
  const queryAddBtn = document.getElementById('serp-query-add-btn');
  const historyQueryFilter = document.getElementById(
    'serp-history-query-filter',
  );
  const entityPresenceStatusEl = document.getElementById(
    'serp-entity-presence-status',
  );
  const entityPresenceSummaryEl = document.getElementById(
    'serp-entity-presence-summary',
  );
  const entityPresenceChartWrap = document.getElementById(
    'serp-entity-presence-chart-wrap',
  );
  const entityPresenceCanvas = document.getElementById(
    'serp-entity-presence-canvas',
  );
  const entityPresenceTogglesEl = document.getElementById(
    'serp-entity-presence-toggles',
  );
  const entityPresenceSelectAllBtn = document.getElementById(
    'serp-entity-presence-select-all',
  );
  const entityPresenceModeEl = document.getElementById(
    'serp-entity-presence-mode',
  );
  const entityPresenceFromInput = document.getElementById(
    'serp-entity-presence-from',
  );
  const entityPresenceToInput = document.getElementById(
    'serp-entity-presence-to',
  );

  if (!landing || !form) return;

  let selectedPath = null;
  let busy = false;
  let importsCache = [];
  let formExpanded = false;
  /** @type {File[]} Shared selection for picker + drag-and-drop. */
  let selectedFiles = [];
  let queriesBusy = false;
  let entityPresenceBusy = false;
  let entityPresenceChart = null;
  /** @type {Array<{id:string,name:string}>} */
  let entityPresenceCompetitors = [];
  /** Checked state per entity id. Default: unchecked (undefined/false). */
  let entityPresenceChecked = Object.create(null);
  /** @type {'ad'|'organic'|'both'} */
  let entityPresenceMode = 'ad';
  /** Cache: entityId → last presence payload for current query+date filter key. */
  let entityPresenceById = Object.create(null);
  let entityPresenceCacheKey = '';
  let entityPresenceRequestSeq = 0;

  /**
   * Same rules as backend normalizeSearchTerm — presentation filter only.
   * Collapses "prestamo  con cedula" vs catalog "prestamo con cedula".
   */
  function normalizeSerpTermForFilter(term) {
    if (term == null) return '';
    let s = String(term).trim().toLowerCase();
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function populateHistoryQueryFilter(queries) {
    if (!historyQueryFilter) return;
    const prev = historyQueryFilter.value || '';
    const rows = Array.isArray(queries) ? queries.slice() : [];
    rows.sort(function (a, b) {
      return String(a.queryText || '').localeCompare(
        String(b.queryText || ''),
        'es',
      );
    });
    historyQueryFilter.innerHTML =
      '<option value="">Todas</option>' +
      rows
        .map(function (q) {
          const norm =
            q.queryTextNormalized ||
            normalizeSerpTermForFilter(q.queryText);
          const label = q.queryText || norm || '—';
          return (
            '<option value="' +
            escapeHtml(norm) +
            '">' +
            escapeHtml(label) +
            '</option>'
          );
        })
        .join('');
    if (
      prev &&
      Array.prototype.some.call(historyQueryFilter.options, function (opt) {
        return opt.value === prev;
      })
    ) {
      historyQueryFilter.value = prev;
    } else {
      historyQueryFilter.value = '';
    }
  }

  function getFilteredImports() {
    const selectedNorm = historyQueryFilter
      ? String(historyQueryFilter.value || '').trim()
      : '';
    if (!selectedNorm) return importsCache.slice();
    return importsCache.filter(function (item) {
      return (
        normalizeSerpTermForFilter(item && item.searchTerm) === selectedNorm
      );
    });
  }

  function refreshImportsListView() {
    renderImportsList(getFilteredImports());
  }

  function setEntityPresenceStatus(text, isError) {
    if (!entityPresenceStatusEl) return;
    entityPresenceStatusEl.textContent = text || '';
    entityPresenceStatusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function getSelectedSearchTermNormalized() {
    return historyQueryFilter
      ? String(historyQueryFilter.value || '').trim()
      : '';
  }

  function destroyEntityPresenceChart() {
    if (entityPresenceChart) {
      entityPresenceChart.destroy();
      entityPresenceChart = null;
    }
  }

  function formatEntityPresenceAxisDate(ms) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('es-UY');
  }

  function formatEntityPresenceTooltipWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso);
    return d.toLocaleString('es-UY', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getEntityPresenceCheckedIds() {
    return entityPresenceCompetitors
      .map(function (ent) {
        return String(ent.id);
      })
      .filter(function (id) {
        return entityPresenceChecked[id] === true;
      });
  }

  function entityPresenceAllUnchecked(ids) {
    return (
      ids.length > 0 &&
      ids.every(function (id) {
        return entityPresenceChecked[id] !== true;
      })
    );
  }

  function syncEntityPresenceSelectAllButton() {
    if (!entityPresenceSelectAllBtn) return;
    const ids = entityPresenceCompetitors.map(function (ent) {
      return String(ent.id);
    });
    if (!ids.length) {
      entityPresenceSelectAllBtn.hidden = true;
      return;
    }
    entityPresenceSelectAllBtn.hidden = false;
    entityPresenceSelectAllBtn.textContent = entityPresenceAllUnchecked(ids)
      ? 'Seleccionar todos'
      : 'Deseleccionar todos';
  }

  function getEntityPresenceModeBlock(data, kind) {
    if (!data) return null;
    if (kind === 'organic') return data.organic;
    return data.ads;
  }

  function clearEntityPresenceView(message) {
    destroyEntityPresenceChart();
    if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = true;
    if (entityPresenceSummaryEl) {
      entityPresenceSummaryEl.innerHTML = '';
      entityPresenceSummaryEl.hidden = true;
    }
    setEntityPresenceStatus(message || '', false);
  }

  /**
   * Canonical timestamp for chart X and date filter: imported_at only.
   */
  function entityPresencePointTimeMs(p) {
    if (!p || !p.imported_at) return NaN;
    const ms = Date.parse(p.imported_at);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function chartPointsFromPresence(points, resultKind) {
    const list = Array.isArray(points) ? points : [];
    const out = [];
    list.forEach(function (p) {
      const ms = entityPresencePointTimeMs(p);
      const y = Number(p && p.position);
      if (!Number.isFinite(ms) || !Number.isFinite(y)) return;
      const count = Math.max(1, Number(p.appearance_count) || 1);
      out.push({
        x: ms,
        y: y,
        search_term: p.search_term || '',
        imported_at: p.imported_at || null,
        capture_id: p.capture_id || null,
        appearance_count: count,
        result_kind: resultKind || null,
      });
    });
    return out;
  }

  /**
   * Point radius from appearance_count. count=1 → 4 (previous fixed size);
   * grows with sqrt so multi-hit captures are visible without dominating.
   */
  function entityPresencePointRadius(count) {
    const n = Math.max(1, Number(count) || 1);
    const minR = 4;
    const maxR = 12;
    const raw = minR + (Math.sqrt(n) - 1) * 5;
    return Math.min(maxR, Math.max(minR, Math.round(raw)));
  }

  function entityPresenceHoverRadius(count) {
    return entityPresencePointRadius(count) + 2;
  }

  function getEntityPresenceDateRange() {
    const from = entityPresenceFromInput
      ? String(entityPresenceFromInput.value || '').trim()
      : '';
    const to = entityPresenceToInput
      ? String(entityPresenceToInput.value || '').trim()
      : '';
    if (!from && !to) return { from: '', to: '' };
    if (!from || !to) return { from: '', to: '', incomplete: true };
    if (from > to) return { from: from, to: to, invalidOrder: true };
    return { from: from, to: to };
  }

  function getEntityPresenceCacheKey(norm, dateRange) {
    return (
      (norm || '__all__') +
      '|' +
      (dateRange.from || '') +
      '|' +
      (dateRange.to || '')
    );
  }

  function getEntityPresenceFilterMeta(checkedIds) {
    for (let i = 0; i < checkedIds.length; i += 1) {
      const data = entityPresenceById[checkedIds[i]];
      if (!data) continue;
      const total =
        data.totalSuccessCaptures != null
          ? Number(data.totalSuccessCaptures)
          : 0;
      const captures = Array.isArray(data.captures) ? data.captures : [];
      const times = [];
      captures.forEach(function (c) {
        const ms = entityPresencePointTimeMs(c);
        if (Number.isFinite(ms)) times.push(ms);
      });
      return {
        totalSuccessCaptures: total,
        xMin: times.length ? Math.min.apply(null, times) : null,
        xMax: times.length ? Math.max.apply(null, times) : null,
      };
    }
    return { totalSuccessCaptures: 0, xMin: null, xMax: null };
  }

  function pushEntityPresenceDataset(datasets, opts) {
    const points = opts.points || [];
    points.forEach(function (p) {
      if (p.y > opts.maxPosRef.value) opts.maxPosRef.value = p.y;
    });
    opts.pointCountRef.value += points.length;
    const ds = {
      id: opts.id,
      label: opts.label,
      data: points,
      borderColor: opts.color,
      backgroundColor: opts.color,
      pointBackgroundColor: opts.color,
      borderWidth: 2,
      pointRadius: function (context) {
        const raw = context && context.raw;
        return entityPresencePointRadius(
          raw && raw.appearance_count != null ? raw.appearance_count : 1,
        );
      },
      pointHoverRadius: function (context) {
        const raw = context && context.raw;
        return entityPresenceHoverRadius(
          raw && raw.appearance_count != null ? raw.appearance_count : 1,
        );
      },
      tension: 0,
      spanGaps: false,
      showLine: true,
    };
    if (opts.dashed) {
      ds.borderDash = [6, 4];
    }
    datasets.push(ds);
  }

  function rawChartPointsForBlock(block) {
    if (!block) return [];
    if (Array.isArray(block.chartPoints)) return block.chartPoints;
    if (Array.isArray(block.appearances)) return block.appearances;
    return [];
  }

  function renderEntityPresenceChart(checkedIds) {
    destroyEntityPresenceChart();
    if (!checkedIds.length) {
      if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = true;
      return;
    }
    if (!entityPresenceCanvas || typeof window.Chart !== 'function') {
      setEntityPresenceStatus(
        'No se pudo cargar Chart.js para el gráfico de presencia.',
        true,
      );
      if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = true;
      return;
    }

    const filterMeta = getEntityPresenceFilterMeta(checkedIds);
    if (!(filterMeta.totalSuccessCaptures > 0)) {
      if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = true;
      setEntityPresenceStatus('Sin corridas para este filtro', false);
      return;
    }

    const datasets = [];
    const maxPosRef = { value: 5 };
    const pointCountRef = { value: 0 };
    const mode = entityPresenceMode;

    checkedIds.forEach(function (id) {
      const ent = entityPresenceCompetitors.find(function (e) {
        return String(e.id) === id;
      });
      const name = (ent && ent.name) || id;
      const data = entityPresenceById[id];
      const color = colorForString(name || id);

      if (mode === 'ad' || mode === 'both') {
        pushEntityPresenceDataset(datasets, {
          id: id + ':ad',
          label: mode === 'both' ? name + ' (Ad)' : name,
          points: chartPointsFromPresence(
            rawChartPointsForBlock(getEntityPresenceModeBlock(data, 'ad')),
            'ad',
          ),
          color: color,
          dashed: false,
          maxPosRef: maxPosRef,
          pointCountRef: pointCountRef,
        });
      }
      if (mode === 'organic' || mode === 'both') {
        pushEntityPresenceDataset(datasets, {
          id: id + ':organic',
          label: mode === 'both' ? name + ' (Orgánico)' : name,
          points: chartPointsFromPresence(
            rawChartPointsForBlock(
              getEntityPresenceModeBlock(data, 'organic'),
            ),
            'organic',
          ),
          color: color,
          dashed: mode === 'both',
          maxPosRef: maxPosRef,
          pointCountRef: pointCountRef,
        });
      }
    });

    const xScale = {
      type: 'linear',
      grid: { color: '#2a2f3a' },
      ticks: {
        color: '#9aa3b2',
        maxRotation: 0,
        callback: function (value) {
          return formatEntityPresenceAxisDate(value);
        },
      },
      title: {
        display: true,
        text: 'Captura',
        color: '#9aa3b2',
      },
    };
    if (filterMeta.xMin != null && filterMeta.xMax != null) {
      const pad =
        filterMeta.xMax > filterMeta.xMin
          ? (filterMeta.xMax - filterMeta.xMin) * 0.02
          : 86400000;
      xScale.min = filterMeta.xMin - pad;
      xScale.max = filterMeta.xMax + pad;
    }

    if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = false;
    if (pointCountRef.value === 0) {
      setEntityPresenceStatus(
        'Sin apariciones de los competidores tildados en este filtro (eje X = corridas del filtro).',
        false,
      );
    } else {
      setEntityPresenceStatus('', false);
    }

    entityPresenceChart = new window.Chart(
      entityPresenceCanvas.getContext('2d'),
      {
        type: 'line',
        data: { datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          interaction: {
            mode: 'nearest',
            intersect: true,
          },
          plugins: {
            legend: {
              display: mode === 'both',
              position: 'bottom',
              labels: { color: '#9aa3b2' },
            },
            tooltip: {
              callbacks: {
                title: function (items) {
                  if (!items || !items.length || !items[0].raw) return '';
                  const ds = items[0].dataset || {};
                  const raw = items[0].raw;
                  return (
                    (ds.label || 'Competidor') +
                    ' · ' +
                    formatEntityPresenceTooltipWhen(raw.imported_at)
                  );
                },
                label: function (item) {
                  const raw = item.raw || {};
                  const count = Math.max(
                    1,
                    Number(raw.appearance_count) || 1,
                  );
                  const countLabel =
                    raw.result_kind === 'organic'
                      ? count === 1
                        ? '1 resultado orgánico en esta corrida'
                        : count + ' resultados orgánicos en esta corrida'
                      : count === 1
                        ? '1 anuncio en esta corrida'
                        : count + ' anuncios en esta corrida';
                  return [
                    'Query: ' + (raw.search_term || '—'),
                    'Posición: ' +
                      (Number.isFinite(Number(raw.y))
                        ? String(raw.y)
                        : '—'),
                    countLabel,
                  ];
                },
              },
            },
          },
          scales: {
            x: xScale,
            y: {
              reverse: true,
              min: 0.5,
              suggestedMax: maxPosRef.value + 1,
              grace: '5%',
              grid: { color: '#2a2f3a' },
              ticks: {
                color: '#9aa3b2',
                stepSize: 1,
                callback: function (value) {
                  if (!Number.isInteger(value)) return '';
                  return value + '.º';
                },
              },
              title: {
                display: true,
                text: 'Posición',
                color: '#9aa3b2',
              },
            },
          },
        },
      },
    );
  }

  function buildEntityPresenceSummaryItem(label, x, y, color) {
    const hasPresence = Number(x) > 0;
    const swatch =
      '<span class="competitor-activity-weekly-swatch" style="background:' +
      escapeHtml(color) +
      '"></span>';
    return (
      '<span class="serp-entity-presence-summary-item' +
      (hasPresence ? ' is-present' : ' is-absent') +
      '">' +
      swatch +
      escapeHtml(label) +
      ': ' +
      Number(x) +
      ' de ' +
      Number(y) +
      ' corridas</span>'
    );
  }

  function renderEntityPresenceSummary(checkedIds) {
    if (!entityPresenceSummaryEl) return;
    if (!checkedIds.length) {
      entityPresenceSummaryEl.innerHTML = '';
      entityPresenceSummaryEl.hidden = true;
      return;
    }
    const mode = entityPresenceMode;
    const lines = [];
    checkedIds.forEach(function (id) {
      const ent = entityPresenceCompetitors.find(function (e) {
        return String(e.id) === id;
      });
      const name = (ent && ent.name) || id;
      const data = entityPresenceById[id];
      const y =
        data && data.totalSuccessCaptures != null
          ? Number(data.totalSuccessCaptures)
          : 0;
      const adsX =
        data && data.ads && data.ads.appearanceCaptureCount != null
          ? Number(data.ads.appearanceCaptureCount)
          : 0;
      const orgX =
        data && data.organic && data.organic.appearanceCaptureCount != null
          ? Number(data.organic.appearanceCaptureCount)
          : 0;
      const color = colorForString(name || id);

      if (mode === 'both') {
        lines.push(
          buildEntityPresenceSummaryItem(name + ' (Ad)', adsX, y, color),
        );
        lines.push(
          buildEntityPresenceSummaryItem(
            name + ' (Orgánico)',
            orgX,
            y,
            color,
          ),
        );
      } else if (mode === 'organic') {
        lines.push(buildEntityPresenceSummaryItem(name, orgX, y, color));
      } else {
        lines.push(buildEntityPresenceSummaryItem(name, adsX, y, color));
      }
    });
    entityPresenceSummaryEl.innerHTML = lines.join('');
    entityPresenceSummaryEl.hidden = false;
  }

  function renderEntityPresenceFromState() {
    const checkedIds = getEntityPresenceCheckedIds();
    if (!checkedIds.length) {
      clearEntityPresenceView('Seleccioná al menos un competidor');
      return;
    }
    renderEntityPresenceSummary(checkedIds);
    renderEntityPresenceChart(checkedIds);
  }

  function renderEntityPresenceToggles() {
    if (!entityPresenceTogglesEl) return;
    entityPresenceTogglesEl.innerHTML = entityPresenceCompetitors
      .map(function (ent) {
        const id = String(ent.id);
        const checked = entityPresenceChecked[id] === true;
        const color = colorForString(ent.name || id);
        return (
          '<label class="competitor-activity-weekly-toggle">' +
          '<input type="checkbox" data-series="' +
          escapeHtml(id) +
          '"' +
          (checked ? ' checked' : '') +
          ' />' +
          '<span class="competitor-activity-weekly-swatch" style="background:' +
          escapeHtml(color) +
          '"></span>' +
          escapeHtml(ent.name || 'Entidad') +
          '</label>'
        );
      })
      .join('');

    entityPresenceTogglesEl
      .querySelectorAll('input[data-series]')
      .forEach(function (checkbox) {
        checkbox.addEventListener('change', function () {
          const seriesKey = checkbox.getAttribute('data-series');
          if (!seriesKey) return;
          entityPresenceChecked[seriesKey] = checkbox.checked;
          syncEntityPresenceSelectAllButton();
          loadEntityPresence();
        });
      });

    syncEntityPresenceSelectAllButton();
  }

  function toggleEntityPresenceSelectAll() {
    const ids = entityPresenceCompetitors.map(function (ent) {
      return String(ent.id);
    });
    if (!ids.length) return;
    const selectAll = entityPresenceAllUnchecked(ids);
    ids.forEach(function (id) {
      entityPresenceChecked[id] = selectAll;
    });
    if (entityPresenceTogglesEl) {
      entityPresenceTogglesEl
        .querySelectorAll('input[data-series]')
        .forEach(function (checkbox) {
          checkbox.checked = selectAll;
        });
    }
    syncEntityPresenceSelectAllButton();
    loadEntityPresence();
  }

  async function fetchEntityPresenceOne(entityId, norm, dateRange) {
    let url =
      API_BASE +
      '/reports/google-serp-entity-presence?entity_id=' +
      encodeURIComponent(entityId);
    if (norm) {
      url += '&search_term_normalized=' + encodeURIComponent(norm);
    }
    if (dateRange && dateRange.from && dateRange.to) {
      url +=
        '&from=' +
        encodeURIComponent(dateRange.from) +
        '&to=' +
        encodeURIComponent(dateRange.to);
    }
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    const body = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      throw new Error(
        body && body.error
          ? String(body.error)
          : 'No se pudo cargar la presencia.',
      );
    }
    return body;
  }

  async function loadEntityPresenceCompetitors() {
    if (!entityPresenceTogglesEl) return;
    try {
      const entities = await supabaseRestGet(
        'monitored_entities?select=id,name,website_domain,active,is_self' +
          '&is_self=eq.false&active=eq.true' +
          '&website_domain=not.is.null&order=name.asc',
      );
      entityPresenceCompetitors = (Array.isArray(entities) ? entities : []).map(
        function (e) {
          return {
            id: String(e.id),
            name: e.name || String(e.id),
          };
        },
      );
      renderEntityPresenceToggles();
    } catch (err) {
      setEntityPresenceStatus(
        'No se pudieron cargar los competidores.',
        true,
      );
    }
  }

  async function loadEntityPresence() {
    const checkedIds = getEntityPresenceCheckedIds();
    if (!checkedIds.length) {
      clearEntityPresenceView('Seleccioná al menos un competidor');
      return;
    }

    const dateRange = getEntityPresenceDateRange();
    if (dateRange.incomplete) {
      setEntityPresenceStatus(
        'Completá Desde y Hasta (o dejá ambos vacíos).',
        true,
      );
      return;
    }
    if (dateRange.invalidOrder) {
      setEntityPresenceStatus('Desde no puede ser posterior a Hasta.', true);
      return;
    }

    const norm = getSelectedSearchTermNormalized();
    const cacheKey = getEntityPresenceCacheKey(norm, dateRange);
    if (cacheKey !== entityPresenceCacheKey) {
      entityPresenceById = Object.create(null);
      entityPresenceCacheKey = cacheKey;
    }

    const missing = checkedIds.filter(function (id) {
      return !entityPresenceById[id];
    });

    if (!missing.length) {
      renderEntityPresenceFromState();
      return;
    }

    const seq = ++entityPresenceRequestSeq;
    entityPresenceBusy = true;
    setEntityPresenceStatus('Cargando presencia…', false);
    try {
      const results = await Promise.all(
        missing.map(function (id) {
          return fetchEntityPresenceOne(id, norm, dateRange).then(
            function (body) {
              return { id: id, body: body };
            },
          );
        }),
      );
      if (seq !== entityPresenceRequestSeq) return;
      results.forEach(function (row) {
        entityPresenceById[row.id] = row.body;
      });
      renderEntityPresenceFromState();
    } catch (err) {
      if (seq !== entityPresenceRequestSeq) return;
      destroyEntityPresenceChart();
      if (entityPresenceChartWrap) entityPresenceChartWrap.hidden = true;
      if (entityPresenceSummaryEl) {
        entityPresenceSummaryEl.innerHTML = '';
        entityPresenceSummaryEl.hidden = true;
      }
      setEntityPresenceStatus(
        err && err.message
          ? err.message
          : 'No se pudo cargar la presencia.',
        true,
      );
    } finally {
      if (seq === entityPresenceRequestSeq) {
        entityPresenceBusy = false;
      }
    }
  }

  function onSharedQueryFilterChange() {
    refreshImportsListView();
    entityPresenceById = Object.create(null);
    entityPresenceCacheKey = '';
    loadEntityPresence();
  }

  function onEntityPresenceDateRangeChange() {
    entityPresenceById = Object.create(null);
    entityPresenceCacheKey = '';
    loadEntityPresence();
  }

  function onEntityPresenceModeChange() {
    if (!entityPresenceModeEl) return;
    const selected = entityPresenceModeEl.querySelector(
      'input[name="serp-entity-presence-mode"]:checked',
    );
    const value = selected ? String(selected.value || '') : 'ad';
    if (value === 'organic') entityPresenceMode = 'organic';
    else if (value === 'both') entityPresenceMode = 'both';
    else entityPresenceMode = 'ad';
    renderEntityPresenceFromState();
  }

  function setQueriesStatus(text, isError) {
    if (!queriesStatusEl) return;
    queriesStatusEl.textContent = text || '';
    queriesStatusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function formatSerpCreateOutcome(body) {
    const planner = body && body.plannerStatus === 'ok' ? 'ok' : 'error';
    const serper = body && body.serperStatus === 'ok' ? 'ok' : 'error';
    let msg = 'Query agregada. CPC: ' + planner + '. SERP: ' + serper;
    if (planner === 'ok' && serper === 'ok') return msg + '.';
    const bits = [];
    if (planner !== 'ok' && body && body.plannerError) {
      bits.push(String(body.plannerError));
    }
    if (serper !== 'ok' && body && body.serperError) {
      bits.push(String(body.serperError));
    }
    if (bits.length) return msg + ' (' + bits.join('; ') + ').';
    return msg + ' (ver logs).';
  }

  function formatQueryCreatedAt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso);
    return d.toLocaleDateString('es-UY');
  }

  function formatCompetitionLevel(level) {
    if (level == null || level === '') return '—';
    const key = String(level).toUpperCase();
    if (key === 'LOW') return 'Baja';
    if (key === 'MEDIUM') return 'Media';
    if (key === 'HIGH') return 'Alta';
    if (key === 'UNSPECIFIED' || key === 'UNKNOWN') return '—';
    return String(level);
  }

  function competitionLevelToneClass(level) {
    const key = String(level == null ? '' : level).toUpperCase();
    if (key === 'LOW') return 'cpc-comp-low';
    if (key === 'MEDIUM') return 'cpc-comp-medium';
    if (key === 'HIGH') return 'cpc-comp-high';
    return '';
  }

  function renderCompetitionLevelHtml(level, emptyLabel) {
    const label = formatCompetitionLevel(level);
    if (label === '—') {
      return escapeHtml(emptyLabel != null ? emptyLabel : '—');
    }
    const cls = competitionLevelToneClass(level);
    if (!cls) return escapeHtml(label);
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  /** Bids are stored as Google Ads micros (raw). null → em dash, never NaN. */
  function formatBidFromMicros(raw, currencyCode) {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    const amount = (n / 1000000).toFixed(2);
    if (currencyCode) return amount + ' ' + String(currencyCode);
    return amount + ' (moneda sin confirmar)';
  }

  function formatAvgMonthlySearches(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return String(Math.trunc(n));
  }

  function renderSerpQueryClassificationBadge(estimate) {
    const status =
      estimate && estimate.classificationStatus
        ? String(estimate.classificationStatus)
        : '';
    const map = {
      recommended: ['Recomendada', 'is-cpc-recommended'],
      evaluate: ['Evaluar', 'is-cpc-evaluate'],
      low_priority: ['Baja prioridad', 'is-cpc-low-priority'],
      discarded_high_competition: ['Competencia alta', 'is-cpc-high-comp'],
      discarded_low_volume: ['Volumen insuficiente', 'is-cpc-low-volume'],
      insufficient_bid_data: ['Sin datos de bid', 'is-cpc-no-bid'],
    };
    const entry = map[status];
    if (!entry) return '';
    if (
      status === 'discarded_high_competition' ||
      status === 'evaluate' ||
      status === 'discarded_low_volume'
    ) {
      return '';
    }
    return (
      '<span class="cov-badge cpc-class-badge ' +
      entry[1] +
      '">' +
      escapeHtml(entry[0]) +
      '</span> '
    );
  }

  function volumeSearchPrefixEmoji(estimate) {
    const status =
      estimate && estimate.classificationStatus
        ? String(estimate.classificationStatus)
        : '';
    let emoji = '⏩';
    let unclassified = true;
    if (status === 'recommended') {
      emoji = '🟢';
      unclassified = false;
    } else if (status === 'evaluate') {
      emoji = '🟡';
      unclassified = false;
    } else if (status === 'discarded_high_competition') {
      emoji = '🔴';
      unclassified = false;
    } else if (
      status === 'low_priority' ||
      status === 'discarded_low_volume' ||
      status === 'insufficient_bid_data'
    ) {
      emoji = '⚪';
      unclassified = false;
    }
    const cls = unclassified
      ? 'cpc-vol-emoji cov-badge cpc-class-badge is-cpc-unclassified'
      : 'cpc-vol-emoji';
    return '<span class="' + cls + '">' + emoji + '</span>';
  }

  function renderSerpQueryCpcMeta(estimate) {
    if (!estimate) {
      return (
        '<p class="serp-queries-hint serp-query-cpc-empty">' +
        '⏳ Sin datos de CPC todavía</p>'
      );
    }
    const vol = formatAvgMonthlySearches(estimate.avgMonthlySearches);
    const low = formatBidFromMicros(
      estimate.lowTopOfPageBidRaw,
      estimate.currencyCode,
    );
    const high = formatBidFromMicros(
      estimate.highTopOfPageBidRaw,
      estimate.currencyCode,
    );
    const fetched = formatQueryCreatedAt(estimate.fetchedAt);
    const badge = renderSerpQueryClassificationBadge(estimate);
    return (
      '<p class="text-muted serp-queries-hint">' +
      badge +
      volumeSearchPrefixEmoji(estimate) +
      ' Vol. búsquedas: ' +
      escapeHtml(vol) +
      ' · Competencia: ' +
      renderCompetitionLevelHtml(estimate.competitionLevel) +
      ' · Bid bajo: <span class="cpc-bid-low">' +
      escapeHtml(low) +
      '</span> · Bid alto: <span class="cpc-bid-high">' +
      escapeHtml(high) +
      '</span> · CPC al ' +
      escapeHtml(fetched) +
      '</p>'
    );
  }

  function renderSerpQueries(queries, estimatesByQueryId) {
    if (!queriesListEl) return;
    const rows = Array.isArray(queries) ? queries.slice() : [];
    const byId =
      estimatesByQueryId && typeof estimatesByQueryId === 'object'
        ? estimatesByQueryId
        : Object.create(null);
    if (!rows.length) {
      queriesListEl.innerHTML =
        '<p class="text-muted">Todavía no hay queries en el catálogo.</p>';
      return;
    }
    queriesListEl.innerHTML = rows
      .map(function (q) {
        const active = q && q.active !== false;
        const id = q && q.id != null ? String(q.id) : '';
        const estimate = id && byId[id] ? byId[id] : null;
        const alreadyMeasured = Boolean(q && q.alreadyMeasuredFromLanding);
        const alreadyHasCpc = Boolean(estimate);
        return (
          '<div>' +
          '<div class="serp-query-row' +
          (active ? '' : ' is-inactive') +
          '" data-id="' +
          escapeHtml(id) +
          '">' +
          '<span class="serp-query-text">' +
          escapeHtml((q && q.queryText) || '—') +
          '</span>' +
          '<span class="serp-query-date">' +
          escapeHtml(formatQueryCreatedAt(q && q.createdAt)) +
          '</span>' +
          '<button type="button" class="serp-query-toggle' +
          (active ? ' is-active' : '') +
          '" data-id="' +
          escapeHtml(id) +
          '" data-active="' +
          (active ? '1' : '0') +
          '">' +
          (active ? 'Activa' : 'Inactiva') +
          '</button>' +
          '<button type="button" class="serp-query-measure-cpc-btn" data-id="' +
          escapeHtml(id) +
          '"' +
          (alreadyHasCpc ? ' disabled' : '') +
          ' title="' +
          (alreadyHasCpc ? 'Ya medido' : 'Medir CPC') +
          '">' +
          (alreadyHasCpc ? 'Ya medido' : 'Medir CPC') +
          '</button>' +
          '<button type="button" class="serp-query-queue-btn" data-id="' +
          escapeHtml(id) +
          '"' +
          (alreadyMeasured ? ' disabled' : '') +
          ' title="' +
          (alreadyMeasured
            ? 'Ya medido'
            : 'Envía a Pendientes y mide CPC con Keyword Planner si aún no tiene estimate') +
          '">' +
          (alreadyMeasured ? 'Ya medido' : 'Enviar y medir') +
          '</button>' +
          '</div>' +
          renderSerpQueryCpcMeta(estimate) +
          '</div>'
        );
      })
      .join('');

    queriesListEl.querySelectorAll('.serp-query-toggle').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (queriesBusy) return;
        const id = btn.getAttribute('data-id');
        const currentlyActive = btn.getAttribute('data-active') === '1';
        if (!id) return;
        queriesBusy = true;
        setQueriesStatus('Actualizando…', false);
        try {
          const res = await fetch(
            API_BASE + '/reports/serp-queries/' + encodeURIComponent(id),
            {
              method: 'PATCH',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ active: !currentlyActive }),
            },
          );
          const body = await res.json().catch(function () {
            return {};
          });
          if (!res.ok) {
            throw new Error(
              body && body.error
                ? String(body.error)
                : 'No se pudo actualizar la query.',
            );
          }
          setQueriesStatus('', false);
          await loadSerpQueries();
        } catch (err) {
          setQueriesStatus(
            err && err.message
              ? err.message
              : 'No se pudo actualizar la query.',
            true,
          );
        } finally {
          queriesBusy = false;
        }
      });
    });

    queriesListEl.querySelectorAll('.serp-query-measure-cpc-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        measureSerpQueryCpc(btn);
      });
    });

    queriesListEl.querySelectorAll('.serp-query-queue-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        queueSerpQueryForLanding(btn);
      });
    });
  }

  function landingDecisionLabel(decision) {
    if (decision === 'monitor_trends') return 'Generar landing SEO';
    if (decision === 'added_as_competitor') return 'Monitorear competidor';
    if (decision === 'discarded') return 'Descartar';
    if (decision === 'pending') return 'pendiente';
    return decision ? String(decision) : 'procesado';
  }

  async function measureSerpQueryCpc(btn) {
    if (!btn || btn.disabled || queriesBusy) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const row = btn.closest('.serp-query-row');
    const termEl = row ? row.querySelector('.serp-query-text') : null;
    const term = termEl ? String(termEl.textContent || '').trim() : '';
    const ok = window.confirm(
      '¿Medir CPC de «' +
        (term || 'esta query') +
        '» con Keyword Planner?\n\nEsto puede tardar hasta un minuto. No envía el término a Pendientes.',
    );
    if (!ok) return;

    const prevLabel = btn.textContent;
    queriesBusy = true;
    btn.disabled = true;
    btn.textContent = 'Midiendo…';
    setQueriesStatus('Midiendo CPC… esto puede tardar hasta un minuto', false);
    try {
      const res = await fetch(
        API_BASE +
          '/reports/serp-queries/' +
          encodeURIComponent(id) +
          '/measure-cpc',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
      );
      const body = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        throw new Error(
          body && body.error
            ? String(body.error)
            : 'No se pudo medir el CPC.',
        );
      }
      if (body && body.alreadyMeasured) {
        setQueriesStatus('Ya tenía CPC medido', false);
      } else {
        setQueriesStatus('CPC medido', false);
      }
      await loadSerpQueries();
    } catch (err) {
      setQueriesStatus(
        err && err.message ? err.message : 'No se pudo medir el CPC.',
        true,
      );
      btn.disabled = false;
      btn.textContent = prevLabel;
      btn.title = 'Medir CPC';
    } finally {
      queriesBusy = false;
    }
  }

  async function queueSerpQueryForLanding(btn) {
    if (!btn || btn.disabled) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const row = btn.closest('.serp-query-row');
    const termEl = row ? row.querySelector('.serp-query-text') : null;
    const term = termEl ? String(termEl.textContent || '').trim() : '';
    const ok = window.confirm(
      '¿Enviar «' +
        (term || 'esta query') +
        '» a Pendientes?\n\nSe mide con Keyword Planner si todavía no tiene estimate. No modifica la query SERP ni decisiones ya tomadas.',
    );
    if (!ok) return;

    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    setQueriesStatus('Enviando a Pendientes… esto puede tardar hasta un minuto', false);
    let queuedOk = false;
    let measureErr = '';
    let outcome = '';
    try {
      const res = await fetch(
        API_BASE +
          '/reports/serp-queries/' +
          encodeURIComponent(id) +
          '/queue-for-landing',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
      );
      const body = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        throw new Error(
          body && body.error
            ? String(body.error)
            : 'No se pudo enviar a Pendientes.',
        );
      }
      queuedOk = true;
      outcome = body && body.outcome ? String(body.outcome) : '';
      measureErr =
        body && body.measureError && body.measureError.error
          ? String(body.measureError.error)
          : '';
      if (outcome === 'created') {
        if (measureErr) {
          setQueriesStatus(
            'Agregado a Pendientes. No se pudo medir: ' + measureErr,
            true,
          );
        } else if (body.alreadyMeasured) {
          setQueriesStatus('Agregado a Pendientes (ya estaba medido)', false);
        } else {
          setQueriesStatus('Agregado a Pendientes', false);
        }
      } else if (outcome === 'already_pending') {
        if (measureErr) {
          setQueriesStatus(
            'Ya está pendiente en Pendientes. No se pudo medir: ' + measureErr,
            true,
          );
        } else {
          setQueriesStatus('Ya está pendiente en Pendientes', false);
        }
      } else if (outcome === 'already_processed') {
        setQueriesStatus(
          'Ya existe en Pendientes (decisión: ' +
            landingDecisionLabel(body.decision) +
            ')',
          false,
        );
      } else {
        setQueriesStatus('Listo.', false);
      }
      if (
        !measureErr &&
        (outcome === 'created' || outcome === 'already_pending')
      ) {
        await loadSerpQueries();
      }
    } catch (err) {
      setQueriesStatus(
        err && err.message ? err.message : 'No se pudo enviar a Pendientes.',
        true,
      );
    } finally {
      const nowMeasured =
        queuedOk &&
        !measureErr &&
        (outcome === 'created' || outcome === 'already_pending');
      if (nowMeasured) {
        btn.disabled = true;
        btn.textContent = 'Ya medido';
        btn.title = 'Ya medido';
      } else {
        btn.disabled = false;
        btn.textContent = prevLabel;
        btn.title =
          'Envía a Pendientes y mide CPC con Keyword Planner si aún no tiene estimate';
      }
    }
  }

  async function loadSerpQueries() {
    if (!queriesListEl) return;
    try {
      const [queriesRes, estimatesRes] = await Promise.all([
        fetch(API_BASE + '/reports/serp-queries', {
          headers: { Accept: 'application/json' },
        }),
        fetch(API_BASE + '/reports/keyword-cpc-estimates', {
          headers: { Accept: 'application/json' },
        }),
      ]);
      const body = await queriesRes.json().catch(function () {
        return {};
      });
      if (!queriesRes.ok) {
        throw new Error(
          body && body.error
            ? String(body.error)
            : 'No se pudieron cargar las queries.',
        );
      }

      const estimatesByQueryId = Object.create(null);
      if (estimatesRes.ok) {
        const estimatesBody = await estimatesRes.json().catch(function () {
          return {};
        });
        const list = Array.isArray(estimatesBody.estimates)
          ? estimatesBody.estimates
          : [];
        list.forEach(function (est) {
          if (!est || est.monitoredQueryId == null) return;
          estimatesByQueryId[String(est.monitoredQueryId)] = est;
        });
      }

      renderSerpQueries(body.queries, estimatesByQueryId);
      populateHistoryQueryFilter(body.queries);
      refreshImportsListView();
      loadEntityPresence();
      loadKeywordRunAnalysis();
    } catch (err) {
      setQueriesStatus(
        err && err.message
          ? err.message
          : 'No se pudieron cargar las queries.',
        true,
      );
    }
  }

  async function loadKeywordRunAnalysis() {
    if (!serpRunAnalysisEl) return;
    const render =
      typeof window.__mieRenderCpcRunAnalysis === 'function'
        ? window.__mieRenderCpcRunAnalysis
        : null;
    if (!render) return;
    try {
      const res = await fetch(
        API_BASE +
          '/reports/sync-run-summaries?sourceTable=keyword_cpc_estimates',
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      render(
        serpRunAnalysisEl,
        body && body.summary ? body.summary : null,
        'Queries monitoreadas',
      );
    } catch (err) {
      render(serpRunAnalysisEl, null);
    }
  }

  if (historyQueryFilter) {
    historyQueryFilter.addEventListener('change', onSharedQueryFilterChange);
  }

  if (entityPresenceSelectAllBtn) {
    entityPresenceSelectAllBtn.addEventListener('click', function () {
      toggleEntityPresenceSelectAll();
    });
  }

  if (entityPresenceModeEl) {
    entityPresenceModeEl
      .querySelectorAll('input[name="serp-entity-presence-mode"]')
      .forEach(function (input) {
        input.addEventListener('change', onEntityPresenceModeChange);
      });
  }

  if (entityPresenceFromInput) {
    entityPresenceFromInput.addEventListener(
      'change',
      onEntityPresenceDateRangeChange,
    );
  }
  if (entityPresenceToInput) {
    entityPresenceToInput.addEventListener(
      'change',
      onEntityPresenceDateRangeChange,
    );
  }

  if (queryForm) {
    queryForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (queriesBusy) return;
      const text = queryInput ? queryInput.value.trim() : '';
      if (!text) {
        setQueriesStatus('Escribí una query.', true);
        return;
      }
      queriesBusy = true;
      if (queryAddBtn) queryAddBtn.disabled = true;
      const prevAddLabel = queryAddBtn ? queryAddBtn.textContent : '';
      if (queryAddBtn) queryAddBtn.textContent = 'Agregando y midiendo…';
      setQueriesStatus(
        'Agregando y midiendo… esto puede tardar hasta un minuto',
        false,
      );
      try {
        const res = await fetch(API_BASE + '/reports/serp-queries', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ queryText: text }),
        });
        const body = await res.json().catch(function () {
          return {};
        });
        if (res.status === 201) {
          if (queryInput) queryInput.value = '';
          setQueriesStatus(formatSerpCreateOutcome(body), false);
          await loadSerpQueries();
          return;
        }
        if (res.status === 409 && body && body.code === 'QUERY_DUPLICATE') {
          setQueriesStatus(
            'Ya se está monitoreando este término en SERP',
            false,
          );
          return;
        }
        throw new Error(
          body && body.error
            ? String(body.error)
            : 'No se pudo agregar la query.',
        );
      } catch (err) {
        setQueriesStatus(
          err && err.message ? err.message : 'No se pudo agregar la query.',
          true,
        );
      } finally {
        queriesBusy = false;
        if (queryAddBtn) {
          queryAddBtn.disabled = false;
          if (prevAddLabel) queryAddBtn.textContent = prevAddLabel;
        }
      }
    });
  }

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

  function setImportsExpanded(expanded) {
    const on = Boolean(expanded);
    if (listEl) {
      if (on) listEl.removeAttribute('hidden');
      else listEl.setAttribute('hidden', '');
    }
    if (importsToggleBtn) {
      importsToggleBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      importsToggleBtn.textContent = on ? 'Ocultar' : 'Mostrar';
    }
  }

  if (importsToggleBtn) {
    importsToggleBtn.addEventListener('click', function () {
      const open = importsToggleBtn.getAttribute('aria-expanded') === 'true';
      setImportsExpanded(!open);
    });
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
  setImportsExpanded(false);
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
        const ratio = totalForRow > 0 ? appeared / totalForRow : 0;
        let levelClass = 'is-presence-low';
        if (ratio >= 0.6) levelClass = 'is-presence-high';
        else if (ratio >= 0.3) levelClass = 'is-presence-mid';

        const fractionHtml =
          '<strong class="serp-presence-fraction ' +
          levelClass +
          '">' +
          escapeHtml(String(appeared)) +
          ' de ' +
          escapeHtml(String(totalForRow)) +
          '</strong>';

        const adsCount = Number(e.appearedAdsCaptureCount || 0);
        const organicCount = Number(e.appearedOrganicCaptureCount || 0);
        const breakdownHtml =
          appeared > 0
            ? ' (' +
              escapeHtml(String(adsCount)) +
              ' en ads, ' +
              escapeHtml(String(organicCount)) +
              ' en orgánico — puede solaparse)'
            : '';

        const presenceHtml =
          appeared > 0
            ? 'Apareció en ' + fractionHtml + ' capturas realizadas' + breakdownHtml + '.'
            : 'No apareció en ninguna de las ' +
              '<strong class="serp-presence-fraction is-presence-low">' +
              escapeHtml(String(totalForRow)) +
              '</strong>' +
              ' capturas realizadas.';

        const lastText =
          'Última aparición: ' + formatPresenceDate(e.mostRecentAppearanceDate);

        const adsPct =
          totalForRow > 0 ? Math.min(100, Math.round((adsCount / totalForRow) * 100)) : 0;
        const organicPct =
          totalForRow > 0 ? Math.min(100, Math.round((organicCount / totalForRow) * 100)) : 0;
        const barsHtml =
          '<div class="serp-presence-bars" aria-hidden="true">' +
          '<div class="serp-presence-bar-row">' +
          '<span class="serp-presence-bar-label">Ads</span>' +
          '<div class="serp-presence-bar-track">' +
          '<div class="serp-presence-bar-fill is-ads" style="width:' +
          adsPct +
          '%"></div>' +
          '</div>' +
          '<span class="serp-presence-bar-count">' +
          escapeHtml(String(adsCount)) +
          '</span>' +
          '</div>' +
          '<div class="serp-presence-bar-row">' +
          '<span class="serp-presence-bar-label">Orgánico</span>' +
          '<div class="serp-presence-bar-track">' +
          '<div class="serp-presence-bar-fill is-organic" style="width:' +
          organicPct +
          '%"></div>' +
          '</div>' +
          '<span class="serp-presence-bar-count">' +
          escapeHtml(String(organicCount)) +
          '</span>' +
          '</div>' +
          '</div>';

        const avatarHtml = renderGaugeAvatar({
          entityName: e.entityName,
          websiteDomain: e.websiteDomain,
        });

        return (
          '<div class="serp-presence-row">' +
          '<div class="serp-presence-main">' +
          avatarHtml +
          '<span class="serp-presence-name">' +
          escapeHtml(e.entityName || '—') +
          '</span>' +
          '<span class="serp-presence-domain">' +
          escapeHtml(e.websiteDomain || '—') +
          '</span>' +
          '</div>' +
          '<div class="serp-presence-copy">' +
          presenceHtml +
          '</div>' +
          '<div class="serp-presence-last">' +
          escapeHtml(lastText) +
          '</div>' +
          barsHtml +
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
        refreshImportsListView();
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
      refreshImportsListView();
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
    loadSerpQueries();
    loadEntityPresenceCompetitors().then(function () {
      clearEntityPresenceView('Seleccioná al menos un competidor');
    });
    loadImports();
    loadPresence();
  };
  window.__loadSerpQueries = loadSerpQueries;
})();
/* ----------------------------------------------------------------------------
 * Campañas SMS — Notifyme via GET/POST /sms/*
 * No CRM fields. unique_id and campaign IDs stay strings forever.
 * ------------------------------------------------------------------------- */
(function initSmsCampaigns() {
  const panel = document.getElementById('sms-panel');
  const form = document.getElementById('sms-create-form');
  const nameInput = document.getElementById('sms-name');
  const phonesInput = document.getElementById('sms-phones');
  const destPasteWrap = document.getElementById('sms-dest-paste-wrap');
  const destListWrap = document.getElementById('sms-dest-list-wrap');
  const sourceSystemInput = document.getElementById('sms-source-system');
  const fromLimitInput = document.getElementById('sms-from-limit');
  const waveSizeInput = document.getElementById('sms-wave-size');
  const waveIntervalInput = document.getElementById('sms-wave-interval-seconds');
  const eligibleStatus = document.getElementById('sms-eligible-status');
  const seriesWrap = document.getElementById('sms-series-wrap');
  const seriesSelect = document.getElementById('sms-series-select');
  const seriesNameInput = document.getElementById('sms-series-name');
  const seriesCreateBtn = document.getElementById('sms-series-create-btn');
  const seriesStatus = document.getElementById('sms-series-status');
  const pasteProtectStatus = document.getElementById('sms-paste-protect-status');
  const messageInput = document.getElementById('sms-message');
  const destinationUrlInput = document.getElementById('sms-destination-url');
  const composePreviewText = document.getElementById('sms-compose-preview-text');
  const composePreviewLabel = document.querySelector(
    '#sms-compose-preview .sms-compose-preview-label',
  );
  const encodingHint = document.getElementById('sms-encoding-hint');
  const batchWarn = document.getElementById('sms-batch-warn');
  const submitBtn = document.getElementById('sms-submit-btn');
  const createStatus = document.getElementById('sms-create-status');
  const listStatus = document.getElementById('sms-list-status');
  const listEl = document.getElementById('sms-list');
  const reloadBtn = document.getElementById('sms-reload-list-btn');
  const detailSection = document.getElementById('sms-detail-section');
  const listSection = document.getElementById('sms-list-section');
  const createSection = document.getElementById('sms-create-section');
  const detailBackBtn = document.getElementById('sms-detail-back-btn');
  const detailStatus = document.getElementById('sms-detail-status');
  const detailBody = document.getElementById('sms-detail-body');
  const monthlySummaryBody = document.getElementById('sms-monthly-summary-body');
  const monthlySummaryStatus = document.getElementById('sms-monthly-summary-status');

  if (
    !panel ||
    !form ||
    !nameInput ||
    !phonesInput ||
    !destPasteWrap ||
    !destListWrap ||
    !sourceSystemInput ||
    !fromLimitInput ||
    !waveSizeInput ||
    !waveIntervalInput ||
    !eligibleStatus ||
    !messageInput ||
    !destinationUrlInput ||
    !composePreviewText ||
    !submitBtn ||
    !listEl ||
    !reloadBtn ||
    !detailSection ||
    !detailBody ||
    !monthlySummaryBody
  ) {
    return;
  }

  let createBusy = false;
  let listBusy = false;
  let pollBusy = false;
  let monthlyBusy = false;
  let openedOnce = false;
  let activeCampaignId = null;
  let smsIndividualTracking = false;
  const smsSeriesById = {};

  // GSM 03.38 basic character set (includes ñ/Ñ — does NOT force UCS-2 alone).
  const GSM7_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  // Extension table (each costs 2 septets with escape).
  const GSM7_EXT = '^{}\\[~]|€';

  const gsm7BasicSet = new Set(GSM7_BASIC.split(''));
  const gsm7ExtSet = new Set(GSM7_EXT.split(''));

  function setStatus(el, text, isError) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('mcl-error', Boolean(isError));
  }

  function dash(value) {
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  }

  function formatCount(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value !== '') return value;
    return '—';
  }

  function formatMonthLabel(yyyyMm) {
    const m = String(yyyyMm || '');
    const match = /^(\d{4})-(\d{2})$/.exec(m);
    if (!match) return dash(m);
    const monthNames = [
      'Enero',
      'Febrero',
      'Marzo',
      'Abril',
      'Mayo',
      'Junio',
      'Julio',
      'Agosto',
      'Septiembre',
      'Octubre',
      'Noviembre',
      'Diciembre',
    ];
    const idx = Number(match[2]) - 1;
    if (idx < 0 || idx > 11) return dash(m);
    return monthNames[idx] + ' ' + match[1];
  }

  function formatCost(value) {
    if (value === null || value === undefined) return '—';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('es-UY', {
        style: 'currency',
        currency: 'UYU',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    } catch (e) {
      return String(n);
    }
  }

  function campaignStatusClass(status) {
    const s = String(status || '');
    if (s === 'sending' || s === 'sent' || s === 'partial_error' || s === 'error') {
      return ' is-' + s;
    }
    return '';
  }

  function parsePhones(raw) {
    return String(raw || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function destMode() {
    const checked = form.querySelector('input[name="sms-dest-mode"]:checked');
    return checked && checked.value === 'list' ? 'list' : 'paste';
  }

  function syncDestModeUi() {
    const list = destMode() === 'list';
    destPasteWrap.hidden = list;
    destListWrap.hidden = !list;
    if (list) refreshEligibleCount();
    refreshPasteProtection();
    schedulePreviewShort();
  }

  async function refreshEligibleCount() {
    const sourceSystem = String(sourceSystemInput.value || '').trim();
    if (!sourceSystem) {
      eligibleStatus.textContent = '';
      return;
    }
    if (smsIndividualTracking && seriesSelect && !String(seriesSelect.value || '').trim()) {
      eligibleStatus.textContent =
        'Elegí una serie para ver contactos elegibles (sin click en esa serie).';
      return;
    }
    eligibleStatus.textContent = 'Consultando elegibles…';
    try {
      let url =
        API_BASE +
        '/sms/contacts/eligible?source_system=' +
        encodeURIComponent(sourceSystem);
      const seriesId =
        seriesSelect && String(seriesSelect.value || '').trim();
      if (smsIndividualTracking && seriesId) {
        url += '&campaign_series_id=' + encodeURIComponent(seriesId);
      }
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = await readJsonSafe(res);
      if (!res.ok) {
        eligibleStatus.textContent =
          (body && body.error) || 'No se pudo contar elegibles.';
        return;
      }
      const count = body && body.count != null ? Number(body.count) : 0;
      const protectedN =
        body && body.protected_clicked_count != null
          ? Number(body.protected_clicked_count)
          : null;
      if (body && body.eligibility === 'series') {
        let text =
          count +
          ' contacto(s) elegibles para esta serie en «' +
          sourceSystem +
          '».';
        if (Number.isFinite(protectedN)) {
          text +=
            ' ' +
            protectedN +
            ' protegido(s) por click en la serie.';
        }
        eligibleStatus.textContent = text;
      } else {
        eligibleStatus.textContent =
          count +
          ' contacto(s) elegibles (sin SMS previo) en «' +
          sourceSystem +
          '».';
      }
    } catch (_err) {
      eligibleStatus.textContent = 'No se pudo contar elegibles.';
    }
  }

  function selectedSeriesId() {
    return seriesSelect ? String(seriesSelect.value || '').trim() : '';
  }

  function renderSeriesOptions(rows, keepId) {
    if (!seriesSelect) return;
    const current = keepId || selectedSeriesId();
    const list = Array.isArray(rows) ? rows : [];
    Object.keys(smsSeriesById).forEach(function (k) {
      delete smsSeriesById[k];
    });
    seriesSelect.innerHTML = '<option value="">Elegí una serie</option>';
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (!row || !row.id) continue;
      const id = String(row.id);
      smsSeriesById[id] = row;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = String(row.name || id);
      seriesSelect.appendChild(opt);
    }
    if (current && smsSeriesById[current]) {
      seriesSelect.value = current;
    }
  }

  function syncSeriesUi() {
    if (seriesWrap) {
      seriesWrap.hidden = !smsIndividualTracking;
    }
    if (destMode() === 'list') refreshEligibleCount();
    refreshPasteProtection();
  }

  async function loadSeriesBootstrap() {
    try {
      const res = await fetch(API_BASE + '/sms/campaign-series', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = await readJsonSafe(res);
      smsIndividualTracking = Boolean(body && body.individual_tracking);
      if (res.ok) {
        renderSeriesOptions(body && body.series);
      }
    } catch (_err) {
      smsIndividualTracking = false;
    }
    syncSeriesUi();
  }

  async function createSeriesFromUi() {
    if (!seriesNameInput || !seriesCreateBtn) return;
    const name = String(seriesNameInput.value || '').trim();
    if (!name) {
      if (seriesStatus) seriesStatus.textContent = 'Escribí un nombre para la serie.';
      return;
    }
    seriesCreateBtn.disabled = true;
    if (seriesStatus) seriesStatus.textContent = 'Creando serie…';
    try {
      const res = await fetch(API_BASE + '/sms/campaign-series', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name }),
      });
      const body = await readJsonSafe(res);
      if (!res.ok) {
        if (seriesStatus) {
          seriesStatus.textContent =
            (body && body.error) || 'No se pudo crear la serie.';
        }
        return;
      }
      const id = body && body.id ? String(body.id) : '';
      const existing = [];
      seriesSelect &&
        seriesSelect.querySelectorAll('option').forEach(function (opt) {
          if (opt.value) {
            existing.push({
              id: opt.value,
              name: opt.textContent,
            });
          }
        });
      existing.unshift({ id: id, name: body.name || name, created_at: body.created_at });
      renderSeriesOptions(existing, id);
      seriesNameInput.value = '';
      if (seriesStatus) seriesStatus.textContent = 'Serie creada.';
      if (destMode() === 'list') refreshEligibleCount();
      refreshPasteProtection();
    } catch (_err) {
      if (seriesStatus) seriesStatus.textContent = 'No se pudo crear la serie.';
    } finally {
      seriesCreateBtn.disabled = false;
    }
  }

  async function refreshPasteProtection() {
    if (!pasteProtectStatus) return;
    if (!smsIndividualTracking || destMode() !== 'paste') {
      pasteProtectStatus.textContent = '';
      return;
    }
    const seriesId = selectedSeriesId();
    const phones = parsePhones(phonesInput.value);
    if (!seriesId || !phones.length) {
      pasteProtectStatus.textContent = seriesId
        ? ''
        : 'Elegí una serie para validar teléfonos protegidos.';
      return;
    }
    pasteProtectStatus.textContent = 'Validando teléfonos contra la serie…';
    try {
      const res = await fetch(API_BASE + '/sms/contacts/classify-for-series', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          campaign_series_id: seriesId,
          phones: phones,
        }),
      });
      const body = await readJsonSafe(res);
      if (!res.ok) {
        pasteProtectStatus.textContent =
          (body && body.error) || 'No se pudo validar la lista.';
        return;
      }
      const clicked = (body && body.protected_clicked) || [];
      const excluded = (body && body.excluded_from_campaigns) || [];
      const ok = (body && body.ok) || [];
      if (!clicked.length && !excluded.length) {
        pasteProtectStatus.textContent =
          ok.length + ' teléfono(s) listos (sin protección de esta serie).';
        return;
      }
      const bits = [];
      if (clicked.length) {
        bits.push(
          clicked.length + ' protegido(s) por click: ' + clicked.join(', '),
        );
      }
      if (excluded.length) {
        bits.push(
          excluded.length +
            ' exclusión definitiva: ' +
            excluded.join(', '),
        );
      }
      pasteProtectStatus.textContent =
        bits.join(' ') + ' El envío se rechazará hasta sacarlos de la lista.';
    } catch (_err) {
      pasteProtectStatus.textContent = 'No se pudo validar la lista.';
    }
  }

  function estimateSmsSegments(text) {
    const chars = Array.from(String(text || ''));
    let gsmSeptets = 0;
    let allGsm = true;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (gsm7BasicSet.has(ch)) {
        gsmSeptets += 1;
      } else if (gsm7ExtSet.has(ch)) {
        gsmSeptets += 2;
      } else {
        allGsm = false;
        break;
      }
    }

    if (allGsm) {
      const units = gsmSeptets;
      let segments = 1;
      if (units === 0) segments = 0;
      else if (units <= 160) segments = 1;
      else segments = Math.ceil(units / 153);
      return {
        encoding: 'GSM-7',
        units: units,
        unitLabel: 'septetos',
        segments: segments,
        chars: chars.length,
      };
    }

    const units = chars.length;
    let segments = 1;
    if (units === 0) segments = 0;
    else if (units <= 70) segments = 1;
    else segments = Math.ceil(units / 67);
    return {
      encoding: 'UCS-2',
      units: units,
      unitLabel: 'caracteres',
      segments: segments,
      chars: chars.length,
    };
  }

  function looksLikeHttpUrl(raw) {
    if (raw == null || String(raw).trim() === '') return false;
    try {
      const u = new URL(String(raw).trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  const PREVIEW_SHORT_DEBOUNCE_MS = 700;
  const previewShortCache = new Map();
  const previewShortFailed = new Set();
  const previewShortInflight = new Map();
  let previewShortTimer = null;
  let previewShortPendingKey = null;
  let lastPreviewFetchKey = null;

  function currentDestinationKey() {
    return String(destinationUrlInput.value || '').trim();
  }

  function composePreviewUrl(destinationUrl, utmCampaign) {
    const raw = String(destinationUrl || '').trim();
    if (!looksLikeHttpUrl(raw)) return null;
    try {
      const url = new URL(raw);
      url.searchParams.set('utm_source', 'sms');
      url.searchParams.set('utm_medium', 'sms');
      url.searchParams.set('utm_campaign', String(utmCampaign || 'PENDING'));
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  function buildComposedMessage(messageBody, finalUrl) {
    const body = String(messageBody || '');
    const url = String(finalUrl || '');
    if (!url) return body;
    if (!body) return url;
    return body + ' ' + url;
  }

  function messageBodyHasHttpUrl(text) {
    return /https?:\/\//i.test(String(text == null ? '' : text));
  }

  // Keep in sync with src/lib/smsCampaignContacts.js applyNombrePlaceholder.
  const NOMBRE_PLACEHOLDER = '{{nombre}}';
  const SMS_MAX_MESSAGE_CHARS = 160;
  const PREVIEW_EXAMPLE_NOMBRE = 'María del Valle';

  function titleCaseNombre(raw) {
    const trimmed = String(raw == null ? '' : raw).trim();
    if (!trimmed) return '';
    return trimmed
      .split(/\s+/)
      .map(function (word) {
        const lower = word.toLocaleLowerCase('es');
        if (!lower) return '';
        return lower.charAt(0).toLocaleUpperCase('es') + lower.slice(1);
      })
      .filter(Boolean)
      .join(' ');
  }

  function countSmsChars(text) {
    return Array.from(String(text == null ? '' : text)).length;
  }

  function replaceNombre(messageBody, inserted) {
    const body = String(messageBody == null ? '' : messageBody);
    let out;
    if (inserted) {
      out = body.split(NOMBRE_PLACEHOLDER).join(inserted);
    } else {
      out = body.split(NOMBRE_PLACEHOLDER).join('');
      out = out.replace(/[ \t]{2,}/g, ' ');
      out = out.replace(/ +([,.;:!?])/g, '$1');
      out = out.replace(/^ +/, '');
    }
    return out.replace(/ +$/g, '').replace(/  +/g, ' ');
  }

  function applyNombrePlaceholder(messageBody, nombreRaw, options) {
    const opts = options || {};
    const shouldFit = opts.link != null || opts.maxChars != null;
    const titled = titleCaseNombre(nombreRaw);
    if (!shouldFit) {
      return replaceNombre(messageBody, titled);
    }

    const link = opts.link != null ? String(opts.link) : '';
    const maxCharsRaw =
      opts.maxChars != null ? Number(opts.maxChars) : SMS_MAX_MESSAGE_CHARS;
    const maxChars =
      Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
        ? maxCharsRaw
        : SMS_MAX_MESSAGE_CHARS;

    const titledChars = Array.from(titled);
    if (titledChars.length < 2) {
      return replaceNombre(messageBody, '');
    }

    function fits(resolvedBody) {
      return countSmsChars(buildComposedMessage(resolvedBody, link)) <= maxChars;
    }

    let resolved = replaceNombre(messageBody, titled);
    if (fits(resolved)) return resolved;

    for (let n = titledChars.length - 1; n >= 2; n -= 1) {
      resolved = replaceNombre(messageBody, titledChars.slice(0, n).join(''));
      if (fits(resolved)) return resolved;
    }
    return replaceNombre(messageBody, '');
  }

  function resolvePreviewMessageBody(messageBody, previewUrl) {
    const body = String(messageBody == null ? '' : messageBody);
    if (body.indexOf(NOMBRE_PLACEHOLDER) === -1) return body;
    const skipAutoLink = messageBodyHasHttpUrl(body);
    return applyNombrePlaceholder(body, PREVIEW_EXAMPLE_NOMBRE, {
      link: skipAutoLink ? '' : previewUrl || '',
      maxChars: SMS_MAX_MESSAGE_CHARS,
    });
  }

  function encodingHintPrefix(linkKind) {
    if (linkKind === 'final') return 'Segmentos definitivos';
    if (linkKind === 'short-preview') {
      return 'Estimación sobre link acortado de preview (no es el de la campaña)';
    }
    if (linkKind === 'shortening') {
      return 'Estimación provisional (URL larga; acortando…)';
    }
    if (linkKind === 'long-fallback') {
      return 'Estimación sobre URL larga (Link corto no disponible)';
    }
    if (linkKind === 'manual-link') {
      return 'Estimación sobre el mensaje (sin link automático)';
    }
    return 'Estimación sobre vista previa';
  }

  function updateEncodingHint(options) {
    const opts = options || {};
    const phones =
      destMode() === 'list'
        ? Array(
            Math.max(
              0,
              parseInt(String(fromLimitInput.value || '0'), 10) || 0,
            ),
          )
        : parsePhones(phonesInput.value);
    const messageBody = messageInput.value;
    const destKey = currentDestinationKey();
    const overrideUrl = opts.finalUrl != null ? String(opts.finalUrl) : null;
    const utmValue =
      opts.utmCampaignValue != null ? String(opts.utmCampaignValue) : 'PENDING';

    let previewUrl = null;
    let linkKind = 'none';
    if (overrideUrl) {
      previewUrl = overrideUrl;
      linkKind = 'final';
    } else if (previewShortCache.has(destKey)) {
      previewUrl = previewShortCache.get(destKey);
      linkKind = 'short-preview';
    } else if (looksLikeHttpUrl(destKey) && previewShortPendingKey === destKey) {
      previewUrl = composePreviewUrl(destKey, utmValue);
      linkKind = 'shortening';
    } else if (looksLikeHttpUrl(destKey) && previewShortFailed.has(destKey)) {
      previewUrl = composePreviewUrl(destKey, utmValue);
      linkKind = 'long-fallback';
    } else {
      previewUrl = composePreviewUrl(destKey, utmValue);
      linkKind = previewUrl ? 'long-preview' : 'none';
    }

    const skipAutoLink = messageBodyHasHttpUrl(messageBody);
    if (skipAutoLink) {
      previewUrl = '';
      linkKind = 'manual-link';
    }

    const resolvedBody = resolvePreviewMessageBody(messageBody, previewUrl || '');
    const composed = buildComposedMessage(resolvedBody, previewUrl || '');
    const est = estimateSmsSegments(composed);
    const isFinal = linkKind === 'final';
    const hasNombrePlaceholder =
      String(messageBody || '').indexOf(NOMBRE_PLACEHOLDER) !== -1;

    if (composePreviewText) {
      composePreviewText.textContent = composed || '(escribí el mensaje y la URL de destino)';
    }
    if (composePreviewLabel) {
      if (isFinal) {
        composePreviewLabel.textContent =
          'Mensaje definitivo enviado (cuerpo + URL final con UTM)';
      } else if (linkKind === 'short-preview') {
        composePreviewLabel.textContent = hasNombrePlaceholder
          ? 'Vista previa (link acortado de preview; nombre de ejemplo «María del Valle», puede truncarse)'
          : 'Vista previa (cuerpo + link acortado de preview; no es el link de la campaña)';
      } else if (linkKind === 'manual-link') {
        composePreviewLabel.textContent =
          'Vista previa (el mensaje ya incluye un link; no se agrega el automático)';
      } else if (linkKind === 'shortening') {
        composePreviewLabel.textContent =
          'Vista previa provisional (cuerpo + URL larga; acortando…)';
      } else {
        composePreviewLabel.textContent = hasNombrePlaceholder
          ? 'Vista previa (nombre de ejemplo «María del Valle»; puede truncarse a 160 caracteres)'
          : 'Vista previa del mensaje (cuerpo + URL con utm_campaign=PENDING)';
      }
    }

    encodingHint.textContent =
      encodingHintPrefix(linkKind) +
      ': ' +
      est.chars +
      ' caracteres · ' +
      est.segments +
      ' segmento(s), encoding ' +
      est.encoding +
      ' (' +
      est.units +
      ' ' +
      est.unitLabel +
      '). El comportamiento del proveedor puede diferir.';

    if (phones.length > 2000) {
      batchWarn.hidden = false;
      batchWarn.textContent =
        'La campaña supera los 2000 mensajes. El backend la dividirá automáticamente en varios lotes del proveedor.';
    } else {
      batchWarn.hidden = true;
      batchWarn.textContent = '';
    }
  }

  async function fetchPreviewShort(key) {
    if (previewShortCache.has(key)) {
      if (previewShortPendingKey === key) previewShortPendingKey = null;
      if (currentDestinationKey() === key) updateEncodingHint();
      return;
    }
    if (previewShortInflight.has(key)) {
      await previewShortInflight.get(key);
      if (previewShortPendingKey === key) previewShortPendingKey = null;
      if (currentDestinationKey() === key) updateEncodingHint();
      return;
    }
    if (lastPreviewFetchKey === key && previewShortFailed.has(key)) {
      if (previewShortPendingKey === key) previewShortPendingKey = null;
      if (currentDestinationKey() === key) updateEncodingHint();
      return;
    }
    lastPreviewFetchKey = key;
    previewShortPendingKey = key;
    if (currentDestinationKey() === key) updateEncodingHint();

    const pending = (async function () {
      try {
        const res = await fetch(API_BASE + '/sms/preview-short-url', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ destination_url: key }),
        });
        const body = await readJsonSafe(res);
        const shortUrl =
          body && body.short_url != null && String(body.short_url).trim() !== ''
            ? String(body.short_url).trim()
            : '';
        if (shortUrl) {
          previewShortCache.set(key, shortUrl);
          previewShortFailed.delete(key);
        } else {
          previewShortFailed.add(key);
        }
      } catch (_err) {
        previewShortFailed.add(key);
      }
    })();

    previewShortInflight.set(key, pending);
    try {
      await pending;
    } finally {
      previewShortInflight.delete(key);
    }
    if (previewShortPendingKey === key) {
      previewShortPendingKey = null;
    }
    if (currentDestinationKey() === key) {
      updateEncodingHint();
    }
  }

  function schedulePreviewShort() {
    if (previewShortTimer) {
      clearTimeout(previewShortTimer);
      previewShortTimer = null;
    }
    const key = currentDestinationKey();
    if (messageBodyHasHttpUrl(messageInput.value)) {
      previewShortPendingKey = null;
      updateEncodingHint();
      return;
    }
    if (!looksLikeHttpUrl(key)) {
      previewShortPendingKey = null;
      updateEncodingHint();
      return;
    }
    if (previewShortCache.has(key)) {
      previewShortPendingKey = null;
      updateEncodingHint();
      return;
    }
    previewShortPendingKey = key;
    updateEncodingHint();
    previewShortTimer = setTimeout(function () {
      previewShortTimer = null;
      fetchPreviewShort(key);
    }, PREVIEW_SHORT_DEBOUNCE_MS);
  }

  async function readJsonSafe(res) {
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function formatBackendPayload(body) {
    if (body == null) return 'Respuesta vacía o no JSON.';
    if (typeof body === 'string') return body;
    try {
      return JSON.stringify(body, null, 2);
    } catch (e) {
      return String(body);
    }
  }

  function formatProtectedPayload(body) {
    if (!body || typeof body !== 'object') return '';
    const clicked = Array.isArray(body.protected_clicked)
      ? body.protected_clicked
      : [];
    const excluded = Array.isArray(body.excluded_from_campaigns)
      ? body.excluded_from_campaigns
      : [];
    if (!clicked.length && !excluded.length) return '';
    const lines = [body.error || 'Hay teléfonos protegidos.'];
    if (clicked.length) {
      lines.push('Protegidos por click: ' + clicked.join(', '));
    }
    if (excluded.length) {
      lines.push('Exclusión definitiva: ' + excluded.join(', '));
    }
    return lines.join('\n');
  }

  function showListView() {
    detailSection.classList.add('hidden');
    detailSection.setAttribute('hidden', '');
    if (listSection) listSection.hidden = false;
    if (createSection) createSection.hidden = false;
    activeCampaignId = null;
  }

  function showDetailView() {
    detailSection.classList.remove('hidden');
    detailSection.removeAttribute('hidden');
    if (listSection) listSection.hidden = true;
    if (createSection) createSection.hidden = true;
  }

  function pickAggregates(campaign) {
    const agg = campaign && campaign.aggregates ? campaign.aggregates : {};
    const cost = campaign && campaign.cost ? campaign.cost : {};
    return {
      total:
        agg.total != null
          ? agg.total
          : campaign && campaign.total_messages != null
            ? campaign.total_messages
            : null,
      delivered: agg.delivered != null ? agg.delivered : null,
      failed: agg.failed != null ? agg.failed : null,
      responded: agg.responded != null ? agg.responded : null,
      pending: agg.pending != null ? agg.pending : null,
      estimated_cost: cost.estimated_cost != null ? cost.estimated_cost : null,
      currency:
        cost.currency != null
          ? cost.currency
          : cost.currency_code != null
            ? cost.currency_code
            : null,
      messages_sent: cost.messages_sent != null ? cost.messages_sent : null,
      messages_delivered:
        cost.messages_delivered != null ? cost.messages_delivered : null,
      status_counts: agg.status_counts || null,
    };
  }

  function campaignSeriesLabel(campaign) {
    const id =
      campaign && campaign.campaign_series_id != null
        ? String(campaign.campaign_series_id)
        : '';
    if (!id) return '';
    const row = smsSeriesById[id];
    if (row && row.name) return String(row.name);
    return id;
  }

  function formatPct(val) {
    if (val === null || val === undefined || typeof val !== 'number' || Number.isNaN(val)) {
      return '—';
    }
    return val.toFixed(1) + '%';
  }

  function renderCampaignList(campaigns, analyticsByCampaignId = {}) {
    const rows = Array.isArray(campaigns) ? campaigns.slice() : [];
    rows.sort((a, b) => {
      const ca = String((a && a.created_at) || '');
      const cb = String((b && b.created_at) || '');
      if (ca === cb) return 0;
      return ca < cb ? 1 : -1;
    });

    if (!rows.length) {
      listEl.innerHTML =
        '<div class="sms-empty">No hay campañas SMS todavía.</div>';
      return;
    }

    const body = rows
      .map((c) => {
        const id = String((c && c.id) || '');
        const agg = pickAggregates(c);
        const status = dash(c && c.status);
        const costCell =
          agg.estimated_cost === null || agg.estimated_cost === undefined
            ? '—<div class="sms-cost-note">Costo pendiente de configurar</div>'
            : escapeHtml(formatCost(agg.estimated_cost, agg.currency));

        const trk = analyticsByCampaignId[id] || null;
        const seriesName = trk && trk.campaign_series_name
          ? trk.campaign_series_name
          : campaignSeriesLabel(c) || '—';

        const mainRow =
          '<tr class="sms-row" tabindex="0" role="button" data-campaign-id="' +
          escapeHtml(id) +
          '" aria-label="Abrir detalle de campaña">' +
          '<td>' +
          escapeHtml(dash(c && c.name)) +
          '</td>' +
          '<td>' +
          escapeHtml(dash(c && c.created_at)) +
          '</td>' +
          '<td><span class="sms-badge' +
          campaignStatusClass(c && c.status) +
          '">' +
          escapeHtml(status) +
          '</span></td>' +
          '<td>' +
          escapeHtml(formatCount(agg.total)) +
          '</td>' +
          '<td>' +
          escapeHtml(formatCount(agg.delivered)) +
          '</td>' +
          '<td>' +
          escapeHtml(formatCount(agg.failed)) +
          '</td>' +
          '<td>' +
          escapeHtml(formatCount(agg.responded)) +
          '</td>' +
          '<td>' +
          escapeHtml(formatCount(agg.pending)) +
          '</td>' +
          '<td>' +
          costCell +
          '</td>' +
          '<td>' +
          '<div style="display:flex;gap:4px;">' +
          '<button type="button" class="btn btn-sm sms-tracking-toggle-btn" data-campaign-id="' +
          escapeHtml(id) +
          '">Tracking</button>' +
          '<button type="button" class="btn sms-open-btn" data-campaign-id="' +
          escapeHtml(id) +
          '">Ver</button>' +
          '</div>' +
          '</td>' +
          '</tr>';

        const trkDelivered = trk ? formatCount(trk.messages_delivered) + ' / ' + formatCount(trk.messages_sent) : '—';
        const trkDeliveredSub = trk ? formatPct(trk.delivery_pct) + ' entrega' : '';

        const trkClicks = trk ? formatCount(trk.total_clicks) : '—';
        const trkClicksSub = trk ? formatPct(trk.ctr_delivered_pct) + ' s/entr. · ' + formatPct(trk.ctr_sent_pct) + ' s/env.' : '';

        const trkStep1 = trk ? formatCount(trk.total_form_step_1) : '—';
        const trkStep1Sub = trk ? formatPct(trk.step_1_pct) + ' s/entr. · ' + formatPct(trk.step_1_from_click_pct) + ' s/click' : '';

        const trkStep2 = trk ? formatCount(trk.total_form_step_2) : '—';
        const trkStep2Sub = trk ? formatPct(trk.step_2_pct) + ' s/entr. · ' + formatPct(trk.step_2_from_step_1_pct) + ' s/paso 1' : '';

        const trkStep3 = trk ? formatCount(trk.total_form_step_3) : '—';
        const trkStep3Sub = trk ? formatPct(trk.step_3_pct) + ' s/entr. · ' + formatPct(trk.step_3_from_step_2_pct) + ' s/paso 2' : '';

        const trkSol = trk ? formatCount(trk.total_solicitudes) : '—';
        const trkSolSub = trk ? formatCount(trk.impacts_with_solicitud) + ' SMS (' + formatPct(trk.solicitud_conversion_pct) + ' conv.)' : '';

        const trackingRow =
          '<tr class="sms-tracking-row" id="sms-tracking-row-' +
          escapeHtml(id) +
          '" style="display:none;">' +
          '<td colspan="10">' +
          '<div class="sms-tracking-box">' +
          '<div class="sms-tracking-box-header">' +
          '<span>🎯 Embudo de seguimiento individual</span>' +
          '<span>Serie: <strong>' + escapeHtml(seriesName) + '</strong></span>' +
          '</div>' +
          '<div class="sms-tracking-box-metrics">' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkDelivered) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Entregados</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkDeliveredSub) + '</div>' +
          '</div>' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkClicks) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Clicks</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkClicksSub) + '</div>' +
          '</div>' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkStep1) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Paso 1</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkStep1Sub) + '</div>' +
          '</div>' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkStep2) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Paso 2</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkStep2Sub) + '</div>' +
          '</div>' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkStep3) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Paso 3</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkStep3Sub) + '</div>' +
          '</div>' +
          '<div class="sms-tracking-metric-card">' +
          '<div class="sms-tracking-metric-val">' + escapeHtml(trkSol) + '</div>' +
          '<div class="sms-tracking-metric-lbl">Solicitudes</div>' +
          '<div class="sms-tracking-metric-sub">' + escapeHtml(trkSolSub) + '</div>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</td>' +
          '</tr>';

        return mainRow + trackingRow;
      })
      .join('');

    listEl.innerHTML =
      '<details class="cz-funnel-block sms-campaigns-block">' +
      '<summary class="sms-section-title">' +
      '<span class="cz-funnel-chevron">▶</span> ' +
      '<span>Campañas (' + rows.length + ')</span>' +
      '</summary>' +
      '<div class="sms-table-wrap" style="margin-top:10px;"><table class="sms-table">' +
      '<thead><tr>' +
      '<th>Nombre</th><th>Creada</th><th>Estado</th><th>Total</th>' +
      '<th>Entregados</th><th>Fallidos</th><th>Respondidos</th><th>Pendientes</th>' +
      '<th>Costo est.</th><th>Acciones</th>' +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div></details>';
  }

  async function loadMonthlySummary() {
    if (!monthlySummaryBody || monthlyBusy) return;
    monthlyBusy = true;
    if (monthlySummaryStatus) {
      setStatus(monthlySummaryStatus, 'Cargando resumen del mes…', false);
    }
    try {
      const [costRes, sessionsRes, analyticsRes] = await Promise.all([
        fetch(API_BASE + '/sms/campaigns/summary/monthly', {
          headers: { Accept: 'application/json' },
        }),
        fetch(API_BASE + '/sms/campaigns/summary/monthly/sessions', {
          headers: { Accept: 'application/json' },
        }),
        fetch(API_BASE + '/sms/analytics/performance', {
          headers: { Accept: 'application/json' },
        }).catch(() => null),
      ]);
      const body = await readJsonSafe(costRes);
      const sessionsBody = await readJsonSafe(sessionsRes);
      const analyticsBody = analyticsRes ? await readJsonSafe(analyticsRes) : null;

      if (!costRes.ok) {
        if (monthlySummaryStatus) {
          setStatus(
            monthlySummaryStatus,
            (body && (body.error || formatBackendPayload(body))) ||
              'No se pudo cargar el resumen mensual.',
            true,
          );
        }
        monthlySummaryBody.innerHTML = '';
        return;
      }

      const monthLabel = formatMonthLabel(body && body.month);
      const delivered =
        body && body.messages_delivered != null
          ? formatCount(body.messages_delivered)
          : '—';
      const costNull =
        !body || body.estimated_cost === null || body.estimated_cost === undefined;
      const costValue = costNull
        ? '—'
        : formatCost(body.estimated_cost);
      const costNote = costNull
        ? '<div class="sms-monthly-cost-note">Costo pendiente de configurar</div>'
        : '<div class="sms-monthly-cost-note">IVA incluido</div>';

      let sessionsValue = '—';
      let sessionsNote =
        '<div class="sms-monthly-cost-note">No se pudo consultar GA4</div>';
      if (sessionsRes.ok && sessionsBody) {
        if (sessionsBody.query_status === 'success') {
          sessionsValue = formatCount(sessionsBody.sessions);
          sessionsNote = '';
        } else if (sessionsBody.query_status === 'error') {
          sessionsValue = '—';
          sessionsNote =
            '<div class="sms-monthly-cost-note">No se pudo consultar GA4</div>';
        }
      }

      let currentMonthAnalytics = null;
      if (analyticsBody && analyticsBody.ok && analyticsBody.data) {
        const monthlySummaryList = analyticsBody.data.monthly_summary || [];
        currentMonthAnalytics = monthlySummaryList.find((m) => m.is_current_month) || null;
      }

      const clicksVal = currentMonthAnalytics ? formatCount(currentMonthAnalytics.total_clicks) : '—';
      const clicksNote = currentMonthAnalytics
        ? (currentMonthAnalytics.ctr_delivered_pct !== null
            ? escapeHtml(formatPct(currentMonthAnalytics.ctr_delivered_pct)) + ' s/entregados'
            : (currentMonthAnalytics.total_clicks > 0 ? 'Entrega pendiente' : 'Sin clicks'))
        : '<div class="sms-monthly-cost-note">Tracking no disponible</div>';

      const step1Val = currentMonthAnalytics ? formatCount(currentMonthAnalytics.total_form_step_1) : '—';
      const step1Note = currentMonthAnalytics
        ? (currentMonthAnalytics.step_1_pct !== null
            ? escapeHtml(formatPct(currentMonthAnalytics.step_1_pct)) + ' s/entregados'
            : (currentMonthAnalytics.step_1_from_click_pct !== null
                ? escapeHtml(formatPct(currentMonthAnalytics.step_1_from_click_pct)) + ' s/clicks'
                : '—'))
        : '';

      const step2Val = currentMonthAnalytics ? formatCount(currentMonthAnalytics.total_form_step_2) : '—';
      const step2Note = currentMonthAnalytics
        ? (currentMonthAnalytics.step_2_pct !== null
            ? escapeHtml(formatPct(currentMonthAnalytics.step_2_pct)) + ' s/entregados'
            : (currentMonthAnalytics.step_2_from_step_1_pct !== null
                ? escapeHtml(formatPct(currentMonthAnalytics.step_2_from_step_1_pct)) + ' s/paso 1'
                : '—'))
        : '';

      const step3Val = currentMonthAnalytics ? formatCount(currentMonthAnalytics.total_form_step_3) : '—';
      const step3Note = currentMonthAnalytics
        ? (currentMonthAnalytics.step_3_pct !== null
            ? escapeHtml(formatPct(currentMonthAnalytics.step_3_pct)) + ' s/entregados'
            : (currentMonthAnalytics.step_3_from_step_2_pct !== null
                ? escapeHtml(formatPct(currentMonthAnalytics.step_3_from_step_2_pct)) + ' s/paso 2'
                : '—'))
        : '';

      const solVal = currentMonthAnalytics ? formatCount(currentMonthAnalytics.total_solicitudes) : '—';
      const solNote = currentMonthAnalytics
        ? (currentMonthAnalytics.solicitud_conversion_pct !== null
            ? escapeHtml(formatPct(currentMonthAnalytics.solicitud_conversion_pct)) + ' conv. (' + formatCount(currentMonthAnalytics.impacts_with_solicitud) + ' SMS)'
            : (currentMonthAnalytics.impacts_with_solicitud > 0 ? formatCount(currentMonthAnalytics.impacts_with_solicitud) + ' SMS con sol.' : 'Sin solicitudes'))
        : '';

      let cardsHtml =
        '<div class="kpi-card is-neutral">' +
        '<div class="kpi-value">' +
        escapeHtml(monthLabel) +
        '</div>' +
        '<div class="kpi-label">Mes (entregas)</div>' +
        '</div>' +
        '<div class="kpi-card is-accent">' +
        '<div class="kpi-value">' +
        escapeHtml(delivered) +
        '</div>' +
        '<div class="kpi-label">SMS entregados este mes</div>' +
        '</div>' +
        '<div class="kpi-card is-success">' +
        '<div class="kpi-value">' +
        escapeHtml(costValue) +
        '</div>' +
        '<div class="kpi-label">Costo estimado</div>' +
        costNote +
        '</div>' +
        '<div class="kpi-card is-neutral">' +
        '<div class="kpi-value">' +
        escapeHtml(sessionsValue) +
        '</div>' +
        '<div class="kpi-label">Sesiones desde SMS</div>' +
        sessionsNote +
        '</div>' +
        '<div class="kpi-card is-accent">' +
        '<div class="kpi-value">' +
        escapeHtml(clicksVal) +
        '</div>' +
        '<div class="kpi-label">Clicks</div>' +
        '<div class="sms-monthly-cost-note">' + clicksNote + '</div>' +
        '</div>' +
        '<div class="kpi-card is-neutral">' +
        '<div class="kpi-value">' +
        escapeHtml(step1Val) +
        '</div>' +
        '<div class="kpi-label">Paso 1</div>' +
        '<div class="sms-monthly-cost-note">' + escapeHtml(step1Note) + '</div>' +
        '</div>' +
        '<div class="kpi-card is-neutral">' +
        '<div class="kpi-value">' +
        escapeHtml(step2Val) +
        '</div>' +
        '<div class="kpi-label">Paso 2</div>' +
        '<div class="sms-monthly-cost-note">' + escapeHtml(step2Note) + '</div>' +
        '</div>' +
        '<div class="kpi-card is-neutral">' +
        '<div class="kpi-value">' +
        escapeHtml(step3Val) +
        '</div>' +
        '<div class="kpi-label">Paso 3</div>' +
        '<div class="sms-monthly-cost-note">' + escapeHtml(step3Note) + '</div>' +
        '</div>' +
        '<div class="kpi-card is-success">' +
        '<div class="kpi-value">' +
        escapeHtml(solVal) +
        '</div>' +
        '<div class="kpi-label">Solicitudes</div>' +
        '<div class="sms-monthly-cost-note">' + escapeHtml(solNote) + '</div>' +
        '</div>';

      let closedMonthsHtml = '';
      if (analyticsBody && analyticsBody.ok && analyticsBody.data && Array.isArray(analyticsBody.data.monthly_summary)) {
        const closedMonths = analyticsBody.data.monthly_summary.filter((m) => !m.is_current_month);
        if (closedMonths.length > 0) {
          const closedBody = closedMonths.map((m) => (
            '<tr>' +
            '<td>' + escapeHtml(formatMonthLabel(m.cohort_month)) + '</td>' +
            '<td>' + escapeHtml(formatCount(m.messages_delivered)) + ' / ' + escapeHtml(formatCount(m.messages_sent)) + ' (' + escapeHtml(formatPct(m.delivery_pct)) + ')</td>' +
            '<td>' + escapeHtml(formatCount(m.total_clicks)) + ' (' + escapeHtml(formatPct(m.ctr_delivered_pct)) + ')</td>' +
            '<td>' + escapeHtml(formatCount(m.total_form_step_1)) + ' (' + escapeHtml(formatPct(m.step_1_pct)) + ')</td>' +
            '<td>' + escapeHtml(formatCount(m.total_form_step_2)) + ' (' + escapeHtml(formatPct(m.step_2_pct)) + ')</td>' +
            '<td>' + escapeHtml(formatCount(m.total_form_step_3)) + ' (' + escapeHtml(formatPct(m.step_3_pct)) + ')</td>' +
            '<td>' + escapeHtml(formatCount(m.total_solicitudes)) + ' (' + escapeHtml(formatPct(m.solicitud_conversion_pct)) + ')</td>' +
            '</tr>'
          )).join('');

          closedMonthsHtml =
            '<details class="cz-funnel-block sms-closed-months-block" style="margin-top:16px;">' +
            '<summary class="sms-section-title">' +
            '<span class="cz-funnel-chevron">▶</span> ' +
            '<span>Meses anteriores (' + closedMonths.length + ')</span>' +
            '</summary>' +
            '<div class="sms-table-wrap" style="margin-top:10px;"><table class="sms-table">' +
            '<thead><tr>' +
            '<th>Mes de cohorte</th><th>Entregados / Enviados</th><th>Clicks</th>' +
            '<th>Paso 1</th><th>Paso 2</th><th>Paso 3</th><th>Solicitudes</th>' +
            '</tr></thead><tbody>' +
            closedBody +
            '</tbody></table></div></details>';
        }
      }

      monthlySummaryBody.innerHTML = cardsHtml + closedMonthsHtml;
      if (monthlySummaryStatus) setStatus(monthlySummaryStatus, '', false);
    } catch (err) {
      if (monthlySummaryStatus) {
        setStatus(monthlySummaryStatus, 'No se pudo conectar con el servidor.', true);
      }
      monthlySummaryBody.innerHTML = '';
    } finally {
      monthlyBusy = false;
    }
  }

  async function loadCampaignList() {
    if (listBusy) return;
    listBusy = true;
    setStatus(listStatus, 'Cargando campañas…', false);
    try {
      const [res, analyticsRes] = await Promise.all([
        fetch(API_BASE + '/sms/campaigns', {
          headers: { Accept: 'application/json' },
        }),
        fetch(API_BASE + '/sms/analytics/performance', {
          headers: { Accept: 'application/json' },
        }).catch(() => null),
      ]);
      const body = await readJsonSafe(res);
      const analyticsBody = analyticsRes ? await readJsonSafe(analyticsRes) : null;

      if (!res.ok) {
        setStatus(
          listStatus,
          (body && (body.error || formatBackendPayload(body))) ||
            'No se pudo cargar el listado.',
          true,
        );
        listEl.innerHTML = '';
        return;
      }
      const campaigns = Array.isArray(body && body.campaigns)
        ? body.campaigns
        : Array.isArray(body)
          ? body
          : [];

      const analyticsByCampaignId = {};
      if (analyticsBody && analyticsBody.ok && analyticsBody.data && Array.isArray(analyticsBody.data.campaign_breakdown)) {
        for (const item of analyticsBody.data.campaign_breakdown) {
          if (item && item.campaign_id) {
            analyticsByCampaignId[String(item.campaign_id)] = item;
          }
        }
      }

      renderCampaignList(campaigns, analyticsByCampaignId);
      setStatus(listStatus, campaigns.length + ' campaña(s)', false);
    } catch (err) {
      setStatus(listStatus, 'No se pudo conectar con el servidor.', true);
      listEl.innerHTML = '';
    } finally {
      listBusy = false;
    }
  }

  function renderDetail(payload) {
    const campaign = (payload && payload.campaign) || {};
    const messages = Array.isArray(payload && payload.messages)
      ? payload.messages.slice()
      : [];
    messages.sort((a, b) => {
      const ao = a && a.submission_order != null ? a.submission_order : 0;
      const bo = b && b.submission_order != null ? b.submission_order : 0;
      return ao - bo;
    });

    const agg = pickAggregates(campaign);
    const costNote =
      agg.estimated_cost === null || agg.estimated_cost === undefined
        ? '<p class="sms-cost-note">Costo pendiente de configurar</p>'
        : '';

    const metaCards = [
      ['Nombre', dash(campaign.name)],
      ['Serie', dash(campaignSeriesLabel(campaign))],
      ['Creada', dash(campaign.created_at)],
      ['Estado', dash(campaign.status)],
      ['Total mensajes', formatCount(campaign.total_messages)],
      ['ID', dash(campaign.id)],
      ['Enviados (costo)', formatCount(agg.messages_sent)],
      ['Entregados (costo)', formatCount(agg.messages_delivered)],
      ['Costo estimado', formatCost(agg.estimated_cost, agg.currency)],
    ]
      .map(
        (pair) =>
          '<div class="sms-detail-card">' +
          '<div class="sms-detail-card-label">' +
          escapeHtml(pair[0]) +
          '</div>' +
          '<div class="sms-detail-card-value">' +
          escapeHtml(pair[1]) +
          '</div>' +
          '</div>',
      )
      .join('');

    const msgRows = messages
      .map((m) => {
        const uid = m && m.unique_id != null ? String(m.unique_id) : '';
        return (
          '<tr data-unique-id="' +
          escapeHtml(uid) +
          '">' +
          '<td>' +
          escapeHtml(formatCount(m && m.submission_order)) +
          '</td>' +
          '<td>' +
          escapeHtml(dash(m && m.phone)) +
          '</td>' +
          '<td><span class="sms-badge">' +
          escapeHtml(dash(m && m.status)) +
          '</span></td>' +
          '<td>' +
          escapeHtml(dash(m && m.fail_reason)) +
          '</td>' +
          '<td>' +
          escapeHtml(dash(m && m.delivered_at)) +
          '</td>' +
          '<td>' +
          escapeHtml(dash(m && m.response_text)) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    detailBody.innerHTML =
      '<div class="sms-detail-actions">' +
      '<button type="button" class="btn btn-primary" id="sms-poll-btn">Actualizar estado</button>' +
      '</div>' +
      costNote +
      '<div class="sms-detail-meta">' +
      metaCards +
      '</div>' +
      (messages.length
        ? '<div class="sms-table-wrap"><table class="sms-table">' +
          '<thead><tr>' +
          '<th>#</th><th>Teléfono</th><th>Estado</th><th>Motivo</th>' +
          '<th>Entregado</th><th>Respuesta</th>' +
          '</tr></thead><tbody>' +
          msgRows +
          '</tbody></table></div>'
        : '<div class="sms-empty">Esta campaña no tiene mensajes.</div>');

    const pollBtn = document.getElementById('sms-poll-btn');
    if (pollBtn) {
      pollBtn.addEventListener('click', () => {
        if (activeCampaignId) pollCampaign(activeCampaignId);
      });
    }
  }

  async function openCampaignDetail(campaignId) {
    const id = String(campaignId || '');
    if (!id) return;
    activeCampaignId = id;
    showDetailView();
    setStatus(detailStatus, 'Cargando detalle…', false);
    detailBody.innerHTML = '';
    try {
      const res = await fetch(
        API_BASE + '/sms/campaigns/' + encodeURIComponent(id),
        {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        },
      );
      const body = await readJsonSafe(res);
      if (!res.ok) {
        setStatus(
          detailStatus,
          (body && (body.error || formatBackendPayload(body))) ||
            'No se pudo cargar el detalle.',
          true,
        );
        return;
      }
      renderDetail(body);
      setStatus(detailStatus, '', false);
    } catch (err) {
      setStatus(detailStatus, 'No se pudo conectar con el servidor.', true);
    }
  }

  async function pollCampaign(campaignId) {
    const id = String(campaignId || '');
    if (!id || pollBusy) return;
    pollBusy = true;
    const pollBtn = document.getElementById('sms-poll-btn');
    if (pollBtn) {
      pollBtn.disabled = true;
      pollBtn.textContent = 'Actualizando…';
    }
    setStatus(detailStatus, 'Consultando Notifyme…', false);
    try {
      const res = await fetch(
        API_BASE + '/sms/campaigns/' + encodeURIComponent(id) + '/poll',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        },
      );
      const body = await readJsonSafe(res);
      if (!res.ok) {
        setStatus(
          detailStatus,
          (body && (body.error || formatBackendPayload(body))) ||
            'Falló la actualización de estado.',
          true,
        );
        return;
      }

      // Re-render full detail (summary cards + per-message table) from poll
      // payload when messages are included; otherwise re-fetch GET.
      if (body && body.campaign && Array.isArray(body.messages)) {
        activeCampaignId = id;
        showDetailView();
        renderDetail(body);
      } else {
        await openCampaignDetail(id);
      }
      await loadCampaignList();
      setStatus(detailStatus, 'Estado actualizado.', false);
    } catch (err) {
      setStatus(detailStatus, 'No se pudo conectar con el servidor.', true);
    } finally {
      pollBusy = false;
      const btn = document.getElementById('sms-poll-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Actualizar estado';
      }
    }
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (createBusy) return;

    const name = String(nameInput.value || '').trim();
    const messageBody = messageInput.value;
    const destinationUrl = String(destinationUrlInput.value || '').trim();
    const listMode = destMode() === 'list';
    const phones = listMode ? [] : parsePhones(phonesInput.value);
    const sourceSystem = String(sourceSystemInput.value || '').trim();
    const fromLimit = parseInt(String(fromLimitInput.value || ''), 10);
    const seriesId = selectedSeriesId();

    if (!name) {
      setStatus(createStatus, 'El nombre de la campaña es obligatorio.', true);
      return;
    }
    if (!listMode && !phones.length) {
      setStatus(createStatus, 'Ingresá al menos un teléfono (una línea no vacía).', true);
      return;
    }
    if (listMode) {
      if (!sourceSystem) {
        setStatus(createStatus, 'Elegí un source_system.', true);
        return;
      }
      if (!Number.isFinite(fromLimit) || fromLimit < 1 || fromLimit > 2000) {
        setStatus(
          createStatus,
          'La cantidad debe ser un entero entre 1 y 2000.',
          true,
        );
        return;
      }
    }
    if (!String(messageBody || '').trim()) {
      setStatus(createStatus, 'El mensaje no puede estar vacío.', true);
      return;
    }
    if (!looksLikeHttpUrl(destinationUrl)) {
      setStatus(
        createStatus,
        'La URL de destino debe ser una URL http(s) válida.',
        true,
      );
      return;
    }
    if (smsIndividualTracking && !seriesId) {
      setStatus(
        createStatus,
        'Elegí o creá una serie de campaña (obligatoria con tracking individual).',
        true,
      );
      return;
    }

    const waveSizeRaw = String(waveSizeInput.value || '').trim();
    const intervalRaw = String(waveIntervalInput.value || '').trim();
    let waveSize = null;
    if (waveSizeRaw !== '') {
      waveSize = parseInt(waveSizeRaw, 10);
      if (!Number.isInteger(waveSize) || waveSize < 1) {
        setStatus(
          createStatus,
          'SMS por tanda debe ser un entero ≥ 1, o vacío.',
          true,
        );
        return;
      }
    }
    const intervalSeconds =
      intervalRaw === '' ? 0 : parseInt(intervalRaw, 10);
    if (
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < 0 ||
      intervalSeconds > 86400
    ) {
      setStatus(
        createStatus,
        'El intervalo debe ser un entero entre 0 y 86400 segundos.',
        true,
      );
      return;
    }
    if (intervalSeconds > 0 && waveSize == null) {
      setStatus(
        createStatus,
        'SMS por tanda es obligatorio si el intervalo es mayor a 0.',
        true,
      );
      return;
    }

    createBusy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando…';
    setStatus(createStatus, 'Creando campaña…', false);

    try {
      const res = await fetch(API_BASE + '/sms/campaigns', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          listMode
            ? {
                name: name,
                destination_url: destinationUrl,
                message_body: messageBody,
                wave_size: waveSize,
                interval_seconds: intervalSeconds,
                campaign_series_id: smsIndividualTracking ? seriesId : undefined,
                from_contacts: {
                  source_system: sourceSystem,
                  limit: fromLimit,
                },
              }
            : {
                name: name,
                destination_url: destinationUrl,
                message_body: messageBody,
                wave_size: waveSize,
                interval_seconds: intervalSeconds,
                campaign_series_id: smsIndividualTracking ? seriesId : undefined,
                phones: phones,
              },
        ),
      });
      const body = await readJsonSafe(res);

      const campaign = (body && body.campaign) || null;
      const statusText = campaign && campaign.status ? String(campaign.status) : '';
      const idText = campaign && campaign.id != null ? String(campaign.id) : '';
      const totalText =
        campaign && campaign.total_messages != null
          ? String(campaign.total_messages)
          : body && body.summary && body.summary.total_messages != null
            ? String(body.summary.total_messages)
            : '';
      const finalUrl =
        body && body.final_url != null ? String(body.final_url) : '';
      const shortUrl =
        body && body.short_url != null
          ? String(body.short_url)
          : campaign && campaign.short_url != null
            ? String(campaign.short_url)
            : '';
      const individualTracking = body && body.individual_tracking === true;
      const sentUrl = individualTracking ? '' : (shortUrl || finalUrl);
      const utmValue =
        body && body.utm_campaign_value != null
          ? String(body.utm_campaign_value)
          : campaign && campaign.utm_campaign_value != null
            ? String(campaign.utm_campaign_value)
            : '';

      if (!res.ok) {
        const bits = [];
        if (idText) bits.push('ID: ' + idText);
        if (statusText) bits.push('Estado: ' + statusText);
        if (totalText) bits.push('Total: ' + totalText);
        if (finalUrl) bits.push('URL final: ' + finalUrl);
        if (shortUrl) bits.push('URL corta enviada: ' + shortUrl);
        bits.push(formatProtectedPayload(body) || formatBackendPayload(body));
        setStatus(createStatus, bits.join('\n'), true);
        if (idText) {
          await loadCampaignList();
          await loadMonthlySummary();
        }
        return;
      }

      if (sentUrl) {
        updateEncodingHint({
          finalUrl: sentUrl,
          utmCampaignValue: utmValue || idText,
        });
      }

      const okBits = [];
      if (idText) okBits.push('Campaña creada. ID: ' + idText);
      if (statusText) okBits.push('Estado: ' + statusText);
      if (totalText) okBits.push('Total: ' + totalText);
      if (utmValue) okBits.push('utm_campaign: ' + utmValue);
      if (finalUrl) okBits.push('URL final (con UTM): ' + finalUrl);
      if (shortUrl) {
        okBits.push('URL corta enviada en el SMS: ' + shortUrl);
      } else if (individualTracking) {
        okBits.push(
          'URL corta individual por destinatario (no hay short único de campaña)',
        );
      } else if (finalUrl) {
        okBits.push(
          'No se pudo acortar el link, se envió la URL completa',
        );
        okBits.push('URL enviada en el SMS: ' + finalUrl);
      }
      if (body && body.summary) {
        okBits.push('Resumen: ' + formatBackendPayload(body.summary));
      }
      createStatus.classList.remove('mcl-error');
      createStatus.innerHTML =
        '<div class="sms-create-result">' +
        escapeHtml(okBits.join('\n') || 'Campaña creada.') +
        '</div>';

      // Keep preview showing the URL actually sent; clear inputs after.
      form.reset();
      if (messageBodyHasHttpUrl(messageBody)) {
        if (composePreviewText) {
          composePreviewText.textContent =
            resolvePreviewMessageBody(messageBody, '') ||
            '(escribí el mensaje y la URL de destino)';
        }
        if (composePreviewLabel) {
          composePreviewLabel.textContent =
            'Mensaje enviado (sin link automático; el cuerpo ya incluía una URL)';
        }
        updateEncodingHint();
      } else if (sentUrl) {
        updateEncodingHint({
          finalUrl: sentUrl,
          utmCampaignValue: utmValue || idText,
        });
        if (composePreviewText) {
          composePreviewText.textContent = buildComposedMessage(
            resolvePreviewMessageBody(messageBody, sentUrl),
            sentUrl,
          );
        }
        if (composePreviewLabel) {
          composePreviewLabel.textContent = shortUrl
            ? 'Mensaje definitivo enviado (cuerpo + URL corta)'
            : 'Mensaje definitivo enviado (cuerpo + URL completa; acortado no disponible)';
        }
      } else {
        updateEncodingHint();
      }
      await loadCampaignList();
      await loadMonthlySummary();
      if (listSection && typeof listSection.scrollIntoView === 'function') {
        listSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) {
      setStatus(createStatus, 'No se pudo conectar con el servidor.', true);
    } finally {
      createBusy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Enviar campaña';
    }
  });

  listEl.addEventListener('click', (ev) => {
    const trackingBtn = ev.target.closest('.sms-tracking-toggle-btn');
    if (trackingBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const cid = trackingBtn.getAttribute('data-campaign-id');
      const trkRow = document.getElementById('sms-tracking-row-' + cid);
      if (trkRow) {
        const isHidden = trkRow.style.display === 'none';
        trkRow.style.display = isHidden ? 'table-row' : 'none';
        trackingBtn.classList.toggle('btn-primary', isHidden);
      }
      return;
    }
    const btn = ev.target.closest('.sms-open-btn');
    if (btn) {
      ev.preventDefault();
      ev.stopPropagation();
      openCampaignDetail(btn.getAttribute('data-campaign-id'));
      return;
    }
    const trkRow = ev.target.closest('tr.sms-tracking-row');
    if (trkRow) {
      return;
    }
    const row = ev.target.closest('tr.sms-row');
    if (row) {
      openCampaignDetail(row.getAttribute('data-campaign-id'));
    }
  });

  listEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = ev.target.closest('tr.sms-row');
    if (!row) return;
    ev.preventDefault();
    openCampaignDetail(row.getAttribute('data-campaign-id'));
  });

  reloadBtn.addEventListener('click', () => {
    loadCampaignList();
  });

  detailBackBtn.addEventListener('click', () => {
    showListView();
    loadCampaignList();
  });

  messageInput.addEventListener('input', () => updateEncodingHint());
  destinationUrlInput.addEventListener('input', () => schedulePreviewShort());
  form.querySelectorAll('input[name="sms-dest-mode"]').forEach(function (el) {
    el.addEventListener('change', syncDestModeUi);
  });
  sourceSystemInput.addEventListener('change', () => {
    if (destMode() === 'list') refreshEligibleCount();
  });
  fromLimitInput.addEventListener('input', () => updateEncodingHint());
  if (seriesSelect) {
    seriesSelect.addEventListener('change', () => {
      if (destMode() === 'list') refreshEligibleCount();
      refreshPasteProtection();
    });
  }
  if (seriesCreateBtn) {
    seriesCreateBtn.addEventListener('click', () => {
      createSeriesFromUi();
    });
  }
  phonesInput.addEventListener('input', () => {
    updateEncodingHint();
    refreshPasteProtection();
  });
  syncDestModeUi();

  window.__openSms = () => {
    showListView();
    loadMonthlySummary();
    loadCampaignList();
    loadSeriesBootstrap();
    openedOnce = true;
  };
})();

/* ----------------------------------------------------------------------------
 * Inbox — Instagram comments + DMs (FB/Messenger placeholders)
 * ------------------------------------------------------------------------- */
(function initInbox() {
  const panel = document.getElementById('inbox-panel');
  const statusEl = document.getElementById('inbox-status');
  const commentsEl = document.getElementById('inbox-comments-list');
  const dmsEl = document.getElementById('inbox-dms-list');
  const reloadBtn = document.getElementById('inbox-reload-btn');
  const actorInput = document.getElementById('inbox-actor');
  const igPane = document.getElementById('inbox-pane-instagram');
  const fbPane = document.getElementById('inbox-pane-facebook');
  const msgPane = document.getElementById('inbox-pane-messenger');
  const igTab = document.getElementById('inbox-ig-tab-btn');
  const fbTab = document.getElementById('inbox-fb-tab-btn');
  const msgTab = document.getElementById('inbox-msg-tab-btn');

  if (!panel || !statusEl || !commentsEl || !dmsEl || !reloadBtn) return;

  let busy = false;
  let openedOnce = false;

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function actorId() {
    const v = actorInput && typeof actorInput.value === 'string'
      ? actorInput.value.trim()
      : '';
    return v || 'user:dashboard';
  }

  async function readJsonSafe(res) {
    try {
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function formatWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('es-UY', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch (_) {
      return String(iso);
    }
  }

  function showChannel(name) {
    const map = {
      instagram: { pane: igPane, tab: igTab },
      facebook: { pane: fbPane, tab: fbTab },
      messenger: { pane: msgPane, tab: msgTab },
    };
    Object.keys(map).forEach((key) => {
      const show = key === name;
      const { pane, tab } = map[key];
      if (pane) {
        pane.classList.toggle('hidden', !show);
        if (show) pane.removeAttribute('hidden');
        else pane.setAttribute('hidden', '');
      }
      if (tab && !tab.disabled) {
        tab.classList.toggle('active', show);
        tab.setAttribute('aria-selected', show ? 'true' : 'false');
      }
    });
  }

  function renderComments(comments) {
    commentsEl.innerHTML = '';
    if (!comments.length) {
      commentsEl.innerHTML =
        '<div class="inbox-empty">No hay comentarios pendientes.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    comments.forEach((c) => {
      const card = document.createElement('article');
      card.className = 'inbox-card';
      card.setAttribute('data-comment-id', String(c.id));
      card.innerHTML =
        '<div class="inbox-card-meta">' +
        '<span class="inbox-badge is-pending">' +
        escapeHtml(c.status || 'pending') +
        '</span>' +
        '<span>@' +
        escapeHtml(c.from_username || 'desconocido') +
        '</span>' +
        '<span>' +
        escapeHtml(formatWhen(c.comment_timestamp)) +
        '</span>' +
        '<span class="mono">#' +
        escapeHtml(String(c.id)) +
        '</span>' +
        '</div>' +
        '<p class="inbox-card-text">' +
        escapeHtml(c.text || '(sin texto)') +
        '</p>' +
        '<div class="inbox-reply-row">' +
        '<textarea class="mcl-input inbox-reply-text" rows="2" placeholder="Escribí la respuesta…"></textarea>' +
        '<div class="inbox-reply-actions">' +
        '<button type="button" class="btn btn-primary inbox-reply-btn" data-kind="comment" data-id="' +
        escapeHtml(String(c.id)) +
        '">Responder</button>' +
        '<span class="inbox-card-feedback" data-feedback></span>' +
        '</div></div>';
      frag.appendChild(card);
    });
    commentsEl.appendChild(frag);
  }

  function renderDms(conversations) {
    dmsEl.innerHTML = '';
    if (!conversations.length) {
      dmsEl.innerHTML =
        '<div class="inbox-empty">No hay conversaciones pendientes.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    conversations.forEach((c) => {
      const windowCls =
        c.response_window_status === 'expiring'
          ? ' is-expiring'
          : c.response_window_status === 'open'
            ? ' is-pending'
            : '';
      const card = document.createElement('article');
      card.className = 'inbox-card';
      card.setAttribute('data-conversation-id', String(c.id));
      card.innerHTML =
        '<div class="inbox-card-meta">' +
        '<span class="inbox-badge is-pending">' +
        escapeHtml(c.status || 'pending') +
        '</span>' +
        (c.response_window_status
          ? '<span class="inbox-badge' +
            windowCls +
            '">' +
            escapeHtml(c.response_window_status) +
            '</span>'
          : '') +
        '<span>@' +
        escapeHtml(c.ig_username || c.recipient_ig_scoped_id || 'cliente') +
        '</span>' +
        '<span>Último inbound: ' +
        escapeHtml(formatWhen(c.last_inbound_at)) +
        '</span>' +
        '<span class="mono">#' +
        escapeHtml(String(c.id)) +
        '</span>' +
        '</div>' +
        '<p class="inbox-card-text">Ventana vence: ' +
        escapeHtml(formatWhen(c.response_window_expires_at)) +
        '</p>' +
        '<div class="inbox-reply-row">' +
        '<textarea class="mcl-input inbox-reply-text" rows="2" placeholder="Escribí el DM…"></textarea>' +
        '<div class="inbox-reply-actions">' +
        '<button type="button" class="btn btn-primary inbox-reply-btn" data-kind="dm" data-id="' +
        escapeHtml(String(c.id)) +
        '">Responder</button>' +
        '<span class="inbox-card-feedback" data-feedback></span>' +
        '</div></div>';
      frag.appendChild(card);
    });
    dmsEl.appendChild(frag);
  }

  async function loadInbox() {
    if (busy) return;
    busy = true;
    setStatus('Cargando inbox…', false);
    try {
      const [commentsRes, dmsRes] = await Promise.all([
        fetch(API_BASE + '/api/social-comments?status=pending&limit=50', {
          headers: { Accept: 'application/json' },
        }),
        fetch(API_BASE + '/api/social-conversations?status=pending&limit=50', {
          headers: { Accept: 'application/json' },
        }),
      ]);
      const commentsBody = await readJsonSafe(commentsRes);
      const dmsBody = await readJsonSafe(dmsRes);

      if (!commentsRes.ok || !dmsRes.ok) {
        const errMsg =
          (commentsBody && commentsBody.error) ||
          (dmsBody && dmsBody.error) ||
          'No se pudo cargar el inbox.';
        setStatus(errMsg, true);
        return;
      }

      const comments = Array.isArray(commentsBody && commentsBody.comments)
        ? commentsBody.comments
        : [];
      const conversations = Array.isArray(dmsBody && dmsBody.conversations)
        ? dmsBody.conversations
        : [];

      renderComments(comments);
      renderDms(conversations);
      setStatus(
        comments.length +
          ' comentario(s), ' +
          conversations.length +
          ' DM(s)',
        false,
      );
    } catch (err) {
      setStatus('No se pudo conectar con el servidor.', true);
      commentsEl.innerHTML = '';
      dmsEl.innerHTML = '';
    } finally {
      busy = false;
    }
  }

  async function sendReply(kind, id, card) {
    const textarea = card.querySelector('.inbox-reply-text');
    const feedback = card.querySelector('[data-feedback]');
    const btn = card.querySelector('.inbox-reply-btn');
    const text = textarea ? String(textarea.value || '').trim() : '';
    if (!text) {
      if (feedback) {
        feedback.textContent = 'Escribí un mensaje.';
        feedback.className = 'inbox-card-feedback is-error';
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Enviando…';
    }
    if (feedback) {
      feedback.textContent = '';
      feedback.className = 'inbox-card-feedback';
    }

    const actor = actorId();
    let url;
    let payload;
    if (kind === 'comment') {
      url = API_BASE + '/api/social-comments/' + encodeURIComponent(id) + '/reply';
      payload = { replyText: text, repliedBy: actor };
    } else {
      url =
        API_BASE +
        '/api/social-conversations/' +
        encodeURIComponent(id) +
        '/send';
      payload = { messageText: text, sentBy: actor };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await readJsonSafe(res);

      if (res.status === 409 && body && body.requiresConfirmation) {
        const ok = window.confirm(
          'Este mensaje dispara un guardrail de confirmación.\n\n' +
            ((body.matches &&
              body.matches.map((m) => m.phrase_or_pattern).join(', ')) ||
              '') +
            '\n\n¿Enviar de todos modos?',
        );
        if (ok) {
          payload.guardrailConfirmed = true;
          const res2 = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(payload),
          });
          const body2 = await readJsonSafe(res2);
          if (!res2.ok) {
            if (feedback) {
              feedback.textContent =
                (body2 && body2.error) || 'Error al enviar.';
              feedback.className = 'inbox-card-feedback is-error';
            }
            return;
          }
          if (feedback) {
            feedback.textContent = body2 && body2.alreadyReplied
              ? 'Ya estaba respondido.'
              : 'Enviado.';
            feedback.className = 'inbox-card-feedback is-ok';
          }
          if (textarea) textarea.value = '';
          await loadInbox();
          return;
        }
        if (feedback) {
          feedback.textContent = 'Envío cancelado.';
          feedback.className = 'inbox-card-feedback';
        }
        return;
      }

      if (!res.ok) {
        if (feedback) {
          feedback.textContent = (body && body.error) || 'Error al enviar.';
          feedback.className = 'inbox-card-feedback is-error';
        }
        return;
      }

      if (feedback) {
        feedback.textContent =
          body && body.alreadyReplied
            ? 'Ya estaba respondido.'
            : 'Enviado.';
        feedback.className = 'inbox-card-feedback is-ok';
      }
      if (textarea) textarea.value = '';
      await loadInbox();
    } catch (err) {
      if (feedback) {
        feedback.textContent = 'No se pudo conectar con el servidor.';
        feedback.className = 'inbox-card-feedback is-error';
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Responder';
      }
    }
  }

  reloadBtn.addEventListener('click', () => {
    loadInbox();
  });

  if (igTab) {
    igTab.addEventListener('click', () => {
      showChannel('instagram');
    });
  }

  panel.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.inbox-reply-btn');
    if (!btn) return;
    const card = btn.closest('.inbox-card');
    if (!card) return;
    const kind = btn.getAttribute('data-kind');
    const id = btn.getAttribute('data-id');
    if (!kind || !id) return;
    sendReply(kind, id, card);
  });

  window.__openInbox = () => {
    showChannel('instagram');
    loadInbox();
    openedOnce = true;
  };
})();

/* ----------------------------------------------------------------------------
 * Campañas Email — integración /email/*
 * ------------------------------------------------------------------------- */
(function initEmailCampaigns() {
  const panel = document.getElementById('email-panel');
  if (!panel) return;

  const list = document.getElementById('email-list');
  const createButton = document.getElementById('email-create-btn');
  const form = document.getElementById('email-create-form');
  const formSubmit = document.getElementById('email-form-submit');
  const formCancel = document.getElementById('email-form-cancel');
  const processQueueBtn = document.getElementById('email-process-queue-btn');

  const nameInput = document.getElementById('email-form-name');
  const subjectInput = document.getElementById('email-form-subject');
  const bodyInput = document.getElementById('email-form-body');
  const scoreInput = document.getElementById('email-form-score');

  let listenersAttached = false;

  function emailStatusClass(status) {
    const allowedStatuses = [
      'draft', 'scheduled', 'sending', 'completed', 'partial_error', 'error',
    ];
    return allowedStatuses.includes(status) ? ' email-badge--' + status : '';
  }

  async function readJsonSafe(response) {
    return response.json().catch(function () { return {}; });
  }

  function getErrorMessage(data, fallback) {
    return data.error || data.message || data.msg || fallback;
  }

  async function fetchCampaigns() {
    const response = await fetch('/email/campaigns');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(data, 'No se pudieron cargar las campañas.'));
    }
    return Array.isArray(data.campaigns) ? data.campaigns : [];
  }

  async function createCampaign({ name, subject, bodyHtml, minScore }) {
    const segmentResponse = await fetch('/email/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Segmento para ' + name,
        rules: [{ field: 'encuesta_score', operator: '>=', value: minScore }],
      }),
    });
    const segmentData = await readJsonSafe(segmentResponse);
    if (!segmentResponse.ok) {
      throw new Error(getErrorMessage(segmentData, 'No se pudo crear el segmento.'));
    }
    if (!segmentData.segment || !segmentData.segment.id) {
      throw new Error('El servidor creó el segmento pero no devolvió un ID válido.');
    }

    const campaignResponse = await fetch('/email/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        subject,
        body_html: bodyHtml,
        segment_id: segmentData.segment.id,
        scheduled_at: new Date().toISOString(),
      }),
    });
    const campaignData = await readJsonSafe(campaignResponse);
    if (!campaignResponse.ok) {
      throw new Error(getErrorMessage(campaignData, 'El segmento fue creado, pero no se pudo crear la campaña.'));
    }
    return campaignData;
  }

  async function materializeCampaign(id) {
    const response = await fetch('/email/campaigns/' + encodeURIComponent(id) + '/materialize', {
      method: 'POST',
    });
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(data, 'No se pudo materializar la campaña.'));
    }
    return data;
  }

  async function processQueue() {
    const response = await fetch('/email/process-queue', { method: 'POST' });
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(data, 'No se pudo procesar la cola.'));
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('es-UY');
  }

  function formatRecipientCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? String(count) : '0';
  }

  function resetForm() {
    if (nameInput) nameInput.value = '';
    if (subjectInput) subjectInput.value = '';
    if (bodyInput) bodyInput.value = '';
    if (scoreInput) scoreInput.value = '70';
  }

  async function renderList() {
    if (!list) return;
    list.innerHTML = '<div class="sms-empty">Cargando…</div>';
    try {
      const campaigns = await fetchCampaigns();
      if (!campaigns.length) {
        list.innerHTML = '<div class="sms-empty">No hay campañas email todavía.</div>';
        return;
      }
      const rows = campaigns.map(function (campaign) {
        const materializeButton = campaign.status === 'draft'
          ? '<button type="button" class="btn email-materialize-btn" data-id="' + escapeHtml(campaign.id) + '">Materializar</button>'
          : '';
        return (
          '<tr class="sms-row">' +
            '<td>' + escapeHtml(campaign.name) + '</td>' +
            '<td>' + escapeHtml(formatDate(campaign.created_at)) + '</td>' +
            '<td><span class="email-badge' + emailStatusClass(campaign.status) + '">' + escapeHtml(campaign.status) + '</span></td>' +
            '<td>' + escapeHtml(formatRecipientCount(campaign.recipient_count)) + '</td>' +
            '<td>' + materializeButton + '</td>' +
          '</tr>'
        );
      }).join('');

      list.innerHTML =
        '<div class="sms-table-wrap"><table class="sms-table">' +
          '<thead><tr><th>Nombre</th><th>Creada</th><th>Estado</th><th>Destinatarios</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>';

      list.querySelectorAll('.email-materialize-btn').forEach(function (button) {
        button.addEventListener('click', async function () {
          const id = button.getAttribute('data-id');
          if (!id) return;
          button.disabled = true;
          const origText = button.textContent;
          button.textContent = 'Procesando...';
          try {
            const result = await materializeCampaign(id);
            alert('Materializada: ' + Number(result.recipientCount || 0) + ' destinatarios.');
            await renderList();
          } catch (error) {
            alert('Error: ' + error.message);
            button.disabled = false;
            button.textContent = origText;
          }
        });
      });
    } catch (error) {
      list.innerHTML = '<div class="sms-empty">Error cargando campañas: ' + escapeHtml(error.message) + '</div>';
    }
  }

  if (!listenersAttached) {
    if (createButton && form) {
      createButton.addEventListener('click', function () {
        form.classList.toggle('hidden');
      });
    }
    if (formCancel && form) {
      formCancel.addEventListener('click', function () {
        form.classList.add('hidden');
      });
    }
    if (formSubmit) {
      formSubmit.addEventListener('click', async function () {
        const name = nameInput ? nameInput.value.trim() : '';
        const subject = subjectInput ? subjectInput.value.trim() : '';
        const bodyHtml = bodyInput ? bodyInput.value.trim() : '';
        const rawMinScore = scoreInput ? scoreInput.value.trim() : '';
        const minScore = Number(rawMinScore);

        if (!name || !subject || !bodyHtml) {
          alert('Completá nombre, asunto y cuerpo.');
          return;
        }
        if (rawMinScore === '' || !Number.isFinite(minScore) || minScore < 0) {
          alert('Ingresá un puntaje mínimo válido.');
          return;
        }

        formSubmit.disabled = true;
        const origText = formSubmit.textContent;
        formSubmit.textContent = 'Creando...';
        try {
          await createCampaign({ name, subject, bodyHtml, minScore });
          if (form) form.classList.add('hidden');
          resetForm();
          await renderList();
        } catch (error) {
          alert('Error: ' + error.message);
        } finally {
          formSubmit.disabled = false;
          formSubmit.textContent = origText;
        }
      });
    }
    if (processQueueBtn) {
      processQueueBtn.addEventListener('click', async function () {
        const confirmed = window.confirm(
          '¿Confirmás procesar la cola de envío? Esto puede enviar emails reales a destinatarios.'
        );
        if (!confirmed) return;

        processQueueBtn.disabled = true;
        const origText = processQueueBtn.textContent;
        processQueueBtn.textContent = 'Procesando...';
        try {
          const result = await processQueue();
          if (result && result.skipped === true) {
            alert('Ya hay otra ejecución procesando la cola.');
          } else {
            alert(
              'Procesado: ' + Number(result.sent || 0) + ' enviados, ' +
              Number(result.failed || 0) + ' fallidos, ' +
              Number(result.deferred || 0) + ' pospuestos.'
            );
          }
          await renderList();
        } catch (error) {
          alert('Error: ' + error.message);
        } finally {
          processQueueBtn.disabled = false;
          processQueueBtn.textContent = origText;
        }
      });
    }
    listenersAttached = true;
  }

  window.__openEmail = function () {
    renderList();
  };
})();

/* ----------------------------------------------------------------------------
 * AI Visibility — integración /ai-visibility/*
 * ------------------------------------------------------------------------- */
(function initAiVisibility() {
  const panel = document.getElementById('ai-visibility-panel');
  if (!panel) return;

  const runBtn = document.getElementById('ai-visibility-run-btn');
  const summaryEl = document.getElementById('ai-visibility-summary');
  const listEl = document.getElementById('ai-visibility-list');
  const analyzeBtn = document.getElementById(
    'ai-visibility-analyze-credizona-btn',
  );
  const retryAnalysisBtn = document.getElementById(
    'ai-visibility-retry-analysis-btn',
  );
  const analysisStatusEl = document.getElementById(
    'ai-visibility-analysis-status',
  );

  let analysisPendingCount = 0;
  let analysisFailedCount = 0;
  let analyzeListenersAttached = false;

  const WEEKLY_ALREADY_RUN_MSG =
    '💡 Ya se corrió esta semana. Próxima corrida disponible la semana que viene.';

  function setWeeklyRunLocked(locked) {
    if (runBtn) {
      runBtn.disabled = !!locked;
    }
    if (locked && summaryEl) {
      summaryEl.innerHTML =
        '<div class="sms-empty">' + WEEKLY_ALREADY_RUN_MSG + '</div>';
    }
  }

  async function fetchRunStatus() {
    const response = await fetch('/ai-visibility/run-status');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo consultar el estado de la corrida.'),
      );
    }
    return {
      week_of: data.week_of || null,
      already_run: !!data.already_run,
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(
      /[&<>"']/g,
      function (character) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[character];
      },
    );
  }

  async function readJsonSafe(response) {
    return response.json().catch(function () {
      return {};
    });
  }

  function getErrorMessage(data, fallback) {
    return data && (data.error || data.message)
      ? data.error || data.message
      : fallback;
  }

  function providerLabel(provider) {
    const labels = {
      openai: 'ChatGPT',
      anthropic: 'Claude',
      gemini: 'Gemini',
      perplexity: 'Perplexity',
    };
    return labels[provider] || provider || '—';
  }

  function providerLogoHtml(provider) {
    const domains = {
      openai: 'chatgpt.com',
      anthropic: 'claude.ai',
      gemini: 'gemini.google.com',
      perplexity: 'perplexity.ai',
    };
    const domain = domains[provider];
    if (!domain) return '';
    return '<img src="https://www.google.com/s2/favicons?sz=32&domain=' +
      domain + '" width="16" height="16" alt="" style="vertical-align:middle;border-radius:3px">';
  }

  function statusLabel(status) {
    const labels = {
      success: 'Correcto',
      error: 'Error',
      not_configured: 'Sin configurar',
      pending: 'Pendiente',
    };
    return labels[status] || status || '—';
  }

  function statusBadgeClass(status) {
    if (status === 'success') return ' email-badge--completed';
    if (status === 'error') return ' email-badge--error';
    return '';
  }

  function classificationLabel(value) {
    const labels = {
      recomendada: 'Recomendada',
      mencionada: 'Mencionada',
      comparada: 'Comparada',
      desaconsejada: 'Desaconsejada',
      informacion_insuficiente: 'Información insuficiente',
    };
    return labels[value] || value || '—';
  }

  function sentimentLabel(value) {
    const labels = {
      positivo: 'Positivo',
      neutral: 'Neutral',
      negativo: 'Negativo',
    };
    return labels[value] || value || '—';
  }

  function classificationBadgeClass(value) {
    if (value === 'recomendada') return ' email-badge--completed';
    if (value === 'desaconsejada') return ' email-badge--error';
    if (value === 'informacion_insuficiente') return ' email-badge--faint';
    return '';
  }

  function renderCredizonaAnalysisBlock(response) {
    if (!response || response.mentions_credizona !== true) return '';
    const analysis = response.credizona_analysis;
    if (!analysis) {
      return (
        '<div class="text-muted" style="margin-top:10px">' +
        'Análisis pendiente' +
        '</div>'
      );
    }
    if (analysis.status === 'error') {
      const errMsg = analysis.error ? String(analysis.error) : 'Error de análisis';
      return (
        '<div class="text-muted" style="margin-top:10px" title="' +
        escapeHtml(errMsg) +
        '">Error de análisis</div>'
      );
    }
    const attrs = Array.isArray(analysis.attributes)
      ? analysis.attributes
          .map(function (a) {
            return escapeHtml(a);
          })
          .filter(Boolean)
          .join(', ')
      : '';
    return (
      '<div style="margin-top:10px">' +
      '<span class="email-badge' +
      classificationBadgeClass(analysis.classification) +
      '">' +
      escapeHtml(classificationLabel(analysis.classification)) +
      '</span> ' +
      '<span class="text-muted">' +
      escapeHtml(sentimentLabel(analysis.sentiment)) +
      '</span>' +
      (attrs
        ? '<div class="text-muted" style="margin-top:4px">' +
          attrs +
          '</div>'
        : '') +
      '</div>'
    );
  }

  async function fetchAnalysisPending() {
    const response = await fetch('/ai-visibility/credizona-analysis/pending');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo consultar análisis pendientes.'),
      );
    }
    return {
      pending: Number(data.pending) || 0,
      failed: Number(data.failed) || 0,
    };
  }

  function applyAnalysisStatusUi(pending, failed) {
    analysisPendingCount = pending;
    analysisFailedCount = failed;
    if (analysisStatusEl) {
      analysisStatusEl.textContent =
        pending +
        ' respuestas pendientes de análisis · ' +
        failed +
        ' con error';
    }
    if (analyzeBtn) {
      analyzeBtn.disabled = pending <= 0;
    }
    if (retryAnalysisBtn) {
      if (failed > 0) {
        retryAnalysisBtn.hidden = false;
        retryAnalysisBtn.disabled = false;
      } else {
        retryAnalysisBtn.hidden = true;
        retryAnalysisBtn.disabled = true;
      }
    }
  }

  async function refreshAnalysisStatus() {
    try {
      const status = await fetchAnalysisPending();
      applyAnalysisStatusUi(status.pending, status.failed);
    } catch (_err) {
      /* no bloquear el tab */
    }
  }

  async function fetchLatestResponses() {
    const response = await fetch('/ai-visibility/responses');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudieron cargar los resultados.'),
      );
    }
    return {
      weekOf: data.week_of || null,
      responses: Array.isArray(data.responses) ? data.responses : [],
    };
  }

  async function fetchPrompts() {
    const response = await fetch('/ai-visibility/prompts');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudieron cargar los prompts.'),
      );
    }
    return Array.isArray(data.prompts) ? data.prompts : [];
  }

  async function runNow() {
    const response = await fetch('/ai-visibility/run', { method: 'POST' });
    const data = await readJsonSafe(response);
    if (response.status === 409) {
      const err = new Error(
        getErrorMessage(
          data,
          'Ya se corrió la verificación esta semana. Próxima corrida disponible la semana que viene.',
        ),
      );
      err.status = 409;
      throw err;
    }
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo correr la verificación.'),
      );
    }
    return data;
  }

  async function runSinglePrompt(promptId) {
    const response = await fetch(
      '/ai-visibility/run/' + encodeURIComponent(promptId),
      { method: 'POST' },
    );
    const data = await readJsonSafe(response);
    if (response.status === 409) {
      const err = new Error(
        getErrorMessage(data, 'Este prompt ya se corrió esta semana.'),
      );
      err.status = 409;
      throw err;
    }
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo correr ese prompt.'),
      );
    }
    return data;
  }

  function renderSummary(data) {
    if (!summaryEl) return;
    if (!data || !data.week_of) {
      summaryEl.innerHTML = '';
      return;
    }
    summaryEl.innerHTML =
      '<p class="text-muted">' +
      'Semana ' +
      escapeHtml(data.week_of) +
      ' — ' +
      escapeHtml(data.success) +
      ' correctas, ' +
      escapeHtml(data.error) +
      ' con error, ' +
      escapeHtml(data.not_configured) +
      ' sin configurar ' +
      '(de ' +
      escapeHtml(data.attempted) +
      ' intentos)' +
      '</p>';
  }

  let cachedPromptsList = [];
  let ranPromptIdsThisWeek = new Set();

  function buildRanPromptIds(responses) {
    const set = new Set();
    (responses || []).forEach(function (row) {
      if (row && row.prompt_id != null) set.add(String(row.prompt_id));
    });
    return set;
  }

  function renderPrompts(prompts) {
    const el = document.getElementById('ai-visibility-prompts');
    if (!el) return;
    cachedPromptsList = Array.isArray(prompts) ? prompts : [];
    if (!cachedPromptsList.length) {
      el.innerHTML = '<div class="sms-empty">No hay prompts activos.</div>';
      return;
    }
    const rows = cachedPromptsList
      .map(function (p) {
        const already = ranPromptIdsThisWeek.has(String(p.id));
        const btnLabel = already ? 'Ya corrido' : 'Correr';
        const btnDisabled = already ? ' disabled' : '';
        return (
          '<tr class="sms-row">' +
          '<td>' +
          escapeHtml(p.text) +
          '</td>' +
          '<td>' +
          escapeHtml(p.category) +
          '</td>' +
          '<td><button type="button" class="btn ai-visibility-run-single-btn" data-prompt-id="' +
          escapeHtml(p.id) +
          '"' +
          btnDisabled +
          '>' +
          btnLabel +
          '</button></td>' +
          '</tr>'
        );
      })
      .join('');
    el.innerHTML =
      '<div class="sms-table-wrap"><table class="sms-table">' +
      '<thead><tr><th>Prompt</th><th>Categoría</th><th></th></tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody></table></div>';

    el.querySelectorAll('.ai-visibility-run-single-btn').forEach(function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', async function () {
        const promptId = btn.getAttribute('data-prompt-id');
        if (!promptId) return;
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = 'Corriendo…';
        let stayDisabled = false;
        try {
          await runSinglePrompt(promptId);
          stayDisabled = true;
          await refresh();
          await refreshEvolution({ force: true });
          await refreshAnalysisStatus();
        } catch (error) {
          if (error && error.status === 409) {
            stayDisabled = true;
            btn.disabled = true;
            btn.textContent = 'Ya corrido';
          } else {
            alert('Error: ' + error.message);
          }
        } finally {
          if (!stayDisabled) {
            btn.disabled = false;
            btn.textContent = origText;
          } else {
            btn.disabled = true;
            btn.textContent = 'Ya corrido';
          }
        }
      });
    });
  }

  async function loadPrompts() {
    const el = document.getElementById('ai-visibility-prompts');
    if (!el) return;
    el.innerHTML = '<div class="sms-empty">Cargando prompts…</div>';
    try {
      const prompts = await fetchPrompts();
      renderPrompts(prompts);
    } catch (error) {
      el.innerHTML =
        '<div class="sms-empty">Error: ' +
        escapeHtml(error.message) +
        '</div>';
    }
  }

  let promptsToggleAttached = false;
  const promptsToggle = document.getElementById('ai-visibility-prompts-toggle');
  const promptsPanel = document.getElementById('ai-visibility-prompts');

  if (promptsToggle && promptsPanel && !promptsToggleAttached) {
    promptsToggle.addEventListener('click', function () {
      const expanded = promptsToggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      promptsToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (next) promptsPanel.classList.remove('hidden');
      else promptsPanel.classList.add('hidden');
      const chevron = document.getElementById('ai-visibility-prompts-chevron');
      if (chevron) chevron.textContent = next ? '▾' : '▸';
    });
    promptsToggleAttached = true;
  }

  /* ---- Posición en respuestas de IA (Chart.js) ---- */
  let evolutionChart = null;
  let evolutionRequestId = 0;
  let evolutionLastData = null;
  let evolutionShowAll = false;
  let evolutionToggleAttached = false;
  let evolutionSelectAllAttached = false;
  let evolutionFiltersAttached = false;
  /** @type {Object.<string, boolean>} */
  let evolutionChecked = Object.create(null);

  const evolutionCanvas = document.getElementById(
    'ai-visibility-evolution-chart',
  );
  const evolutionStatus = document.getElementById(
    'ai-visibility-evolution-status',
  );
  const evolutionCredizonaCard = document.getElementById(
    'ai-visibility-evolution-credizona-card',
  );
  let credizonaAnalysisSummary = null;

  async function fetchCredizonaAnalysisSummary() {
    const response = await fetch('/ai-visibility/credizona-analysis/summary');
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo cargar el resumen de análisis.'),
      );
    }
    return data;
  }

  function sentimentBadgeClass(value) {
    if (value === 'positivo') return ' email-badge--completed';
    if (value === 'negativo') return ' email-badge--error';
    if (value === 'neutral') return ' email-badge--faint';
    return '';
  }

  function renderSummarySourcesList(sources) {
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) return '';
    return (
      '<ul class="text-muted ai-vis-summary-sources" data-ai-vis-sources hidden>' +
      list
        .map(function (s) {
          const provider = providerLabel(s && s.provider);
          const prompt =
            s && s.prompt_text_snapshot ? String(s.prompt_text_snapshot) : '';
          const week = s && s.week_of ? String(s.week_of) : '';
          return (
            '<li>' +
            escapeHtml(provider) +
            ' — ' +
            escapeHtml(prompt) +
            (week ? ' (semana ' + escapeHtml(week) + ')' : '') +
            '</li>'
          );
        })
        .join('') +
      '</ul>'
    );
  }

  function renderSummaryBucketRow(count, label, badgeClass, sources, emoji) {
    const n = Number(count) || 0;
    if (!(n > 0)) return '';
    return (
      '<div class="ai-vis-summary-row">' +
      '<button type="button" class="ai-vis-summary-toggle">' +
      '<span data-chevron aria-hidden="true">▸</span> ' +
      '<span class="email-badge' +
      (badgeClass || '') +
      '">' +
      (emoji ? emoji + ' ' : '') +
      escapeHtml(String(n)) +
      ' ' +
      escapeHtml(label) +
      '</span>' +
      '</button>' +
      renderSummarySourcesList(sources) +
      '</div>'
    );
  }

  function formatCredizonaAnalysisSummaryHtml(summary) {
    if (!summary || !(Number(summary.total_analyzed) > 0)) return '';

    const classLabels = {
      recomendada: 'recomendada',
      mencionada: 'mencionada',
      comparada: 'comparada',
      desaconsejada: 'desaconsejada',
      informacion_insuficiente: 'sin información',
    };
    const sentLabels = {
      positivo: 'positivo',
      neutral: 'neutral',
      negativo: 'negativo',
    };
    const sentEmojis = {
      positivo: '😊',
      neutral: '😐',
      negativo: '😟',
    };

    const classRows = (Array.isArray(summary.classification_counts)
      ? summary.classification_counts
      : []
    )
      .map(function (item) {
        if (!item || !(Number(item.count) > 0)) return '';
        const value = String(item.value || '');
        return renderSummaryBucketRow(
          item.count,
          classLabels[value] || value,
          classificationBadgeClass(value),
          item.sources,
        );
      })
      .join('');

    const sentRows = (Array.isArray(summary.sentiment_counts)
      ? summary.sentiment_counts
      : []
    )
      .map(function (item) {
        if (!item || !(Number(item.count) > 0)) return '';
        const value = String(item.value || '');
        return renderSummaryBucketRow(
          item.count,
          sentLabels[value] || value,
          sentimentBadgeClass(value),
          item.sources,
          sentEmojis[value] || '',
        );
      })
      .join('');

    const attrRows = (Array.isArray(summary.top_attributes)
      ? summary.top_attributes
      : []
    )
      .map(function (item) {
        if (!item || !(Number(item.count) > 0) || !item.attribute) return '';
        return renderSummaryBucketRow(
          item.count,
          String(item.attribute),
          '',
          item.sources,
        );
      })
      .join('');

    let html = '<div class="ai-vis-credizona-summary">';
    if (classRows) {
      html +=
        '<div class="ai-vis-summary-section">' +
        '<div class="text-muted ai-vis-summary-section-label">Clasificación</div>' +
        classRows +
        '</div>';
    }
    if (sentRows) {
      html +=
        '<div class="ai-vis-summary-section">' +
        '<div class="text-muted ai-vis-summary-section-label">Sentiment</div>' +
        sentRows +
        '</div>';
    }
    if (attrRows) {
      html +=
        '<div class="ai-vis-summary-section">' +
        '<div class="text-muted ai-vis-summary-section-label">Atributos frecuentes</div>' +
        attrRows +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  async function refreshCredizonaAnalysisSummary() {
    try {
      credizonaAnalysisSummary = await fetchCredizonaAnalysisSummary();
    } catch (_err) {
      /* no bloquear el tab */
      return;
    }
    renderCredizonaCard(evolutionLastData);
  }

  if (evolutionCredizonaCard && !evolutionCredizonaCard._summaryToggleBound) {
    evolutionCredizonaCard.addEventListener('click', function (ev) {
      const btn = ev.target.closest
        ? ev.target.closest('.ai-vis-summary-toggle')
        : null;
      if (!btn || !evolutionCredizonaCard.contains(btn)) return;
      const row = btn.parentElement;
      const list =
        row && row.querySelector
          ? row.querySelector('[data-ai-vis-sources]')
          : null;
      const chev = btn.querySelector('[data-chevron]');
      if (!list) return;
      const open = !list.hasAttribute('hidden');
      if (open) {
        list.setAttribute('hidden', '');
        if (chev) chev.textContent = '▸';
      } else {
        list.removeAttribute('hidden');
        if (chev) chev.textContent = '▾';
      }
    });
    evolutionCredizonaCard._summaryToggleBound = true;
  }

  const evolutionToggle = document.getElementById(
    'ai-visibility-evolution-toggle',
  );
  const evolutionSelectAllBtn = document.getElementById(
    'ai-visibility-evolution-select-all',
  );
  const evolutionTogglesEl = document.getElementById(
    'ai-visibility-evolution-toggles',
  );
  const evolutionChartWrap = document.getElementById(
    'ai-visibility-evolution-chart-wrap',
  );
  const filterProvider = document.getElementById(
    'ai-visibility-filter-provider',
  );
  const filterWeekFrom = document.getElementById(
    'ai-visibility-filter-week-from',
  );
  const filterWeekTo = document.getElementById('ai-visibility-filter-week-to');
  const evolutionEnabled = !!(evolutionCanvas && evolutionStatus);

  function ensureEvolutionCheckedDefaults(entities) {
    const list = entities || [];
    const hasAny = Object.keys(evolutionChecked).length > 0;
    list.forEach(function (ent, index) {
      const id = String(ent.entity_id);
      if (evolutionChecked[id] === undefined) {
        // First population: top 5 by mention rank. Later newcomers: checked.
        evolutionChecked[id] = hasAny ? true : index < 5;
      }
    });
  }

  function getEvolutionPoolEntities(data) {
    const entities = Array.isArray(data && data.entities) ? data.entities : [];
    if (evolutionShowAll || entities.length <= 5) return entities;
    return entities.slice(0, 5);
  }

  function getEvolutionCheckedEntities(data) {
    return getEvolutionPoolEntities(data).filter(function (entity) {
      return evolutionChecked[String(entity.entity_id)] === true;
    });
  }

  function evolutionAllPoolUnchecked(data) {
    const pool = getEvolutionPoolEntities(data);
    return (
      pool.length > 0 &&
      pool.every(function (ent) {
        return evolutionChecked[String(ent.entity_id)] !== true;
      })
    );
  }

  function syncEvolutionToggle(entityCount) {
    if (!evolutionToggle) return;
    if (!(entityCount > 5)) {
      evolutionToggle.hidden = true;
      return;
    }
    evolutionToggle.hidden = false;
    evolutionToggle.textContent = evolutionShowAll
      ? 'Mostrar top 5'
      : 'Mostrar todos';
  }

  function syncEvolutionSelectAllButton(data) {
    if (!evolutionSelectAllBtn) return;
    const pool = getEvolutionPoolEntities(data);
    if (!pool.length) {
      evolutionSelectAllBtn.hidden = true;
      return;
    }
    evolutionSelectAllBtn.hidden = false;
    evolutionSelectAllBtn.textContent = evolutionAllPoolUnchecked(data)
      ? 'Seleccionar todos'
      : 'Deseleccionar todos';
  }

  function toggleEvolutionSelectAll() {
    if (!evolutionLastData) return;
    const pool = getEvolutionPoolEntities(evolutionLastData);
    if (!pool.length) return;
    const selectAll = evolutionAllPoolUnchecked(evolutionLastData);
    pool.forEach(function (ent) {
      evolutionChecked[String(ent.entity_id)] = selectAll;
    });
    if (evolutionTogglesEl) {
      evolutionTogglesEl
        .querySelectorAll('input[data-series]')
        .forEach(function (checkbox) {
          checkbox.checked = selectAll;
        });
    }
    syncEvolutionSelectAllButton(evolutionLastData);
    renderEvolutionChart(evolutionLastData);
  }

  function renderEvolutionToggles(data) {
    if (!evolutionTogglesEl) return;
    const pool = getEvolutionPoolEntities(data);
    ensureEvolutionCheckedDefaults(
      Array.isArray(data && data.entities) ? data.entities : [],
    );
    evolutionTogglesEl.innerHTML = pool
      .map(function (ent) {
        const id = String(ent.entity_id);
        const checked = evolutionChecked[id] === true;
        const color = colorForString(ent.name || id);
        return (
          '<label class="competitor-activity-weekly-toggle">' +
          '<input type="checkbox" data-series="' +
          escapeHtml(id) +
          '"' +
          (checked ? ' checked' : '') +
          ' />' +
          '<span class="competitor-activity-weekly-swatch" style="background:' +
          escapeHtml(color) +
          '"></span>' +
          escapeHtml(ent.name || 'Entidad') +
          '</label>'
        );
      })
      .join('');

    evolutionTogglesEl
      .querySelectorAll('input[data-series]')
      .forEach(function (checkbox) {
        checkbox.addEventListener('change', function () {
          const seriesKey = checkbox.getAttribute('data-series');
          if (!seriesKey) return;
          evolutionChecked[seriesKey] = checkbox.checked;
          if (evolutionLastData) {
            syncEvolutionSelectAllButton(evolutionLastData);
            renderEvolutionChart(evolutionLastData);
          }
        });
      });

    syncEvolutionSelectAllButton(data);
  }

  function computeMaxMentionCount(data, weeks) {
    const weekSet = Array.isArray(weeks)
      ? new Set(weeks)
      : null;
    let max = 0;
    (Array.isArray(data && data.entities) ? data.entities : []).forEach(
      function (entity) {
        (Array.isArray(entity.series) ? entity.series : []).forEach(
          function (point) {
            if (!point || !(point.mention_count > 0)) return;
            if (weekSet && !weekSet.has(point.week_of)) return;
            if (point.mention_count > max) max = point.mention_count;
          },
        );
      },
    );
    const credSeries =
      data && data.credizona && Array.isArray(data.credizona.series)
        ? data.credizona.series
        : [];
    credSeries.forEach(function (point) {
      if (!point || !(point.mention_count > 0)) return;
      if (weekSet && !weekSet.has(point.week_of)) return;
      if (point.mention_count > max) max = point.mention_count;
    });
    return max || 1;
  }

  /**
   * Point radius from mention_count — same √ growth pattern as
   * entityPresencePointRadius, scaled to the chart's max so week-to-week
   * differences stay visible (mention counts are often >> SERP hits).
   */
  function bubbleRadius(mentionCount, maxMentionCount) {
    if (!mentionCount || mentionCount <= 0) return 0;
    const n = Math.max(1, Number(mentionCount) || 1);
    const maxN = Math.max(1, Number(maxMentionCount) || 1);
    const minR = 4;
    const maxR = 24;
    const ratio = Math.sqrt(n) / Math.sqrt(maxN);
    const raw = minR + ratio * (maxR - minR);
    return Math.min(maxR, Math.max(minR, Math.round(raw)));
  }

  function destroyEvolutionChart() {
    if (evolutionChart) {
      evolutionChart.destroy();
      evolutionChart = null;
    }
    if (
      evolutionCanvas &&
      typeof window.Chart === 'function' &&
      typeof window.Chart.getChart === 'function'
    ) {
      const existing = window.Chart.getChart(evolutionCanvas);
      if (existing) existing.destroy();
    }
  }

  async function fetchEvolutionSummary(provider) {
    let url = '/ai-visibility/evolution-summary';
    if (provider) {
      url += '?provider=' + encodeURIComponent(provider);
    }
    const response = await fetch(url);
    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        getErrorMessage(data, 'No se pudo cargar el resumen de evolución.'),
      );
    }
    return data;
  }

  function setEvolutionStatus(message) {
    if (evolutionStatus) evolutionStatus.textContent = message || '';
  }

  function buildCoverageByWeek(data) {
    const coverageByWeek = {};
    (Array.isArray(data && data.coverage) ? data.coverage : []).forEach(
      function (c) {
        if (c && c.week_of) {
          coverageByWeek[c.week_of] =
            Number(
              c.total_combos != null ? c.total_combos : c.successful_providers,
            ) || 0;
        }
      },
    );
    return coverageByWeek;
  }

  function getFilteredWeeks(data) {
    const weeks = Array.isArray(data && data.weeks) ? data.weeks.slice() : [];
    const from = filterWeekFrom ? filterWeekFrom.value : '';
    const to = filterWeekTo ? filterWeekTo.value : '';
    if (!from && !to) return { weeks: weeks, error: null };
    if (from && to && from > to) {
      return {
        weeks: null,
        error: '💡 "Desde" no puede ser posterior a "Hasta".',
      };
    }
    const start = from || weeks[0] || '';
    const end = to || weeks[weeks.length - 1] || '';
    return {
      weeks: weeks.filter(function (w) {
        return (!start || w >= start) && (!end || w <= end);
      }),
      error: null,
    };
  }

  function populateSelectOptions(select, values, previous, emptyLabel) {
    if (!select) return;
    select.innerHTML = '';
    if (emptyLabel != null) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = emptyLabel;
      select.appendChild(emptyOpt);
    }
    (values || []).forEach(function (value) {
      const opt = document.createElement('option');
      opt.value = String(value.value);
      opt.textContent = value.label;
      select.appendChild(opt);
    });
    if (
      previous &&
      Array.from(select.options).some(function (o) {
        return o.value === previous;
      })
    ) {
      select.value = previous;
    } else if (emptyLabel != null) {
      select.value = '';
    } else if (select.options.length) {
      select.value = select.options[0].value;
    }
  }

  function populateEvolutionFilters(data) {
    const weeks = Array.isArray(data && data.weeks) ? data.weeks : [];
    const entities = Array.isArray(data && data.entities) ? data.entities : [];
    ensureEvolutionCheckedDefaults(entities);

    const prevFrom = filterWeekFrom ? filterWeekFrom.value : '';
    const prevTo = filterWeekTo ? filterWeekTo.value : '';
    const weekOptions = weeks.map(function (w) {
      return { value: w, label: w };
    });
    populateSelectOptions(filterWeekFrom, weekOptions, prevFrom, null);
    populateSelectOptions(filterWeekTo, weekOptions, prevTo, null);
    if (filterWeekFrom && !filterWeekFrom.value && weeks.length) {
      filterWeekFrom.value = weeks[0];
    }
    if (filterWeekTo && !filterWeekTo.value && weeks.length) {
      filterWeekTo.value = weeks[weeks.length - 1];
    }

    renderEvolutionToggles(data);
  }

  function mentionSharePctSuffix(count, total) {
    if (!(total > 0)) return '';
    return ' (' + Math.round((count / total) * 100) + '%)';
  }

  function renderCredizonaCard(data) {
    if (!evolutionCredizonaCard) return;
    const series =
      data && data.credizona && Array.isArray(data.credizona.series)
        ? data.credizona.series
        : [];

    let metricHtml =
      '<div class="text-muted">Sin datos de menciones esta semana todavía.</div>';
    if (series.length) {
      const last = series[series.length - 1];
      const n = Number(last && last.mention_count) || 0;
      const coverageByWeek = buildCoverageByWeek(data);
      const m = (last && last.week_of && coverageByWeek[last.week_of]) || 0;
      const pct =
        m > 0 ? ' (' + Math.round((n / m) * 100) + '%)' : '';
      metricHtml =
        '<div class="kpi-value">' +
        escapeHtml(String(n)) +
        ' <span class="ai-vis-credizona-of">de ' +
        escapeHtml(String(m)) +
        '</span></div>' +
        '<div class="kpi-label">respuestas exitosas esta semana' +
        escapeHtml(pct) +
        '</div>';
    }

    evolutionCredizonaCard.innerHTML =
      '<h3 class="ai-vis-section-title">Credizona en las respuestas de IA</h3>' +
      '<div class="ai-vis-credizona-metric">' +
      metricHtml +
      '</div>' +
      formatCredizonaAnalysisSummaryHtml(credizonaAnalysisSummary);
  }

  const EVOLUTION_MENTION_LABELS_PLUGIN = {
    id: 'evolutionMentionLabels',
    afterDatasetsDraw: function (chart) {
      const ctx = chart.ctx;
      const area = chart.chartArea;
      if (!ctx || !area) return;

      chart.data.datasets.forEach(function (dataset, datasetIndex) {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (!meta || meta.hidden) return;
        const elements = meta.data || [];
        elements.forEach(function (el, index) {
          if (!el || !Number.isFinite(el.x) || !Number.isFinite(el.y)) return;
          const raw = dataset.data && dataset.data[index];
          if (!raw || !(raw.mention_count > 0)) return;

          const label = String(Math.round(Number(raw.mention_count)));
          const pointR =
            (el.options && Number(el.options.radius)) ||
            Number(raw.r) ||
            4;
          // Top-right of the point, clear of the marker and line.
          const tx = el.x + Math.max(4, pointR * 0.35) + 3;
          const ty = el.y - Math.max(4, pointR * 0.35) - 2;
          if (tx < area.left || tx > area.right) return;
          if (ty < area.top || ty > area.bottom) return;

          ctx.save();
          ctx.font =
            '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(18, 20, 26, 0.9)';
          ctx.strokeText(label, tx, ty);
          ctx.fillStyle = '#f3f4f6';
          ctx.fillText(label, tx, ty);
          ctx.restore();
        });
      });
    },
  };

  function renderEvolutionLineChart(data, weeks, coverageByWeek) {
    let maxRank = 1;
    const datasets = [];
    const maxMentionCount = computeMaxMentionCount(data, weeks);
    const visibleEntities = getEvolutionCheckedEntities(data);
    const totalVisible = visibleEntities.length;
    const xJitter = 0.12;
    const maxOffset =
      totalVisible > 1 ? ((totalVisible - 1) / 2) * xJitter : 0;

    visibleEntities.forEach(function (entity, entityIndex) {
      const color = colorForString(entity.name || entity.entity_id);
      const xOffset =
        totalVisible > 1
          ? (entityIndex - (totalVisible - 1) / 2) * xJitter
          : 0;
      const seriesByWeek = {};
      (Array.isArray(entity.series) ? entity.series : []).forEach(function (p) {
        if (p && p.week_of) seriesByWeek[p.week_of] = p;
      });

      // Chart.js parsing:false crashes on interleaved nulls in data[].
      const points = [];
      weeks.forEach(function (week, index) {
        const point = seriesByWeek[week];
        if (!point || !(point.mention_count > 0) || point.avg_rank == null) {
          return;
        }
        if (point.avg_rank > maxRank) maxRank = point.avg_rank;
        points.push({
          x: index + xOffset,
          y: point.avg_rank,
          r: bubbleRadius(point.mention_count, maxMentionCount),
          week_index: index,
          week_of: week,
          mention_count: point.mention_count,
          avg_rank: point.avg_rank,
          successful_providers: coverageByWeek[week] || 0,
        });
      });

      if (!points.length) return;

      datasets.push({
        label: entity.name || entity.entity_id || 'Entidad',
        data: points,
        showLine: true,
        spanGaps: false,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: 0.25,
        pointRadius: function (context) {
          return context.raw && context.raw.r ? context.raw.r : 0;
        },
        pointHoverRadius: function (context) {
          const base = context.raw && context.raw.r ? context.raw.r : 0;
          return base ? base + 2 : 0;
        },
      });
    });

    if (!datasets.length) {
      setEvolutionStatus('Todavía no hay respuestas exitosas.');
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
      return;
    }

    if (evolutionChartWrap) evolutionChartWrap.hidden = false;
    setEvolutionStatus('');
    destroyEvolutionChart();
    const ctx = evolutionCanvas.getContext('2d');
    evolutionChart = new window.Chart(ctx, {
      type: 'line',
      data: { datasets: datasets },
      plugins: [EVOLUTION_MENTION_LABELS_PLUGIN],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
          },
          tooltip: {
            callbacks: {
              title: function (items) {
                if (!items || !items.length || !items[0].raw) return '';
                return String(items[0].raw.week_of || '');
              },
              label: function (item) {
                const raw = item.raw || {};
                const name = item.dataset.label || '';
                const yTotal = Number(raw.successful_providers) || 0;
                const mentionCount = Number(raw.mention_count) || 0;
                const avg =
                  raw.avg_rank != null
                    ? String(raw.avg_rank).replace('.', ',')
                    : '—';
                return [
                  name,
                  'Menciones: ' +
                    mentionCount +
                    ' de ' +
                    yTotal +
                    ' respuestas' +
                    mentionSharePctSuffix(mentionCount, yTotal),
                  'Posición promedio: ' + avg,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: -0.5 - maxOffset,
            max: weeks.length - 0.5 + maxOffset,
            grid: {
              color: '#2a2f3a',
              drawTicks: false,
            },
            ticks: {
              stepSize: 1,
              callback: function (value) {
                const weekIndex = Math.round(value);
                if (Math.abs(value - weekIndex) > 1e-6) return '';
                return weeks[weekIndex] || '';
              },
            },
            title: {
              display: true,
              text: 'Semana',
            },
          },
          y: {
            reverse: true,
            min: 0.5,
            suggestedMax: maxRank + 1,
            grace: '5%',
            grid: {
              color: '#2a2f3a',
              drawTicks: false,
            },
            ticks: {
              stepSize: 1,
              callback: function (value) {
                if (!Number.isInteger(value)) return '';
                return value + '.º';
              },
            },
            title: {
              display: true,
              text: 'Posición promedio',
            },
          },
        },
      },
    });
  }

  function renderEvolutionChart(data) {
    if (!evolutionEnabled) return;

    destroyEvolutionChart();
    renderCredizonaCard(data);
    populateEvolutionFilters(data);

    const entityCount = Array.isArray(data && data.entities)
      ? data.entities.length
      : 0;
    syncEvolutionToggle(entityCount);

    if (typeof window.Chart !== 'function') {
      setEvolutionStatus(
        'No se pudo cargar Chart.js. Revisá la conexión o el CDN.',
      );
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
      return;
    }

    const weekResult = getFilteredWeeks(data);
    if (weekResult.error) {
      setEvolutionStatus(weekResult.error);
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
      return;
    }
    const weeks = weekResult.weeks || [];
    if (!weeks.length) {
      setEvolutionStatus('Todavía no hay respuestas exitosas.');
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
      return;
    }

    if (!getEvolutionCheckedEntities(data).length) {
      setEvolutionStatus('Seleccioná al menos un competidor');
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
      return;
    }

    renderEvolutionLineChart(data, weeks, buildCoverageByWeek(data));
  }

  async function refreshEvolution(opts) {
    if (!evolutionEnabled) return;
    const force = !!(opts && opts.force);

    if (!force && evolutionLastData && evolutionChart) {
      return;
    }

    const provider =
      filterProvider && filterProvider.value ? filterProvider.value : '';
    const requestId = ++evolutionRequestId;
    setEvolutionStatus('Cargando evolución…');
    try {
      const data = await fetchEvolutionSummary(provider);
      if (requestId !== evolutionRequestId) return;
      evolutionShowAll = false;
      evolutionLastData = data;
      evolutionChecked = Object.create(null);
      ensureEvolutionCheckedDefaults(data.entities || []);
      renderEvolutionChart(data);
    } catch (error) {
      if (requestId !== evolutionRequestId) return;
      destroyEvolutionChart();
      evolutionLastData = null;
      setEvolutionStatus('Error: ' + error.message);
      if (evolutionChartWrap) evolutionChartWrap.hidden = true;
    }
  }

  if (evolutionToggle && !evolutionToggleAttached) {
    evolutionToggle.addEventListener('click', function () {
      evolutionShowAll = !evolutionShowAll;
      if (evolutionLastData) renderEvolutionChart(evolutionLastData);
    });
    evolutionToggleAttached = true;
  }

  if (evolutionSelectAllBtn && !evolutionSelectAllAttached) {
    evolutionSelectAllBtn.addEventListener('click', function () {
      toggleEvolutionSelectAll();
    });
    evolutionSelectAllAttached = true;
  }

  if (!evolutionFiltersAttached) {
    if (filterProvider) {
      filterProvider.addEventListener('change', function () {
        refreshEvolution({ force: true });
      });
    }
    function onWeekFilterChange() {
      if (evolutionLastData) renderEvolutionChart(evolutionLastData);
    }
    if (filterWeekFrom) {
      filterWeekFrom.addEventListener('change', onWeekFilterChange);
    }
    if (filterWeekTo) {
      filterWeekTo.addEventListener('change', onWeekFilterChange);
    }
    evolutionFiltersAttached = true;
  }

  function formatUnknownCandidatesCell(response) {
    const unknownCandidates = Array.isArray(response.unknown_candidates)
      ? response.unknown_candidates
      : [];
    const title =
      'Posibles entidades detectadas por formato en negrita. Requieren revisión manual.';
    if (!unknownCandidates.length) {
      return '<td title="' + escapeHtml(title) + '">—</td>';
    }
    const joined = unknownCandidates
      .map(function (c) {
        return escapeHtml(String(c));
      })
      .join(', ');
    return (
      '<td title="' + escapeHtml(title) + '">⚠️ ' + joined + '</td>'
    );
  }

  function renderProviderRows(responses) {
    return (responses || [])
      .map(function (response) {
        const entityNamesPlain = Array.isArray(response.mentioned_entities)
          ? response.mentioned_entities
              .map(function (entity) {
                return entity && entity.name ? String(entity.name) : '';
              })
              .filter(Boolean)
              .join(', ')
          : '';
        const entitiesHtml = entityNamesPlain
          ? escapeHtml(entityNamesPlain)
          : '';

        const provider = providerLabel(response.provider);
        const logo = providerLogoHtml(response.provider);
        const model = response.model_name
          ? provider + ' / ' + response.model_name
          : provider;

        const providerCell = logo
          ? '<span style="display:inline-flex;align-items:center;gap:6px">' +
            logo +
            ' ' +
            escapeHtml(model) +
            '</span>'
          : escapeHtml(model);

        const analysisBlock = renderCredizonaAnalysisBlock(response);
        const rawResponse = response.raw_response
          ? '<details>' +
            '<summary>Ver respuesta</summary>' +
            '<div class="text-muted" style="white-space:pre-wrap;word-break:break-word">' +
            escapeHtml(response.raw_response) +
            '</div>' +
            analysisBlock +
            '</details>'
          : response.error
            ? '<details>' +
              '<summary>Ver error</summary>' +
              '<div class="text-muted" style="white-space:pre-wrap;word-break:break-word">' +
              escapeHtml(response.error) +
              '</div>' +
              '</details>'
            : '—';

        return (
          '<tr class="sms-row">' +
          '<td>' +
          providerCell +
          '</td>' +
          '<td><span class="email-badge' +
          statusBadgeClass(response.status) +
          '">' +
          escapeHtml(statusLabel(response.status)) +
          '</span></td>' +
          '<td>' +
          (response.mentions_credizona ? 'Sí' : 'No') +
          '</td>' +
          '<td' +
          (entityNamesPlain
            ? ' title="' + escapeHtml(entityNamesPlain) + '"'
            : '') +
          '>' +
          (entitiesHtml || '—') +
          '</td>' +
          formatUnknownCandidatesCell(response) +
          '<td>' +
          rawResponse +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderProviderTable(responses) {
    return (
      '<div class="sms-table-wrap"><table class="sms-table">' +
      '<thead><tr><th>Proveedor / modelo</th><th>Estado</th>' +
      '<th>Credizona</th><th>Competidores detectados</th>' +
      '<th>Posibles nuevos</th><th>Respuesta</th></tr></thead>' +
      '<tbody>' +
      renderProviderRows(responses) +
      '</tbody></table></div>'
    );
  }

  function renderList(weekOf, responses) {
    if (!listEl) return;
    if (!responses.length) {
      listEl.innerHTML =
        '<div class="sms-empty">Todavía no hay corridas. Tocá "Correr esta semana".</div>';
      return;
    }
    const groups = new Map();
    responses.forEach(function (response) {
      const key = response.prompt_id || response.prompt_text_snapshot || '';
      if (!groups.has(key)) {
        groups.set(key, {
          promptText: response.prompt_text_snapshot || '',
          responses: [],
        });
      }
      groups.get(key).responses.push(response);
    });

    const sections = Array.from(groups.values())
      .map(function (group) {
        return (
          '<section style="margin-top:20px">' +
          '<h3 class="ai-vis-section-title">' +
          escapeHtml(group.promptText) +
          '</h3>' +
          renderProviderTable(group.responses) +
          '</section>'
        );
      })
      .join('');

    listEl.innerHTML =
      '<p class="text-muted">Semana ' +
      escapeHtml(weekOf) +
      '</p>' +
      sections;
  }

  async function refresh() {
    if (!listEl) return;
    listEl.innerHTML = '<div class="sms-empty">Cargando…</div>';
    try {
      const result = await fetchLatestResponses();
      ranPromptIdsThisWeek = buildRanPromptIds(result.responses);
      renderList(result.weekOf, result.responses);
      if (cachedPromptsList.length) renderPrompts(cachedPromptsList);
    } catch (error) {
      listEl.innerHTML =
        '<div class="sms-empty">Error: ' +
        escapeHtml(error.message) +
        '</div>';
    }
  }

  if (!analyzeListenersAttached) {
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', async function () {
        let pending = analysisPendingCount;
        try {
          const status = await fetchAnalysisPending();
          applyAnalysisStatusUi(status.pending, status.failed);
          pending = status.pending;
        } catch (error) {
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              'Error: ' + (error && error.message ? error.message : 'unknown');
          }
          return;
        }
        if (pending <= 0) {
          applyAnalysisStatusUi(0, analysisFailedCount);
          return;
        }
        const confirmed = window.confirm(
          '¿Analizar ' +
            pending +
            ' respuestas pendientes? Esta acción realizará hasta ' +
            pending +
            ' llamadas pagas a OpenAI.',
        );
        if (!confirmed) return;

        const origAnalyze = analyzeBtn.textContent;
        const origRetry = retryAnalysisBtn
          ? retryAnalysisBtn.textContent
          : '';
        analyzeBtn.disabled = true;
        if (retryAnalysisBtn) retryAnalysisBtn.disabled = true;
        analyzeBtn.textContent = 'Analizando…';
        if (analysisStatusEl) {
          analysisStatusEl.textContent = 'Analizando menciones de Credizona…';
        }
        try {
          const response = await fetch(
            '/ai-visibility/analyze-credizona-mentions',
            { method: 'POST' },
          );
          const data = await readJsonSafe(response);
          if (!response.ok) {
            throw new Error(
              getErrorMessage(data, 'No se pudo completar el análisis.'),
            );
          }
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              (data.attempted != null ? data.attempted : 0) +
              ' procesadas: ' +
              (data.success != null ? data.success : 0) +
              ' correctas, ' +
              (data.error != null ? data.error : 0) +
              ' con error.';
          }
          await refresh();
          await refreshAnalysisStatus();
          await refreshCredizonaAnalysisSummary();
        } catch (error) {
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              'Error: ' + (error && error.message ? error.message : 'unknown');
          }
          await refreshAnalysisStatus();
        } finally {
          analyzeBtn.textContent = origAnalyze;
          if (retryAnalysisBtn) retryAnalysisBtn.textContent = origRetry;
        }
      });
    }

    if (retryAnalysisBtn) {
      retryAnalysisBtn.addEventListener('click', async function () {
        let failed = analysisFailedCount;
        try {
          const status = await fetchAnalysisPending();
          applyAnalysisStatusUi(status.pending, status.failed);
          failed = status.failed;
        } catch (error) {
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              'Error: ' + (error && error.message ? error.message : 'unknown');
          }
          return;
        }
        if (failed <= 0) {
          applyAnalysisStatusUi(analysisPendingCount, 0);
          return;
        }
        const confirmed = window.confirm(
          '¿Reintentar ' +
            failed +
            ' análisis con error? Esta acción realizará hasta ' +
            failed +
            ' llamadas pagas a OpenAI.',
        );
        if (!confirmed) return;

        const origRetry = retryAnalysisBtn.textContent;
        const origAnalyze = analyzeBtn ? analyzeBtn.textContent : '';
        retryAnalysisBtn.disabled = true;
        if (analyzeBtn) analyzeBtn.disabled = true;
        retryAnalysisBtn.textContent = 'Reintentando…';
        if (analysisStatusEl) {
          analysisStatusEl.textContent = 'Reintentando análisis con error…';
        }
        try {
          const response = await fetch(
            '/ai-visibility/retry-credizona-analysis-errors',
            { method: 'POST' },
          );
          const data = await readJsonSafe(response);
          if (!response.ok) {
            throw new Error(
              getErrorMessage(data, 'No se pudo reintentar el análisis.'),
            );
          }
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              (data.attempted != null ? data.attempted : 0) +
              ' procesadas: ' +
              (data.success != null ? data.success : 0) +
              ' correctas, ' +
              (data.error != null ? data.error : 0) +
              ' con error.';
          }
          await refresh();
          await refreshAnalysisStatus();
        } catch (error) {
          if (analysisStatusEl) {
            analysisStatusEl.textContent =
              'Error: ' + (error && error.message ? error.message : 'unknown');
          }
          await refreshAnalysisStatus();
        } finally {
          retryAnalysisBtn.textContent = origRetry;
          if (analyzeBtn) analyzeBtn.textContent = origAnalyze;
        }
      });
    }

    analyzeListenersAttached = true;
  }

  if (runBtn) {
    runBtn.addEventListener('click', async function () {
      const confirmed = window.confirm(
        '¿Correr la verificación ahora? Se consultarán las APIs configuradas.',
      );
      if (!confirmed) return;

      const originalText = runBtn.textContent;
      let lockWeeklyButton = false;
      runBtn.disabled = true;
      runBtn.textContent = 'Corriendo…';
      if (summaryEl) {
        summaryEl.innerHTML =
          '<div class="sms-empty">Consultando los proveedores configurados…</div>';
      }
      try {
        const result = await runNow();
        renderSummary(result);
        lockWeeklyButton = true;
        await refresh();
        await refreshEvolution({ force: true });
        await refreshAnalysisStatus();
      } catch (error) {
        if (error && error.status === 409) {
          lockWeeklyButton = true;
          setWeeklyRunLocked(true);
        } else {
          if (summaryEl) {
            summaryEl.innerHTML =
              '<div class="sms-empty">Error: ' +
              escapeHtml(error.message) +
              '</div>';
          }
          // HTTP may have timed out while the server kept writing rows — refresh later.
          setTimeout(function () {
            refresh();
            refreshEvolution({ force: true });
            refreshAnalysisStatus();
          }, 3000);
        }
      } finally {
        runBtn.textContent = originalText;
        runBtn.disabled = lockWeeklyButton;
      }
    });
  }

  const adhocSave = document.getElementById('ai-visibility-adhoc-save');
  const adhocCategoryWrap = document.getElementById(
    'ai-visibility-adhoc-category-wrap',
  );
  const adhocText = document.getElementById('ai-visibility-adhoc-text');
  const adhocCategory = document.getElementById('ai-visibility-adhoc-category');
  const adhocRunBtn = document.getElementById('ai-visibility-adhoc-run-btn');
  const adhocResult = document.getElementById('ai-visibility-adhoc-result');

  if (adhocSave && adhocCategoryWrap) {
    adhocSave.addEventListener('change', function () {
      if (adhocSave.checked) {
        adhocCategoryWrap.classList.remove('hidden');
      } else {
        adhocCategoryWrap.classList.add('hidden');
      }
    });
  }

  if (adhocRunBtn) {
    adhocRunBtn.addEventListener('click', async function () {
      const text = adhocText ? String(adhocText.value || '').trim() : '';
      if (!text) {
        alert('Escribí un prompt para correr.');
        return;
      }

      const save = !!(adhocSave && adhocSave.checked);
      const category = adhocCategory ? adhocCategory.value : '';
      if (save && !category) {
        alert('Elegí una categoría para guardar el prompt.');
        return;
      }

      const confirmed = window.confirm(
        save
          ? '¿Guardar este prompt y correrlo ahora con los 4 proveedores? Se consultarán las APIs (llamadas pagas).'
          : '¿Correr este prompt una vez con los 4 proveedores? Se consultarán las APIs (llamadas pagas).',
      );
      if (!confirmed) return;

      const originalText = adhocRunBtn.textContent;
      adhocRunBtn.disabled = true;
      adhocRunBtn.textContent = 'Corriendo…';
      if (adhocResult) adhocResult.innerHTML = '';

      try {
        const body = { text: text, save: save };
        if (save) body.category = category;

        const response = await fetch('/ai-visibility/run-adhoc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await readJsonSafe(response);
        if (!response.ok) {
          throw new Error(
            getErrorMessage(data, 'No se pudo correr el prompt ad-hoc.'),
          );
        }

        if (data.saved) {
          if (adhocText) adhocText.value = '';
          if (adhocSave) {
            adhocSave.checked = false;
            if (adhocCategoryWrap) adhocCategoryWrap.classList.add('hidden');
          }
          if (adhocResult) {
            adhocResult.innerHTML =
              '<p class="text-muted">Prompt guardado y corrido. Resultados abajo.</p>';
          }
          await loadPrompts();
          await refresh();
          await refreshEvolution({ force: true });
          await refreshAnalysisStatus();
        } else {
          const results = Array.isArray(data.results) ? data.results : [];
          if (adhocResult) {
            adhocResult.innerHTML =
              '<p class="text-muted" style="margin-top:12px">Resultado de prueba (no guardado)</p>' +
              renderProviderTable(results);
          }
        }
      } catch (error) {
        if (adhocResult) {
          adhocResult.innerHTML =
            '<div class="sms-empty">Error: ' +
            escapeHtml(error.message) +
            '</div>';
        } else {
          alert('Error: ' + error.message);
        }
      } finally {
        adhocRunBtn.disabled = false;
        adhocRunBtn.textContent = originalText;
      }
    });
  }

  window.__openAiVisibility = function () {
    loadPrompts();
    refresh();
    refreshAnalysisStatus();
    refreshCredizonaAnalysisSummary();
    fetchRunStatus()
      .then(function (status) {
        if (status.already_run) {
          setWeeklyRunLocked(true);
        } else if (runBtn) {
          runBtn.disabled = false;
        }
      })
      .catch(function () {
        /* no bloquear el tab si falla el status */
      });
    refreshEvolution({ force: true });
  };
})();

(function initJanusLogout() {
  const btn = document.getElementById('janus-logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    btn.disabled = true;
    try {
      await fetch((typeof API_BASE === 'string' ? API_BASE : '') + '/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
    } catch (_err) {
      /* redirect anyway */
    }
    window.location.href = '/login.html';
  });
})();

/* ----------------------------------------------------------------------------
 * Administrar — usuarios del dashboard (solo is_admin; auth real en /api/admin)
 * UX only for the tab; never hash passwords in the browser.
 * ------------------------------------------------------------------------- */
(function initAdminUsers() {
  const panel = document.getElementById('admin-panel');
  const tbody = document.getElementById('admin-users-tbody');
  const listStatus = document.getElementById('admin-list-status');
  const createStatus = document.getElementById('admin-create-status');
  const createForm = document.getElementById('admin-create-form');
  const createPermsEl = document.getElementById('admin-create-permissions');
  const createPermsWrap = document.getElementById('admin-create-permissions-wrap');
  const isAdminCb = document.getElementById('admin-create-is-admin');
  const reloadBtn = document.getElementById('admin-reload-btn');
  if (!panel || !tbody || !createForm || !createPermsEl) return;

  const API = typeof API_BASE === 'string' ? API_BASE : '';
  let sectionKeys = [];
  let usersCache = [];

  function setStatus(el, message, isError) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('mcl-error', Boolean(isError));
  }

  function renderCreatePermissionChecks() {
    createPermsEl.innerHTML = sectionKeys
      .map(function (key) {
        return (
          '<label class="admin-perm-check">' +
          '<input type="checkbox" name="admin-create-perm" value="' +
          escapeHtml(key) +
          '" /> ' +
          escapeHtml(key) +
          '</label>'
        );
      })
      .join('');
  }

  function selectedCreatePermissions() {
    return Array.prototype.slice
      .call(createForm.querySelectorAll('input[name="admin-create-perm"]:checked'))
      .map(function (el) {
        return el.value;
      });
  }

  function syncCreateAdminUi() {
    const admin = isAdminCb && isAdminCb.checked;
    if (createPermsWrap) {
      createPermsWrap.hidden = Boolean(admin);
      createPermsWrap.style.display = admin ? 'none' : '';
    }
  }

  function renderUsers() {
    tbody.innerHTML = '';
    if (!usersCache.length) {
      tbody.innerHTML = '<tr><td colspan="5">No hay usuarios.</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    usersCache.forEach(function (u) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-user-id', u.id);
      const permsText = u.is_admin
        ? '(acceso total)'
        : (u.permissions || []).join(', ') || '—';
      tr.innerHTML =
        '<td>' +
        escapeHtml(u.email) +
        '</td>' +
        '<td>' +
        (u.is_admin ? 'sí' : 'no') +
        '</td>' +
        '<td>' +
        (u.active ? 'sí' : 'no') +
        '</td>' +
        '<td class="admin-perms-cell">' +
        escapeHtml(permsText) +
        '</td>' +
        '<td class="admin-actions-cell"></td>';
      const actions = tr.querySelector('.admin-actions-cell');
      if (!u.is_admin) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn';
        editBtn.textContent = 'Permisos';
        editBtn.addEventListener('click', function () {
          editPermissions(u);
        });
        actions.appendChild(editBtn);
      }
      const pwdBtn = document.createElement('button');
      pwdBtn.type = 'button';
      pwdBtn.className = 'btn';
      pwdBtn.textContent = 'Cambiar contraseña';
      pwdBtn.addEventListener('click', function () {
        changePassword(u);
      });
      actions.appendChild(pwdBtn);
      if (u.active) {
        const deact = document.createElement('button');
        deact.type = 'button';
        deact.className = 'btn';
        deact.textContent = 'Desactivar';
        deact.addEventListener('click', function () {
          deactivateUser(u);
        });
        actions.appendChild(deact);
      } else {
        const react = document.createElement('button');
        react.type = 'button';
        react.className = 'btn';
        react.textContent = 'Reactivar';
        react.addEventListener('click', function () {
          patchUser(u.id, { active: true });
        });
        actions.appendChild(react);
      }
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  async function loadUsers() {
    setStatus(listStatus, 'Cargando…', false);
    try {
      const res = await fetch(API + '/api/admin/users', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (res.status === 403) {
        setStatus(listStatus, 'Sin permiso de administrador.', true);
        return;
      }
      if (!res.ok) {
        setStatus(
          listStatus,
          (data && data.error) || 'Error al listar usuarios',
          true,
        );
        return;
      }
      sectionKeys = Array.isArray(data.sectionKeys) ? data.sectionKeys : [];
      usersCache = Array.isArray(data.users) ? data.users : [];
      renderCreatePermissionChecks();
      renderUsers();
      setStatus(listStatus, usersCache.length + ' usuario(s)', false);
    } catch (_err) {
      setStatus(listStatus, 'No se pudo conectar.', true);
    }
  }

  async function patchUser(id, body) {
    setStatus(listStatus, 'Guardando…', false);
    try {
      const res = await fetch(API + '/api/admin/users/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(listStatus, (data && data.error) || 'Error al actualizar', true);
        return;
      }
      await loadUsers();
    } catch (_err) {
      setStatus(listStatus, 'No se pudo conectar.', true);
    }
  }

  function changePassword(u) {
    const raw = window.prompt(
      'Nueva contraseña para ' + u.email + ' (mínimo 8 caracteres):',
    );
    if (raw == null) return;
    const password = String(raw);
    if (password.length < 8) {
      setStatus(listStatus, 'password mínimo 8 caracteres', true);
      return;
    }
    patchPassword(u.id, password);
  }

  async function patchPassword(id, password) {
    setStatus(listStatus, 'Guardando…', false);
    try {
      const res = await fetch(
        API + '/api/admin/users/' + encodeURIComponent(id) + '/password',
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ password: password }),
        },
      );
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(
          listStatus,
          (data && data.error) || 'Error al actualizar la contraseña',
          true,
        );
        return;
      }
      setStatus(listStatus, 'Contraseña actualizada', false);
    } catch (_err) {
      setStatus(listStatus, 'No se pudo conectar.', true);
    }
  }

  function deactivateUser(u) {
    if (!window.confirm('¿Desactivar a ' + u.email + '?')) return;
    patchUser(u.id, { active: false });
  }

  async function editPermissions(u) {
    const current = new Set(u.permissions || []);
    const raw = window.prompt(
      'Permisos para ' +
        u.email +
        ' (marcá con x las secciones; una por línea):',
      sectionKeys
        .map(function (key) {
          return (current.has(key) ? 'x ' : '  ') + key;
        })
        .join('\n'),
    );
    if (raw == null) return;
    const next = [];
    String(raw)
      .split(/\r?\n/)
      .forEach(function (line) {
        const m = /^\s*[xX*]\s+(\S+)/.exec(line);
        if (m && sectionKeys.indexOf(m[1]) !== -1) next.push(m[1]);
      });
    setStatus(listStatus, 'Guardando permisos…', false);
    try {
      const res = await fetch(
        API + '/api/admin/users/' + encodeURIComponent(u.id) + '/permissions',
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ permissions: next }),
        },
      );
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(
          listStatus,
          (data && data.error) || 'Error al guardar permisos',
          true,
        );
        return;
      }
      await loadUsers();
    } catch (_err) {
      setStatus(listStatus, 'No se pudo conectar.', true);
    }
  }

  createForm.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    setStatus(createStatus, 'Creando…', false);
    const email = document.getElementById('admin-create-email').value;
    const password = document.getElementById('admin-create-password').value;
    const is_admin = Boolean(isAdminCb && isAdminCb.checked);
    const permissions = is_admin ? [] : selectedCreatePermissions();
    try {
      const res = await fetch(API + '/api/admin/users', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password, is_admin, permissions }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(
          createStatus,
          (data && data.error) || 'No se pudo crear',
          true,
        );
        return;
      }
      createForm.reset();
      syncCreateAdminUi();
      setStatus(
        createStatus,
        'Usuario creado: ' + ((data.user && data.user.email) || email),
        false,
      );
      await loadUsers();
    } catch (_err) {
      setStatus(createStatus, 'No se pudo conectar.', true);
    }
  });

  if (isAdminCb) {
    isAdminCb.addEventListener('change', syncCreateAdminUi);
    syncCreateAdminUi();
  }
  if (reloadBtn) reloadBtn.addEventListener('click', loadUsers);

  window.__openAdmin = function () {
    loadUsers();
  };
})();

/* ----------------------------------------------------------------------------
 * Funnel Credizona — local summary + sync via session (no X-Cron-Key)
 * ------------------------------------------------------------------------- */
(function initCzFunnel() {
  const panel = document.getElementById('cz-funnel-panel');
  const statusEl = document.getElementById('cz-funnel-status');
  const resultsEl = document.getElementById('cz-funnel-results');
  const monthKpisEl = document.getElementById('cz-funnel-month-kpis');
  const syncBtn = document.getElementById('cz-funnel-sync-btn');
  const reloadBtn = document.getElementById('cz-funnel-reload-btn');
  if (!panel || !statusEl || !resultsEl) return;

  const API = typeof API_BASE === 'string' ? API_BASE : '';

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('mcl-error', Boolean(isError));
  }

  function formatMoney(n) {
    if (n == null || n === '') return '—';
    const rounded = Math.round(Number(n));
    if (!Number.isFinite(rounded)) return '—';
    return (
      (rounded < 0 ? '-' : '') +
      '$' +
      Math.abs(rounded).toLocaleString('es-UY', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })
    );
  }

  function currentMonthMontevideo() {
    const ymd = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Montevideo',
    });
    return ymd && ymd.length >= 7 ? ymd.slice(0, 7) : '';
  }

  function formatCzMonthLabel(yyyyMm) {
    const parts = String(yyyyMm || '').split('-');
    if (parts.length < 2) return String(yyyyMm || '');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return String(yyyyMm);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleDateString('es-UY', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  function numOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function perGranted(numerator, grantedCount) {
    if (numerator == null || numerator === '') return '—';
    const den = Number(grantedCount);
    if (!Number.isFinite(den) || den <= 0) return '—';
    const num = Number(numerator);
    if (!Number.isFinite(num)) return '—';
    return formatMoney(num / den);
  }

  function emptyChannelMetrics() {
    return {
      granted_count: 0,
      monto_total_otorgado: 0,
      spend: 0,
      utility: 0,
    };
  }

  function metricsFromUtilRow(row) {
    if (!row || typeof row !== 'object') return emptyChannelMetrics();
    return {
      granted_count: numOrZero(row.granted_count),
      monto_total_otorgado: numOrZero(row.monto_total_otorgado),
      spend: row.spend == null ? null : numOrZero(row.spend),
      utility: row.utility == null ? null : numOrZero(row.utility),
    };
  }

  function addMetrics(a, b) {
    const spendA = a.spend;
    const spendB = b.spend;
    const utilA = a.utility;
    const utilB = b.utility;
    return {
      granted_count: a.granted_count + b.granted_count,
      monto_total_otorgado: a.monto_total_otorgado + b.monto_total_otorgado,
      spend: spendA == null || spendB == null ? null : spendA + spendB,
      utility: utilA == null || utilB == null ? null : utilA + utilB,
    };
  }

  function currentMonthChannelMetrics(utilRowsRaw, monthKey) {
    const by = {
      meta: emptyChannelMetrics(),
      sms: emptyChannelMetrics(),
      sin_atribuir: emptyChannelMetrics(),
    };
    (utilRowsRaw || []).forEach(function (r) {
      const monthRaw = r.period_month == null ? '' : String(r.period_month);
      const month = monthRaw.length >= 7 ? monthRaw.slice(0, 7) : monthRaw;
      if (month !== monthKey) return;
      const ch = r.channel == null ? '' : String(r.channel);
      if (ch === 'meta' || ch === 'sms' || ch === 'sin_atribuir') {
        by[ch] = metricsFromUtilRow(r);
      }
    });
    return {
      by: by,
      total: addMetrics(addMetrics(by.meta, by.sms), by.sin_atribuir),
    };
  }

  function renderKpiCard(value, label, tone) {
    const t = tone || 'neutral';
    return (
      '<div class="kpi-card is-' +
      escapeHtml(t) +
      '"><div class="kpi-value">' +
      escapeHtml(String(value)) +
      '</div><div class="kpi-label">' +
      escapeHtml(label) +
      '</div></div>'
    );
  }

  function renderKpiSection(title, innerHtml, gridClass) {
    return (
      '<section class="cz-funnel-kpi-section">' +
      '<h3 class="sms-section-title">' +
      escapeHtml(title) +
      '</h3>' +
      '<div class="' +
      escapeHtml(gridClass || 'kpi-grid sms-monthly-kpi-grid') +
      '">' +
      innerHtml +
      '</div></section>'
    );
  }

  function renderKpiSectionError(title, err) {
    return (
      '<section class="cz-funnel-kpi-section">' +
      '<h3 class="sms-section-title">' +
      escapeHtml(title) +
      '</h3><p class="text-muted">' +
      escapeHtml(err) +
      '</p></section>'
    );
  }

  function isMissingDisplay(value) {
    return value == null || value === '' || String(value) === '—';
  }

  function utilitySign(raw) {
    if (raw == null || raw === '') return '';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '';
    return n < 0 ? 'neg' : 'pos';
  }

  function renderKpiTotalCard(emoji, value, label, kind, raw) {
    let extra = ' is-neutral';
    if (kind === 'utility' && !isMissingDisplay(value)) {
      extra = utilitySign(raw) === 'neg' ? ' is-neg' : ' is-pos';
    }
    if (isMissingDisplay(value)) extra += ' is-missing';
    return (
      '<div class="cz-funnel-kpi-total' +
      extra +
      '">' +
      '<div class="cz-funnel-kpi-emoji" aria-hidden="true">' +
      escapeHtml(emoji) +
      '</div>' +
      '<div class="cz-funnel-kpi-value">' +
      escapeHtml(String(value)) +
      '</div>' +
      '<div class="cz-funnel-kpi-label">' +
      escapeHtml(label) +
      '</div></div>'
    );
  }

  let czFunnelMetaIconSeq = 0;

  function renderCzFunnelMetaIcon() {
    czFunnelMetaIconSeq += 1;
    const g1 = 'cz-funnel-meta-g1-' + czFunnelMetaIconSeq;
    const g2 = 'cz-funnel-meta-g2-' + czFunnelMetaIconSeq;
    return (
      '<svg class="cz-funnel-channel-icon cz-funnel-channel-icon-meta" viewBox="0 0 290 191" width="21" height="14" aria-hidden="true" focusable="false">' +
      '<defs>' +
      '<linearGradient id="' +
      g1 +
      '" x1="61" y1="117" x2="259" y2="127" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#0064e1" offset="0"/>' +
      '<stop stop-color="#0064e1" offset="0.4"/>' +
      '<stop stop-color="#0073ee" offset="0.83"/>' +
      '<stop stop-color="#0082fb" offset="1"/>' +
      '</linearGradient>' +
      '<linearGradient id="' +
      g2 +
      '" x1="45" y1="139" x2="45" y2="66" gradientUnits="userSpaceOnUse">' +
      '<stop stop-color="#0082fb" offset="0"/>' +
      '<stop stop-color="#0064e0" offset="1"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<path fill="#0081fb" d="m31.06,125.96c0,10.98 2.41,19.41 5.56,24.51 4.13,6.68 10.29,9.51 16.57,9.51 8.1,0 15.51-2.01 29.79-21.76 11.44-15.83 24.92-38.05 33.99-51.98l15.36-23.6c10.67-16.39 23.02-34.61 37.18-46.96 11.56-10.08 24.03-15.68 36.58-15.68 21.07,0 41.14,12.21 56.5,35.11 16.81,25.08 24.97,56.67 24.97,89.27 0,19.38-3.82,33.62-10.32,44.87-6.28,10.88-18.52,21.75-39.11,21.75l0-31.02c17.63,0 22.03-16.2 22.03-34.74 0-26.42-6.16-55.74-19.73-76.69-9.63-14.86-22.11-23.94-35.84-23.94-14.85,0-26.8,11.2-40.23,31.17-7.14,10.61-14.47,23.54-22.7,38.13l-9.06,16.05c-18.2,32.27-22.81,39.62-31.91,51.75-15.95,21.24-29.57,29.29-47.5,29.29-21.27,0-34.72-9.21-43.05-23.09-6.8-11.31-10.14-26.15-10.14-43.06z"/>' +
      '<path fill="url(#' +
      g1 +
      ')" d="m24.49,37.3c14.24-21.95 34.79-37.3 58.36-37.3 13.65,0 27.22,4.04 41.39,15.61 15.5,12.65 32.02,33.48 52.63,67.81l7.39,12.32c17.84,29.72 27.99,45.01 33.93,52.22 7.64,9.26 12.99,12.02 19.94,12.02 17.63,0 22.03-16.2 22.03-34.74l27.4-.86c0,19.38-3.82,33.62-10.32,44.87-6.28,10.88-18.52,21.75-39.11,21.75-12.8,0-24.14-2.78-36.68-14.61-9.64-9.08-20.91-25.21-29.58-39.71l-25.79-43.08c-12.94-21.62-24.81-37.74-31.68-45.04-7.39-7.85-16.89-17.33-32.05-17.33-12.27,0-22.69,8.61-31.41,21.78z"/>' +
      '<path fill="url(#' +
      g2 +
      ')" d="m82.35,31.23c-12.27,0-22.69,8.61-31.41,21.78-12.33,18.61-19.88,46.33-19.88,72.95 0,10.98 2.41,19.41 5.56,24.51l-26.48,17.44c-6.8-11.31-10.14-26.15-10.14-43.06 0-30.75 8.44-62.8 24.49-87.55 14.24-21.95 34.79-37.3 58.36-37.3z"/>' +
      '</svg>'
    );
  }

  function renderCzFunnelChannelIcon(channel) {
    if (channel === 'meta') return renderCzFunnelMetaIcon();
    if (channel === 'sms') {
      return '<i class="ti ti-message-circle cz-funnel-channel-icon" aria-hidden="true"></i>';
    }
    return '<span class="cz-funnel-kpi-emoji" aria-hidden="true">❓</span>';
  }

  function renderKpiBreakdownCard(channel, value, label, kind, raw) {
    let extra = '';
    if (isMissingDisplay(value)) extra += ' is-missing';
    else if (kind === 'utility' && utilitySign(raw) === 'neg') extra += ' is-neg';
    return (
      '<div class="cz-funnel-kpi-break' +
      extra +
      '">' +
      '<div class="cz-funnel-kpi-icon" aria-hidden="true">' +
      renderCzFunnelChannelIcon(channel) +
      '</div>' +
      '<div class="cz-funnel-kpi-value">' +
      escapeHtml(String(value)) +
      '</div>' +
      '<div class="cz-funnel-kpi-label">' +
      escapeHtml(label) +
      '</div></div>'
    );
  }

  function renderMetricRow(opts) {
    const kind = opts.kind || 'neutral';
    const emoji = opts.emoji;
    return (
      '<div class="cz-funnel-metric-row">' +
      renderKpiTotalCard(emoji, opts.total, opts.label, kind, opts.totalRaw) +
      renderKpiBreakdownCard('meta', opts.meta, 'Meta', kind, opts.metaRaw) +
      renderKpiBreakdownCard('sms', opts.sms, 'SMS', kind, opts.smsRaw) +
      renderKpiBreakdownCard(
        'sin',
        opts.sin,
        'sin_atribuir',
        kind,
        opts.sinRaw,
      ) +
      '</div>'
    );
  }

  function renderResultado(by, tot) {
    return renderKpiSection(
      'Resultado',
      renderMetricRow({
        kind: 'utility',
        emoji: '💰',
        label: 'Utilidad',
        total: formatMoney(tot.utility),
        totalRaw: tot.utility,
        meta: formatMoney(by.meta.utility),
        metaRaw: by.meta.utility,
        sms: formatMoney(by.sms.utility),
        smsRaw: by.sms.utility,
        sin: formatMoney(by.sin_atribuir.utility),
        sinRaw: by.sin_atribuir.utility,
      }) +
        renderMetricRow({
          kind: 'neutral',
          emoji: '💸',
          label: 'Gasto',
          total: formatMoney(tot.spend),
          meta: formatMoney(by.meta.spend),
          sms: formatMoney(by.sms.spend),
          sin: formatMoney(by.sin_atribuir.spend),
        }),
      'cz-funnel-metric-stack',
    );
  }

  function renderNegocio(by, tot) {
    return renderKpiSection(
      'Negocio',
      renderMetricRow({
        kind: 'neutral',
        emoji: '🏦',
        label: 'Monto colocado',
        total: formatMoney(tot.monto_total_otorgado),
        meta: formatMoney(by.meta.monto_total_otorgado),
        sms: formatMoney(by.sms.monto_total_otorgado),
        sin: formatMoney(by.sin_atribuir.monto_total_otorgado),
      }) +
        renderMetricRow({
          kind: 'neutral',
          emoji: '🔢',
          label: 'Otorgados',
          total: String(tot.granted_count),
          meta: String(by.meta.granted_count),
          sms: String(by.sms.granted_count),
          sin: String(by.sin_atribuir.granted_count),
        }) +
        renderMetricRow({
          kind: 'neutral',
          emoji: '💳',
          label: 'Ticket promedio',
          total: perGranted(tot.monto_total_otorgado, tot.granted_count),
          meta: perGranted(by.meta.monto_total_otorgado, by.meta.granted_count),
          sms: perGranted(by.sms.monto_total_otorgado, by.sms.granted_count),
          sin: perGranted(
            by.sin_atribuir.monto_total_otorgado,
            by.sin_atribuir.granted_count,
          ),
        }) +
        renderMetricRow({
          kind: 'neutral',
          emoji: '🎯',
          label: 'Costo por otorgado',
          total: perGranted(tot.spend, tot.granted_count),
          meta: perGranted(by.meta.spend, by.meta.granted_count),
          sms: perGranted(by.sms.spend, by.sms.granted_count),
          sin: perGranted(by.sin_atribuir.spend, by.sin_atribuir.granted_count),
        }),
      'cz-funnel-metric-stack',
    );
  }

  function renderCalidad(encRow) {
    const count = encRow ? numOrZero(encRow.total_encuestas) : 0;
    const scoreRaw = encRow && encRow.score_promedio;
    const scoreNum = Number(scoreRaw);
    const score =
      scoreRaw == null || !Number.isFinite(scoreNum) ? '—' : String(scoreRaw);
    return renderKpiSection(
      'Calidad',
      renderKpiCard(String(count), '📋 Encuestas del mes', 'neutral') +
        renderKpiCard(score, '⭐ Score promedio', 'accent'),
    );
  }

  function renderCollapsibleBlock(title, innerHtml) {
    return (
      '<details class="cz-funnel-block">' +
      '<summary class="sms-section-title">' +
      '<span class="cz-funnel-chevron" aria-hidden="true">▸</span>' +
      escapeHtml(title) +
      '</summary>' +
      innerHtml +
      '</details>'
    );
  }

  function renderTable(title, headers, rows) {
    if (!rows.length) {
      return renderCollapsibleBlock(
        title,
        '<p class="text-muted">Sin datos.</p>',
      );
    }
    const head = headers
      .map(function (h) {
        return '<th>' + escapeHtml(h) + '</th>';
      })
      .join('');
    const body = rows
      .map(function (r) {
        return (
          '<tr>' +
          r
            .map(function (c) {
              return '<td>' + escapeHtml(String(c)) + '</td>';
            })
            .join('') +
          '</tr>'
        );
      })
      .join('');
    return renderCollapsibleBlock(
      title,
      '<div class="table-wrap"><table class="ga4-table"><thead><tr>' +
        head +
        '</tr></thead><tbody>' +
        body +
        '</tbody></table></div>',
    );
  }

  async function loadSummary() {
    setStatus('Cargando resumen…', false);
    try {
      const [sumRes, utilRes] = await Promise.all([
        fetch(API + '/reports/cz-funnel-summary', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        }),
        fetch(API + '/reports/cz-funnel-channel-utility', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        }).catch(function () {
          return null;
        }),
      ]);
      const data = await sumRes.json().catch(function () {
        return {};
      });
      const utilData =
        utilRes &&
        (await utilRes.json().catch(function () {
          return {};
        }));
      if (!sumRes.ok) {
        setStatus((data && data.error) || 'Error al cargar resumen', true);
        if (monthKpisEl) monthKpisEl.innerHTML = '';
        resultsEl.innerHTML = '';
        return;
      }
      const monthKey = currentMonthMontevideo();
      const totals = data.totals || {};
      const solRows = (data.solicitudesByMonth || []).map(function (r) {
        return [r.month, r.total_solicitudes];
      });
      const grantRows = (data.grantedByMonth || []).map(function (r) {
        return [r.month, r.total_granted, formatMoney(r.monto_total_otorgado)];
      });
      const encRows = (data.encuestasByMonth || []).map(function (r) {
        return [
          r.month,
          r.total_encuestas,
          r.score_promedio == null ? '—' : r.score_promedio,
        ];
      });
      const utilTitle =
        'Utilidad por canal — Fecha aproximada (creación de solicitud, no otorgamiento real) — pendiente de corrección';
      const utilHeaders = [
        'Mes',
        'Canal',
        'Cant. Otorgados',
        'Monto Otorgado',
        'Revenue (6%)',
        'Gasto',
        'Utilidad',
      ];
      let utilBlock;
      let resultadoNegocioHtml;
      if (!utilRes || !utilRes.ok) {
        const utilErr =
          (utilData && utilData.error) || 'Error al cargar utilidad por canal';
        utilBlock = renderCollapsibleBlock(
          utilTitle,
          '<p class="text-muted">' + escapeHtml(String(utilErr)) + '</p>',
        );
        resultadoNegocioHtml =
          renderKpiSectionError('Resultado', String(utilErr)) +
          renderKpiSectionError('Negocio', String(utilErr));
      } else {
        const utilRows = (utilData.rows || []).map(function (r) {
          const monthRaw = r.period_month == null ? '' : String(r.period_month);
          const month = monthRaw.length >= 7 ? monthRaw.slice(0, 7) : monthRaw;
          return [
            month,
            r.channel == null ? '' : String(r.channel),
            r.granted_count == null ? 0 : r.granted_count,
            formatMoney(r.monto_total_otorgado),
            formatMoney(r.revenue),
            formatMoney(r.spend),
            formatMoney(r.utility),
          ];
        });
        utilBlock = renderTable(utilTitle, utilHeaders, utilRows);
        const missingFx = (utilData.rows || []).some(function (r) {
          return r.channel === 'meta' && (r.spend == null || r.utility == null);
        });
        if (missingFx) {
          utilBlock +=
            '<p class="cz-funnel-totals text-muted">Gasto/utilidad Meta en — = falta cotización BCU (USD→UYU) para algún día con spend.</p>';
        }
        const agg = currentMonthChannelMetrics(utilData.rows || [], monthKey);
        czFunnelMetaIconSeq = 0;
        resultadoNegocioHtml =
          renderResultado(agg.by, agg.total) + renderNegocio(agg.by, agg.total);
      }
      const encRow = (data.encuestasByMonth || []).find(function (r) {
        return r.month === monthKey;
      });
      if (monthKpisEl) {
        monthKpisEl.innerHTML =
          '<section class="cz-funnel-month-summary">' +
          '<h2 class="sms-section-title">Mes corriente — ' +
          escapeHtml(formatCzMonthLabel(monthKey)) +
          '</h2>' +
          resultadoNegocioHtml +
          renderCalidad(encRow) +
          '</section>';
      }
      resultsEl.innerHTML =
        '<p class="cz-funnel-totals text-muted">Totales — solicitudes: ' +
        escapeHtml(String(totals.solicitudes || 0)) +
        ' · granted: ' +
        escapeHtml(String(totals.grantedLoans || 0)) +
        ' · encuestas: ' +
        escapeHtml(String(totals.encuestas || 0)) +
        '</p>' +
        renderTable('Solicitudes por mes', ['Mes', 'Total'], solRows) +
        renderTable(
          'Créditos GRANTED por mes (updated ≈ tiempo)',
          ['Mes', 'Total', 'Monto otorgado'],
          grantRows,
        ) +
        renderTable(
          'Encuestas por mes (score_v2)',
          ['Mes', 'Total', 'Score promedio'],
          encRows,
        ) +
        utilBlock;
      setStatus('', false);
    } catch (_err) {
      setStatus('No se pudo conectar.', true);
    }
  }

  async function runSync() {
    if (syncBtn) syncBtn.disabled = true;
    setStatus('Sincronizando…', false);
    try {
      const res = await fetch(API + '/jobs/run-cz-data-sync', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(
          (data && (data.error || data.reason)) || 'Sync falló',
          true,
        );
        return;
      }
      setStatus('Sync OK — recargando resumen…', false);
      await loadSummary();
    } catch (_err) {
      setStatus('No se pudo sincronizar.', true);
    } finally {
      if (syncBtn) syncBtn.disabled = false;
    }
  }

  if (syncBtn) syncBtn.addEventListener('click', runSync);
  if (reloadBtn) reloadBtn.addEventListener('click', loadSummary);

  window.__openCzFunnel = function () {
    loadSummary();
  };
})();
