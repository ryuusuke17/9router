import { NextResponse } from "next/server";
import { getPool, listAllocationsForPool } from "@/lib/db/index.js";
import { getSqliteQuotaStore } from "@/lib/quota/sqliteQuotaStore.js";

const COMMON_DIMENSIONS = [
  { unit: "requests", window: "hourly" },
  { unit: "requests", window: "daily" },
  { unit: "tokens", window: "hourly" },
  { unit: "tokens", window: "daily" },
];

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getPool(id);
    if (!pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    const allocations = await listAllocationsForPool(id).catch(() => []);

    const store = getSqliteQuotaStore();
    const dimensions = await Promise.all(
      COMMON_DIMENSIONS.map(async (dim) => {
        const dimWithPool = { poolId: id, ...dim };
        const consumedTotal = await store.poolConsumedTotal(id, dimWithPool);

        const perKey = await Promise.all(
          allocations.map(async (a) => {
            const consumed = await store.peek(a.apiKeyId, dimWithPool);
            return { apiKeyId: a.apiKeyId, consumed, weight: a.weight };
          })
        );

        return { unit: dim.unit, window: dim.window, consumedTotal, perKey };
      })
    );

    return NextResponse.json({
      poolId: id,
      poolName: pool.name,
      generatedAt: new Date().toISOString(),
      dimensions,
    });
  } catch (error) {
    console.log("[QuotaConsumption] Error:", error);
    return NextResponse.json({ error: "Failed to get consumption" }, { status: 500 });
  }
}
