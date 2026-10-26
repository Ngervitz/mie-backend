'use strict';

/**
 * In-memory rate limits for the public affiliate join API (per process).
 */

const IP_WINDOW_MS = 60 * 1000;
const IP_MAX = 30;
const CI_WINDOW_MS = 60 * 1000;
const CI_MAX = 15;

const ipHits = new Map();
const ciHits = new Map();

function prune(map, windowMs, now) {
  if (map.size <= 10000) return;
  for (const [key, value] of map) {
    if (now - value.start >= windowMs) map.delete(key);
  }
}

function hit(map, key, windowMs, max, now) {
  const rec = map.get(key);
  if (!rec || now - rec.start >= windowMs) {
    map.set(key, { start: now, count: 1 });
    prune(map, windowMs, now);
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

function clientIp(req) {
  if (req.socket && req.socket.remoteAddress) {
    return String(req.socket.remoteAddress);
  }
  return 'unknown';
}

function isIpRateLimited(req, now) {
  const t = now == null ? Date.now() : Number(now);
  return hit(ipHits, clientIp(req), IP_WINDOW_MS, IP_MAX, t);
}

function isCiRateLimited(ci, now) {
  const t = now == null ? Date.now() : Number(now);
  const key = 'ci:' + String(ci);
  return hit(ciHits, key, CI_WINDOW_MS, CI_MAX, t);
}

function resetForTests() {
  ipHits.clear();
  ciHits.clear();
}

module.exports = {
  IP_WINDOW_MS,
  IP_MAX,
  CI_WINDOW_MS,
  CI_MAX,
  clientIp,
  isIpRateLimited,
  isCiRateLimited,
  resetForTests,
};
