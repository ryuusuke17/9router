export const QUOTA_UNITS = ["percent", "requests", "tokens", "usd"];

export const QUOTA_WINDOWS = ["5h", "hourly", "daily", "weekly", "monthly"];

export const POLICIES = ["hard", "soft", "burst"];

export const WINDOW_MS = {
  hourly: 60 * 60 * 1000,
  "5h": 5 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export const KNOWN_POLICIES = new Set(POLICIES);

export function dimensionKeyToString(k) {
  return `${k.poolId}:${k.unit}:${k.window}`;
}

export function normalizePolicy(policy) {
  return KNOWN_POLICIES.has(policy) ? policy : "hard";
}

export function costForUnit(cost, unit) {
  switch (unit) {
    case "tokens": return cost.tokens ?? 0;
    case "usd": return cost.usd ?? 0;
    case "requests": return cost.requests ?? 1;
    case "percent": return 0;
    default: return 0;
  }
}
