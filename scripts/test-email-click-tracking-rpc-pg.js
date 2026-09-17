'use strict';

/**
 * Live Postgres tests for upsert_email_survey_invite_recipient_impact.
 *
 * SAFETY:
 *   ALLOW_EMAIL_CLICK_RPC_HARNESS=1  required for any DB connection/writes.
 *   EMAIL_CLICK_RPC_HARNESS_DRY_RUN=1  prints plan only (no connect / no writes).
 *
 * Requires for live run:
 *   DATABASE_URL | SUPABASE_DB_URL | POSTGRES_URL | DIRECT_URL
 *   Migration 20260916_email_click_tracking_survey_invite.sql applied
 *
 * Usage:
 *   EMAIL_CLICK_RPC_HARNESS_DRY_RUN=1 node scripts/test-email-click-tracking-rpc-pg.js
 *   ALLOW_EMAIL_CLICK_RPC_HARNESS=1 DATABASE_URL=... node scripts/test-email-click-tracking-rpc-pg.js
 *
 * Does NOT send email/SMS.
 */

const crypto = require('crypto');
const { URL } = require('url');

const ALLOW = String(process.env.ALLOW_EMAIL_CLICK_RPC_HARNESS || '') === '1';
const DRY_RUN = String(process.env.EMAIL_CLICK_RPC_HARNESS_DRY_RUN || '') === '1';

const CAMPAIGN_NAME_PREFIX = 'TEST email click rpc';

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  process.env.DIRECT_URL ||
  '';

/**
 * Sanitize connection target for logs (no password / full URL).
 * PRODUCTION_DETECTION_AVAILABLE = NO — no reliable prod signal without invented heuristics.
 */
function sanitizeDbTarget(connectionString) {
  if (!connectionString) {
    return { available: false, host: null, database: null, ssl: null };
  }
  try {
    const normalized = connectionString.replace(/^postgresql:/i, 'http:');
    const u = new URL(normalized);
    let ssl = null;
    if (u.searchParams.has('sslmode')) ssl = u.searchParams.get('sslmode');
    else if (/ssl=true/i.test(connectionString)) ssl = 'true';
    return {
      available: true,
      host: u.hostname || null,
      database: (u.pathname || '').replace(/^\//, '') || null,
      ssl: ssl,
      port: u.port || null,
    };
  } catch (_e) {
    return {
      available: true,
      host: '(unparsed)',
      database: '(unparsed)',
      ssl: null,
      note: 'connection string present but could not parse host/db',
    };
  }
}

function uniquePush(arr, id) {
  if (id == null || id === '') return;
  const s = String(id);
  if (arr.indexOf(s) === -1) arr.push(s);
}

function trackUnit(ids, j) {
  if (!j) return;
  uniquePush(ids.createdRecipientIds, j.recipient_id);
  uniquePush(ids.createdImpactIds, j.impact_id);
}

async function q(client, sql, params) {
  return client.query(sql, params);
}

async function cleanupExact(client, ids) {
  const errors = [];

  // FK order (verified):
  // marketing_impact_events.impact_id → marketing_impacts (ON DELETE CASCADE)
  // email_campaign_recipients.marketing_impact_id → marketing_impacts (ON DELETE SET NULL)
  // email_campaign_recipients.campaign_id → email_campaigns (restrict)
  // Therefore: events → recipients → impacts → campaign

  if (ids.createdImpactIds.length) {
    try {
      await q(
        client,
        `DELETE FROM public.marketing_impact_events WHERE impact_id = ANY($1::uuid[])`,
        [ids.createdImpactIds],
      );
    } catch (e) {
      errors.push({
        op: 'DELETE marketing_impact_events',
        ids: ids.createdImpactIds.slice(),
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  }

  if (ids.createdRecipientIds.length) {
    try {
      await q(
        client,
        `DELETE FROM public.email_campaign_recipients WHERE id = ANY($1::bigint[])`,
        [ids.createdRecipientIds.map(Number)],
      );
    } catch (e) {
      errors.push({
        op: 'DELETE email_campaign_recipients',
        ids: ids.createdRecipientIds.slice(),
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  }

  if (ids.createdImpactIds.length) {
    try {
      await q(
        client,
        `DELETE FROM public.marketing_impacts WHERE id = ANY($1::uuid[])`,
        [ids.createdImpactIds],
      );
    } catch (e) {
      errors.push({
        op: 'DELETE marketing_impacts',
        ids: ids.createdImpactIds.slice(),
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  }

  if (ids.createdCampaignId != null) {
    try {
      const check = await q(
        client,
        `SELECT id, name FROM public.email_campaigns WHERE id = $1`,
        [ids.createdCampaignId],
      );
      const row = check.rows[0];
      if (!row) {
        // already gone
      } else if (Number(row.id) !== Number(ids.createdCampaignId)) {
        errors.push({
          op: 'DELETE email_campaigns ABORT',
          ids: [ids.createdCampaignId],
          error: 'campaign id mismatch before delete',
        });
      } else if (String(row.name || '').indexOf(CAMPAIGN_NAME_PREFIX) !== 0) {
        errors.push({
          op: 'DELETE email_campaigns ABORT',
          ids: [ids.createdCampaignId],
          error:
            'campaign name does not start with "' +
            CAMPAIGN_NAME_PREFIX +
            '"; refusing delete',
          name: row.name,
        });
      } else {
        await q(client, `DELETE FROM public.email_campaigns WHERE id = $1`, [
          ids.createdCampaignId,
        ]);
      }
    } catch (e) {
      errors.push({
        op: 'DELETE email_campaigns',
        ids: [ids.createdCampaignId],
        error: e && e.message ? String(e.message) : String(e),
      });
    }
  }

  return errors;
}

function printDryRun(suffix, campaignName, target) {
  console.log(
    JSON.stringify(
      {
        mode: 'DRY_RUN',
        ALLOW_EMAIL_CLICK_RPC_HARNESS: ALLOW,
        DATABASE_URL_PRESENT: Boolean(dbUrl),
        target: target,
        PRODUCTION_DETECTION_AVAILABLE: false,
        PRODUCTION_EXTRA_GATE: 'NOT_IMPLEMENTABLE_RELIABLY',
        MID_TRANSACTION_ROLLBACK_TEST_AVAILABLE_WITH_CURRENT_RPC: false,
        fixture: {
          campaignName: campaignName,
          suffix: suffix,
          planned_tests: ['A_create', 'B_retry', 'C_concurrency_two_clients', 'D_prewrite_validation_only', 'E_recipient_without_impact'],
        },
        note:
          'No connection opened. Live run requires ALLOW_EMAIL_CLICK_RPC_HARNESS=1 and a Postgres URL env.',
      },
      null,
      2,
    ),
  );
}

(async function main() {
  const suffix = Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  const campaignName = CAMPAIGN_NAME_PREFIX + ' ' + suffix;
  const target = sanitizeDbTarget(dbUrl);

  if (DRY_RUN) {
    printDryRun(suffix, campaignName, target);
    process.exit(0);
  }

  if (!ALLOW) {
    console.error(
      JSON.stringify({
        error: 'ALLOW_EMAIL_CLICK_RPC_HARNESS_REQUIRED',
        message:
          'Refusing to connect/write. Set ALLOW_EMAIL_CLICK_RPC_HARNESS=1 explicitly to run this harness.',
        hint: 'For plan-only: EMAIL_CLICK_RPC_HARNESS_DRY_RUN=1',
      }),
    );
    process.exit(2);
  }

  if (!dbUrl) {
    console.error(
      JSON.stringify({
        error: 'NO_PG_URL',
        CONCURRENCY_SAFE: 'UNKNOWN',
        hint: 'Set DATABASE_URL (or SUPABASE_DB_URL / POSTGRES_URL / DIRECT_URL)',
      }),
    );
    process.exit(2);
  }

  console.log(
    JSON.stringify({
      phase: 'pre_write',
      target: target,
      campaignName: campaignName,
      suffix: suffix,
      PRODUCTION_DETECTION_AVAILABLE: false,
      MID_TRANSACTION_ROLLBACK_TEST_AVAILABLE_WITH_CURRENT_RPC: false,
      MID_TRANSACTION_ROLLBACK_NOTE:
        'Current RPC validates destination before any write; no controllable post-write failure without modifying the RPC. Function body is still one Postgres transaction (uncaught error ⇒ full rollback).',
    }),
  );

  const { Client } = require('pg');

  const ids = {
    createdCampaignId: null,
    createdRecipientIds: [],
    createdImpactIds: [],
    createdEventIds: [],
  };

  const report = {
    tests: {},
    CONCURRENCY_SAFE: null,
    HARNESS_CLEANUP_FAILED: false,
    MID_TRANSACTION_ROLLBACK_TEST_AVAILABLE_WITH_CURRENT_RPC: false,
  };

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let exitCode = 0;

  try {
    const camp = await q(
      client,
      `INSERT INTO public.email_campaigns
        (name, subject, body_html, segment_id, segment_rules_snapshot, status, audience_mode)
       VALUES ($1, $2, $3, NULL, NULL, 'draft', 'DIRECTED')
       RETURNING id, name`,
      [campaignName, 'test subject', '<p>{{survey_url}}</p>'],
    );
    const campRow = camp.rows[0];
    if (!campRow || campRow.id == null) {
      throw new Error('ABORT: campaign INSERT returned no id');
    }
    if (String(campRow.name || '').indexOf(CAMPAIGN_NAME_PREFIX) !== 0) {
      throw new Error(
        'ABORT: campaign name does not start with "' + CAMPAIGN_NAME_PREFIX + '"',
      );
    }
    ids.createdCampaignId = campRow.id;

    const campaignId = ids.createdCampaignId;
    const keyA =
      'rechazados_survey_invite:campaign:' +
      campaignId +
      ':ci:9900' +
      suffix.slice(-4);
    const dest =
      'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=TEST-' + suffix;

    // TEST A
    const a1 = await q(
      client,
      `SELECT public.upsert_email_survey_invite_recipient_impact($1,$2,$3,$4,$5,$6) AS j`,
      [
        keyA,
        campaignId,
        '99001',
        'rpc-a-' + suffix + '@example.com',
        'rechazados_survey_invite',
        dest,
      ],
    );
    const j1 = a1.rows[0].j;
    trackUnit(ids, j1);
    report.tests.A = {
      created: j1.created,
      recipient_id: j1.recipient_id,
      impact_id: j1.impact_id,
      tracking_token: j1.tracking_token,
    };
    if (
      !j1.created ||
      !j1.tracking_token ||
      String(j1.tracking_token).length !== 22
    ) {
      throw new Error('TEST A failed');
    }

    // TEST B
    const a2 = await q(
      client,
      `SELECT public.upsert_email_survey_invite_recipient_impact($1,$2,$3,$4,$5,$6) AS j`,
      [
        keyA,
        campaignId,
        '99001',
        'rpc-a-' + suffix + '@example.com',
        'rechazados_survey_invite',
        dest,
      ],
    );
    const j2 = a2.rows[0].j;
    trackUnit(ids, j2);
    report.tests.B = {
      created: j2.created,
      same_recipient: j2.recipient_id === j1.recipient_id,
      same_impact: j2.impact_id === j1.impact_id,
      same_token: j2.tracking_token === j1.tracking_token,
    };
    if (
      j2.created ||
      j2.impact_id !== j1.impact_id ||
      j2.tracking_token !== j1.tracking_token
    ) {
      throw new Error('TEST B failed');
    }

    // TEST C — two independent connections
    const keyC =
      'rechazados_survey_invite:campaign:' +
      campaignId +
      ':ci:8800' +
      suffix.slice(-4);
    const emailC = 'rpc-c-' + suffix + '@example.com';
    const clientA = new Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    });
    const clientB = new Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    });
    await clientA.connect();
    await clientB.connect();
    let cj1;
    let cj2;
    try {
      const sql = `SELECT public.upsert_email_survey_invite_recipient_impact($1,$2,$3,$4,$5,$6) AS j`;
      const params = [
        keyC,
        campaignId,
        '88001',
        emailC,
        'rechazados_survey_invite',
        dest,
      ];
      const [c1, c2] = await Promise.all([
        q(clientA, sql, params),
        q(clientB, sql, params),
      ]);
      cj1 = c1.rows[0].j;
      cj2 = c2.rows[0].j;
    } finally {
      await clientA.end();
      await clientB.end();
    }
    trackUnit(ids, cj1);
    trackUnit(ids, cj2);

    const counts = await q(
      client,
      `SELECT
         (SELECT count(*)::int FROM email_campaign_recipients WHERE idempotency_key=$1) AS recipients,
         (SELECT count(*)::int FROM marketing_impacts mi
            JOIN email_campaign_recipients r ON r.marketing_impact_id = mi.id
           WHERE r.idempotency_key=$1) AS impacts,
         (SELECT count(DISTINCT marketing_impact_id)::int FROM email_campaign_recipients WHERE idempotency_key=$1) AS distinct_impacts,
         (SELECT count(DISTINCT mi.tracking_token)::int FROM marketing_impacts mi
            JOIN email_campaign_recipients r ON r.marketing_impact_id = mi.id
           WHERE r.idempotency_key=$1) AS distinct_tokens`,
      [keyC],
    );
    report.tests.C = {
      r1: { recipient_id: cj1.recipient_id, impact_id: cj1.impact_id, token: cj1.tracking_token },
      r2: { recipient_id: cj2.recipient_id, impact_id: cj2.impact_id, token: cj2.tracking_token },
      counts: counts.rows[0],
      same_token: cj1.tracking_token === cj2.tracking_token,
      same_impact: cj1.impact_id === cj2.impact_id,
      separate_connections: true,
    };
    if (
      counts.rows[0].recipients !== 1 ||
      counts.rows[0].impacts !== 1 ||
      counts.rows[0].distinct_impacts !== 1 ||
      counts.rows[0].distinct_tokens !== 1 ||
      cj1.tracking_token !== cj2.tracking_token
    ) {
      report.CONCURRENCY_SAFE = 'NO';
      throw new Error(
        'TEST C concurrency failed: ' + JSON.stringify(counts.rows[0]),
      );
    }
    report.CONCURRENCY_SAFE = 'YES';

    // TEST D — pre-write validation only (no mid-txn fault injection with current RPC)
    const beforeImpacts = await q(
      client,
      `SELECT count(*)::int AS n FROM marketing_impacts WHERE id = ANY($1::uuid[])`,
      [ids.createdImpactIds.length ? ids.createdImpactIds : ['00000000-0000-4000-8000-000000000000']],
    );
    try {
      await q(
        client,
        `SELECT public.upsert_email_survey_invite_recipient_impact($1,$2,$3,$4,$5,$6)`,
        [
          'bad-key-' + suffix,
          campaignId,
          '1',
          'x@y.z',
          'rechazados_survey_invite',
          'not-a-url',
        ],
      );
      throw new Error('expected invalid destination to raise');
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      if (!/DESTINATION_URL_INVALID|P0001|not-a-url|expected invalid/i.test(msg)) {
        report.tests.D_note = msg.slice(0, 240);
      }
      if (/expected invalid destination/.test(msg)) throw e;
    }
    const afterImpacts = await q(
      client,
      `SELECT count(*)::int AS n FROM marketing_impacts WHERE id = ANY($1::uuid[])`,
      [ids.createdImpactIds.length ? ids.createdImpactIds : ['00000000-0000-4000-8000-000000000000']],
    );
    report.tests.D = {
      kind: 'prewrite_validation_only',
      MID_TRANSACTION_ROLLBACK_TEST_AVAILABLE_WITH_CURRENT_RPC: false,
      tracked_impact_count_unchanged:
        beforeImpacts.rows[0].n === afterImpacts.rows[0].n,
      explanation:
        'RPC rejects invalid destination before INSERT recipient/impact. Cannot fault-inject after first write without changing the RPC.',
    };

    // TEST E
    const keyE =
      'rechazados_survey_invite:campaign:' +
      campaignId +
      ':ci:7700' +
      suffix.slice(-4);
    const ins = await q(
      client,
      `INSERT INTO email_campaign_recipients
        (campaign_id, idempotency_key, ci, email, status, purpose, template_vars)
       VALUES ($1,$2,'77001',$3,'queued','rechazados_survey_invite','{}'::jsonb)
       RETURNING id`,
      [campaignId, keyE, 'rpc-e-' + suffix + '@example.com'],
    );
    uniquePush(ids.createdRecipientIds, ins.rows[0].id);
    const eRes = await q(
      client,
      `SELECT public.upsert_email_survey_invite_recipient_impact($1,$2,$3,$4,$5,$6) AS j`,
      [
        keyE,
        campaignId,
        '77001',
        'rpc-e-' + suffix + '@example.com',
        'rechazados_survey_invite',
        dest,
      ],
    );
    const ej = eRes.rows[0].j;
    trackUnit(ids, ej);
    const eCheck = await q(
      client,
      `SELECT id, marketing_impact_id FROM email_campaign_recipients WHERE id=$1`,
      [ins.rows[0].id],
    );
    report.tests.E = {
      same_recipient:
        eCheck.rows[0].id === ins.rows[0].id &&
        ej.recipient_id === ins.rows[0].id,
      linked: String(eCheck.rows[0].marketing_impact_id) === String(ej.impact_id),
      created_impact: ej.created === true,
    };
    if (!report.tests.E.same_recipient || !report.tests.E.linked) {
      throw new Error('TEST E failed');
    }

    report.tracked_ids = {
      createdCampaignId: ids.createdCampaignId,
      createdRecipientIds: ids.createdRecipientIds.slice(),
      createdImpactIds: ids.createdImpactIds.slice(),
      createdEventIds: ids.createdEventIds.slice(),
    };

    console.log(JSON.stringify(report, null, 2));
    console.log('test-email-click-tracking-rpc-pg: PASS');
  } catch (err) {
    exitCode = 1;
    console.error(err && err.stack ? err.stack : err);
    console.error(
      JSON.stringify({
        phase: 'test_failed',
        tracked_ids: ids,
        report: report,
      }),
    );
  } finally {
    try {
      const cleanupErrors = await cleanupExact(client, ids);
      if (cleanupErrors.length) {
        report.HARNESS_CLEANUP_FAILED = true;
        exitCode = 1;
        console.error(
          JSON.stringify({
            HARNESS_CLEANUP_FAILED: true,
            cleanupErrors: cleanupErrors,
            tracked_ids: ids,
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            cleanup: 'ok',
            deleted: {
              campaignId: ids.createdCampaignId,
              recipients: ids.createdRecipientIds.length,
              impacts: ids.createdImpactIds.length,
            },
          }),
        );
      }
    } catch (cleanErr) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          HARNESS_CLEANUP_FAILED: true,
          error: cleanErr && cleanErr.message ? cleanErr.message : String(cleanErr),
          tracked_ids: ids,
        }),
      );
    }
    await client.end();
  }

  process.exit(exitCode);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
