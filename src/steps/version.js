const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function saveAdVersions({ recordsToVersion, detectedAt }) {
  if (!Array.isArray(recordsToVersion)) {
    throw new Error('recordsToVersion must be an array');
  }

  if (!detectedAt) {
    throw new Error('detectedAt is required');
  }

  const detectedAtDate = detectedAt.split('T')[0];

  if (!isValidDateOnly(detectedAtDate)) {
    throw new Error(`Invalid detectedAt date: ${detectedAt}`);
  }

  if (recordsToVersion.length === 0) {
    return { inserted: 0 };
  }

  logger.info('Entity version started', {
    count: recordsToVersion.length,
  });

  const rowsToInsert = recordsToVersion.map((record) => ({
    ad_id: record.ad_id,
    detected_at: detectedAtDate,
    ad_text: record.ad_text,
    cta_text: record.cta_text,
    landing_url: record.landing_url,
    platforms: record.platforms,
    ad_format: record.ad_format,
    image_url: record.image_url,
    video_url: record.video_url,
    creative_hash: record.creative_hash,
    copy_hash: record.copy_hash,
  }));

  const { error } = await supabase.from('ad_versions').insert(rowsToInsert);

  if (error) {
    throw new Error(`Failed to insert ad_versions: ${error.message}`);
  }

  logger.info('Entity version finished', {
    inserted: rowsToInsert.length,
  });

  return { inserted: rowsToInsert.length };
}

module.exports = { saveAdVersions };
