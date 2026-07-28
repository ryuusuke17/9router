import { getAdapter } from "../driver.js";

export async function saveQuotaSnapshot(snapshot) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO quotaSnapshots(provider, connectionId, windowKey, remainingPercent, isExhausted, nextResetAt, windowDurationMs, rawData, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      snapshot.provider,
      snapshot.connectionId,
      snapshot.windowKey,
      snapshot.remainingPercent ?? null,
      snapshot.isExhausted ? 1 : 0,
      snapshot.nextResetAt ?? null,
      snapshot.windowDurationMs ?? null,
      snapshot.rawData ? JSON.stringify(snapshot.rawData) : null,
    ]
  );
}

export async function getQuotaSnapshots(connectionId, provider, limit = 100) {
  const db = await getAdapter();
  const params = [];
  const clauses = [];
  if (connectionId) { clauses.push("connectionId = ?"); params.push(connectionId); }
  if (provider) { clauses.push("provider = ?"); params.push(provider); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.all(
    `SELECT * FROM quotaSnapshots ${where} ORDER BY createdAt DESC LIMIT ?`,
    [...params, limit]
  );
}

export async function getLatestSnapshot(connectionId, windowKey) {
  const db = await getAdapter();
  return db.get(
    `SELECT * FROM quotaSnapshots WHERE connectionId = ? AND windowKey = ? ORDER BY createdAt DESC LIMIT 1`,
    [connectionId, windowKey]
  ) || null;
}

export async function gcSnapshotsOlderThan(days) {
  const db = await getAdapter();
  db.run(
    `DELETE FROM quotaSnapshots WHERE createdAt < datetime('now', '-${Math.max(1, days)} days')`
  );
}
