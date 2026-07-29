const {
  IG_USER_ID,
  RESPONSE_WINDOW_MS,
  EXPIRING_THRESHOLD_MS,
} = require('./config');

/**
 * Pick customer participant (not @credizonauy).
 * @returns {{ id: string, username: string|null }|null}
 */
function pickRecipient(participants) {
  const list =
    participants && Array.isArray(participants.data)
      ? participants.data
      : Array.isArray(participants)
        ? participants
        : [];

  const ours = String(IG_USER_ID);
  const other = list.find((p) => p && String(p.id) !== ours);
  if (!other || other.id == null) return null;
  return {
    id: String(other.id),
    username: other.username != null ? String(other.username) : null,
  };
}

function messageDirection(from) {
  const fromId =
    from && from.id != null
      ? String(from.id)
      : null;
  if (fromId && fromId === String(IG_USER_ID)) return 'outbound';
  return 'inbound';
}

function computeWindowFields(lastInboundAt) {
  if (!lastInboundAt) {
    return {
      response_window_expires_at: null,
      response_window_status: null,
    };
  }
  const inboundMs = new Date(lastInboundAt).getTime();
  const expiresAt = new Date(inboundMs + RESPONSE_WINDOW_MS);
  const remaining = expiresAt.getTime() - Date.now();
  let response_window_status;
  if (remaining <= 0) response_window_status = 'expired';
  else if (remaining <= EXPIRING_THRESHOLD_MS) response_window_status = 'expiring';
  else response_window_status = 'open';

  return {
    response_window_expires_at: expiresAt.toISOString(),
    response_window_status,
  };
}

/**
 * Derive conversation status from message timeline + window.
 * Does not override 'closed' or 'in_progress' if already set by operator —
 * sync only applies pending/answered/expired when status is one of those
 * or still default pending.
 */
function computeConversationStatus({
  lastInboundAt,
  lastOutboundAt,
  currentStatus,
}) {
  if (currentStatus === 'closed') return 'closed';

  const window = computeWindowFields(lastInboundAt);
  if (!lastInboundAt) {
    return {
      status: currentStatus === 'in_progress' ? 'in_progress' : 'pending',
      ...window,
    };
  }

  if (window.response_window_status === 'expired') {
    const outboundAfterInbound =
      lastOutboundAt &&
      new Date(lastOutboundAt).getTime() >= new Date(lastInboundAt).getTime();
    if (!outboundAfterInbound) {
      return { status: 'expired', ...window };
    }
  }

  const outboundAfterInbound =
    lastOutboundAt &&
    new Date(lastOutboundAt).getTime() >= new Date(lastInboundAt).getTime();

  if (outboundAfterInbound) {
    return {
      status: currentStatus === 'in_progress' ? 'in_progress' : 'answered',
      ...window,
    };
  }

  return {
    status: currentStatus === 'in_progress' ? 'in_progress' : 'pending',
    ...window,
  };
}

function hasOutboundAfterInbound(messages) {
  let lastInbound = null;
  let lastOutbound = null;
  for (const m of messages) {
    const ts = m.message_timestamp || m.created_time;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (m.direction === 'inbound') {
      if (lastInbound == null || t > lastInbound) lastInbound = t;
    } else if (m.direction === 'outbound') {
      if (lastOutbound == null || t > lastOutbound) lastOutbound = t;
    }
  }
  if (lastInbound == null) return false;
  return lastOutbound != null && lastOutbound >= lastInbound;
}

function extremaFromMappedMessages(mapped) {
  let lastInboundAt = null;
  let lastOutboundAt = null;
  for (const m of mapped) {
    const ts = m.message_timestamp;
    if (!ts) continue;
    if (m.direction === 'inbound') {
      if (!lastInboundAt || new Date(ts) > new Date(lastInboundAt)) {
        lastInboundAt = ts;
      }
    } else if (m.direction === 'outbound') {
      if (!lastOutboundAt || new Date(ts) > new Date(lastOutboundAt)) {
        lastOutboundAt = ts;
      }
    }
  }
  return { lastInboundAt, lastOutboundAt };
}

module.exports = {
  pickRecipient,
  messageDirection,
  computeWindowFields,
  computeConversationStatus,
  hasOutboundAfterInbound,
  extremaFromMappedMessages,
};
