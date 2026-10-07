'use strict';

/**
 * Mi Deuda Stage 2 — `miplan_declared` seed for the canonical creditor catalog.
 *
 * Human-reviewed (2026-10-06) from the read-only proposal of Mi Plan CREDITOR_DICT
 * (scripts/propose-miplan-declared-aliases-ro.js). Mirrors
 * migrations/20261006_mi_deuda_miplan_declared_debts.sql row for row
 * (scripts/unit-creditor-catalog-miplan-seed.js enforces it).
 *
 * New creditors use a neutral commercial display_name (no unsupported legal denomination).
 * Ambiguous aliases record "reviewed, never auto-resolve" (creditor_id NULL).
 * Reviewed-UNSAFE keys are deliberately absent (they arrive as UNKNOWN).
 *
 * IDs are UUIDv5(SEED_UUID_NAMESPACE, 'creditor:<slug>' | 'creditor_alias:miplan_declared:<key>').
 */

const { SEED_UUID_NAMESPACE, seedCatalogRows } = require('./creditorCatalogBcuSeed');

const MIPLAN_CREDITOR_SEED = Object.freeze([
  { creditor_id: '89311a19-c966-5a9e-818e-87c9149bd049', slug: 'ute', display_name: 'UTE' },
  { creditor_id: '28c03a55-d4fe-5996-983c-3d6cb04fc5b0', slug: 'ose', display_name: 'OSE' },
  { creditor_id: '851f0ee8-ba61-5088-a2ed-28e81c3f9330', slug: 'antel', display_name: 'ANTEL' },
  { creditor_id: '0e50ca6f-85a3-5455-88cf-d88b5e530f13', slug: 'movistar', display_name: 'Movistar' },
  { creditor_id: 'fb9dba7a-7d4c-5c53-9002-3545fc066af9', slug: 'claro', display_name: 'Claro' },
  { creditor_id: '701847fd-5514-58f7-a39d-8c5a435e0e2f', slug: 'bse', display_name: 'BSE' },
  { creditor_id: 'ddfd4e1e-f9de-54c2-b7bb-d1578c60b56f', slug: 'caja-notarial', display_name: 'Caja Notarial' },
  { creditor_id: '73d66738-81dc-5d1a-83ac-49e86e1b3aad', slug: 'bhu', display_name: 'BHU' },
  { creditor_id: '1b99ccf3-8349-5649-8b43-4cbf281a567c', slug: 'creditel', display_name: 'Creditel' },
  { creditor_id: '0d2ed2d7-4db0-5d0d-bd41-24a431f4b716', slug: 'pronto', display_name: 'Pronto' },
  { creditor_id: '860ecab9-2f51-52f0-bf75-25de198be758', slug: 'divino', display_name: 'Divino' },
  { creditor_id: '83f339cc-f353-5a10-a301-0fbe6fa91d44', slug: 'motociclo', display_name: 'Motociclo' },
  { creditor_id: '33ba6704-7fc1-5908-9995-826d75db3fd7', slug: 'multi-ahorro', display_name: 'Multi Ahorro' },
]);

/** status 'approved' → creditor_slug (Stage 1 or MIPLAN_CREDITOR_SEED); 'ambiguous' → no creditor. */
const MIPLAN_DECLARED_ALIAS_SEED = Object.freeze([
  { id: '0b4233d2-ad7c-5ab8-98d9-8256a735d236', normalized_key: 'brou', status: 'approved', creditor_slug: 'brou' },
  { id: '9b698887-074e-5b15-ac15-3df2ee813abe', normalized_key: 'banco republica', status: 'approved', creditor_slug: 'brou' },
  { id: '0ae9dee2-5d83-5839-a513-ea9164522a54', normalized_key: 'banco de la republica', status: 'approved', creditor_slug: 'brou' },
  { id: '4ccd266f-7f0e-5270-b97b-fd3e849afe90', normalized_key: 'banco de la republica oriental del uruguay', status: 'approved', creditor_slug: 'brou' },
  { id: 'c2614b1e-a9a7-5a38-93f7-76d6f1744a2f', normalized_key: 'itau', status: 'approved', creditor_slug: 'banco-itau-uruguay' },
  { id: 'a1b14e97-5a94-5e14-a8d5-176c2b482ae3', normalized_key: 'banco itau', status: 'approved', creditor_slug: 'banco-itau-uruguay' },
  { id: '051ee864-8700-5d22-9e1b-d3bf61a8064c', normalized_key: 'itau banco', status: 'approved', creditor_slug: 'banco-itau-uruguay' },
  { id: 'e1891af2-76aa-5bdb-bda8-fa7b6569b8a0', normalized_key: 'santander', status: 'approved', creditor_slug: 'banco-santander' },
  { id: '45536d0e-768e-5e46-b316-5c806c966e1a', normalized_key: 'banco santander', status: 'approved', creditor_slug: 'banco-santander' },
  { id: 'ff4c1d63-6d0c-54da-9758-b8c934d8b0bb', normalized_key: 'scotiabank', status: 'approved', creditor_slug: 'scotiabank-uruguay' },
  { id: '098a8208-64ee-5d17-a993-3cdae32cf448', normalized_key: 'scotia', status: 'approved', creditor_slug: 'scotiabank-uruguay' },
  { id: '1a9402b9-4594-5f02-9a0c-48a42d26e331', normalized_key: 'bbva', status: 'approved', creditor_slug: 'bbva-uruguay' },
  { id: '7137e5b6-93b8-5b78-925c-01c3d97a2772', normalized_key: 'oca', status: 'approved', creditor_slug: 'oca' },
  { id: '1f068c3e-ebcd-5620-9d06-1e5ed6c4f706', normalized_key: 'tarjeta oca', status: 'approved', creditor_slug: 'oca' },
  { id: 'b4bc32a3-a4d1-5741-963e-3efaf59a8391', normalized_key: 'oca tarjeta', status: 'approved', creditor_slug: 'oca' },
  { id: '409d8cde-54f0-55e3-9712-91e28d48d491', normalized_key: 'anda', status: 'approved', creditor_slug: 'anda' },
  { id: 'c67fc70c-2af7-53e8-90e4-7ea3da9832a8', normalized_key: 'anda prestamo', status: 'approved', creditor_slug: 'anda' },
  { id: '4685a7f2-ba7b-59ae-a589-be30cc4c1299', normalized_key: 'fucerep', status: 'approved', creditor_slug: 'fucerep' },
  { id: 'f0114e4b-552d-5e4b-a4d6-ed69fc11faa9', normalized_key: 'pass card', status: 'approved', creditor_slug: 'pass-card' },
  { id: '53b16f1a-66dd-5995-98ec-87a32627a95e', normalized_key: 'passcard', status: 'approved', creditor_slug: 'pass-card' },
  { id: 'ae6f775d-ae42-5071-9170-71468a92f53f', normalized_key: 'ute', status: 'approved', creditor_slug: 'ute' },
  { id: '1984075d-98a9-5ab9-9145-3289afc6d9f8', normalized_key: 'ose', status: 'approved', creditor_slug: 'ose' },
  { id: '3bb5ddf3-56bf-5245-83d4-2bd6e9468a70', normalized_key: 'antel', status: 'approved', creditor_slug: 'antel' },
  { id: '21039abe-8b70-5fd3-a45a-2b7b306c7aa1', normalized_key: 'movistar', status: 'approved', creditor_slug: 'movistar' },
  { id: 'a460d4f6-1be8-5574-992e-9fa0527d9a0e', normalized_key: 'claro', status: 'approved', creditor_slug: 'claro' },
  { id: '5f80c75f-b615-555c-a969-5a50da58d5fd', normalized_key: 'bse', status: 'approved', creditor_slug: 'bse' },
  { id: '5a067348-241f-5b88-b8bc-91777cbad473', normalized_key: 'caja notarial', status: 'approved', creditor_slug: 'caja-notarial' },
  { id: '874506ac-bb94-5844-ba6f-0bc2f5951c3e', normalized_key: 'bhu', status: 'approved', creditor_slug: 'bhu' },
  { id: 'baceab7e-e216-57e4-9e90-656720ed6984', normalized_key: 'banco hipotecario', status: 'approved', creditor_slug: 'bhu' },
  { id: '5d2024f7-3af7-5d21-994c-9396351bd2b4', normalized_key: 'creditel', status: 'approved', creditor_slug: 'creditel' },
  { id: 'ecd73e75-fa7c-5291-aa9f-76dbacf57bd8', normalized_key: 'pronto', status: 'approved', creditor_slug: 'pronto' },
  { id: '41723f6d-3201-56af-9f1a-3784b55bf986', normalized_key: 'divino', status: 'approved', creditor_slug: 'divino' },
  { id: 'be2cbb65-7969-5f7f-9947-c1e8e14d4a0a', normalized_key: 'motociclo', status: 'approved', creditor_slug: 'motociclo' },
  { id: '77ef9deb-56fb-5964-99bc-595d2433cb7a', normalized_key: 'multi ahorro', status: 'approved', creditor_slug: 'multi-ahorro' },
  { id: '1709b866-9b23-5396-b583-8db02325fd36', normalized_key: 'multiahorro', status: 'approved', creditor_slug: 'multi-ahorro' },
  { id: '1d564b59-cd51-5b28-ba38-2cd4438d1f0b', normalized_key: 'republica', status: 'ambiguous', creditor_slug: null },
  { id: '040adc1c-f2c6-51d0-9310-3399f750f7ea', normalized_key: 'visa', status: 'ambiguous', creditor_slug: null },
  { id: '4e05990f-9cf7-594c-8d82-b81816e3e108', normalized_key: 'visa uruguay', status: 'ambiguous', creditor_slug: null },
  { id: 'caede661-422b-5bad-81b4-2cca2251f68c', normalized_key: 'mastercard', status: 'ambiguous', creditor_slug: null },
  { id: '57b2027a-a21b-55c0-9a30-e83d1d07cc15', normalized_key: 'master', status: 'ambiguous', creditor_slug: null },
  { id: '64effede-881b-54f6-b041-30533c63f918', normalized_key: 'cash', status: 'ambiguous', creditor_slug: null },
  { id: '2bc00b46-8b6f-55bf-8a57-a0b0555519a1', normalized_key: 'pass', status: 'ambiguous', creditor_slug: null },
  { id: 'cbd0d1f8-5eaf-5fb4-b335-d2947039cb61', normalized_key: 'alfa', status: 'ambiguous', creditor_slug: null },
  { id: '9189ee49-7d28-56dc-b35f-cd0df645a4bd', normalized_key: 'uruguaya', status: 'ambiguous', creditor_slug: null },
  { id: 'ce5afde2-e03f-513b-a728-1e2f4bd5b735', normalized_key: 'notarial', status: 'ambiguous', creditor_slug: null },
  { id: 'c47f8f94-c60f-5318-b014-c6dce39efc22', normalized_key: 'abitab', status: 'ambiguous', creditor_slug: null },
  { id: '73f1e85a-11eb-5a8a-809d-ac1413882aa8', normalized_key: 'redpagos', status: 'ambiguous', creditor_slug: null },
  { id: '283d7419-6575-5e2e-972e-0a2de6d05cc0', normalized_key: 'red pagos', status: 'ambiguous', creditor_slug: null },
  { id: 'ee221a0e-5e79-5a99-bbc4-cf03e3409021', normalized_key: 'familiar', status: 'ambiguous', creditor_slug: null },
  { id: 'a0d6f6e4-e4c2-53be-96ef-4e2a65126fb0', normalized_key: 'familia', status: 'ambiguous', creditor_slug: null },
  { id: '06f08660-e0f0-5223-bac0-1e148ce378fe', normalized_key: 'madre', status: 'ambiguous', creditor_slug: null },
  { id: 'f2008fe5-6462-54f3-9ff6-b1c7dd133b4e', normalized_key: 'padre', status: 'ambiguous', creditor_slug: null },
  { id: '6c939a28-fa4e-5f67-9f0a-2b70b41b05ae', normalized_key: 'hermano', status: 'ambiguous', creditor_slug: null },
  { id: '91280c4b-b190-52fe-9a3f-ea681277f044', normalized_key: 'hermana', status: 'ambiguous', creditor_slug: null },
  { id: 'b52a4594-3929-559a-92b6-6f36bd81670f', normalized_key: 'tio', status: 'ambiguous', creditor_slug: null },
  { id: '325be6d8-7596-5963-867b-935c1a31e5d8', normalized_key: 'tia', status: 'ambiguous', creditor_slug: null },
  { id: '462ef0d5-46e6-5269-8712-1e7310fc2a2f', normalized_key: 'abuelo', status: 'ambiguous', creditor_slug: null },
  { id: '927c2ab5-b291-5eed-b5c8-baa02552c1bb', normalized_key: 'abuela', status: 'ambiguous', creditor_slug: null },
  { id: '1f03177c-c46c-55b5-8e02-8fd6247bfa78', normalized_key: 'primo', status: 'ambiguous', creditor_slug: null },
  { id: 'ca02f72e-4d60-5256-9c23-e3c6e23dc38a', normalized_key: 'prima', status: 'ambiguous', creditor_slug: null },
  { id: '0e08539f-bf7c-5dda-bda5-869830a7fe2b', normalized_key: 'amigo', status: 'ambiguous', creditor_slug: null },
  { id: '9683ab47-bf7f-57e5-a440-fd61a4c82fdc', normalized_key: 'amiga', status: 'ambiguous', creditor_slug: null },
  { id: '128a9d83-2bf3-5afa-bfe0-d57d7ea4250f', normalized_key: 'prestamista', status: 'ambiguous', creditor_slug: null },
  { id: '6451f488-474c-5480-9e72-d8a80de508cd', normalized_key: 'particular', status: 'ambiguous', creditor_slug: null },
  { id: '979dbee3-e92a-5916-9b53-084f8260625e', normalized_key: 'persona', status: 'ambiguous', creditor_slug: null },
  { id: 'a4b072b9-cd7b-5f52-ba42-6adaf07e97c7', normalized_key: 'privado', status: 'ambiguous', creditor_slug: null },
]);

/** Reviewed-UNSAFE keys: must never appear in the seed (they stay UNKNOWN). */
const MIPLAN_DECLARED_EXCLUDED_KEYS = Object.freeze([
  'fucac', 'alfabrou', 'alfa brou', 'midinero', 'mi dinero', 'hsbc',
  'cofac', 'disse', 'prex', 'acac', 'coopace', 'la uruguaya',
]);

/** Stage 1 + Stage 2 catalog rows, shaped like the DB tables after both migrations. */
function fullSeedCatalogRows() {
  const base = seedCatalogRows();
  MIPLAN_CREDITOR_SEED.forEach(function (c) {
    base.creditors.push({
      creditor_id: c.creditor_id,
      slug: c.slug,
      display_name: c.display_name,
      status: 'active',
      merged_into_creditor_id: null,
    });
  });
  const idBySlug = new Map(
    base.creditors.map(function (c) {
      return [c.slug, c.creditor_id];
    }),
  );
  MIPLAN_DECLARED_ALIAS_SEED.forEach(function (a) {
    base.aliases.push({
      id: a.id,
      source: 'miplan_declared',
      normalized_key: a.normalized_key,
      creditor_id: a.status === 'approved' ? idBySlug.get(a.creditor_slug) : null,
      status: a.status,
      example_raw: a.normalized_key,
    });
  });
  return base;
}

module.exports = {
  SEED_UUID_NAMESPACE,
  MIPLAN_CREDITOR_SEED,
  MIPLAN_DECLARED_ALIAS_SEED,
  MIPLAN_DECLARED_EXCLUDED_KEYS,
  fullSeedCatalogRows,
};
