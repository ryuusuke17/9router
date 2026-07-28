import { NextResponse } from "next/server";
import {
  getPool, updatePool, deletePool,
  listAllocationsForPool, listConnectionIdsForPool,
  listModelCapsForPool, addConnectionToPool, removeConnectionFromPool,
} from "@/lib/db/index.js";

async function enrichPool(poolId) {
  const pool = await getPool(poolId);
  if (!pool) return null;
  const [allocations, connectionIds, modelCaps] = await Promise.all([
    listAllocationsForPool(poolId).catch(() => []),
    listConnectionIdsForPool(poolId).catch(() => []),
    listModelCapsForPool(poolId).catch(() => []),
  ]);
  return { ...pool, allocations, connectionIds, modelCaps };
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await enrichPool(id);
    if (!pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }
    return NextResponse.json({ pool });
  } catch (error) {
    console.log("[QuotaAPI] Error getting pool:", error);
    return NextResponse.json({ error: "Failed to get pool" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getPool(id);
    if (!existing) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    const body = await request.json();
    if (body.name) {
      await updatePool(id, { name: body.name });
    }

    if (Array.isArray(body.connectionIds)) {
      const currentIds = await listConnectionIdsForPool(id);
      for (const cid of body.connectionIds) {
        if (!currentIds.includes(cid)) {
          await addConnectionToPool(id, cid).catch(() => {});
        }
      }
      for (const cid of currentIds) {
        if (!body.connectionIds.includes(cid)) {
          await removeConnectionFromPool(id, cid).catch(() => {});
        }
      }
    }

    const pool = await enrichPool(id);
    return NextResponse.json({ pool });
  } catch (error) {
    console.log("[QuotaAPI] Error updating pool:", error);
    return NextResponse.json({ error: error.message || "Failed to update pool" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getPool(id);
    if (!existing) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    await deletePool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("[QuotaAPI] Error deleting pool:", error);
    return NextResponse.json({ error: "Failed to delete pool" }, { status: 500 });
  }
}
