import { getAdapter } from "@/lib/db/driver.js";
import { WINDOW_MS, dimensionKeyToString } from "./dimensions.js";
import { computeBurnRateFromWindow } from "./burnRate.js";

const _mutexes = new Map();

function mutexKey(apiKeyId, dimKey) {
  return `${apiKeyId}|${dimKey}`;
}

async function withMutex(key, fn) {
  const current = _mutexes.get(key) ?? Promise.resolve();
  let resolve;
  const next = new Promise((res) => { resolve = res; });
  _mutexes.set(key, next);

  try {
    await current;
    return await fn();
  } finally {
    resolve();
    if (_mutexes.get(key) === next) {
      _mutexes.delete(key);
    }
  }
}

function slidingWindowEffective(curr, prev, nowMs, windowMs) {
  const currentBucketIndex = Math.floor(nowMs / windowMs);
  const currentBucketStartMs = currentBucketIndex * windowMs;
  const elapsed = nowMs - currentBucketStartMs;
  const weight = 1 - elapsed / windowMs;
  return prev * weight + curr;
}

export class SqliteQuotaStore {
  async consume(apiKeyId, dim, cost) {
    const nowMs = Date.now();
    const dimKey = dimensionKeyToString(dim);
    const windowMs = WINDOW_MS[dim.window];
    const currentBucket = Math.floor(nowMs / windowMs);

    return withMutex(mutexKey(apiKeyId, dimKey), async () => {
      const db = await getAdapter();
      db.run(
        `INSERT INTO quotaConsumption(apiKeyId, dimensionKey, bucketIndex, consumed, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(apiKeyId, dimensionKey, bucketIndex)
         DO UPDATE SET consumed = consumed + ?, updatedAt = ?`,
        [apiKeyId, dimKey, currentBucket, cost, nowMs, cost, nowMs]
      );

      const prevBucket = currentBucket - 1;
      const rows = db.all(
        `SELECT bucketIndex, consumed FROM quotaConsumption
         WHERE apiKeyId = ? AND dimensionKey = ? AND bucketIndex IN (?, ?)`,
        [apiKeyId, dimKey, currentBucket, prevBucket]
      );
      const map = {};
      for (const r of rows) map[r.bucketIndex] = r.consumed;
      const curr = map[currentBucket] ?? 0;
      const prev = map[prevBucket] ?? 0;
      return slidingWindowEffective(curr, prev, nowMs, windowMs);
    });
  }

  async peek(apiKeyId, dim) {
    const nowMs = Date.now();
    const dimKey = dimensionKeyToString(dim);
    const windowMs = WINDOW_MS[dim.window];
    const currentBucket = Math.floor(nowMs / windowMs);

    const db = await getAdapter();
    const prevBucket = currentBucket - 1;
    const rows = db.all(
      `SELECT bucketIndex, consumed FROM quotaConsumption
       WHERE apiKeyId = ? AND dimensionKey = ? AND bucketIndex IN (?, ?)`,
      [apiKeyId, dimKey, currentBucket, prevBucket]
    );
    const map = {};
    for (const r of rows) map[r.bucketIndex] = r.consumed;
    const curr = map[currentBucket] ?? 0;
    const prev = map[prevBucket] ?? 0;
    return slidingWindowEffective(curr, prev, nowMs, windowMs);
  }

  async poolConsumedTotal(poolId, dim) {
    const nowMs = Date.now();
    const dimKey = dimensionKeyToString(dim);
    const windowMs = WINDOW_MS[dim.window];
    const currentBucket = Math.floor(nowMs / windowMs);

    const db = await getAdapter();
    const prevBucket = currentBucket - 1;
    const rows = db.all(
      `SELECT bucketIndex, SUM(consumed) as total FROM quotaConsumption
       WHERE dimensionKey = ? AND bucketIndex IN (?, ?)
       GROUP BY bucketIndex`,
      [dimKey, currentBucket, prevBucket]
    );
    const map = {};
    for (const r of rows) map[r.bucketIndex] = r.total;
    const currTotal = map[currentBucket] ?? 0;
    const prevTotal = map[prevBucket] ?? 0;
    return slidingWindowEffective(currTotal, prevTotal, nowMs, windowMs);
  }

  async poolUsageWithDimensions(poolId, planDimensions) {
    const nowMs = Date.now();
    const db = await getAdapter();
    const poolRow = db.get(`SELECT * FROM quotaPools WHERE id = ?`, [poolId]);
    if (!poolRow) {
      return { poolId, generatedAt: new Date(nowMs).toISOString(), dimensions: [] };
    }

    const allocations = db.all(
      `SELECT * FROM quotaAllocations WHERE poolId = ?`, [poolId]
    );
    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);

    const dimensionSnapshots = [];

    for (const planDim of planDimensions) {
      const windowMs = WINDOW_MS[planDim.window];
      if (!windowMs) continue;

      let consumedTotal = 0;
      const perKey = [];

      for (const alloc of allocations) {
        const dim = { poolId, unit: planDim.unit, window: planDim.window };
        const consumed = await this.peek(alloc.apiKeyId, dim);
        consumedTotal += consumed;

        const effectiveWeight = totalWeight > 0 ? alloc.weight : 0;
        const fairShare = (effectiveWeight / 100) * planDim.limit;
        const deficit = consumed - fairShare;
        const borrowing = consumed > fairShare;

        perKey.push({
          apiKeyId: alloc.apiKeyId,
          consumed,
          fairShare,
          deficit,
          borrowing,
        });
      }

      dimensionSnapshots.push({
        unit: planDim.unit,
        window: planDim.window,
        limit: planDim.limit,
        consumedTotal,
        perKey,
      });
    }

    const tokenDim = dimensionSnapshots.find((d) => d.unit === "tokens");
    let burnRate;
    if (tokenDim && tokenDim.consumedTotal > 0) {
      const windowMs = WINDOW_MS[tokenDim.window];
      const remaining = tokenDim.limit - tokenDim.consumedTotal;
      const rateResult = computeBurnRateFromWindow(tokenDim.consumedTotal, windowMs, remaining);
      burnRate = {
        tokensPerSecond: rateResult.tokensPerSecond,
        timeToExhaustionMs: rateResult.timeToExhaustionMs,
      };
    }

    return {
      poolId,
      generatedAt: new Date(nowMs).toISOString(),
      dimensions: dimensionSnapshots,
      burnRate,
    };
  }
}

let _instance = null;

export function getSqliteQuotaStore() {
  if (!_instance) {
    _instance = new SqliteQuotaStore();
  }
  return _instance;
}
