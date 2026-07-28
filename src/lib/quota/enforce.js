import { dimensionKeyToString, costForUnit } from "./dimensions.js";
import { decideFairShare } from "./fairShare.js";
import { resolvePlan } from "./planResolver.js";
import { getSaturation } from "./saturationSignals.js";
import { getQuotaStore } from "./storeFactory.js";
import {
  listAllocationsForApiKey,
  getPool,
} from "@/lib/db/index.js";
import { getModelCap } from "@/lib/db/index.js";

const SATURATION_THRESHOLD = Number(process.env.QUOTA_SATURATION_THRESHOLD ?? "0.5");
const COUNTABLE_UNITS = new Set(["requests", "tokens", "usd"]);

export async function enforceQuotaShare(input) {
  let allocations;
  try {
    allocations = await listAllocationsForApiKey(input.apiKeyId);
  } catch {
    return { kind: "allow" };
  }

  if (!allocations.length) {
    return { kind: "allow" };
  }

  let pool = null;
  let poolAllocation = null;
  for (const { poolId, allocation } of allocations) {
    let p = null;
    try {
      p = await getPool(poolId);
    } catch {
      continue;
    }
    if (
      p &&
      (Array.isArray(p.connectionIds)
        ? p.connectionIds.includes(input.connectionId)
        : p.connectionId === input.connectionId)
    ) {
      pool = p;
      poolAllocation = allocation;
      break;
    }
  }

  if (!pool || !poolAllocation) {
    return { kind: "allow" };
  }

  const store = await getQuotaStore();

  const plan = await resolvePlan(input.connectionId, input.provider);

  if (input.model) {
    let modelCap = null;
    try {
      modelCap = await getModelCap(pool.id, input.apiKeyId, input.model);
    } catch {
      // fail-open
    }
    if (modelCap && modelCap.capValue > Number.EPSILON) {
      const modelBucketPoolId = `${pool.id}:model:${input.model}`;
      const modelDimKey = {
        poolId: modelBucketPoolId,
        unit: modelCap.capUnit,
        window: "hourly",
      };
      const modelConsumed = await store.peek(input.apiKeyId, modelDimKey).catch(() => 0);
      if (modelConsumed >= modelCap.capValue) {
        return {
          kind: "block",
          reason: `Model cap reached for your API key on ${input.provider}/${input.model} [model-cap]`,
          httpStatus: 429,
        };
      }
    }
  }

  if (!plan.dimensions.length) {
    return { kind: "allow" };
  }

  const accountCount =
    Array.isArray(pool.connectionIds) && pool.connectionIds.length > 0
      ? pool.connectionIds.length
      : 1;

  const dimensionsInfo = [];
  const consumedByThisKey = {};

  for (const dim of plan.dimensions) {
    if (!(dim.limit > Number.EPSILON)) continue;
    const dimKey = { poolId: pool.id, unit: dim.unit, window: dim.window };
    const dimKeyStr = dimensionKeyToString(dimKey);

    const consumedThisKey = await store.peek(input.apiKeyId, dimKey).catch(() => 0);
    consumedByThisKey[dimKeyStr] = consumedThisKey;

    const globalUsedPercent = await getSaturation(input.connectionId, input.provider, dim).catch(
      () => 0
    );

    const effectiveLimit = dim.limit * accountCount;

    let consumedTotal;
    if (COUNTABLE_UNITS.has(dim.unit)) {
      consumedTotal = await store.poolConsumedTotal(pool.id, dimKey).catch(() => 0);
    } else {
      consumedTotal = globalUsedPercent * effectiveLimit;
    }

    dimensionsInfo.push({
      key: dimKey,
      limit: effectiveLimit,
      consumedTotal,
      globalUsedPercent,
    });
  }

  const poolTotalWeight = Array.isArray(pool.allocations)
    ? pool.allocations.reduce((s, a) => s + (Number.isFinite(a.weight) ? a.weight : 0), 0)
    : 0;
  const allocCount = Array.isArray(pool.allocations) ? pool.allocations.length : 0;
  const effectiveWeight =
    poolTotalWeight > 0 ? poolAllocation.weight : allocCount > 0 ? 100 / allocCount : 0;

  const decision = decideFairShare({
    dimensions: dimensionsInfo,
    allocation: { ...poolAllocation, weight: effectiveWeight },
    consumedByThisKey,
    saturationThreshold: SATURATION_THRESHOLD,
  });

  if (decision.kind === "block") {
    return {
      kind: "block",
      reason: messageForReason(decision.reason, input.provider),
      httpStatus: 429,
      retryAfterSeconds: decision.retryAfterMs
        ? Math.ceil(decision.retryAfterMs / 1000)
        : undefined,
    };
  }

  return {
    kind: "allow",
    deprioritize: decision.penalized === true,
  };
}

export async function recordConsumption(input) {
  let allocations;
  try {
    allocations = await listAllocationsForApiKey(input.apiKeyId);
  } catch {
    return;
  }

  if (!allocations.length) return;

  let poolId = null;
  for (const { poolId: pid } of allocations) {
    let p = null;
    try {
      p = await getPool(pid);
    } catch {
      continue;
    }
    if (
      p &&
      (Array.isArray(p.connectionIds)
        ? p.connectionIds.includes(input.connectionId)
        : p.connectionId === input.connectionId)
    ) {
      poolId = pid;
      break;
    }
  }

  if (!poolId) return;

  const plan = await resolvePlan(input.connectionId, input.provider);
  const store = await getQuotaStore();

  for (const dim of plan.dimensions) {
    const dimKey = { poolId, unit: dim.unit, window: dim.window };
    const cost = costForUnit(input.cost, dim.unit);
    if (cost > 0) {
      await store.consume(input.apiKeyId, dimKey, cost).catch(() => {});
    }
  }

  if (input.model) {
    let modelCap = null;
    try {
      modelCap = await getModelCap(poolId, input.apiKeyId, input.model);
    } catch {
      // silent
    }
    if (modelCap && modelCap.capValue > Number.EPSILON) {
      const cost = costForUnit(input.cost, modelCap.capUnit);
      if (cost > 0) {
        const modelBucketPoolId = `${poolId}:model:${input.model}`;
        const modelDimKey = {
          poolId: modelBucketPoolId,
          unit: modelCap.capUnit,
          window: "hourly",
        };
        await store.consume(input.apiKeyId, modelDimKey, cost).catch(() => {});
      }
    }
  }
}

function messageForReason(reason, provider) {
  switch (reason) {
    case "fair-share":
      return `Quota share limit reached for your API key on ${provider}`;
    case "cap-absolute":
      return `Absolute quota cap reached for your API key on ${provider}`;
    case "global-saturated":
      return `Provider ${provider} quota window is saturated; no shared capacity available`;
    default:
      return "Quota share enforcement blocked the request";
  }
}
