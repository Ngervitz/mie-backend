-- Exact-domain matching for SERP advertiser ↔ monitored_entities.
-- Adds website_domain (nullable hostname) and backfills four known entities
-- by their real UUIDs. Matching in collectGoogleSerpImports uses ONLY
-- normalizeDomain(advertiser_domain) === normalizeDomain(website_domain).
--
-- Note: monitored_entities already has website_url (full URL, currently NULL
-- for these rows) and ad_library_url (Facebook Ad Library). website_domain
-- is a dedicated normalized-hostname field for exact equality matching.

BEGIN;

ALTER TABLE public.monitored_entities
  ADD COLUMN IF NOT EXISTS website_domain text NULL;

-- Partial unique index (same pattern as events_dedup partial uniques):
-- only enforces uniqueness among non-null values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitored_entities_website_domain_lower
  ON public.monitored_entities (LOWER(website_domain))
  WHERE website_domain IS NOT NULL;

-- Backfill by confirmed entity IDs (do not derive from name matching).
UPDATE public.monitored_entities
SET website_domain = 'pronto.com.uy'
WHERE id = '131940fe-6ade-48b5-9d23-d0ca10c55a48';

UPDATE public.monitored_entities
SET website_domain = 'creditoamigo.com.uy'
WHERE id = '4491164a-0a65-439e-afab-1c9541b6f0dc';

UPDATE public.monitored_entities
SET website_domain = 'tuprestamo.com.uy'
WHERE id = '0680a0ee-f7d3-4f06-b481-e2ec120e8876';

UPDATE public.monitored_entities
SET website_domain = 'crediton.com.uy'
WHERE id = '8f20fcba-6589-487e-a178-62bada98b8df';

COMMIT;
