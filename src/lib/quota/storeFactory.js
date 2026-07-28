import { getSqliteQuotaStore } from "./sqliteQuotaStore.js";

let _store = null;

export async function getQuotaStore() {
  if (!_store) {
    _store = getSqliteQuotaStore();
  }
  return _store;
}

export function resetQuotaStoreForTests() {
  _store = null;
}
