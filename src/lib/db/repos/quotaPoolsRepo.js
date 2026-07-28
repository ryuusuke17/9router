import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// ─── Pools ────────────────────────────────────────────────────────────────

export async function listPools() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM quotaPools ORDER BY name`);
  const out = [];
  for (const r of rows) {
    const allocations = await listAllocationsForPool(r.id);
    const connectionIds = await listConnectionIdsForPool(r.id);
    out.push({ ...r, allocations, connectionIds });
  }
  return out;
}

export async function getPool(poolId) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM quotaPools WHERE id = ?`, [poolId]);
  if (!row) return null;
  const allocations = await listAllocationsForPool(poolId);
  const connectionIds = await listConnectionIdsForPool(poolId);
  return { ...row, allocations, connectionIds };
}

export async function createPool(id, name) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO quotaPools(id, name, createdAt) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [id, name]
  );
  return getPool(id);
}

export async function updatePool(id, fields) {
  const db = await getAdapter();
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (sets.length === 0) return getPool(id);
  params.push(id);
  db.run(`UPDATE quotaPools SET ${sets.join(", ")} WHERE id = ?`, params);
  return getPool(id);
}

export async function deletePool(poolId) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM quotaAllocations WHERE poolId = ?`, [poolId]);
    db.run(`DELETE FROM quotaPoolConnections WHERE poolId = ?`, [poolId]);
    db.run(`DELETE FROM quotaPools WHERE id = ?`, [poolId]);
  });
}

// ─── Allocations ──────────────────────────────────────────────────────────

export async function listAllocationsForPool(poolId) {
  const db = await getAdapter();
  return db.all(`SELECT * FROM quotaAllocations WHERE poolId = ? ORDER BY apiKeyId`, [poolId]);
}

export async function listAllocationsForApiKey(apiKeyId) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM quotaAllocations WHERE apiKeyId = ?`, [apiKeyId]);
  return rows.map((r) => ({ poolId: r.poolId, allocation: r }));
}

export async function setAllocation(poolId, apiKeyId, fields) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO quotaAllocations(poolId, apiKeyId, weight, capValue, capUnit, policy)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(poolId, apiKeyId)
     DO UPDATE SET weight = excluded.weight,
                   capValue = excluded.capValue,
                   capUnit = excluded.capUnit,
                   policy = excluded.policy`,
    [
      poolId, apiKeyId,
      fields.weight ?? 0,
      fields.capValue ?? null,
      fields.capUnit ?? null,
      fields.policy ?? "hard",
    ]
  );
}

export async function deleteAllocation(poolId, apiKeyId) {
  const db = await getAdapter();
  db.run(`DELETE FROM quotaAllocations WHERE poolId = ? AND apiKeyId = ?`, [poolId, apiKeyId]);
}

// ─── Pool-Connection Links ────────────────────────────────────────────────

export async function listConnectionIdsForPool(poolId) {
  const db = await getAdapter();
  const rows = db.all(`SELECT connectionId FROM quotaPoolConnections WHERE poolId = ?`, [poolId]);
  return rows.map((r) => r.connectionId);
}

export async function addConnectionToPool(poolId, connectionId) {
  const db = await getAdapter();
  db.run(
    `INSERT OR IGNORE INTO quotaPoolConnections(poolId, connectionId, createdAt)
     VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [poolId, connectionId]
  );
}

export async function removeConnectionFromPool(poolId, connectionId) {
  const db = await getAdapter();
  db.run(`DELETE FROM quotaPoolConnections WHERE poolId = ? AND connectionId = ?`, [poolId, connectionId]);
}

export async function findPoolsForConnection(connectionId) {
  const db = await getAdapter();
  return db.all(
    `SELECT p.* FROM quotaPools p
     INNER JOIN quotaPoolConnections c ON c.poolId = p.id
     WHERE c.connectionId = ?
     ORDER BY p.name`,
    [connectionId]
  );
}
