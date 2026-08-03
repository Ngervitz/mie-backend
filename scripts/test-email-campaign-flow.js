/**
 * TEMP — end-to-end smoke for email campaign materialize + processQueue.
 * Does not delete test rows. Delete after validating.
 *
 * Usage (PowerShell):
 *   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (via dotenv if loaded)
 *   $env:EMAIL_PROVIDER_MODE = 'log'
 *   $env:EMAIL_CAMPAIGNS_FROM = 'noreply@credizona.com.uy'
 *   node scripts/test-email-campaign-flow.js
 *
 * Optional: load dotenv like other local scripts if present.
 */

try {
  require('dotenv').config();
} catch (_) {
  /* optional */
}

if (!process.env.EMAIL_PROVIDER_MODE) {
  process.env.EMAIL_PROVIDER_MODE = 'log';
}

const supabase = require('../src/clients/supabase');
const {
  materializeCampaign,
  processQueue,
} = require('../src/services/email-campaigns/processor');

const RULES = [
  { field: 'encuesta_score', operator: '>=', value: 70 },
  { field: 'marketing_consent', operator: '=', value: true },
];

async function main() {
  console.log('EMAIL_PROVIDER_MODE=', process.env.EMAIL_PROVIDER_MODE);
  console.log('EMAIL_CAMPAIGNS_FROM=', process.env.EMAIL_CAMPAIGNS_FROM || '(missing — processQueue will fail)');

  const marker = `e2e-${Date.now()}`;
  const cis = [`${marker}-1`, `${marker}-2`, `${marker}-3`];

  console.log('\n--- 1) Insert cz_encuestas_synced (3 rows) ---');
  const encuestaRows = [
    {
      ci: cis[0],
      email: 'test1@example.com',
      encuesta_score: 80,
      marketing_consent: true,
      marketing_consent_at: new Date().toISOString(),
      attributes: { origen: 'e2e', marker },
    },
    {
      ci: cis[1],
      email: 'test2@example.com',
      encuesta_score: 40,
      marketing_consent: true,
      marketing_consent_at: new Date().toISOString(),
      attributes: { origen: 'e2e', marker },
    },
    {
      ci: cis[2],
      email: 'test3@example.com',
      encuesta_score: 90,
      marketing_consent: false,
      marketing_consent_at: null,
      attributes: { origen: 'e2e', marker },
    },
  ];

  const { data: encuestas, error: encErr } = await supabase
    .from('cz_encuestas_synced')
    .insert(encuestaRows)
    .select('id, ci, email, encuesta_score, marketing_consent');

  if (encErr) {
    console.error('Insert cz_encuestas_synced failed:', encErr);
    process.exit(1);
  }
  console.log(JSON.stringify(encuestas, null, 2));

  console.log('\n--- 1b) Insert email_segments ---');
  const { data: segment, error: segErr } = await supabase
    .from('email_segments')
    .insert({
      name: `E2E segment ${marker}`,
      rules: RULES,
    })
    .select('*')
    .single();

  if (segErr) {
    console.error('Insert email_segments failed:', segErr);
    process.exit(1);
  }
  console.log(JSON.stringify(segment, null, 2));

  console.log('\n--- 1c) Insert email_campaigns (draft) ---');
  const { data: campaign, error: campErr } = await supabase
    .from('email_campaigns')
    .insert({
      name: `E2E campaign ${marker}`,
      subject: 'E2E Test EmailProvider campaign',
      body_html: '<p>Hola — email de prueba E2E (LogEmailProvider).</p>',
      segment_id: segment.id,
      segment_rules_snapshot: RULES,
      recipient_count: 0,
      status: 'draft',
    })
    .select('*')
    .single();

  if (campErr) {
    console.error('Insert email_campaigns failed:', campErr);
    process.exit(1);
  }
  console.log(JSON.stringify(campaign, null, 2));

  const campaignId = campaign.id;
  console.log('\n--- 2) materializeCampaign ---');
  console.log(
    'Expect 1 recipient: test1@example.com (score 80 + consent). ' +
      'Exclude test2 (score 40) and test3 (no consent).',
  );
  const materializeResult = await materializeCampaign(campaignId);
  console.log('materializeCampaign result:');
  console.log(JSON.stringify(materializeResult, null, 2));

  const { data: recipients, error: recErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, email, status, ci, campaign_id')
    .eq('campaign_id', campaignId);

  if (recErr) {
    console.error('Select recipients failed:', recErr);
  } else {
    console.log('Recipients after materialize:');
    console.log(JSON.stringify(recipients, null, 2));
  }

  console.log('\n--- 3) processQueue (EMAIL_PROVIDER_MODE=log) ---');
  const queueResult = await processQueue();
  console.log('processQueue result:');
  console.log(JSON.stringify(queueResult, null, 2));

  const { data: recipientsAfter, error: rec2Err } = await supabase
    .from('email_campaign_recipients')
    .select('id, email, status, provider_message_id, attempt_count, error_reason')
    .eq('campaign_id', campaignId);

  if (rec2Err) {
    console.error('Select recipients after queue failed:', rec2Err);
  } else {
    console.log('Recipients after processQueue:');
    console.log(JSON.stringify(recipientsAfter, null, 2));
  }

  const { data: campaignAfter, error: camp2Err } = await supabase
    .from('email_campaigns')
    .select('id, status, recipient_count, sent_at')
    .eq('id', campaignId)
    .single();

  if (camp2Err) {
    console.error('Select campaign after queue failed:', camp2Err);
  } else {
    console.log('Campaign after processQueue:');
    console.log(JSON.stringify(campaignAfter, null, 2));
  }

  console.log('\n=== CLEANUP (manual — script does NOT delete) ===');
  console.log(`marker = ${marker}`);
  console.log(`campaign_id = ${campaignId}`);
  console.log(`segment_id = ${segment.id}`);
  console.log('Run in Supabase SQL Editor:');
  console.log(`
DELETE FROM email_campaign_recipients WHERE campaign_id = ${campaignId};
DELETE FROM email_campaigns WHERE id = ${campaignId};
DELETE FROM email_segments WHERE id = ${segment.id};
DELETE FROM cz_encuestas_synced WHERE ci IN ('${cis[0]}', '${cis[1]}', '${cis[2]}');
`);
  console.log('Or by marker attribute:');
  console.log(`
DELETE FROM cz_encuestas_synced WHERE attributes->>'marker' = '${marker}';
`);
}

main().catch((err) => {
  console.error('Unhandled failure:');
  console.error(err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
