import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export async function getDomainState(scope, key) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM domainState WHERE scope = ? AND key = ?`, [scope, key]);
  return row ? parseJson(row.value) : null;
}

export async function setDomainState(scope, key, value) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO domainState(scope, key, value) VALUES (?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [scope, key, stringifyJson(value)]
  );
}

export async function deleteDomainState(scope, key) {
  const db = await getAdapter();
  db.run(`DELETE FROM domainState WHERE scope = ? AND key = ?`, [scope, key]);
}

export async function listDomainState(scope) {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM domainState WHERE scope = ?`, [scope]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value);
  return out;
}

export async function batchSaveDomainState(scope, entries) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const { key, value } of entries) {
      db.run(
        `INSERT INTO domainState(scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [scope, key, stringifyJson(value)]
      );
    }
  });
}
