'use strict';

/**
 * Email template catalog. Edits never propagate to campaigns or recipients.
 */

const logger = require('../../lib/logger');

function trimRequired(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    const err = new Error(label + ' must be a non-empty string');
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
}

/**
 * Copy an active template into campaign-owned subject/body.
 * Does not keep a live dependency.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {unknown} templateId
 */
async function loadActiveTemplateForCampaign(supabase, templateId) {
  const { data: template, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('id', templateId)
    .maybeSingle();

  if (error) {
    logger.error('email template lookup failed', {
      templateId,
      error: error.message,
    });
    const err = new Error(error.message);
    err.statusCode = 500;
    throw err;
  }
  if (!template) {
    const err = new Error('template_id not found: ' + templateId);
    err.statusCode = 400;
    throw err;
  }
  if (template.active !== true) {
    const err = new Error('template is inactive: ' + templateId);
    err.statusCode = 400;
    throw err;
  }
  return template;
}

/**
 * Campaign-owned copy. Later template edits do not flow through this object.
 * @param {object} template
 */
function campaignOwnedCopyFromTemplate(template) {
  return {
    template_id: template.id,
    subject: String(template.subject || '').trim(),
    body_html: String(template.body_html || '').trim(),
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ name: string, subject: string, body_html: string, active?: boolean }} input
 */
async function createEmailTemplate(supabase, input) {
  const row = {
    name: trimRequired(input && input.name, 'name'),
    subject: trimRequired(input && input.subject, 'subject'),
    body_html: trimRequired(input && input.body_html, 'body_html'),
    active: input && input.active === false ? false : true,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('email_templates')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function listEmailTemplates(supabase) {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Updates only the catalog row. Never touches campaigns or recipients.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {unknown} templateId
 * @param {object} patch
 */
async function updateEmailTemplate(supabase, templateId, patch) {
  const { data: existing, error: loadErr } = await supabase
    .from('email_templates')
    .select('id')
    .eq('id', templateId)
    .maybeSingle();
  if (loadErr) throw new Error(loadErr.message);
  if (!existing) {
    const err = new Error('template not found');
    err.statusCode = 404;
    throw err;
  }

  const update = { updated_at: new Date().toISOString() };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
    update.name = trimRequired(patch.name, 'name');
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'subject')) {
    update.subject = trimRequired(patch.subject, 'subject');
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'body_html')) {
    update.body_html = trimRequired(patch.body_html, 'body_html');
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'active')) {
    update.active = patch.active === true;
  }

  const { data, error } = await supabase
    .from('email_templates')
    .update(update)
    .eq('id', templateId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  loadActiveTemplateForCampaign,
  createEmailTemplate,
  listEmailTemplates,
  updateEmailTemplate,
  campaignOwnedCopyFromTemplate,
};
