import { TABLES, buildCreateTableSql } from "../schema.js";

const QUOTA_TABLES = [
  "quotaConsumption",
  "quotaPools",
  "quotaAllocations",
  "quotaPoolConnections",
  "quotaAllocationModelCaps",
  "quotaSnapshots",
  "domainState",
];

export default {
  version: 2,
  name: "quota-tables",
  up(db) {
    for (const name of QUOTA_TABLES) {
      const def = TABLES[name];
      if (!def) continue;
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};
