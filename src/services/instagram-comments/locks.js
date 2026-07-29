const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const {
  RATE_BUDGET_BUCKET,
  RATE_BUDGET_HOURLY_LIMIT,
  RATE_BUDGET_WINDOW_SECONDS,
} = require('./config');

async function acquireJobLock(jobName, lockedBy, ttlSeconds) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: jobName,
    p_locked_by: lockedBy,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) {
    logger.error('acquire_job_lock failed', {
      jobName,
      error: error.message,
    });
    throw new Error(`acquire_job_lock failed: ${error.message}`);
  }
  return data === true;
}

async function releaseJobLock(jobName, lockedBy) {
  const { data, error } = await supabase.rpc('release_job_lock', {
    p_job_name: jobName,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', {
      jobName,
      lockedBy,
      error: error.message,
    });
    return false;
  }
  return data === true;
}

async function confirmJobLock(jobName, lockedBy) {
  const { data, error } = await supabase.rpc('confirm_job_lock', {
    p_job_name: jobName,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('confirm_job_lock failed', {
      jobName,
      lockedBy,
      error: error.message,
    });
    return false;
  }
  return data === true;
}

/**
 * Atomic check-and-reserve against the shared hourly Meta budget.
 * @param {number} calls
 * @returns {Promise<boolean>} true if reserved
 */
async function reserveMetaApiBudget(calls = 1) {
  const { data, error } = await supabase.rpc('reserve_meta_api_budget', {
    p_bucket_key: RATE_BUDGET_BUCKET,
    p_calls: calls,
    p_hourly_limit: RATE_BUDGET_HOURLY_LIMIT,
    p_window_seconds: RATE_BUDGET_WINDOW_SECONDS,
  });
  if (error) {
    logger.error('reserve_meta_api_budget failed', { error: error.message });
    throw new Error(`reserve_meta_api_budget failed: ${error.message}`);
  }
  return data === true;
}

module.exports = {
  acquireJobLock,
  releaseJobLock,
  confirmJobLock,
  reserveMetaApiBudget,
};
