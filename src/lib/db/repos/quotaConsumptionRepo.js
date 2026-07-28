import { getAdapter } from "../driver.js";

export async function getBucket(apiKeyId, dimensionKey, bucketIndex) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT consumed FROM quotaConsumption WHERE apiKeyId = ? AND dimensionKey = ? AND bucketIndex = ?`,
    [apiKeyId, dimensionKey, bucketIndex]
  );
  return row ? row.consumed : 0;
}

export async function incrementBucket(apiKeyId, dimensionKey, bucketIndex, amount, nowMs) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO quotaConsumption(apiKeyId, dimensionKey, bucketIndex, consumed, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(apiKeyId, dimensionKey, bucketIndex)
     DO UPDATE SET consumed = consumed + ?, updatedAt = ?`,
    [apiKeyId, dimensionKey, bucketIndex, amount, nowMs, amount, nowMs]
  );
}

export async function getPair(apiKeyId, dimensionKey, currentBucket) {
  const db = await getAdapter();
  const prevBucket = currentBucket - 1;
  const rows = db.all(
    `SELECT bucketIndex, consumed FROM quotaConsumption
     WHERE apiKeyId = ? AND dimensionKey = ? AND bucketIndex IN (?, ?)`,
    [apiKeyId, dimensionKey, currentBucket, prevBucket]
  );
  const map = {};
  for (const r of rows) map[r.bucketIndex] = r.consumed;
  return {
    curr: map[currentBucket] ?? 0,
    prev: map[prevBucket] ?? 0,
  };
}

export async function sumPoolDimension(dimensionKey, currentBucket) {
  const db = await getAdapter();
  const prevBucket = currentBucket - 1;
  const rows = db.all(
    `SELECT bucketIndex, SUM(consumed) as total FROM quotaConsumption
     WHERE dimensionKey = ? AND bucketIndex IN (?, ?)
     GROUP BY bucketIndex`,
    [dimensionKey, currentBucket, prevBucket]
  );
  const map = {};
  for (const r of rows) map[r.bucketIndex] = r.total;
  return {
    currTotal: map[currentBucket] ?? 0,
    prevTotal: map[prevBucket] ?? 0,
  };
}

export async function listConsumptionForPool(dimensionKey, currentBucket) {
  const db = await getAdapter();
  const prevBucket = currentBucket - 1;
  return db.all(
    `SELECT apiKeyId, bucketIndex, consumed FROM quotaConsumption
     WHERE dimensionKey = ? AND bucketIndex IN (?, ?)`,
    [dimensionKey, currentBucket, prevBucket]
  );
}

export async function gcOlderThan(timestampMs) {
  const db = await getAdapter();
  db.run(`DELETE FROM quotaConsumption WHERE updatedAt < ?`, [timestampMs]);
}
