require('dotenv').config();
process.env.APIFY_TOKEN = process.env.APIFY_TOKEN || 'dummy';
process.env.APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'dummy';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const supabase = require('../src/clients/supabase');

(async () => {
  console.log('=== 1) google_serp_ads_manual (capture_id + placement) ===');
  const { data: ads, error: adsErr } = await supabase
    .from('google_serp_ads_manual')
    .select(
      'id, capture_id, position, placement, search_term, advertiser_name, advertiser_domain, ad_title, raw_html_storage_path, imported_at',
    )
    .order('position', { ascending: true });
  if (adsErr) {
    console.error(adsErr);
    process.exit(1);
  }
  console.log(JSON.stringify(ads, null, 2));

  console.log('\n=== captures ===');
  const { data: caps, error: capsErr } = await supabase
    .from('google_serp_captures')
    .select('*')
    .order('imported_at', { ascending: true });
  if (capsErr) console.error(capsErr);
  else console.log(JSON.stringify(caps, null, 2));

  const samplePath = path.join(
    'samples',
    'prestamos con cedula - Google Search.html',
  );
  const buf = fs.readFileSync(samplePath);
  const localHash = createHash('sha256').update(buf).digest('hex');
  console.log('\n=== hash compare ===');
  console.log('local_bytes=', buf.length);
  console.log('local_sha256=', localHash);
  if (caps && caps[0]) {
    console.log('db_file_hash=', caps[0].file_hash);
    console.log('hashes_match=', caps[0].file_hash === localHash);
  }
})();
