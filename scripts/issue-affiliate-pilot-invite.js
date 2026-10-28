'use strict';

/**
 * Issue one affiliate landing invite for a pilot CI (operator script).
 *
 *   ALLOW_AFFILIATE_PILOT_INVITE=true node scripts/issue-affiliate-pilot-invite.js <CI>
 *
 * Prints the join URL to stdout only. Progress and errors go to stderr.
 * Never logs the raw invite token.
 */

const readline = require('readline');
const { parseCi } = require('../src/lib/affiliateDirectory');
const { resolveAffiliateSmsPhone, normalizeDigits } = require('../src/lib/affiliatePhoneResolve');
const { readAffiliateJoinPilotCi } = require('../src/lib/affiliateJoinPilot');
const {
  AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
} = require('../src/lib/affiliateJoinPilotRoster');
const { issueInviteToken, getActiveAffiliateByCi } = require('../src/lib/affiliateOptIn');
const { ciExistsInFunnel } = require('../src/lib/affiliateOptInDbHelpers');
const { INVITE_TTL_MS } = require('../src/lib/affiliateInviteToken');

const PROD_REF = 'usezztlmwfgjcidcrrde';
const DEFAULT_JOIN_ORIGIN = 'https://s.credizona.net';

function assertPilotInviteAllowed() {
  if (String(process.env.ALLOW_AFFILIATE_PILOT_INVITE || '').trim() !== 'true') {
    throw new Error('ALLOW_AFFILIATE_PILOT_INVITE=true is required');
  }
}

function assertSupabaseConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !String(url).trim()) throw new Error('SUPABASE_URL is required');
  if (!key || !String(key).trim()) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

function supabaseHost(url) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch (_e) {
    throw new Error('SUPABASE_URL is not a valid URL');
  }
  if (!parsed.hostname) throw new Error('SUPABASE_URL has no host');
  return parsed.host;
}

function parseArgvCi(argv) {
  const raw = argv[2];
  if (raw == null || String(raw).trim() === '') {
    throw new Error('usage: node scripts/issue-affiliate-pilot-invite.js <CI>');
  }
  const ci = parseCi(String(raw).trim());
  if (ci == null) throw new Error('CI inválida');
  return ci;
}

function joinOrigin() {
  const raw = process.env.AFFILIATE_PILOT_JOIN_ORIGIN || DEFAULT_JOIN_ORIGIN;
  return String(raw).trim().replace(/\/+$/, '');
}

function confirmationAccepted(answer) {
  return String(answer == null ? '' : answer).trim() === 'yes';
}

function promptConfirmation(host, ci, input, output) {
  const rl = readline.createInterface({ input: input, output: output });
  return new Promise(function (resolve) {
    let settled = false;
    function finish(answer) {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(confirmationAccepted(answer));
    }
    output.write('Supabase host: ' + host + '\n');
    output.write('Pilot CI: ' + String(ci) + '\n');
    output.write('Invite TTL: 14 days. Prior issued invites for this CI will be revoked.\n');
    rl.question('Type yes to issue the invite: ', finish);
    rl.once('close', function () {
      finish('');
    });
  });
}

function assertValidPhone(phone) {
  const digits = normalizeDigits(phone);
  if (!digits || digits.length < 8) {
    throw new Error('La CI no tiene celular válido en cz_funnel_solicitudes');
  }
  return digits;
}

async function validateCiForPilotInvite(supabase, ci) {
  const pilotEnv = readAffiliateJoinPilotCi();
  if (pilotEnv != null && pilotEnv !== ci) {
    throw new Error(
      'AFFILIATE_JOIN_PILOT_CI no coincide con la CI solicitada; ajuste env o CI',
    );
  }
  if (ci !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) {
    throw new Error(
      'Solo la CI autorizada del piloto (' +
        String(AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) +
        ') puede recibir invite token',
    );
  }

  const inFunnel = await ciExistsInFunnel(supabase, ci);
  if (!inFunnel) {
    throw new Error('La CI no tiene solicitudes en JANUS');
  }

  const existing = await getActiveAffiliateByCi(supabase, ci);
  if (existing) {
    throw new Error('La CI ya es afiliada activa');
  }

  const phone = await resolveAffiliateSmsPhone(supabase, ci);
  assertValidPhone(phone);

  return { phone_masked: '***' + normalizeDigits(phone).slice(-4) };
}

function buildJoinUrl(rawToken) {
  return (
    joinOrigin() + '/affiliates/join?t=' + encodeURIComponent(String(rawToken))
  );
}

async function main() {
  require('dotenv').config();
  assertPilotInviteAllowed();
  assertSupabaseConfigured();

  const ci = parseArgvCi(process.argv);
  const host = supabaseHost(process.env.SUPABASE_URL);
  const accepted = await promptConfirmation(host, ci, process.stdin, process.stderr);
  if (!accepted) {
    throw new Error('invite cancelled');
  }

  const supabase = require('../src/clients/supabase');
  const preview = await validateCiForPilotInvite(supabase, ci);
  process.stderr.write(
    'Celular en funnel (enmascarado): ' + preview.phone_masked + '\n',
  );

  const now = new Date();
  const result = await issueInviteToken(supabase, ci, now);
  if (!result.ok) {
    const err = result.error || 'invite_failed';
    if (err === 'affiliate_join_not_ready') {
      throw new Error('Tablas de invite/OTP no disponibles (aplicar migración 20261026)');
    }
    throw new Error(String(err));
  }

  const expiresMs = INVITE_TTL_MS;
  process.stderr.write(
    'Invite emitida. Vence: ' +
      String(result.invite.expires_at) +
      ' (' +
      String(Math.round(expiresMs / 86400000)) +
      ' días).\n',
  );

  process.stdout.write(buildJoinUrl(result.token) + '\n');
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  PROD_REF,
  parseArgvCi,
  assertPilotInviteAllowed,
  assertValidPhone,
  validateCiForPilotInvite,
  buildJoinUrl,
  joinOrigin,
};
