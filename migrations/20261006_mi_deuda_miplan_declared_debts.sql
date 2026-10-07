-- Mi Deuda Stage 2: Mi Plan debt-management opt-in copy + declared debts + miplan_declared seed.
-- Apply manually in Supabase AFTER 20261006_mi_deuda_creditor_catalog.sql and
-- 20260925_miplan_handoff_tokens.sql, BEFORE deploying the runtime that reads/writes it.
-- Idempotent. Additive only: does not touch BCU facts, rejected_ci_outreach, Stage 1 rows or Mi Plan.
--
-- Mi Plan is the source of truth of the opt-in; these tables are JANUS's immutable operational copy.
-- creditor_raw = counterparty DECLARED by the user (not necessarily the current legal creditor).
-- ingestion_* = how the debt resolved when it entered; never re-pointed (merge followed at read only).
--
-- Access: backend only (service_role). RLS enabled with NO policies; PUBLIC/anon/authenticated revoked.
-- Seed mirrors src/lib/creditorCatalogMiplanDeclaredSeed.js
-- (enforced by scripts/unit-creditor-catalog-miplan-seed.js).
-- Requires extensions.uuid_generate_v5 (uuid-ossp, present in Supabase).

BEGIN;

-- ---------------------------------------------------------------------------
-- A. miplan_declared seed (human-reviewed). Reviewed-UNSAFE keys intentionally absent.
-- ---------------------------------------------------------------------------

INSERT INTO public.creditors (creditor_id, slug, display_name, status)
VALUES
  ('89311a19-c966-5a9e-818e-87c9149bd049', 'ute', 'UTE', 'active'),
  ('28c03a55-d4fe-5996-983c-3d6cb04fc5b0', 'ose', 'OSE', 'active'),
  ('851f0ee8-ba61-5088-a2ed-28e81c3f9330', 'antel', 'ANTEL', 'active'),
  ('0e50ca6f-85a3-5455-88cf-d88b5e530f13', 'movistar', 'Movistar', 'active'),
  ('fb9dba7a-7d4c-5c53-9002-3545fc066af9', 'claro', 'Claro', 'active'),
  ('701847fd-5514-58f7-a39d-8c5a435e0e2f', 'bse', 'BSE', 'active'),
  ('ddfd4e1e-f9de-54c2-b7bb-d1578c60b56f', 'caja-notarial', 'Caja Notarial', 'active'),
  ('73d66738-81dc-5d1a-83ac-49e86e1b3aad', 'bhu', 'BHU', 'active'),
  ('1b99ccf3-8349-5649-8b43-4cbf281a567c', 'creditel', 'Creditel', 'active'),
  ('0d2ed2d7-4db0-5d0d-bd41-24a431f4b716', 'pronto', 'Pronto', 'active'),
  ('860ecab9-2f51-52f0-bf75-25de198be758', 'divino', 'Divino', 'active'),
  ('83f339cc-f353-5a10-a301-0fbe6fa91d44', 'motociclo', 'Motociclo', 'active'),
  ('33ba6704-7fc1-5908-9995-826d75db3fd7', 'multi-ahorro', 'Multi Ahorro', 'active')
ON CONFLICT (creditor_id) DO NOTHING;

INSERT INTO public.creditor_aliases
  (id, source, normalized_key, creditor_id, status, example_raw, note, approved_at)
VALUES
  ('0b4233d2-ad7c-5ab8-98d9-8256a735d236', 'miplan_declared', 'brou', '2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'approved', 'brou', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('9b698887-074e-5b15-ac15-3df2ee813abe', 'miplan_declared', 'banco republica', '2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'approved', 'banco republica', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('0ae9dee2-5d83-5839-a513-ea9164522a54', 'miplan_declared', 'banco de la republica', '2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'approved', 'banco de la republica', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('4ccd266f-7f0e-5270-b97b-fd3e849afe90', 'miplan_declared', 'banco de la republica oriental del uruguay', '2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'approved', 'banco de la republica oriental del uruguay', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('c2614b1e-a9a7-5a38-93f7-76d6f1744a2f', 'miplan_declared', 'itau', '23e32bcd-6d59-560f-8bca-e8d17bfe6f8c', 'approved', 'itau', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('a1b14e97-5a94-5e14-a8d5-176c2b482ae3', 'miplan_declared', 'banco itau', '23e32bcd-6d59-560f-8bca-e8d17bfe6f8c', 'approved', 'banco itau', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('051ee864-8700-5d22-9e1b-d3bf61a8064c', 'miplan_declared', 'itau banco', '23e32bcd-6d59-560f-8bca-e8d17bfe6f8c', 'approved', 'itau banco', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('e1891af2-76aa-5bdb-bda8-fa7b6569b8a0', 'miplan_declared', 'santander', '0039dcbe-0af2-5a2d-a025-3a94e072ed95', 'approved', 'santander', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('45536d0e-768e-5e46-b316-5c806c966e1a', 'miplan_declared', 'banco santander', '0039dcbe-0af2-5a2d-a025-3a94e072ed95', 'approved', 'banco santander', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('ff4c1d63-6d0c-54da-9758-b8c934d8b0bb', 'miplan_declared', 'scotiabank', 'f7301263-de28-5ba4-8cfe-c3af02ea9982', 'approved', 'scotiabank', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('098a8208-64ee-5d17-a993-3cdae32cf448', 'miplan_declared', 'scotia', 'f7301263-de28-5ba4-8cfe-c3af02ea9982', 'approved', 'scotia', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('1a9402b9-4594-5f02-9a0c-48a42d26e331', 'miplan_declared', 'bbva', 'c4f5b28b-a68b-535e-9b1a-4844b0120569', 'approved', 'bbva', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('7137e5b6-93b8-5b78-925c-01c3d97a2772', 'miplan_declared', 'oca', '6a126a47-8b2a-5872-9a2c-527d0891b855', 'approved', 'oca', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('1f068c3e-ebcd-5620-9d06-1e5ed6c4f706', 'miplan_declared', 'tarjeta oca', '6a126a47-8b2a-5872-9a2c-527d0891b855', 'approved', 'tarjeta oca', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('b4bc32a3-a4d1-5741-963e-3efaf59a8391', 'miplan_declared', 'oca tarjeta', '6a126a47-8b2a-5872-9a2c-527d0891b855', 'approved', 'oca tarjeta', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('409d8cde-54f0-55e3-9712-91e28d48d491', 'miplan_declared', 'anda', '9d17be3d-44b8-5689-b2db-7476254cb8fa', 'approved', 'anda', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('c67fc70c-2af7-53e8-90e4-7ea3da9832a8', 'miplan_declared', 'anda prestamo', '9d17be3d-44b8-5689-b2db-7476254cb8fa', 'approved', 'anda prestamo', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('4685a7f2-ba7b-59ae-a589-be30cc4c1299', 'miplan_declared', 'fucerep', '485edd12-a6ca-591b-a869-7c3f0faaedca', 'approved', 'fucerep', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('f0114e4b-552d-5e4b-a4d6-ed69fc11faa9', 'miplan_declared', 'pass card', 'aba4810d-3f3c-5e3a-8507-192b7d9a8cd5', 'approved', 'pass card', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('53b16f1a-66dd-5995-98ec-87a32627a95e', 'miplan_declared', 'passcard', 'aba4810d-3f3c-5e3a-8507-192b7d9a8cd5', 'approved', 'passcard', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('ae6f775d-ae42-5071-9170-71468a92f53f', 'miplan_declared', 'ute', '89311a19-c966-5a9e-818e-87c9149bd049', 'approved', 'ute', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('1984075d-98a9-5ab9-9145-3289afc6d9f8', 'miplan_declared', 'ose', '28c03a55-d4fe-5996-983c-3d6cb04fc5b0', 'approved', 'ose', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('3bb5ddf3-56bf-5245-83d4-2bd6e9468a70', 'miplan_declared', 'antel', '851f0ee8-ba61-5088-a2ed-28e81c3f9330', 'approved', 'antel', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('21039abe-8b70-5fd3-a45a-2b7b306c7aa1', 'miplan_declared', 'movistar', '0e50ca6f-85a3-5455-88cf-d88b5e530f13', 'approved', 'movistar', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('a460d4f6-1be8-5574-992e-9fa0527d9a0e', 'miplan_declared', 'claro', 'fb9dba7a-7d4c-5c53-9002-3545fc066af9', 'approved', 'claro', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('5f80c75f-b615-555c-a969-5a50da58d5fd', 'miplan_declared', 'bse', '701847fd-5514-58f7-a39d-8c5a435e0e2f', 'approved', 'bse', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('5a067348-241f-5b88-b8bc-91777cbad473', 'miplan_declared', 'caja notarial', 'ddfd4e1e-f9de-54c2-b7bb-d1578c60b56f', 'approved', 'caja notarial', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('874506ac-bb94-5844-ba6f-0bc2f5951c3e', 'miplan_declared', 'bhu', '73d66738-81dc-5d1a-83ac-49e86e1b3aad', 'approved', 'bhu', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('baceab7e-e216-57e4-9e90-656720ed6984', 'miplan_declared', 'banco hipotecario', '73d66738-81dc-5d1a-83ac-49e86e1b3aad', 'approved', 'banco hipotecario', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('5d2024f7-3af7-5d21-994c-9396351bd2b4', 'miplan_declared', 'creditel', '1b99ccf3-8349-5649-8b43-4cbf281a567c', 'approved', 'creditel', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('ecd73e75-fa7c-5291-aa9f-76dbacf57bd8', 'miplan_declared', 'pronto', '0d2ed2d7-4db0-5d0d-bd41-24a431f4b716', 'approved', 'pronto', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('41723f6d-3201-56af-9f1a-3784b55bf986', 'miplan_declared', 'divino', '860ecab9-2f51-52f0-bf75-25de198be758', 'approved', 'divino', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('be2cbb65-7969-5f7f-9947-c1e8e14d4a0a', 'miplan_declared', 'motociclo', '83f339cc-f353-5a10-a301-0fbe6fa91d44', 'approved', 'motociclo', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('77ef9deb-56fb-5964-99bc-595d2433cb7a', 'miplan_declared', 'multi ahorro', '33ba6704-7fc1-5908-9995-826d75db3fd7', 'approved', 'multi ahorro', 'seed: reviewed Mi Plan CREDITOR_DICT', now()),
  ('1709b866-9b23-5396-b583-8db02325fd36', 'miplan_declared', 'multiahorro', '33ba6704-7fc1-5908-9995-826d75db3fd7', 'approved', 'multiahorro', 'seed: reviewed Mi Plan CREDITOR_DICT', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.creditor_aliases
  (id, source, normalized_key, creditor_id, status, example_raw, note)
VALUES
  ('1d564b59-cd51-5b28-ba38-2cd4438d1f0b', 'miplan_declared', 'republica', NULL, 'ambiguous', 'republica', 'reviewed: generic word, does not identify a bank'),
  ('040adc1c-f2c6-51d0-9310-3399f750f7ea', 'miplan_declared', 'visa', NULL, 'ambiguous', 'visa', 'reviewed: card network, not issuer'),
  ('4e05990f-9cf7-594c-8d82-b81816e3e108', 'miplan_declared', 'visa uruguay', NULL, 'ambiguous', 'visa uruguay', 'reviewed: card network, not issuer'),
  ('caede661-422b-5bad-81b4-2cca2251f68c', 'miplan_declared', 'mastercard', NULL, 'ambiguous', 'mastercard', 'reviewed: card network, not issuer'),
  ('57b2027a-a21b-55c0-9a30-e83d1d07cc15', 'miplan_declared', 'master', NULL, 'ambiguous', 'master', 'reviewed: card network / generic word'),
  ('64effede-881b-54f6-b041-30533c63f918', 'miplan_declared', 'cash', NULL, 'ambiguous', 'cash', 'reviewed: generic word, does not imply CASH S.A.'),
  ('2bc00b46-8b6f-55bf-8a57-a0b0555519a1', 'miplan_declared', 'pass', NULL, 'ambiguous', 'pass', 'reviewed: generic word, does not imply PASS CARD S.A.'),
  ('cbd0d1f8-5eaf-5fb4-b335-d2947039cb61', 'miplan_declared', 'alfa', NULL, 'ambiguous', 'alfa', 'reviewed: generic word'),
  ('9189ee49-7d28-56dc-b35f-cd0df645a4bd', 'miplan_declared', 'uruguaya', NULL, 'ambiguous', 'uruguaya', 'reviewed: generic adjective'),
  ('ce5afde2-e03f-513b-a728-1e2f4bd5b735', 'miplan_declared', 'notarial', NULL, 'ambiguous', 'notarial', 'reviewed: generic word'),
  ('c47f8f94-c60f-5318-b014-c6dce39efc22', 'miplan_declared', 'abitab', NULL, 'ambiguous', 'abitab', 'reviewed: payment/collection network, not creditor'),
  ('73f1e85a-11eb-5a8a-809d-ac1413882aa8', 'miplan_declared', 'redpagos', NULL, 'ambiguous', 'redpagos', 'reviewed: payment/collection network, not creditor'),
  ('283d7419-6575-5e2e-972e-0a2de6d05cc0', 'miplan_declared', 'red pagos', NULL, 'ambiguous', 'red pagos', 'reviewed: payment/collection network, not creditor'),
  ('ee221a0e-5e79-5a99-bbc4-cf03e3409021', 'miplan_declared', 'familiar', NULL, 'ambiguous', 'familiar', 'reviewed: informal category (person), not identity'),
  ('a0d6f6e4-e4c2-53be-96ef-4e2a65126fb0', 'miplan_declared', 'familia', NULL, 'ambiguous', 'familia', 'reviewed: informal category (person), not identity'),
  ('06f08660-e0f0-5223-bac0-1e148ce378fe', 'miplan_declared', 'madre', NULL, 'ambiguous', 'madre', 'reviewed: informal category (person), not identity'),
  ('f2008fe5-6462-54f3-9ff6-b1c7dd133b4e', 'miplan_declared', 'padre', NULL, 'ambiguous', 'padre', 'reviewed: informal category (person), not identity'),
  ('6c939a28-fa4e-5f67-9f0a-2b70b41b05ae', 'miplan_declared', 'hermano', NULL, 'ambiguous', 'hermano', 'reviewed: informal category (person), not identity'),
  ('91280c4b-b190-52fe-9a3f-ea681277f044', 'miplan_declared', 'hermana', NULL, 'ambiguous', 'hermana', 'reviewed: informal category (person), not identity'),
  ('b52a4594-3929-559a-92b6-6f36bd81670f', 'miplan_declared', 'tio', NULL, 'ambiguous', 'tio', 'reviewed: informal category (person), not identity'),
  ('325be6d8-7596-5963-867b-935c1a31e5d8', 'miplan_declared', 'tia', NULL, 'ambiguous', 'tia', 'reviewed: informal category (person), not identity'),
  ('462ef0d5-46e6-5269-8712-1e7310fc2a2f', 'miplan_declared', 'abuelo', NULL, 'ambiguous', 'abuelo', 'reviewed: informal category (person), not identity'),
  ('927c2ab5-b291-5eed-b5c8-baa02552c1bb', 'miplan_declared', 'abuela', NULL, 'ambiguous', 'abuela', 'reviewed: informal category (person), not identity'),
  ('1f03177c-c46c-55b5-8e02-8fd6247bfa78', 'miplan_declared', 'primo', NULL, 'ambiguous', 'primo', 'reviewed: informal category (person), not identity'),
  ('ca02f72e-4d60-5256-9c23-e3c6e23dc38a', 'miplan_declared', 'prima', NULL, 'ambiguous', 'prima', 'reviewed: informal category (person), not identity'),
  ('0e08539f-bf7c-5dda-bda5-869830a7fe2b', 'miplan_declared', 'amigo', NULL, 'ambiguous', 'amigo', 'reviewed: informal category (person), not identity'),
  ('9683ab47-bf7f-57e5-a440-fd61a4c82fdc', 'miplan_declared', 'amiga', NULL, 'ambiguous', 'amiga', 'reviewed: informal category (person), not identity'),
  ('128a9d83-2bf3-5afa-bfe0-d57d7ea4250f', 'miplan_declared', 'prestamista', NULL, 'ambiguous', 'prestamista', 'reviewed: informal category, not identity'),
  ('6451f488-474c-5480-9e72-d8a80de508cd', 'miplan_declared', 'particular', NULL, 'ambiguous', 'particular', 'reviewed: informal category, not identity'),
  ('979dbee3-e92a-5916-9b53-084f8260625e', 'miplan_declared', 'persona', NULL, 'ambiguous', 'persona', 'reviewed: informal category, not identity'),
  ('a4b072b9-cd7b-5f52-ba42-6adaf07e97c7', 'miplan_declared', 'privado', NULL, 'ambiguous', 'privado', 'reviewed: informal category, not identity')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- B. (none) Delivery = Mi Plan pending/ACK protocol; no JANUS sync cursor is stored.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- C. miplan_debt_optin_events: immutable copy of Mi Plan debt_management_opt_in_events.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.miplan_debt_optin_events (
  event_id               uuid PRIMARY KEY,
  journey_id             uuid NOT NULL,
  seq                    integer NOT NULL,
  state                  text NOT NULL,
  scope                  text NOT NULL,
  contract_version       text NOT NULL,
  source                 text NOT NULL,
  consent_text_version   text NULL,
  origin_evaluation_id   uuid NOT NULL,
  origin_diagnosis_id    uuid NULL,
  snapshot_diagnosis_id  uuid NOT NULL,
  miplan_created_at      timestamptz NOT NULL,
  excluded_count         integer NULL,
  handoff_token_id       uuid NULL REFERENCES public.miplan_handoff_tokens (id),
  ci                     bigint NULL,
  ci_resolution          text NOT NULL,
  payload_version        text NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT miplan_debt_optin_events_journey_seq_key UNIQUE (journey_id, seq),
  CONSTRAINT miplan_debt_optin_events_event_snapshot_key UNIQUE (event_id, snapshot_diagnosis_id),
  CONSTRAINT miplan_debt_optin_events_seq_check CHECK (seq >= 1),
  CONSTRAINT miplan_debt_optin_events_state_check CHECK (state IN ('opted_in', 'withdrawn')),
  CONSTRAINT miplan_debt_optin_events_scope_check CHECK (scope = 'debt_management_interest'),
  CONSTRAINT miplan_debt_optin_events_contract_check CHECK (contract_version = 'debt_management_opt_in_v1'),
  CONSTRAINT miplan_debt_optin_events_source_check CHECK (source = 'miplan_v2'),
  CONSTRAINT miplan_debt_optin_events_text_version_check
    CHECK (consent_text_version IS NULL OR consent_text_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT miplan_debt_optin_events_snapshot_check
    CHECK (origin_diagnosis_id IS NULL OR origin_diagnosis_id = snapshot_diagnosis_id),
  CONSTRAINT miplan_debt_optin_events_excluded_check
    CHECK ((state = 'opted_in') = (excluded_count IS NOT NULL) AND (excluded_count IS NULL OR excluded_count >= 0)),
  CONSTRAINT miplan_debt_optin_events_ci_check CHECK (ci IS NULL OR ci > 0),
  CONSTRAINT miplan_debt_optin_events_ci_resolution_check
    CHECK (ci_resolution IN ('resolved', 'unresolvable')),
  CONSTRAINT miplan_debt_optin_events_ci_resolved_check
    CHECK ((ci_resolution = 'resolved') = (ci IS NOT NULL)
           AND (ci_resolution <> 'resolved' OR handoff_token_id IS NOT NULL)),
  CONSTRAINT miplan_debt_optin_events_payload_version_check
    CHECK (payload_version = 'miplan_debt_optin_export_v1')
);

COMMENT ON TABLE public.miplan_debt_optin_events IS
  'Immutable JANUS copy of Mi Plan debt-management opt-in events (Mi Plan is the source of truth). Current state: max(seq) per journey; per effective CI the head with the greatest miplan_created_at (tie: greatest event_id). received_at never decides state.';
COMMENT ON COLUMN public.miplan_debt_optin_events.snapshot_diagnosis_id IS
  'Authorized snapshot D = origin_diagnosis_id, else the origin evaluation''s diagnosis. Later debts are not covered.';
COMMENT ON COLUMN public.miplan_debt_optin_events.ci IS
  'Resolved by JANUS from a consumed miplan_handoff_tokens row only; never from the browser or Mi Plan. '
  'NULL at ingest stays NULL forever here; later resolution lives in miplan_optin_ci_reconciliation.';

CREATE INDEX IF NOT EXISTS idx_miplan_debt_optin_events_ci
  ON public.miplan_debt_optin_events (ci, miplan_created_at DESC)
  WHERE ci IS NOT NULL;

-- ---------------------------------------------------------------------------
-- D. miplan_declared_debts: immutable authorized snapshot rows (one per position in D).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.miplan_declared_debts (
  declared_debt_id             uuid PRIMARY KEY,
  optin_event_id               uuid NOT NULL,
  ci                           bigint NULL,
  snapshot_diagnosis_id        uuid NOT NULL,
  position                     integer NOT NULL,
  client_debt_id               text NULL,
  tipo                         text NULL,
  creditor_raw                 text NULL,
  miplan_acreedor_display      text NULL,
  miplan_acreedor_normalizado  text NULL,
  creditor_normalized_key      text NULL,
  creditor_key_version         text NOT NULL,
  ingestion_resolution         text NOT NULL,
  ingestion_creditor_id        uuid NULL REFERENCES public.creditors (creditor_id),
  ingestion_alias_id           uuid NULL REFERENCES public.creditor_aliases (id),
  monto                        numeric NULL,
  monto_raw                    text NULL,
  pago                         numeric NULL,
  pago_raw                     text NULL,
  pago_mensual_actual          numeric NULL,
  pago_mensual_actual_raw      text NULL,
  situacion_ui                 text NULL,
  estado                       text NULL,
  atraso_tiempo                text NULL,
  atraso_tiempo_aprox          text NULL,
  ultimo_pago_declarado        numeric NULL,
  ultimo_pago_declarado_raw    text NULL,
  debt_confidence              text NULL,
  received_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT miplan_declared_debts_event_position_key UNIQUE (optin_event_id, position),
  CONSTRAINT miplan_declared_debts_event_fk
    FOREIGN KEY (optin_event_id, snapshot_diagnosis_id)
    REFERENCES public.miplan_debt_optin_events (event_id, snapshot_diagnosis_id),
  CONSTRAINT miplan_declared_debts_position_check CHECK (position >= 0),
  CONSTRAINT miplan_declared_debts_ci_check CHECK (ci IS NULL OR ci > 0),
  CONSTRAINT miplan_declared_debts_key_version_check CHECK (creditor_key_version = 'creditor_key_v1'),
  CONSTRAINT miplan_declared_debts_key_format_check
    CHECK (creditor_normalized_key IS NULL OR creditor_normalized_key ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  CONSTRAINT miplan_declared_debts_resolution_check
    CHECK (ingestion_resolution IN ('EMPTY', 'RESOLVED', 'UNKNOWN_REVIEWED', 'UNKNOWN')),
  CONSTRAINT miplan_declared_debts_resolution_shape_check CHECK (
    ((ingestion_resolution = 'EMPTY') = (creditor_normalized_key IS NULL))
    AND ((ingestion_resolution = 'RESOLVED') = (ingestion_creditor_id IS NOT NULL))
    AND ((ingestion_resolution IN ('RESOLVED', 'UNKNOWN_REVIEWED')) = (ingestion_alias_id IS NOT NULL))
  ),
  CONSTRAINT miplan_declared_debts_amounts_check CHECK (
    (monto IS NULL OR monto >= 0) AND (pago IS NULL OR pago >= 0)
    AND (pago_mensual_actual IS NULL OR pago_mensual_actual >= 0)
    AND (ultimo_pago_declarado IS NULL OR ultimo_pago_declarado >= 0)
  ),
  CONSTRAINT miplan_declared_debts_not_paid_check CHECK (situacion_ui IS DISTINCT FROM 'pagada'),
  CONSTRAINT miplan_declared_debts_text_length_check CHECK (
    coalesce(char_length(client_debt_id), 0) <= 500 AND coalesce(char_length(tipo), 0) <= 500
    AND coalesce(char_length(creditor_raw), 0) <= 500
    AND coalesce(char_length(miplan_acreedor_display), 0) <= 500
    AND coalesce(char_length(miplan_acreedor_normalizado), 0) <= 500
    AND coalesce(char_length(monto_raw), 0) <= 500 AND coalesce(char_length(pago_raw), 0) <= 500
    AND coalesce(char_length(pago_mensual_actual_raw), 0) <= 500
    AND coalesce(char_length(ultimo_pago_declarado_raw), 0) <= 500
  )
);

COMMENT ON TABLE public.miplan_declared_debts IS
  'Immutable declared debts of an authorized Mi Plan snapshot. declared_debt_id = uuidv5(ns, event_id:position). position is only the index inside D.';
COMMENT ON COLUMN public.miplan_declared_debts.creditor_raw IS
  'Counterparty declared by the user (acreedor_raw, else acreedor). Not necessarily the current legal creditor.';
COMMENT ON COLUMN public.miplan_declared_debts.ingestion_creditor_id IS
  'Creditor resolved at ingestion (source miplan_declared). Never re-pointed; explicit merges are followed at read time.';

CREATE INDEX IF NOT EXISTS idx_miplan_declared_debts_ci
  ON public.miplan_declared_debts (ci) WHERE ci IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_miplan_declared_debts_creditor
  ON public.miplan_declared_debts (ingestion_creditor_id) WHERE ingestion_creditor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_miplan_declared_debts_unresolved
  ON public.miplan_declared_debts (creditor_normalized_key) WHERE ingestion_resolution <> 'RESOLVED';

-- Debts belong to an opted_in event and carry exactly its CI (defense in depth for direct inserts).
CREATE OR REPLACE FUNCTION public.miplan_declared_debts_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ci bigint;
  v_state text;
BEGIN
  SELECT e.ci, e.state INTO v_ci, v_state
  FROM public.miplan_debt_optin_events e
  WHERE e.event_id = NEW.optin_event_id;
  IF v_state IS DISTINCT FROM 'opted_in' THEN
    RAISE EXCEPTION 'miplan_declared_debts: event % is not opted_in', NEW.optin_event_id USING ERRCODE = '23514';
  END IF;
  IF NEW.ci IS DISTINCT FROM v_ci THEN
    RAISE EXCEPTION 'miplan_declared_debts: ci must equal the event ci' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_miplan_declared_debts_guard_insert ON public.miplan_declared_debts;
CREATE TRIGGER trg_miplan_declared_debts_guard_insert
  BEFORE INSERT ON public.miplan_declared_debts
  FOR EACH ROW EXECUTE FUNCTION public.miplan_declared_debts_guard_insert();

-- ---------------------------------------------------------------------------
-- E. Immutability: no UPDATE / DELETE / TRUNCATE (inserts stay allowed and idempotent).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.miplan_optin_copy_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is an immutable snapshot copy (% forbidden)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_miplan_debt_optin_events_immutable ON public.miplan_debt_optin_events;
CREATE TRIGGER trg_miplan_debt_optin_events_immutable
  BEFORE UPDATE OR DELETE ON public.miplan_debt_optin_events
  FOR EACH ROW EXECUTE FUNCTION public.miplan_optin_copy_forbid_mutation();
DROP TRIGGER IF EXISTS trg_miplan_debt_optin_events_no_truncate ON public.miplan_debt_optin_events;
CREATE TRIGGER trg_miplan_debt_optin_events_no_truncate
  BEFORE TRUNCATE ON public.miplan_debt_optin_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.miplan_optin_copy_forbid_mutation();

DROP TRIGGER IF EXISTS trg_miplan_declared_debts_immutable ON public.miplan_declared_debts;
CREATE TRIGGER trg_miplan_declared_debts_immutable
  BEFORE UPDATE OR DELETE ON public.miplan_declared_debts
  FOR EACH ROW EXECUTE FUNCTION public.miplan_optin_copy_forbid_mutation();
DROP TRIGGER IF EXISTS trg_miplan_declared_debts_no_truncate ON public.miplan_declared_debts;
CREATE TRIGGER trg_miplan_declared_debts_no_truncate
  BEFORE TRUNCATE ON public.miplan_declared_debts
  FOR EACH STATEMENT EXECUTE FUNCTION public.miplan_optin_copy_forbid_mutation();

-- ---------------------------------------------------------------------------
-- E2. CI reconciliation: operational state of events ingested with ci_resolution = 'unresolvable'.
--     Separate from the immutable copy (events / debts are never updated). The row is created in
--     the SAME transaction as the event, so acknowledging delivery to Mi Plan never drops the
--     obligation to resolve. PENDING → RESOLVED (consumed token with CI found later) or
--     TERMINAL_UNRESOLVABLE (horizon exceeded, or no handoff hash at all). Final states never change;
--     first_unresolved_at and horizon_seconds never move (a replay cannot restart the horizon);
--     rows are never deleted. Effective CI at read time = event.ci, else resolved_ci when RESOLVED.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.miplan_optin_ci_reconciliation (
  event_id                    uuid PRIMARY KEY REFERENCES public.miplan_debt_optin_events (event_id),
  handoff_token_hash          text NULL,
  status                      text NOT NULL,
  last_unresolved_reason      text NOT NULL,
  first_unresolved_at         timestamptz NOT NULL,
  last_resolution_attempt_at  timestamptz NOT NULL,
  resolution_attempt_count    integer NOT NULL,
  horizon_seconds             integer NOT NULL,
  resolved_ci                 bigint NULL,
  resolved_handoff_token_id   uuid NULL REFERENCES public.miplan_handoff_tokens (id),
  resolved_at                 timestamptz NULL,
  terminal_reason             text NULL,
  terminal_at                 timestamptz NULL,
  CONSTRAINT miplan_optin_ci_recon_hash_check
    CHECK (handoff_token_hash IS NULL OR handoff_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT miplan_optin_ci_recon_status_check
    CHECK (status IN ('PENDING', 'RESOLVED', 'TERMINAL_UNRESOLVABLE')),
  CONSTRAINT miplan_optin_ci_recon_reason_check
    CHECK (last_unresolved_reason IN ('NO_TOKEN_HASH', 'TOKEN_NOT_FOUND', 'TOKEN_NOT_CONSUMED', 'TOKEN_WITHOUT_CI')),
  CONSTRAINT miplan_optin_ci_recon_attempts_check
    CHECK (resolution_attempt_count >= 1 AND horizon_seconds > 0
           AND last_resolution_attempt_at >= first_unresolved_at),
  CONSTRAINT miplan_optin_ci_recon_resolved_check
    CHECK ((status = 'RESOLVED') = (resolved_ci IS NOT NULL)
           AND (resolved_ci IS NULL OR (resolved_ci > 0 AND resolved_handoff_token_id IS NOT NULL AND resolved_at IS NOT NULL))
           AND (resolved_ci IS NOT NULL OR (resolved_handoff_token_id IS NULL AND resolved_at IS NULL))),
  CONSTRAINT miplan_optin_ci_recon_terminal_check
    CHECK ((status = 'TERMINAL_UNRESOLVABLE') = (terminal_at IS NOT NULL)
           AND ((terminal_at IS NULL) = (terminal_reason IS NULL))
           AND (terminal_reason IS NULL OR terminal_reason IN ('HORIZON_EXCEEDED', 'NO_TOKEN_HASH')))
);

COMMENT ON TABLE public.miplan_optin_ci_reconciliation IS
  'Operational (mutable, guarded) CI reconciliation of opt-in events ingested without CI. Not part of the immutable copy. '
  'TERMINAL_UNRESOLVABLE rows stay visible forever and never feed bags.';

CREATE INDEX IF NOT EXISTS idx_miplan_optin_ci_recon_pending
  ON public.miplan_optin_ci_reconciliation (first_unresolved_at, event_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_miplan_optin_ci_recon_resolved_ci
  ON public.miplan_optin_ci_reconciliation (resolved_ci) WHERE status = 'RESOLVED';

-- Allowed transitions only (applies to service_role too).
CREATE OR REPLACE FUNCTION public.miplan_optin_ci_reconciliation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation rows are never deleted (% forbidden)', TG_OP USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.resolution_attempt_count <> 1
       OR NEW.last_resolution_attempt_at <> NEW.first_unresolved_at THEN
      RAISE EXCEPTION 'miplan_optin_ci_reconciliation: rows start PENDING with one attempt' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.miplan_debt_optin_events e
      WHERE e.event_id = NEW.event_id AND e.ci_resolution = 'unresolvable'
    ) THEN
      RAISE EXCEPTION 'miplan_optin_ci_reconciliation: only for events ingested without CI' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: % is final', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.handoff_token_hash IS DISTINCT FROM OLD.handoff_token_hash
     OR NEW.first_unresolved_at IS DISTINCT FROM OLD.first_unresolved_at
     OR NEW.horizon_seconds IS DISTINCT FROM OLD.horizon_seconds THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: identity / horizon fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.resolution_attempt_count <> OLD.resolution_attempt_count + 1
     OR NEW.last_resolution_attempt_at < OLD.last_resolution_attempt_at THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: every update is exactly one later attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM public.miplan_handoff_tokens t
    WHERE t.id = NEW.resolved_handoff_token_id AND t.token_hash = OLD.handoff_token_hash
      AND t.status = 'consumed' AND t.ci = NEW.resolved_ci
  ) THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: resolved CI not backed by the consumed handoff token' USING ERRCODE = '23514';
  END IF;
  IF NEW.terminal_reason = 'HORIZON_EXCEEDED'
     AND NEW.terminal_at < OLD.first_unresolved_at + make_interval(secs => OLD.horizon_seconds) THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: horizon not reached' USING ERRCODE = '23514';
  END IF;
  IF NEW.terminal_reason = 'NO_TOKEN_HASH' AND OLD.handoff_token_hash IS NOT NULL THEN
    RAISE EXCEPTION 'miplan_optin_ci_reconciliation: NO_TOKEN_HASH requires a missing hash' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_miplan_optin_ci_recon_guard ON public.miplan_optin_ci_reconciliation;
CREATE TRIGGER trg_miplan_optin_ci_recon_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.miplan_optin_ci_reconciliation
  FOR EACH ROW EXECUTE FUNCTION public.miplan_optin_ci_reconciliation_guard();
DROP TRIGGER IF EXISTS trg_miplan_optin_ci_recon_no_truncate ON public.miplan_optin_ci_reconciliation;
CREATE TRIGGER trg_miplan_optin_ci_recon_no_truncate
  BEFORE TRUNCATE ON public.miplan_optin_ci_reconciliation
  FOR EACH STATEMENT EXECUTE FUNCTION public.miplan_optin_ci_reconciliation_guard();

-- ---------------------------------------------------------------------------
-- F. Atomic, idempotent ingest (service_role only).
--    New event → event + debts in one transaction. Same event_id again → no-op ("already_ingested"),
--    never rewrites the stored snapshot; a replay whose core fields differ fails (source inconsistency).
--    The DB re-checks: CI from a consumed token, deterministic debt ids, creditor resolution
--    against the current miplan_declared aliases (no bcu aliases, no re-interpretation).
--    Event without CI → also its PENDING reconciliation row, same transaction (the caller may ACK
--    Mi Plan as soon as this returns). event.handoff_token_hash / ci_unresolved_reason are sent
--    ONLY for events without CI, as inputs for that row; they are not stored on the immutable event.
--    Replay comparison covers Mi Plan fields only, so a replay after a later CI resolution is a no-op.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ingest_miplan_debt_optin_event(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event jsonb;
  v_debts jsonb;
  v_event_id uuid;
  v_journey_id uuid;
  v_seq integer;
  v_state text;
  v_snapshot uuid;
  v_created timestamptz;
  v_ci bigint;
  v_ci_resolution text;
  v_token uuid;
  v_token_hash text;
  v_reason text;
  v_existing public.miplan_debt_optin_events%ROWTYPE;
  v_rows integer;
  v_bad integer;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: payload' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'payload_version' IS DISTINCT FROM 'miplan_debt_optin_export_v1' THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: payload_version' USING ERRCODE = '22023';
  END IF;
  v_event := p_payload->'event';
  v_debts := coalesce(p_payload->'debts', '[]'::jsonb);
  IF jsonb_typeof(v_event) IS DISTINCT FROM 'object' OR jsonb_typeof(v_debts) <> 'array' THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: shape' USING ERRCODE = '22023';
  END IF;

  v_event_id := (v_event->>'event_id')::uuid;
  v_journey_id := (v_event->>'journey_id')::uuid;
  v_seq := (v_event->>'seq')::integer;
  v_state := v_event->>'state';
  v_snapshot := (v_event->>'snapshot_diagnosis_id')::uuid;
  v_created := (v_event->>'miplan_created_at')::timestamptz;
  v_ci := (v_event->>'ci')::bigint;
  v_ci_resolution := v_event->>'ci_resolution';
  v_token := (v_event->>'handoff_token_id')::uuid;
  v_token_hash := v_event->>'handoff_token_hash';
  v_reason := v_event->>'ci_unresolved_reason';

  IF v_state = 'withdrawn' AND jsonb_array_length(v_debts) > 0 THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: withdrawn event with debts' USING ERRCODE = '22023';
  END IF;

  IF v_token_hash IS NOT NULL AND v_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: handoff_token_hash' USING ERRCODE = '22023';
  END IF;
  IF v_ci_resolution = 'resolved' AND (v_reason IS NOT NULL OR v_token_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: resolved event carries reconciliation inputs' USING ERRCODE = '22023';
  END IF;
  IF v_ci_resolution = 'unresolvable' AND (
       v_reason IS NULL
       OR v_reason NOT IN ('NO_TOKEN_HASH', 'TOKEN_NOT_FOUND', 'TOKEN_NOT_CONSUMED', 'TOKEN_WITHOUT_CI')
       OR (v_token_hash IS NULL) <> (v_reason = 'NO_TOKEN_HASH')) THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: ci_unresolved_reason' USING ERRCODE = '22023';
  END IF;

  IF v_ci_resolution = 'resolved' AND NOT EXISTS (
    SELECT 1 FROM public.miplan_handoff_tokens t
    WHERE t.id = v_token AND t.status = 'consumed' AND t.ci = v_ci
  ) THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: ci not backed by a consumed handoff token' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.miplan_debt_optin_events (
    event_id, journey_id, seq, state, scope, contract_version, source, consent_text_version,
    origin_evaluation_id, origin_diagnosis_id, snapshot_diagnosis_id, miplan_created_at,
    excluded_count, handoff_token_id, ci, ci_resolution, payload_version
  ) VALUES (
    v_event_id, v_journey_id, v_seq, v_state, v_event->>'scope', v_event->>'contract_version',
    v_event->>'source', v_event->>'consent_text_version',
    (v_event->>'origin_evaluation_id')::uuid, (v_event->>'origin_diagnosis_id')::uuid, v_snapshot, v_created,
    (v_event->>'excluded_count')::integer, v_token, v_ci, v_ci_resolution, p_payload->>'payload_version'
  )
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    SELECT * INTO v_existing FROM public.miplan_debt_optin_events e WHERE e.event_id = v_event_id;
    IF v_existing.journey_id IS DISTINCT FROM v_journey_id
       OR v_existing.seq IS DISTINCT FROM v_seq
       OR v_existing.state IS DISTINCT FROM v_state
       OR v_existing.snapshot_diagnosis_id IS DISTINCT FROM v_snapshot
       OR v_existing.miplan_created_at IS DISTINCT FROM v_created THEN
      RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_CONFLICT: event % replayed with different core fields', v_event_id
        USING ERRCODE = '23505';
    END IF;
    IF v_existing.ci_resolution = 'unresolvable' AND v_reason IS NOT NULL THEN
      INSERT INTO public.miplan_optin_ci_reconciliation (
        event_id, handoff_token_hash, status, last_unresolved_reason, first_unresolved_at,
        last_resolution_attempt_at, resolution_attempt_count, horizon_seconds
      ) VALUES (v_event_id, v_token_hash, 'PENDING', v_reason, now(), now(), 1, 604800)
      ON CONFLICT (event_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('status', 'already_ingested', 'event_id', v_event_id, 'debts_inserted', 0);
  END IF;

  IF v_ci_resolution = 'unresolvable' THEN
    -- Horizon 7 days (604800 s): stored per row so a policy change never moves existing horizons.
    INSERT INTO public.miplan_optin_ci_reconciliation (
      event_id, handoff_token_hash, status, last_unresolved_reason, first_unresolved_at,
      last_resolution_attempt_at, resolution_attempt_count, horizon_seconds
    ) VALUES (v_event_id, v_token_hash, 'PENDING', v_reason, now(), now(), 1, 604800);
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_debts) d
    WHERE (d->>'declared_debt_id')::uuid IS DISTINCT FROM extensions.uuid_generate_v5(
      '11fda672-dde3-4d71-bb76-1ad75ae30764'::uuid, v_event_id::text || ':' || ((d->>'position')::integer)::text
    )
  ) THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: declared_debt_id is not uuidv5(event_id:position)' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.miplan_declared_debts (
    declared_debt_id, optin_event_id, ci, snapshot_diagnosis_id, position, client_debt_id, tipo,
    creditor_raw, miplan_acreedor_display, miplan_acreedor_normalizado, creditor_normalized_key,
    creditor_key_version, ingestion_resolution, ingestion_creditor_id, ingestion_alias_id,
    monto, monto_raw, pago, pago_raw, pago_mensual_actual, pago_mensual_actual_raw,
    situacion_ui, estado, atraso_tiempo, atraso_tiempo_aprox,
    ultimo_pago_declarado, ultimo_pago_declarado_raw, debt_confidence
  )
  SELECT
    (d->>'declared_debt_id')::uuid, v_event_id, v_ci, v_snapshot, (d->>'position')::integer,
    d->>'client_debt_id', d->>'tipo', d->>'creditor_raw', d->>'miplan_acreedor_display',
    d->>'miplan_acreedor_normalizado', d->>'creditor_normalized_key', d->>'creditor_key_version',
    d->>'ingestion_resolution', (d->>'ingestion_creditor_id')::uuid, (d->>'ingestion_alias_id')::uuid,
    (d->>'monto')::numeric, d->>'monto_raw', (d->>'pago')::numeric, d->>'pago_raw',
    (d->>'pago_mensual_actual')::numeric, d->>'pago_mensual_actual_raw',
    d->>'situacion_ui', d->>'estado', d->>'atraso_tiempo', d->>'atraso_tiempo_aprox',
    (d->>'ultimo_pago_declarado')::numeric, d->>'ultimo_pago_declarado_raw', d->>'debt_confidence'
  FROM jsonb_array_elements(v_debts) d
  ON CONFLICT (declared_debt_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> jsonb_array_length(v_debts) THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_INVALID: duplicate debts in payload' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.miplan_declared_debts x
  LEFT JOIN public.creditor_aliases a ON a.id = x.ingestion_alias_id
  LEFT JOIN public.creditors c ON c.creditor_id = a.creditor_id
  WHERE x.optin_event_id = v_event_id
    AND NOT coalesce(CASE x.ingestion_resolution
      WHEN 'EMPTY' THEN x.creditor_normalized_key IS NULL
      WHEN 'UNKNOWN' THEN NOT EXISTS (
        SELECT 1 FROM public.creditor_aliases a2
        WHERE a2.source = 'miplan_declared' AND a2.normalized_key = x.creditor_normalized_key
          AND a2.status IN ('approved', 'ambiguous'))
      WHEN 'UNKNOWN_REVIEWED' THEN
        a.source = 'miplan_declared' AND a.status = 'ambiguous' AND a.normalized_key = x.creditor_normalized_key
      WHEN 'RESOLVED' THEN
        a.source = 'miplan_declared' AND a.status = 'approved' AND a.normalized_key = x.creditor_normalized_key
        AND x.ingestion_creditor_id = CASE WHEN c.status = 'merged' THEN c.merged_into_creditor_id ELSE c.creditor_id END
      ELSE false
    END, false);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_INGEST_RESOLUTION_MISMATCH: % debts' , v_bad USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('status', 'inserted', 'event_id', v_event_id, 'debts_inserted', v_rows);
END;
$$;

-- ---------------------------------------------------------------------------
-- G. CI reconciliation pass (service_role only). One attempt per PENDING row (oldest first):
--    consumed token with CI > 0 → RESOLVED; no hash → TERMINAL (NO_TOKEN_HASH);
--    otherwise TERMINAL (HORIZON_EXCEEDED) once p_now >= first_unresolved_at + horizon, else
--    stays PENDING with the attempt recorded. p_now NULL → now(); tests inject a fixed clock.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_miplan_optin_ci(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  r public.miplan_optin_ci_reconciliation%ROWTYPE;
  v_tok_id uuid;
  v_tok_status text;
  v_tok_ci bigint;
  v_found boolean;
  v_reason text;
  v_at timestamptz;
  v_attempted integer := 0;
  v_resolved integer := 0;
  v_terminal integer := 0;
  v_pending integer := 0;
  v_new_terminal jsonb := '[]'::jsonb;
  v_new_resolved jsonb := '[]'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'MIPLAN_OPTIN_RECONCILE_INVALID: limit' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT * FROM public.miplan_optin_ci_reconciliation c
    WHERE c.status = 'PENDING'
    ORDER BY c.first_unresolved_at, c.event_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_attempted := v_attempted + 1;
    v_at := greatest(v_now, r.last_resolution_attempt_at);

    IF r.handoff_token_hash IS NULL THEN
      UPDATE public.miplan_optin_ci_reconciliation
      SET status = 'TERMINAL_UNRESOLVABLE', terminal_reason = 'NO_TOKEN_HASH', terminal_at = v_at,
          last_unresolved_reason = 'NO_TOKEN_HASH', last_resolution_attempt_at = v_at,
          resolution_attempt_count = r.resolution_attempt_count + 1
      WHERE event_id = r.event_id;
      v_terminal := v_terminal + 1;
      v_new_terminal := v_new_terminal || jsonb_build_object('event_id', r.event_id, 'terminal_reason', 'NO_TOKEN_HASH');
      CONTINUE;
    END IF;

    SELECT t.id, t.status, t.ci INTO v_tok_id, v_tok_status, v_tok_ci
    FROM public.miplan_handoff_tokens t
    WHERE t.token_hash = r.handoff_token_hash;
    v_found := FOUND;

    IF v_found AND v_tok_status = 'consumed' AND v_tok_ci IS NOT NULL AND v_tok_ci > 0 THEN
      UPDATE public.miplan_optin_ci_reconciliation
      SET status = 'RESOLVED', resolved_ci = v_tok_ci, resolved_handoff_token_id = v_tok_id, resolved_at = v_at,
          last_resolution_attempt_at = v_at, resolution_attempt_count = r.resolution_attempt_count + 1
      WHERE event_id = r.event_id;
      v_resolved := v_resolved + 1;
      v_new_resolved := v_new_resolved || jsonb_build_object('event_id', r.event_id);
      CONTINUE;
    END IF;

    v_reason := CASE
      WHEN NOT v_found THEN 'TOKEN_NOT_FOUND'
      WHEN v_tok_status <> 'consumed' THEN 'TOKEN_NOT_CONSUMED'
      ELSE 'TOKEN_WITHOUT_CI'
    END;

    IF v_now >= r.first_unresolved_at + make_interval(secs => r.horizon_seconds) THEN
      UPDATE public.miplan_optin_ci_reconciliation
      SET status = 'TERMINAL_UNRESOLVABLE', terminal_reason = 'HORIZON_EXCEEDED', terminal_at = v_at,
          last_unresolved_reason = v_reason, last_resolution_attempt_at = v_at,
          resolution_attempt_count = r.resolution_attempt_count + 1
      WHERE event_id = r.event_id;
      v_terminal := v_terminal + 1;
      v_new_terminal := v_new_terminal || jsonb_build_object('event_id', r.event_id, 'terminal_reason', 'HORIZON_EXCEEDED');
    ELSE
      UPDATE public.miplan_optin_ci_reconciliation
      SET last_unresolved_reason = v_reason, last_resolution_attempt_at = v_at,
          resolution_attempt_count = r.resolution_attempt_count + 1
      WHERE event_id = r.event_id;
      v_pending := v_pending + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'attempted', v_attempted,
    'resolved', v_resolved,
    'terminal', v_terminal,
    'still_pending', v_pending,
    'pending_total', (SELECT count(*) FROM public.miplan_optin_ci_reconciliation WHERE status = 'PENDING'),
    'terminal_total', (SELECT count(*) FROM public.miplan_optin_ci_reconciliation WHERE status = 'TERMINAL_UNRESOLVABLE'),
    'newly_resolved', v_new_resolved,
    'newly_terminal', v_new_terminal
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- H. Access: backend (service_role) only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.miplan_debt_optin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.miplan_declared_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.miplan_optin_ci_reconciliation ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.miplan_debt_optin_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.miplan_declared_debts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.miplan_optin_ci_reconciliation FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.ingest_miplan_debt_optin_event(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_miplan_debt_optin_event(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_miplan_optin_ci(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_miplan_optin_ci(timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public.miplan_optin_copy_forbid_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.miplan_declared_debts_guard_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.miplan_optin_ci_reconciliation_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
