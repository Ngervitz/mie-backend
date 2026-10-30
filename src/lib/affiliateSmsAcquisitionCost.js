'use strict';

/**
 * Operational SMS cost of an invite lote.
 * Invitation counters stay on the invite campaign rows.
 * OTP and welcome SMS are cost only, and only when Notifyme status is DELIVERED.
 * Email is never included.
 */

function summarizeAcquisitionCost(inviteRows, relatedRows, unitCostExVat) {
  const inviteCis = new Set();
  (inviteRows || []).forEach(function (row) {
    if (row && row.czuid != null && String(row.czuid).trim() !== '') {
      inviteCis.add(String(row.czuid));
    }
  });

  const out = {
    otp_delivered: 0,
    otp_not_delivered: 0,
    welcome_sms_delivered: 0,
    welcome_sms_not_delivered: 0,
    emails_included: false,
  };

  (relatedRows || []).forEach(function (row) {
    if (!row || !inviteCis.has(String(row.czuid))) return;
    const src = String(row.source_system || '');
    const delivered = String(row.status || '') === 'DELIVERED';
    if (src === 'affiliate_otp') {
      if (delivered) out.otp_delivered += 1;
      else out.otp_not_delivered += 1;
    } else if (src === 'affiliate_welcome') {
      if (delivered) out.welcome_sms_delivered += 1;
      else out.welcome_sms_not_delivered += 1;
    }
  });

  const unit = Number(unitCostExVat);
  const rate = Number.isFinite(unit) ? unit : null;
  out.otp_cost_ex_vat = rate == null ? null : rate * out.otp_delivered;
  out.welcome_sms_cost_ex_vat = rate == null ? null : rate * out.welcome_sms_delivered;
  return out;
}

function loteSmsCostExVat(inviteCostExVat, acquisition) {
  if (inviteCostExVat == null || inviteCostExVat === '') return null;
  const invite = Number(inviteCostExVat);
  if (!Number.isFinite(invite) || !acquisition) return null;
  if (acquisition.otp_cost_ex_vat == null || acquisition.welcome_sms_cost_ex_vat == null) return null;
  return invite + acquisition.otp_cost_ex_vat + acquisition.welcome_sms_cost_ex_vat;
}

module.exports = {
  summarizeAcquisitionCost,
  loteSmsCostExVat,
};
