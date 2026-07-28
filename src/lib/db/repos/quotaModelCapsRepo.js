import { getAdapter } from "../driver.js";

export async function getModelCap(poolId, apiKeyId, model) {
  const db = await getAdapter();
  return db.get(
    `SELECT * FROM quotaAllocationModelCaps WHERE poolId = ? AND apiKeyId = ? AND model = ?`,
    [poolId, apiKeyId, model]
  ) || null;
}

export async function listModelCaps(poolId, apiKeyId) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM quotaAllocationModelCaps WHERE poolId = ? AND apiKeyId = ? ORDER BY model`,
    [poolId, apiKeyId]
  );
}

export async function setModelCap(poolId, apiKeyId, model, capValue, capUnit) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO quotaAllocationModelCaps(poolId, apiKeyId, model, capValue, capUnit)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(poolId, apiKeyId, model)
     DO UPDATE SET capValue = excluded.capValue, capUnit = excluded.capUnit`,
    [poolId, apiKeyId, model, capValue, capUnit]
  );
}

export async function deleteModelCap(poolId, apiKeyId, model) {
  const db = await getAdapter();
  db.run(
    `DELETE FROM quotaAllocationModelCaps WHERE poolId = ? AND apiKeyId = ? AND model = ?`,
    [poolId, apiKeyId, model]
  );
}

export async function listModelCapsForPool(poolId) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM quotaAllocationModelCaps WHERE poolId = ? ORDER BY apiKeyId, model`,
    [poolId]
  );
}
