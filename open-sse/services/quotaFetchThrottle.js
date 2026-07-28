const _lastFetchTimes = new Map();

export function getQuotaFetchMinInterval() {
  const parsed = Number.parseInt(process.env.OMNIROUTE_QUOTA_FETCH_MIN_INTERVAL_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 250;
}

export function shouldThrottleFetch(connectionId, provider) {
  const key = `${provider}:${connectionId}`;
  const last = _lastFetchTimes.get(key);
  if (!last) return false;
  const minInterval = getQuotaFetchMinInterval();
  return Date.now() - last < minInterval;
}

export function markFetchTime(connectionId, provider) {
  const key = `${provider}:${connectionId}`;
  _lastFetchTimes.set(key, Date.now());
}

export function clearFetchThrottle(connectionId, provider) {
  const key = `${provider}:${connectionId}`;
  _lastFetchTimes.delete(key);
}

export function clearAllFetchThrottles() {
  _lastFetchTimes.clear();
}
