'use strict';

/**
 * Create active test affiliates. No clicks, no public signup.
 * Every row is is_test=true. Test affiliates never generate prizes.
 *
 *   ALLOW_AFFILIATE_SEED=true node scripts/seed-affiliates.js code1 code2
 *
 * Refuses production, requires ALLOW_AFFILIATE_SEED=true, and asks for an
 * interactive "yes" after printing the Supabase host. Does not apply migrations.
 */

const readline = require('readline');

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const PROD_REF = 'usezztlmwfgjcidcrrde';

function assertNotProduction(url) {
  const value = url == null ? '' : String(url).trim();
  if (!value) {
    throw new Error('SUPABASE_URL is required');
  }
  if (value.indexOf(PROD_REF) !== -1) {
    throw new Error('refusing to seed production supabase');
  }
}

function assertSeedAllowed(flag) {
  if (String(flag == null ? '' : flag).trim() !== 'true') {
    throw new Error('ALLOW_AFFILIATE_SEED=true is required');
  }
}

function supabaseHost(url) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch (_err) {
    throw new Error('SUPABASE_URL is not a valid URL');
  }
  if (!parsed.hostname) {
    throw new Error('SUPABASE_URL has no host');
  }
  return parsed.host;
}

function confirmationAccepted(answer) {
  return String(answer == null ? '' : answer).trim() === 'yes';
}

function normalizeCodes(codes) {
  const list = [];
  const seen = Object.create(null);
  const source = codes || [];
  for (let i = 0; i < source.length; i += 1) {
    const code = String(source[i] == null ? '' : source[i]).trim();
    if (!code || seen[code]) continue;
    if (!CODE_RE.test(code)) {
      throw new Error('invalid affiliate code');
    }
    seen[code] = true;
    list.push(code);
  }
  if (!list.length) {
    throw new Error('pass at least one affiliate code');
  }
  return list;
}

function promptConfirmation(host, input, output) {
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
    output.write('These affiliates are is_test=true and never generate prizes.\n');
    rl.question('Type yes to continue: ', finish);
    rl.once('close', function () {
      finish('');
    });
  });
}

async function seedAffiliates(codes, supabase) {
  const list = normalizeCodes(codes);
  const pending = [];
  const kept = [];
  for (let i = 0; i < list.length; i += 1) {
    const code = list[i];
    const { data, error } = await supabase
      .from('affiliates')
      .select('id, code, is_test')
      .eq('code', code)
      .maybeSingle();
    if (error) {
      throw new Error('affiliate seed lookup failed');
    }
    if (data && data.is_test !== true) {
      throw new Error('refusing to change a non-test affiliate');
    }
    if (data) kept.push(data);
    else pending.push(code);
  }

  const created = kept.slice();
  for (let i = 0; i < pending.length; i += 1) {
    const row = { code: pending[i], status: 'active', is_test: true };
    if (row.is_test !== true) {
      throw new Error('seed rows must be is_test');
    }
    const { data, error } = await supabase
      .from('affiliates')
      .insert(row)
      .select('id, code, is_test')
      .maybeSingle();
    if (error || !data || data.is_test !== true) {
      throw new Error('affiliate seed failed');
    }
    created.push(data);
  }
  return created;
}

async function main() {
  assertNotProduction(process.env.SUPABASE_URL);
  assertSeedAllowed(process.env.ALLOW_AFFILIATE_SEED);
  const codes = normalizeCodes(process.argv.slice(2));
  const host = supabaseHost(process.env.SUPABASE_URL);
  const accepted = await promptConfirmation(host, process.stdin, process.stdout);
  if (!accepted) {
    throw new Error('seed cancelled');
  }
  const supabase = require('../src/clients/supabase');
  const created = await seedAffiliates(codes, supabase);
  for (let i = 0; i < created.length; i += 1) {
    process.stdout.write(created[i].code + '\n');
  }
}

if (require.main === module) {
  require('dotenv').config();
  main().catch(function (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  PROD_REF,
  assertNotProduction,
  assertSeedAllowed,
  supabaseHost,
  confirmationAccepted,
  normalizeCodes,
  seedAffiliates,
};
