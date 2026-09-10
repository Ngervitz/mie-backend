'use strict';

/**
 * OpenAI strict json_schema for bcu_v1 (ported from Stage 0 spike).
 * Keep in sync with bcuExtractContract / Stage 1 validators.
 */

const MONEY_PAIR = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['mn', 'me'],
  properties: {
    mn: { type: ['number', 'null'] },
    me: { type: ['number', 'null'] },
  },
});

const RUBROS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'vigente',
    'vigente_no_autoliquidable',
    'colocacion_vencida',
    'moroso',
    'castigado_por_atraso',
    'contingencias',
    'creditos_reestructurados',
  ],
  properties: {
    vigente: MONEY_PAIR,
    vigente_no_autoliquidable: MONEY_PAIR,
    colocacion_vencida: MONEY_PAIR,
    moroso: MONEY_PAIR,
    castigado_por_atraso: MONEY_PAIR,
    contingencias: MONEY_PAIR,
    creditos_reestructurados: MONEY_PAIR,
  },
});

const BCU_V1_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'extraction_contract_version',
    'currency_view_selected',
    'period',
    'document_ci_raw',
    'institutions',
    'summary',
    'review',
  ],
  properties: {
    extraction_contract_version: {
      type: 'string',
      enum: ['bcu_v1'],
    },
    currency_view_selected: {
      type: 'string',
      enum: [
        'MN_PESOS_ME_PESOS',
        'MN_PESOS_ME_USD',
        'MN_USD_ME_USD',
        'UNKNOWN',
      ],
    },
    period: { type: ['string', 'null'] },
    document_ci_raw: { type: ['string', 'null'] },
    institutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'institution_name_raw',
          'category',
          'vigente',
          'vigente_no_autoliquidable',
          'colocacion_vencida',
          'moroso',
          'castigado_por_atraso',
          'contingencias',
          'creditos_reestructurados',
        ],
        properties: {
          institution_name_raw: { type: 'string' },
          category: {
            type: ['string', 'null'],
            enum: ['1C', '2A', '2B', '3', '4', '5', null],
          },
          vigente: MONEY_PAIR,
          vigente_no_autoliquidable: MONEY_PAIR,
          colocacion_vencida: MONEY_PAIR,
          moroso: MONEY_PAIR,
          castigado_por_atraso: MONEY_PAIR,
          contingencias: MONEY_PAIR,
          creditos_reestructurados: MONEY_PAIR,
        },
      },
    },
    summary: RUBROS,
    review: {
      type: 'object',
      additionalProperties: false,
      required: ['warnings', 'illegible_fields'],
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
        illegible_fields: { type: 'array', items: { type: 'string' } },
      },
    },
  },
});

module.exports = {
  BCU_V1_JSON_SCHEMA,
  MONEY_PAIR,
  RUBROS,
};
