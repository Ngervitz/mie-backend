require('dotenv').config();
process.env.APIFY_TOKEN = process.env.APIFY_TOKEN || 'dummy';
process.env.APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'dummy';

const supabase = require('../src/clients/supabase');

const SAMPLE_PATH = '1784508079165-8b8c9b9f-56b7-4364-9d32-08aaa68dddd1.html';
const EMPTY_PATH = '1784508082244-0dcc8ae8-d7c7-45ef-8446-8dc4f84915c0.html';

(async () => {
  console.log('=== 2) Rows in google_serp_ads_manual ===');
  const { data, error } = await supabase
    .from('google_serp_ads_manual')
    .select('*')
    .order('imported_at', { ascending: false })
    .order('position', { ascending: true });
  if (error) {
    console.error('DB ERROR', error);
    process.exit(1);
  }
  console.log('row_count=', data.length);
  console.log(JSON.stringify(data, null, 2));

  console.log('\n=== 3) Storage bucket serp-html-imports ===');
  const { data: buckets } = await supabase.storage.listBuckets();
  console.log(
    'buckets=',
    (buckets || []).map((b) => ({ name: b.name, public: b.public })),
  );

  const { data: listed, error: listErr } = await supabase.storage
    .from('serp-html-imports')
    .list('', { limit: 20 });
  if (listErr) console.error('list error', listErr);
  else console.log('objects=', JSON.stringify(listed, null, 2));

  const { data: fileData, error: dlErr } = await supabase.storage
    .from('serp-html-imports')
    .download(SAMPLE_PATH);
  if (dlErr) console.error('download error', dlErr);
  else {
    const buf = Buffer.from(await fileData.arrayBuffer());
    console.log('downloaded sample bytes=', buf.length);
    console.log('starts_with=', buf.slice(0, 120).toString('utf8'));
    console.log(
      'includes data-text-ad marker=',
      buf.toString('utf8').includes('data-text-ad="1"'),
    );
  }

  const { data: emptyFile, error: emptyErr } = await supabase.storage
    .from('serp-html-imports')
    .download(EMPTY_PATH);
  if (emptyErr) console.error('empty download error', emptyErr);
  else {
    const buf2 = Buffer.from(await emptyFile.arrayBuffer());
    console.log('downloaded empty-test bytes=', buf2.length);
    console.log('empty-test content=', buf2.toString('utf8'));
  }
})();
