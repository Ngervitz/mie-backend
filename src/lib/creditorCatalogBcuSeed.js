'use strict';

/**
 * Mi Deuda — BCU seed for the canonical creditor catalog (Stage 1).
 *
 * Mirrors migrations/20261006_mi_deuda_creditor_catalog.sql row for row
 * (scripts/unit-creditor-catalog.js enforces it). Derived from the legacy
 * APPROVED_RAW_TO_CANONICAL map: one creditor per legacy canonical, one bcu alias per
 * distinct creditor_key_v1 of the legacy raw names.
 *
 * IDs are UUIDv5(SEED_UUID_NAMESPACE, 'creditor:<slug>' | 'creditor_alias:bcu:<key>').
 * display_name equals the legacy canonical string exactly.
 */

const SEED_UUID_NAMESPACE = '5b0c6f2e-9a41-4d1e-8c3b-2f7a6e1d9c40';

const CREDITOR_SEED = Object.freeze([
  { creditor_id: '163e0226-599e-5bc2-8553-151379f66537', slug: 'cash', display_name: 'CASH S.A.' },
  { creditor_id: 'c541d904-9aae-5da3-b199-c2107d1dddb8', slug: 'socur', display_name: 'SOCUR S.A.' },
  {
    creditor_id: '0039dcbe-0af2-5a2d-a025-3a94e072ed95',
    slug: 'banco-santander',
    display_name: 'Banco Santander S.A.',
  },
  { creditor_id: '6a126a47-8b2a-5872-9a2c-527d0891b855', slug: 'oca', display_name: 'OCA S.A.' },
  { creditor_id: '8d631ae7-c2f7-5844-b500-c87f01b38aae', slug: 'retop', display_name: 'RETOP S.A.' },
  { creditor_id: '703c88c1-c296-5a10-86b1-9033b1b16044', slug: 'bautzen', display_name: 'BAUTZEN S.A.' },
  {
    creditor_id: 'f7301263-de28-5ba4-8cfe-c3af02ea9982',
    slug: 'scotiabank-uruguay',
    display_name: 'Scotiabank Uruguay S.A.',
  },
  { creditor_id: 'c6b6f643-a76e-59d3-8a8d-df833365c63f', slug: 'floder', display_name: 'Floder S.A.' },
  {
    creditor_id: 'aba4810d-3f3c-5e3a-8507-192b7d9a8cd5',
    slug: 'pass-card',
    display_name: 'PASS CARD S.A.',
  },
  { creditor_id: '9d17be3d-44b8-5689-b2db-7476254cb8fa', slug: 'anda', display_name: 'ANDA' },
  {
    creditor_id: 'c4f5b28b-a68b-535e-9b1a-4844b0120569',
    slug: 'bbva-uruguay',
    display_name: 'Banco Bilbao Vizcaya Argentaria Uruguay S.A.',
  },
  {
    creditor_id: '37ed5be1-7640-5b3d-863b-22931f35b81b',
    slug: 'fucac-verde',
    display_name: 'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO',
  },
  {
    creditor_id: '485edd12-a6ca-591b-a869-7c3f0faaedca',
    slug: 'fucerep',
    display_name: 'Cooperativa de Ahorro y Crédito FUCEREP',
  },
  {
    creditor_id: '2153c7f3-0193-5a03-9055-c37ed08c4ca6',
    slug: 'brou',
    display_name: 'Banco de la República Oriental del Uruguay',
  },
  {
    creditor_id: 'd9269f73-7e34-5ed5-b600-452763fec8c0',
    slug: 'administradora-soluciones-integrales',
    display_name: 'Administradora de Soluciones Integrales S.A.',
  },
  {
    creditor_id: '23e32bcd-6d59-560f-8bca-e8d17bfe6f8c',
    slug: 'banco-itau-uruguay',
    display_name: 'Banco Itaú Uruguay S.A.',
  },
]);

/** `raws` = every legacy raw name collapsing to this key (first one is example_raw). */
const BCU_ALIAS_SEED = Object.freeze([
  { id: 'fbab7b75-407a-5bc3-a1f2-0e51dcb8d7e9', normalized_key: 'cash sa', creditor_slug: 'cash', raws: ['CASH S.A.'] },
  { id: 'ee701800-92e3-5f96-b93c-3c96244ef24f', normalized_key: 'socur sa', creditor_slug: 'socur', raws: ['SOCUR S.A.'] },
  {
    id: '25c150e1-eb95-5805-9dfe-3f7284607361',
    normalized_key: 'banco santander sa',
    creditor_slug: 'banco-santander',
    raws: ['Banco Santander S.A.'],
  },
  { id: '619179c2-2894-532b-8cfa-12312c132443', normalized_key: 'oca sa', creditor_slug: 'oca', raws: ['OCA S.A.'] },
  { id: '92c67cc1-a026-59e9-b95c-7335fbc4dba3', normalized_key: 'retop sa', creditor_slug: 'retop', raws: ['RETOP S.A.'] },
  {
    id: '0b6a87bc-bf7e-5ce9-b4d2-005917f572c8',
    normalized_key: 'bautzen sa',
    creditor_slug: 'bautzen',
    raws: ['BAUTZEN S.A.'],
  },
  {
    id: '09fd3b8b-b54d-52ff-b1db-207cdac29390',
    normalized_key: 'scotiabank uruguay sa',
    creditor_slug: 'scotiabank-uruguay',
    raws: ['Scotiabank Uruguay S.A.'],
  },
  { id: 'eb598c8d-7abb-5a49-b3e8-c83616cce9f8', normalized_key: 'floder sa', creditor_slug: 'floder', raws: ['Floder S.A.'] },
  {
    id: 'feeb1735-ad4d-5a61-bb5c-00616fffec5d',
    normalized_key: 'pass card sa',
    creditor_slug: 'pass-card',
    raws: ['PASS CARD S.A.'],
  },
  { id: 'b5afbc4a-e3a0-5981-948b-219a53d0b28b', normalized_key: 'anda', creditor_slug: 'anda', raws: ['ANDA'] },
  {
    id: '8e48a9af-d785-5d13-bf5b-d12c71cf1d93',
    normalized_key: 'banco bilbao vizcaya argentaria uruguay sa',
    creditor_slug: 'bbva-uruguay',
    raws: ['Banco Bilbao Vizcaya Argentaria Uruguay S.A.'],
  },
  {
    id: '9840787c-c903-561c-8497-8bbe51ff5cbc',
    normalized_key: 'fucac verde cooperativa de ahorro y credito',
    creditor_slug: 'fucac-verde',
    raws: ['FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO'],
  },
  {
    id: '8ae764de-d491-5cb4-a535-d9d359670445',
    normalized_key: 'cooperativa de ahorro y credito fucerep',
    creditor_slug: 'fucerep',
    raws: ['Cooperativa de Ahorro y Crédito FUCEREP'],
  },
  {
    id: '9c62ecd6-b9d0-5482-a600-f750b2759114',
    normalized_key: 'banco de la republica oriental del uruguay',
    creditor_slug: 'brou',
    raws: [
      'Banco de la República Oriental del Uruguay',
      'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY',
    ],
  },
  {
    id: 'bfbabae8-7390-5998-a09e-a2980bcedee2',
    normalized_key: 'administradora de soluciones integrales sa',
    creditor_slug: 'administradora-soluciones-integrales',
    raws: [
      'Administradora de Soluciones Integrales S.A.',
      'ADMINISTRADORA DE SOLUCIONES INTEGRALES S.A.',
    ],
  },
  {
    id: '90c30089-14cc-5aa6-b6f8-a15b906756b2',
    normalized_key: 'banco itau uruguay sa',
    creditor_slug: 'banco-itau-uruguay',
    raws: ['Banco Itaú Uruguay SA'],
  },
]);

/** Catalog rows shaped like the DB tables after the migration's seed ran. */
function seedCatalogRows() {
  const idBySlug = new Map(
    CREDITOR_SEED.map(function (c) {
      return [c.slug, c.creditor_id];
    }),
  );
  return {
    creditors: CREDITOR_SEED.map(function (c) {
      return {
        creditor_id: c.creditor_id,
        slug: c.slug,
        display_name: c.display_name,
        status: 'active',
        merged_into_creditor_id: null,
      };
    }),
    aliases: BCU_ALIAS_SEED.map(function (a) {
      return {
        id: a.id,
        source: 'bcu',
        normalized_key: a.normalized_key,
        creditor_id: idBySlug.get(a.creditor_slug),
        status: 'approved',
        example_raw: a.raws[0],
      };
    }),
  };
}

module.exports = {
  SEED_UUID_NAMESPACE,
  CREDITOR_SEED,
  BCU_ALIAS_SEED,
  seedCatalogRows,
};
