/**
 * MySQL (read-only) adapter for Credizona cPanel DB.
 * Requires: CZ_MYSQL_HOST, CZ_MYSQL_USER, CZ_MYSQL_PASSWORD, CZ_MYSQL_DATABASE
 * Optional: CZ_MYSQL_PORT (default 3306)
 *
 * Missing credentials → same not-configured error (no crash on import).
 */

const {
  PAGE_SIZE,
  NOT_CONFIGURED_MESSAGE,
  defaultSinceIso,
} = require('./interface');

function resolveConfig() {
  const host = (process.env.CZ_MYSQL_HOST || '').trim();
  const user = (process.env.CZ_MYSQL_USER || '').trim();
  const password = process.env.CZ_MYSQL_PASSWORD;
  const database = (process.env.CZ_MYSQL_DATABASE || '').trim();
  if (!host || !user || password == null || password === '' || !database) {
    return null;
  }
  const portRaw = parseInt(String(process.env.CZ_MYSQL_PORT || '3306'), 10);
  const port = Number.isFinite(portRaw) ? portRaw : 3306;
  return { host, user, password: String(password), database, port };
}

/**
 * Convert ISO-8601 → MySQL DATETIME string (UTC, no timezone suffix).
 * @param {string} iso
 * @returns {string}
 */
function isoToMysqlDatetime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(`Invalid ISO since for MySQL: ${iso}`);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * MySQL DATETIME / Date → ISO-8601 UTC.
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function mysqlDatetimeToIso(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  // Treat naive DATETIME as UTC for cursor round-trip consistency.
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
    ? s
    : s.includes('T')
      ? `${s}Z`
      : `${s.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * @implements {import('./interface').CZLeadSource}
 */
class MySqlCZLeadSource {
  /**
   * @param {ReturnType<typeof resolveConfig>} [config]
   */
  constructor(config = resolveConfig()) {
    this.config = config;
    this._pool = null;
  }

  _requireConfig() {
    if (!this.config) {
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    return this.config;
  }

  async _getPool() {
    const cfg = this._requireConfig();
    if (this._pool) return this._pool;
    // Lazy require so the module can load without mysql2 if unused.
    const mysql = require('mysql2/promise');
    this._pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 2,
      connectTimeout: 15000,
    });
    return this._pool;
  }

  async fetchGrantedLoans({ since }) {
    const sinceIso = since || defaultSinceIso();
    const sinceMysql = isoToMysqlDatetime(sinceIso);
    const pool = await this._getPool();

    const [rows] = await pool.execute(
      `SELECT id, lrw_id, monto_otorgado, updated
       FROM solicitudes
       WHERE solicitudes_estados_id = 11 AND updated > ?
       ORDER BY updated ASC
       LIMIT ${PAGE_SIZE}`,
      [sinceMysql],
    );

    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length >= PAGE_SIZE;
    const last = list[list.length - 1];
    const nextSince = last ? mysqlDatetimeToIso(last.updated) : null;

    // Skip rows without lrw_id — not a real CDV-identifiable granted loan.
    const items = [];
    for (const row of list) {
      if (row.lrw_id == null || String(row.lrw_id).trim() === '') continue;
      items.push({
        cdv_operation_id: String(row.lrw_id).trim(),
        loan_amount: row.monto_otorgado,
        granted_at: mysqlDatetimeToIso(row.updated) || sinceIso,
        solicitudes_id: Number(row.id),
      });
    }

    return { items, hasMore, nextSince };
  }

  async fetchSolicitudes({ since }) {
    const sinceIso = since || defaultSinceIso();
    const sinceMysql = isoToMysqlDatetime(sinceIso);
    const pool = await this._getPool();

    const [rows] = await pool.execute(
      `SELECT id, solicitudes_estados_id, usuarios_id, fechaReg, lrw_id, tracking_data
       FROM solicitudes
       WHERE fechaReg > ?
       ORDER BY fechaReg ASC
       LIMIT ${PAGE_SIZE}`,
      [sinceMysql],
    );

    const list = Array.isArray(rows) ? rows : [];
    const hasMore = list.length >= PAGE_SIZE;
    const last = list[list.length - 1];
    const nextSince = last ? mysqlDatetimeToIso(last.fechaReg) : null;

    const items = list.map((row) => {
      let tracking = row.tracking_data;
      if (typeof tracking === 'string') {
        try {
          tracking = JSON.parse(tracking);
        } catch {
          tracking = { raw: tracking };
        }
      }
      return {
        id: Number(row.id),
        solicitudes_estados_id:
          row.solicitudes_estados_id != null
            ? Number(row.solicitudes_estados_id)
            : null,
        usuarios_id: row.usuarios_id != null ? Number(row.usuarios_id) : null,
        fechaReg: mysqlDatetimeToIso(row.fechaReg),
        lrw_id: row.lrw_id != null ? String(row.lrw_id) : null,
        tracking_data: tracking != null ? tracking : null,
      };
    });

    return { items, hasMore, nextSince };
  }
}

module.exports = {
  MySqlCZLeadSource,
  isoToMysqlDatetime,
  mysqlDatetimeToIso,
};
