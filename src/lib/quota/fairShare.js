import { normalizePolicy } from "./dimensions.js";

const KNOWN_POLICIES = new Set(["hard", "soft", "burst"]);

function normalizePolicySafe(policy) {
  return KNOWN_POLICIES.has(policy) ? policy : "hard";
}

function dimensionKeyString(key) {
  return `${key.poolId}:${key.unit}:${key.window}`;
}

export function decideFairShare(input) {
  const { dimensions, allocation, consumedByThisKey, saturationThreshold } = input;

  if (dimensions.length === 0) {
    return { kind: "allow", reason: "ok" };
  }

  const effectivePolicy = normalizePolicySafe(allocation.policy);
  let anyPenalized = false;

  for (const dim of dimensions) {
    const dKey = dimensionKeyString(dim.key);
    const consumed = consumedByThisKey[dKey] ?? 0;
    const fairShare = (allocation.weight / 100) * dim.limit;

    if (
      allocation.capValue !== undefined &&
      allocation.capUnit === dim.key.unit &&
      consumed >= allocation.capValue
    ) {
      return { kind: "block", reason: "cap-absolute" };
    }

    if (dim.consumedTotal >= dim.limit) {
      return { kind: "block", reason: "global-saturated" };
    }

    const isStrict = dim.globalUsedPercent >= saturationThreshold;

    if (isStrict) {
      switch (effectivePolicy) {
        case "hard":
          if (consumed >= fairShare) {
            return { kind: "block", reason: "fair-share" };
          }
          break;
        case "soft":
          if (consumed >= fairShare) {
            anyPenalized = true;
          }
          break;
        case "burst":
          break;
      }
    } else {
      switch (effectivePolicy) {
        case "hard":
          if (consumed >= dim.limit) {
            return { kind: "block", reason: "global-saturated" };
          }
          break;
        case "soft":
          if (consumed >= fairShare) {
            anyPenalized = true;
          }
          break;
        case "burst":
          break;
      }
    }
  }

  return {
    kind: "allow",
    reason: "ok",
    penalized: anyPenalized || undefined,
  };
}
