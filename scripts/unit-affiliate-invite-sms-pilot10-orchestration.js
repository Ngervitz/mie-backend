'use strict';

/**
 * node scripts/unit-affiliate-invite-sms-pilot10-orchestration.js
 */

const assert = require('assert');
const {
  parseInviteTokenFromDestinationUrl,
  detectPartialMintBlocker,
  recoverPilot10Artifacts,
  preparePilot10RecipientPlan,
  pilot10IdempotencyKey,
} = require('../src/lib/affiliateInviteSmsPilot10Orchestration');

assert.strictEqual(
  parseInviteTokenFromDestinationUrl(
    'https://credizona.net/affiliates/join?t=ABC123&jt=xyz',
  ),
  'ABC123',
);

function createFakeSupabase(state) {
  const s = state;
  return {
    from: function (table) {
      const ctx = { table: table, filters: [] };
      const api = {
        select: function () {
          return api;
        },
        eq: function (field, value) {
          ctx.filters.push([field, value]);
          return api;
        },
        order: function () {
          return api;
        },
        limit: function () {
          return api;
        },
        maybeSingle: function () {
          if (table === 'sms_campaigns') {
            return Promise.resolve({ data: s.campaign, error: null });
          }
          if (table === 'affiliates') {
            return Promise.resolve({ data: null, error: null });
          }
          if (table === 'sms_short_links') {
            const impactId = ctx.filters.find(function (f) {
              return f[0] === 'impact_id';
            });
            const id = impactId ? impactId[1] : null;
            const link = s.shortByImpact && s.shortByImpact[String(id)];
            return Promise.resolve({ data: link || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: function (resolve, reject) {
          try {
            if (table === 'affiliate_invite_tokens') {
              const ciFilter = ctx.filters.find(function (f) {
                return f[0] === 'ci';
              });
              const ci = ciFilter ? ciFilter[1] : null;
              const rows = (s.invites || []).filter(function (row) {
                if (ci != null && row.ci !== ci) return false;
                const statusFilter = ctx.filters.find(function (f) {
                  return f[0] === 'status';
                });
                if (statusFilter && row.status !== statusFilter[1]) return false;
                return true;
              });
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            }
            if (table === 'sms_messages') {
              const campaignFilter = ctx.filters.find(function (f) {
                return f[0] === 'campaign_id';
              });
              const czFilter = ctx.filters.find(function (f) {
                return f[0] === 'czuid';
              });
              const rows = (s.messages || []).filter(function (row) {
                if (campaignFilter && row.campaign_id !== campaignFilter[1]) return false;
                if (czFilter && String(row.czuid) !== String(czFilter[1])) return false;
                const sys = ctx.filters.find(function (f) {
                  return f[0] === 'source_system';
                });
                if (sys && row.source_system !== sys[1]) return false;
                return true;
              });
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            }
            if (table === 'cz_funnel_solicitudes') {
              return Promise.resolve({
                data: [{ celular: '099123456', updated_at_src: '2026-10-01', cz_id: 1 }],
                error: null,
              }).then(resolve, reject);
            }
            if (table === 'affiliates') {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        },
      };
      return api;
    },
  };
}

(async function run() {
  const campaignId = 'camp-pilot10';
  const ci = 55597953;
  const impactId = 'impact-1';
  const joinUrl =
    'https://s.credizona.net/affiliates/join?t=RECOVERED_TOKEN&jt=JTTOKEN';

  const supabaseRecover = createFakeSupabase({
    campaign: { id: campaignId, name: 'x' },
    messages: [
      {
        campaign_id: campaignId,
        czuid: String(ci),
        source_system: 'affiliate_invite_sms',
        marketing_impact_id: impactId,
        text: 'Credizona: gana $500 por cada prestamo otorgado a quien recomiendes. Sumate: https://s.credizona.net/s/BBBBBB',
        status: 'pending',
      },
    ],
    shortByImpact: {
      [impactId]: {
        short_code: 'BBBBBB',
        destination_url: joinUrl,
        impact_id: impactId,
      },
    },
    invites: [],
  });

  const recovered = await recoverPilot10Artifacts(supabaseRecover, campaignId, ci);
  assert.strictEqual(recovered.kind, 'recoverable');
  assert.strictEqual(recovered.invite_token, 'RECOVERED_TOKEN');

  const supabaseBlocker = createFakeSupabase({
    campaign: { id: campaignId },
    messages: [],
    invites: [{ id: 'inv-1', ci: ci, status: 'issued' }],
  });
  const blocker = await detectPartialMintBlocker(supabaseBlocker, ci, campaignId);
  assert.ok(blocker);
  assert.strictEqual(blocker.code, 'PILOT_PARTIAL_MINT');

  const supabaseDry = createFakeSupabase({
    campaign: null,
    messages: [],
    invites: [],
  });

  const plan = await preparePilot10RecipientPlan(supabaseDry, ci, new Date(), { dryRun: true });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.dry_run, true);
  assert.strictEqual(plan.idempotency_key, pilot10IdempotencyKey(ci));
  assert.strictEqual(plan.gsm7.encoding, 'GSM-7');
  assert.ok(plan.fits_single_gsm7_segment);

  console.log('OK unit-affiliate-invite-sms-pilot10-orchestration');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
