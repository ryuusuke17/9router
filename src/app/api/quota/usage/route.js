import { NextResponse } from "next/server";
import { getApiKeyByValue, getApiKeys } from "@/lib/db/index.js";
import { getQuotaStore } from "@/lib/quota/storeFactory.js";
import { listAllocationsForApiKey } from "@/lib/db/index.js";
import { getDomainState } from "@/lib/db/index.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const apiKeyValue = searchParams.get("apiKey");
    const apiKeyId = searchParams.get("apiKeyId");

    let targetId = apiKeyId;
    if (apiKeyValue && !targetId) {
      const record = await getApiKeyByValue(apiKeyValue);
      if (record) targetId = record.id;
    }

    if (!targetId) {
      const keys = await getApiKeys();
      return NextResponse.json({ keys: keys.map((k) => ({ id: k.id, name: k.name })) });
    }

    const [allocations, pendingSpend, store] = await Promise.all([
      listAllocationsForApiKey(targetId).catch(() => []),
      getDomainState("spendHistory", targetId).catch(() => null),
      getQuotaStore(),
    ]);

    const poolUsage = [];
    for (const alloc of allocations) {
      const { listPools } = await import("@/lib/db/index.js");
      const allPools = await listPools();
      const pool = allPools.find((p) => p.id === alloc.poolId);
      if (!pool) continue;

      const dims = [
        { poolId: alloc.poolId, unit: "requests", window: "hourly" },
        { poolId: alloc.poolId, unit: "requests", window: "daily" },
        { poolId: alloc.poolId, unit: "tokens", window: "hourly" },
        { poolId: alloc.poolId, unit: "tokens", window: "daily" },
      ];

      const consumed = {};
      for (const dim of dims) {
        const val = await store.peek(targetId, dim).catch(() => 0);
        consumed[`${dim.unit}/${dim.window}`] = val;
      }

      poolUsage.push({
        poolId: alloc.poolId,
        poolName: pool.name,
        allocation: alloc,
        consumed,
      });
    }

    return NextResponse.json({
      apiKeyId: targetId,
      poolUsage,
      pendingSpend: Array.isArray(pendingSpend) ? pendingSpend.length : 0,
    });
  } catch (error) {
    console.log("[QuotaAPI] Error getting usage preview:", error);
    return NextResponse.json({ error: "Failed to get usage preview" }, { status: 500 });
  }
}
