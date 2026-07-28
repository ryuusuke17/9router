import { NextResponse } from "next/server";
import {
  getPool, setAllocation, deleteAllocation, listAllocationsForPool,
  setModelCap, deleteModelCap,
} from "@/lib/db/index.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getPool(id);
    if (!pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }
    const allocations = await listAllocationsForPool(id).catch(() => []);
    return NextResponse.json({ allocations });
  } catch (error) {
    console.log("[QuotaAPI] Error listing allocations:", error);
    return NextResponse.json({ error: "Failed to list allocations" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getPool(id);
    if (!pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const { apiKeyId, weight, capValue, capUnit, policy, modelCaps } = body;

    if (!apiKeyId) {
      return NextResponse.json({ error: "apiKeyId is required" }, { status: 400 });
    }

    await setAllocation(id, apiKeyId, {
      weight: weight ?? 100,
      capValue: capValue ?? null,
      capUnit: capUnit ?? "requests",
      policy: policy ?? "generous",
    });

    if (Array.isArray(modelCaps)) {
      for (const mc of modelCaps) {
        if (mc.model && mc.capValue > 0) {
          await setModelCap(id, apiKeyId, mc.model, mc.capValue, mc.capUnit || "requests");
        }
      }
    }

    const allocations = await listAllocationsForPool(id).catch(() => []);
    return NextResponse.json({ allocations }, { status: 201 });
  } catch (error) {
    console.log("[QuotaAPI] Error setting allocation:", error);
    return NextResponse.json({ error: error.message || "Failed to set allocation" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getPool(id);
    if (!pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const apiKeyId = searchParams.get("apiKeyId");
    if (!apiKeyId) {
      return NextResponse.json({ error: "apiKeyId query param is required" }, { status: 400 });
    }

    await deleteAllocation(id, apiKeyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("[QuotaAPI] Error deleting allocation:", error);
    return NextResponse.json({ error: "Failed to delete allocation" }, { status: 500 });
  }
}
