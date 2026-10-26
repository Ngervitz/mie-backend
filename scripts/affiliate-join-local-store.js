'use strict';

const crypto = require('crypto');
const { hashInviteToken } = require('../src/lib/affiliateInviteToken');

function createAffiliateJoinStore() {
  const tables = {
    affiliate_invite_tokens: [],
    affiliate_otp_challenges: [],
    affiliates: [],
    cz_funnel_solicitudes: [],
  };

  const store = {
    tables: tables,
    addSolicitud: function (row) {
      tables.cz_funnel_solicitudes.push(
        Object.assign(
          {
            cz_id: tables.cz_funnel_solicitudes.length + 1,
            updated_at_src: new Date().toISOString(),
            synced_at: new Date().toISOString(),
            fecha_reg: new Date().toISOString(),
          },
          row,
        ),
      );
    },
    addInvite: function (opts) {
      const raw = opts.raw || crypto.randomBytes(32).toString('base64url');
      const row = {
        id: opts.id || crypto.randomUUID(),
        token_hash: hashInviteToken(raw),
        ci: opts.ci,
        status: opts.status || 'issued',
        issued_at: new Date().toISOString(),
        expires_at:
          opts.expires_at ||
          new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        consumed_at: null,
        revoked_at: null,
      };
      tables.affiliate_invite_tokens.push(row);
      return { raw: raw, row: row };
    },
    from: function (table) {
      return makeQuery(store, table);
    },
  };

  return store;
}

function makeQuery(store, table) {
  const ctx = { filters: [], patch: null, insertRow: null, limitN: null, order: null };

  const api = {
    select: function () {
      return api;
    },
    eq: function (field, value) {
      ctx.filters.push({ field: field, value: value });
      return api;
    },
    gte: function (field, value) {
      ctx.filters.push({ field: field, value: value, op: 'gte' });
      return api;
    },
    order: function (field, opts) {
      ctx.order = { field: field, ascending: !(opts && opts.ascending === false) };
      return api;
    },
    limit: function (n) {
      ctx.limitN = n;
      return api;
    },
    update: function (patch) {
      ctx.patch = patch;
      return api;
    },
    insert: function (row) {
      ctx.insertRow = row;
      return api;
    },
    maybeSingle: function () {
      return run();
    },
    single: function () {
      return run().then(function (res) {
        if (!res.data) {
          const err = new Error('single expected row');
          err.code = 'PGRST116';
          throw err;
        }
        return res;
      });
    },
    then: function (resolve, reject) {
      run().then(resolve, reject);
    },
  };

  function rows() {
    return store.tables[table] || [];
  }

  function match(row) {
    return ctx.filters.every(function (f) {
      if (f.op === 'gte') {
        const left = Date.parse(String(row[f.field] || ''));
        const right = Date.parse(String(f.value || ''));
        return Number.isFinite(left) && Number.isFinite(right) && left >= right;
      }
      return row[f.field] === f.value;
    });
  }

  async function run() {
    const list = rows();

    if (ctx.insertRow) {
      const row = Object.assign({}, ctx.insertRow);
      if (table === 'affiliate_invite_tokens') {
        row.id = row.id || crypto.randomUUID();
        list.push(row);
        ctx.insertRow = null;
        return { data: row, error: null };
      }
      if (table === 'affiliate_otp_challenges') {
        row.id = row.id || crypto.randomUUID();
        list.push(row);
        ctx.insertRow = null;
        return { data: row, error: null };
      }
      if (table === 'affiliates') {
        if (list.some(function (a) {
          return a.ci === row.ci;
        })) {
          ctx.insertRow = null;
          return {
            data: null,
            error: { code: '23505', message: 'affiliates_ci_unique' },
          };
        }
        row.id = row.id || crypto.randomUUID();
        row.created_at = row.created_at || new Date().toISOString();
        list.push(row);
        ctx.insertRow = null;
        return { data: row, error: null };
      }
    }

    if (ctx.patch) {
      list.forEach(function (row) {
        if (match(row)) Object.assign(row, ctx.patch);
      });
      ctx.patch = null;
      return { data: null, error: null };
    }

    let matched = list.filter(match);
    if (ctx.order && ctx.order.field) {
      const field = ctx.order.field;
      const asc = ctx.order.ascending;
      matched = matched.slice().sort(function (a, b) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (ctx.limitN != null) {
      matched = matched.slice(0, ctx.limitN);
    }

    if (table === 'cz_funnel_solicitudes' && ctx.filters.length) {
      return { data: matched, error: null };
    }

    if (matched.length === 1) {
      return { data: matched[0], error: null };
    }
    if (matched.length > 1) {
      return { data: matched, error: null };
    }
    return { data: null, error: null };
  }

  return api;
}

module.exports = {
  createAffiliateJoinStore,
};
