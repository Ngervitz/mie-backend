/**
 * PHP HTTP API adapter for Credizona.
 * Endpoints (pending CZ deploy):
 *   GET {CZ_API_BASE_URL}/api/cdv-granted-loans?since=
 *   GET {CZ_API_BASE_URL}/api/solicitudes?since=
 * Header: X-API-Key: {CZ_API_KEY}
 *
 * `since` is passed as ISO-8601 query param unchanged.
 * Missing CZ_API_BASE_URL / CZ_API_KEY → same not-configured error (no crash on import).
 */

const {
  PAGE_SIZE,
  NOT_CONFIGURED_MESSAGE,
  defaultSinceIso,
} = require('./interface');

function resolveConfig() {
  const baseUrl = (process.env.CZ_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.CZ_API_KEY || '').trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey };
}

/**
 * @implements {import('./interface').CZLeadSource}
 */
class PhpApiCZLeadSource {
  /**
   * @param {{ baseUrl: string, apiKey: string }|null} [config]
   */
  constructor(config = resolveConfig()) {
    this.config = config;
  }

  _requireConfig() {
    if (!this.config) {
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    return this.config;
  }

  /**
   * @param {string} path
   * @param {string|null} since
   */
  async _getPage(path, since) {
    const { baseUrl, apiKey } = this._requireConfig();
    const sinceIso = since || defaultSinceIso();
    const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    url.searchParams.set('since', sinceIso);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
      },
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(
          `CZ PHP API returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        );
      }
    }

    if (!response.ok) {
      const msg =
        (payload && (payload.error || payload.message)) ||
        `CZ PHP API HTTP ${response.status}`;
      throw new Error(String(msg));
    }

    // Accept either { items, hasMore, nextSince } or a bare array.
    if (Array.isArray(payload)) {
      const items = payload;
      const hasMore = items.length >= PAGE_SIZE;
      const last = items[items.length - 1];
      const nextSince =
        last && (last.granted_at || last.fechaReg || last.updated_at)
          ? String(last.granted_at || last.fechaReg || last.updated_at)
          : null;
      return { items, hasMore, nextSince };
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const hasMore =
      typeof payload.hasMore === 'boolean'
        ? payload.hasMore
        : items.length >= PAGE_SIZE;
    const nextSince =
      payload.nextSince != null
        ? String(payload.nextSince)
        : null;

    return { items, hasMore, nextSince };
  }

  async fetchGrantedLoans({ since }) {
    return this._getPage('/api/cdv-granted-loans', since);
  }

  async fetchSolicitudes({ since }) {
    return this._getPage('/api/solicitudes', since);
  }
}

module.exports = { PhpApiCZLeadSource };
