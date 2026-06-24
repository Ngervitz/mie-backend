const { ApifyClient } = require('apify-client');
const env = require('../config/env');

const client = new ApifyClient({ token: env.apifyToken });

function buildApifyInput(adLibraryUrl) {
  return {
    startUrls: [adLibraryUrl],
    // maxResults: 50 — V1 limit. Actor default is 100. Set 0 for unlimited.
    maxResults: 50,
  };
}

async function fetchAllDatasetItems(datasetId) {
  const items = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { items: page } = await client.dataset(datasetId).listItems({ offset, limit });
    items.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return items;
}

async function runActor(input) {
  const { defaultDatasetId } = await client.actor(env.apifyActorId).call(input);
  return fetchAllDatasetItems(defaultDatasetId);
}

module.exports = { buildApifyInput, runActor };
