import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listPools, createPool, listAllocationsForPool,
  findPoolsForConnection, addConnectionToPool,
  setAllocation,
} from "@/lib/db/index.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectionId = searchParams.get("connectionId");

    let pools;
    if (connectionId) {
      const poolIds = await findPoolsForConnection(connectionId);
      const all = await listPools();
      pools = all.filter((p) => poolIds.includes(p.id));
    } else {
      pools = await listPools();
    }

    const enriched = await Promise.all(
      pools.map(async (pool) => {
        const allocations = await listAllocationsForPool(pool.id).catch(() => []);
        return { ...pool, allocations };
      })
    );

    return NextResponse.json({ pools: enriched });
  } catch (error) {
    console.log("[QuotaAPI] Error listing pools:", error);
    return NextResponse.json({ error: "Failed to list pools" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { name, connectionIds } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const poolId = uuidv4();
    await createPool(poolId, name);

    if (Array.isArray(connectionIds)) {
      for (const cid of connectionIds) {
        await addConnectionToPool(poolId, cid).catch(() => {});
      }
    }

    const pool = await listPools().then((pools) => pools.find((p) => p.id === poolId));
    return NextResponse.json({ pool }, { status: 201 });
  } catch (error) {
    console.log("[QuotaAPI] Error creating pool:", error);
    return NextResponse.json({ error: error.message || "Failed to create pool" }, { status: 500 });
  }
}
