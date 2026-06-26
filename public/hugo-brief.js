'use strict';

/**
 * Hugo — Competitive Intelligence Brief (UI v1)
 * Frontend only. Consumes POST /hugo/run (relative path).
 * No frameworks, no dependencies, no build. Vanilla JS.
 */

const HUGO_ENDPOINT = '/hugo/run';
const REQUEST_TIMEOUT_MS = 120000;

// Centralized attention mapping (label + css modifier).
const ATTENTION_MAP = {
  NORMAL: { label: 'Normal', cls: 'att-normal' },
  INTERESTING: { label: 'Interesting', cls: 'att-interesting' },
  HIGH: { label: 'High', cls: 'att-high' },
  STRATEGIC: { label: 'Strategic', cls: 'att-strategic' },
};

const state = {
  loading: false,
  error: null,
  data: null,
};

const root = document.getElementById('app');

/* ----------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------- */

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isInteger(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatDate(dateStr) {
  return dateStr ? String(dateStr) : '—';
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  return d.toLocaleString('es-UY');
}

// Local browser time as HH:mm (no substring / no ISO split, no server UTC).
function formatLocalHHmm(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function humanizeKey(key) {
  const map = {
    daysAvailable: 'Días disponibles',
    note: 'Nota',
    confidence: 'Confianza',
    coverage: 'Cobertura',
    missingEntities: 'Entidades faltantes',
    warnings: 'Advertencias',
  };
  if (map[key]) return map[key];
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => String(v)).join(', ') : '—';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* ----------------------------------------------------------------------------
 * Data fetching
 * ------------------------------------------------------------------------- */

async function fetchBrief() {
  state.loading = true;
  state.error = null;
  render();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(HUGO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`El servidor respondió con estado ${response.status}.`);
    }

    const data = await response.json();
    state.data = data;
    state.loading = false;
    render();
  } catch (err) {
    clearTimeout(timer);
    state.loading = false;
    state.data = null;
    if (err && err.name === 'AbortError') {
      state.error = 'La generación del brief superó el tiempo de espera. Intentá nuevamente.';
    } else {
      state.error = err && err.message ? err.message : 'Error desconocido.';
    }
    render();
  }
}

/* ----------------------------------------------------------------------------
 * Section renderers
 * ------------------------------------------------------------------------- */

function renderHeader(date, generatedAt) {
  return `
    <header class="brief-header">
      <div>
        <div class="logo">Hugo</div>
        <div class="product">Competitive Intelligence Brief</div>
      </div>
      <div class="meta-right">
        <div class="date">${escapeHtml(formatDate(date))}</div>
        <button class="btn btn-secondary header-reload" data-action="reload">Actualizar</button>
      </div>
    </header>
  `;
}

// Reusable attention badge (shared styles, no duplication).
function attentionBadge(levelRaw) {
  const key = typeof levelRaw === 'string' ? levelRaw.toUpperCase() : '';
  const conf = ATTENTION_MAP[key] || { label: key || 'Desconocido', cls: 'att-normal' };
  return `<span class="attention-badge ${conf.cls}">${escapeHtml(conf.label)}</span>`;
}

// Metadata bar: local generation time (HH:mm), attention badge, confidence.
function renderMetaBar(attentionLevel, confidence, generatedAt) {
  const time = formatLocalHHmm(generatedAt);
  const timeHtml = time
    ? `<span class="meta-gen">Generado a las ${escapeHtml(time)}</span>`
    : '';
  const confHtml = confidence
    ? `<span class="meta-confidence">Confianza: ${escapeHtml(String(confidence))}</span>`
    : '';

  return `
    <div class="meta-bar">
      ${timeHtml}
      ${attentionBadge(attentionLevel)}
      ${confHtml}
    </div>
  `;
}

function renderInvestigationCta() {
  return `
    <section class="section investigation-cta">
      <h2 class="cta-title">¿Necesitás la evidencia completa detrás de este análisis?</h2>
      <a class="btn btn-secondary cta-link" href="/mie-dashboard.html">Ver datos operativos →</a>
      &nbsp;&nbsp;
      <a class="btn btn-secondary cta-link" href="/voice-brief.html">Escuchar Voice Brief →</a>
    </section>
  `;
}

function renderHeadline(brief) {
  const headline = brief.headline ? escapeHtml(brief.headline) : 'Sin titular disponible.';
  const why = brief.whyItMatters
    ? `<p class="why-it-matters">${escapeHtml(brief.whyItMatters)}</p>`
    : '';
  return `
    <h1 class="headline">${headline}</h1>
    ${why}
  `;
}

function renderEvidence(evidence) {
  const ev = asObject(evidence);
  const metrics = [];

  if (isInteger(ev.newAds)) metrics.push({ label: 'New Ads', value: ev.newAds });
  if (isInteger(ev.pausedAds)) metrics.push({ label: 'Paused', value: ev.pausedAds });
  if (isInteger(ev.activeAds)) metrics.push({ label: 'Active', value: ev.activeAds });

  if (metrics.length === 0) return '';

  const items = metrics
    .map(
      (m) => `
        <div class="evidence-metric">
          <span class="value">${escapeHtml(String(m.value))}</span>
          <span class="label">${escapeHtml(m.label)}</span>
        </div>
      `,
    )
    .join('');

  return `<div class="evidence-row">${items}</div>`;
}

function renderTopStories(brief) {
  const stories = asArray(brief.topStories);

  if (stories.length === 0) {
    return `
      <section class="section">
        <h2 class="section-title">Top stories</h2>
        <p class="empty-note">No se registraron historias destacadas hoy.</p>
      </section>
    `;
  }

  const cards = stories
    .map((story) => {
      const s = asObject(story);
      const entity = s.entity ? `<div class="story-entity">${escapeHtml(s.entity)}</div>` : '';
      const fact = s.fact ? `<div class="story-fact">${escapeHtml(s.fact)}</div>` : '';
      const interpretation = s.interpretation
        ? `<div class="story-interpretation">${escapeHtml(s.interpretation)}</div>`
        : '';
      return `
        <article class="card story-card">
          ${entity}
          ${fact}
          ${interpretation}
          ${renderEvidence(s.evidence)}
        </article>
      `;
    })
    .join('');

  return `
    <section class="section">
      <h2 class="section-title">Top stories</h2>
      <div class="cards-stack">${cards}</div>
    </section>
  `;
}

function renderRecommendedAction(brief) {
  const action = asObject(brief.recommendedAction);
  const hasContent = action.action || action.reason || action.priority;

  if (!hasContent) {
    return `
      <section class="section">
        <h2 class="section-title">Acción recomendada</h2>
        <p class="empty-note">No hay una acción recomendada para hoy.</p>
      </section>
    `;
  }

  const priority = action.priority
    ? `<span class="action-priority">${escapeHtml(String(action.priority))}</span>`
    : '';
  const text = action.action ? `<div class="action-text">${escapeHtml(action.action)}</div>` : '';
  const reason = action.reason ? `<div class="action-reason">${escapeHtml(action.reason)}</div>` : '';

  return `
    <section class="section">
      <h2 class="section-title">Acción recomendada</h2>
      <div class="action-card">
        ${priority}
        ${text}
        ${reason}
      </div>
    </section>
  `;
}

function renderWatchTomorrow(brief) {
  const items = asArray(brief.watchTomorrow);

  let body;
  if (items.length === 0) {
    body = `<p class="empty-note">No hay señales prioritarias para observar.</p>`;
  } else {
    const rows = items
      .map((item) => {
        const w = asObject(item);
        const entity = w.entity ? `<div class="entity">${escapeHtml(w.entity)}</div>` : '';
        const signal = w.signal ? `<div class="signal">${escapeHtml(w.signal)}</div>` : '';
        const ifConfirmed = w.ifConfirmed
          ? `<div class="if-confirmed">Si se confirma: ${escapeHtml(w.ifConfirmed)}</div>`
          : '';
        return `<li class="watch-item">${entity}${signal}${ifConfirmed}</li>`;
      })
      .join('');
    body = `<ul class="watch-list">${rows}</ul>`;
  }

  return `
    <section class="section">
      <h2 class="section-title">Qué mirar mañana</h2>
      ${body}
    </section>
  `;
}

function renderDataQuality(supportingData) {
  const limitations = asObject(supportingData.dataLimitations);
  const keys = Object.keys(limitations).filter((k) => limitations[k] !== null && limitations[k] !== undefined);

  if (keys.length === 0) return '';

  const items = keys
    .map(
      (key) => `
        <div class="dq-item">
          <span class="dq-key">${escapeHtml(humanizeKey(key))}:</span>
          <span class="dq-val">${escapeHtml(formatValue(limitations[key]))}</span>
        </div>
      `,
    )
    .join('');

  return `
    <section class="section">
      <h2 class="section-title">Calidad de datos</h2>
      <div class="dq-grid">${items}</div>
    </section>
  `;
}

function renderHypotheses(supportingData) {
  const items = asArray(supportingData.hypotheses);

  let body;
  if (items.length === 0) {
    body = `<p class="empty-note">No se generaron hipótesis.</p>`;
  } else {
    const rows = items
      .map((item) => {
        const h = asObject(item);
        const entity = h.entity ? `<div class="entity">${escapeHtml(h.entity)}</div>` : '';
        const hypothesis = h.hypothesis ? `<div>${escapeHtml(h.hypothesis)}</div>` : '';
        const conf = h.confidence
          ? `<div class="conf">Confianza: ${escapeHtml(String(h.confidence))}</div>`
          : '';
        return `<li class="hyp-item">${entity}${hypothesis}${conf}</li>`;
      })
      .join('');
    body = `<ul class="hyp-list">${rows}</ul>`;
  }

  return `
    <section class="section">
      <h2 class="section-title">Hipótesis</h2>
      ${body}
    </section>
  `;
}

function renderInventory(supportingData) {
  let rows = asArray(supportingData.marketInventory).map((r) => asObject(r));

  let body;
  if (rows.length === 0) {
    body = `<p class="empty-note">No hay inventario de mercado disponible.</p>`;
  } else {
    const hasActiveAds = rows.some((r) => isInteger(r.activeAds));
    if (hasActiveAds) {
      rows = rows.slice().sort((a, b) => (Number(b.activeAds) || 0) - (Number(a.activeAds) || 0));
    }
    rows = rows.slice(0, 3);

    const columns = Object.keys(rows[0]);
    const head = columns.map((c) => `<th>${escapeHtml(humanizeKey(c))}</th>`).join('');
    const tbody = rows
      .map((row) => {
        const cells = columns.map((c) => `<td>${escapeHtml(formatValue(row[c]))}</td>`).join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');

    body = `
      <div class="table-wrap">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
  }

  return `
    <section class="section">
      <h2 class="section-title">Inventario de mercado</h2>
      ${body}
    </section>
  `;
}

function renderQuietStrategic(supportingData) {
  const items = asArray(supportingData.quietStrategicEntities);

  let body;
  if (items.length === 0) {
    body = `<p class="empty-note">No hubo entidades relevantes sin cambios.</p>`;
  } else {
    const chips = items
      .map((e) => `<span class="chip">${escapeHtml(typeof e === 'object' ? formatValue(e) : e)}</span>`)
      .join('');
    body = `<div class="chip-row">${chips}</div>`;
  }

  return `
    <section class="section">
      <h2 class="section-title">Entidades estratégicas sin cambios</h2>
      ${body}
    </section>
  `;
}

/* ----------------------------------------------------------------------------
 * Top-level render
 * ------------------------------------------------------------------------- */

function renderLoading() {
  return `
    <div class="center-state">
      <div class="spinner" role="status" aria-label="Cargando"></div>
      <div class="state-text">Generando Executive Brief…</div>
    </div>
  `;
}

function renderError() {
  return `
    <div class="center-state">
      <div class="error-card">
        <h3>No se pudo generar el brief</h3>
        <p>${escapeHtml(state.error || '')}</p>
        <button class="btn" data-action="reload">Reintentar</button>
      </div>
    </div>
  `;
}

function isEmptyBrief(brief, supportingData) {
  const noBriefContent =
    !brief.headline
    && !brief.whyItMatters
    && asArray(brief.topStories).length === 0
    && !asObject(brief.recommendedAction).action
    && asArray(brief.watchTomorrow).length === 0;

  const noSupporting =
    asArray(supportingData.hypotheses).length === 0
    && asArray(supportingData.marketInventory).length === 0
    && asArray(supportingData.quietStrategicEntities).length === 0;

  return noBriefContent && noSupporting;
}

function render() {
  if (state.loading) {
    root.innerHTML = renderLoading();
    return;
  }

  if (state.error) {
    root.innerHTML = renderError();
    bindEvents();
    return;
  }

  const data = asObject(state.data);
  const analysis = asObject(data.analysis);
  const brief = asObject(analysis.brief);
  const supportingData = asObject(analysis.supportingData);
  const meta = asObject(data.meta);

  const date = data.date || meta.date || '';
  const generatedAt = data.generatedAt || '';

  if (isEmptyBrief(brief, supportingData)) {
    root.innerHTML = `
      ${renderHeader(date, generatedAt)}
      <div class="center-state">
        <p class="state-text">No hay información suficiente para generar un Executive Brief.</p>
        <button class="btn btn-secondary" data-action="reload">Reintentar</button>
      </div>
    `;
    bindEvents();
    return;
  }

  root.innerHTML = `
    ${renderHeader(date, generatedAt)}
    ${renderMetaBar(data.attentionLevel, brief.confidence, generatedAt)}
    ${renderHeadline(brief)}
    ${renderTopStories(brief)}
    ${renderRecommendedAction(brief)}
    ${renderWatchTomorrow(brief)}
    ${renderDataQuality(supportingData)}
    ${renderHypotheses(supportingData)}
    ${renderInventory(supportingData)}
    ${renderQuietStrategic(supportingData)}
    ${renderInvestigationCta()}
  `;
  bindEvents();
}

/* ----------------------------------------------------------------------------
 * Events / init
 * ------------------------------------------------------------------------- */

function bindEvents() {
  root.querySelectorAll('[data-action="reload"]').forEach((el) => {
    el.addEventListener('click', () => fetchBrief());
  });
}

function init() {
  fetchBrief();
}

init();
