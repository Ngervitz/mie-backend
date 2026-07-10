const {
  ALERT_SUPPRESSION_DAYS,
  ALERT_ESCALATION_FACTOR,
} = require('./constants');
const { shiftDateUtc } = require('./dates');

/**
 * Anti-flapping anchored by execution_date calendar, never by created_at order.
 * "Yesterday" = latest row for execution_date - 1 day (ORDER BY created_at DESC).
 */
function resolveAntiFlapping({
  executionDate,
  changeRelevantToday,
  changeDirectionToday,
  deltaValueToday,
  yesterdayRow,
  recentAlertsSameDirection,
}) {
  const changeRelevantYesterday = yesterdayRow
    ? Boolean(yesterdayRow.change_relevant)
    : false;

  let consecutiveChangeDays = 0;
  if (changeRelevantToday) {
    const yesterdayConsecutive = yesterdayRow && changeRelevantYesterday
      ? Number(yesterdayRow.consecutive_change_days) || 0
      : 0;
    consecutiveChangeDays = yesterdayConsecutive + 1;
  }

  const changeDetectedToday = changeRelevantToday && !changeRelevantYesterday;

  let alertEmitted = false;

  if (changeDetectedToday && changeDirectionToday) {
    const blockingAlert = (recentAlertsSameDirection || []).find((row) => {
      const alertDate = row.execution_date;
      if (!alertDate) return false;
      const daysSince = (() => {
        const [y1, m1, d1] = String(alertDate).split('-').map(Number);
        const [y2, m2, d2] = String(executionDate).split('-').map(Number);
        return Math.floor(
          (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000,
        );
      })();
      return daysSince >= 0 && daysSince < ALERT_SUPPRESSION_DAYS;
    });

    if (!blockingAlert) {
      alertEmitted = true;
    } else {
      const priorDelta = Number(blockingAlert.delta_value);
      const todayDelta = Number(deltaValueToday);
      if (
        Number.isFinite(priorDelta)
        && Number.isFinite(todayDelta)
        && todayDelta >= priorDelta * ALERT_ESCALATION_FACTOR
      ) {
        alertEmitted = true;
      }
    }
  }

  return {
    changeDetectedToday,
    alertEmitted,
    consecutiveChangeDays,
    changeRelevantYesterday,
  };
}

function yesterdayExecutionDate(executionDate) {
  return shiftDateUtc(executionDate, -1);
}

module.exports = {
  resolveAntiFlapping,
  yesterdayExecutionDate,
};
