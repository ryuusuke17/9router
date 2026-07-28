const SATURATION_THRESHOLD_PCT = 100;
const _buckets = new Map();

function storeKey(connectionId, windowKey) {
  return `${connectionId}::${windowKey}`;
}

function parseResetAtMs(resetAt) {
  if (!resetAt) return 0;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function isBucketSaturated(connectionId, windowKey, nowMs) {
  if (nowMs === undefined) nowMs = Date.now();
  if (!connectionId || !windowKey) return false;
  const key = storeKey(connectionId, windowKey);
  const entry = _buckets.get(key);
  if (!entry) return false;
  if (entry.resetsAtMs > 0 && nowMs >= entry.resetsAtMs) {
    _buckets.delete(key);
    return false;
  }
  return entry.saturated;
}

export function recordUsage(connectionId, windowKey, usedPct, resetAt, nowMs) {
  if (nowMs === undefined) nowMs = Date.now();
  if (!connectionId || !windowKey) return;
  const key = storeKey(connectionId, windowKey);
  const resetsAtMs = parseResetAtMs(resetAt);
  if (resetsAtMs > 0 && nowMs >= resetsAtMs) {
    _buckets.delete(key);
    return;
  }
  const saturated = Number.isFinite(usedPct) && usedPct >= SATURATION_THRESHOLD_PCT;
  if (!saturated) {
    _buckets.delete(key);
    return;
  }
  _buckets.set(key, { saturated: true, resetsAtMs });
}

function processQuotaEntry(connectionId, windowKey, entry, nowMs) {
  if (!entry || typeof entry.used !== "number") return;
  recordUsage(connectionId, windowKey, entry.used, entry.resetAt ?? null, nowMs);
}

export function updateAccountBuckets(connectionId, usageResult, nowMs) {
  if (nowMs === undefined) nowMs = Date.now();
  if (!connectionId || !usageResult?.quotas) return;
  const { quotas } = usageResult;
  processQuotaEntry(connectionId, "5h", quotas["session (5h)"], nowMs);
  processQuotaEntry(connectionId, "7d", quotas["weekly (7d)"], nowMs);
  for (const [key, entry] of Object.entries(quotas)) {
    const match = /^weekly (.+) \(7d\)$/.exec(key);
    if (match?.[1]) {
      processQuotaEntry(connectionId, `7d:${match[1]}`, entry, nowMs);
    }
  }
}

export function _clearBucketsForTest() {
  _buckets.clear();
}

export function _bucketCountForTest() {
  return _buckets.size;
}
