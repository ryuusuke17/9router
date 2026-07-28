import { getUsageForProvider } from "open-sse/services/usage.js";
import { updateAccountBuckets } from "./accountBuckets.js";

const CACHE_TTL_MS = 30_000;
const _cache = new Map();

const _rateLimitHeaders = new Map();
const _tokenHeaders = new Map();
const RL_HEADER_TTL_MS = 5 * 60 * 1000;

export function _clearRateLimitHeaders() {
  _rateLimitHeaders.clear();
  _tokenHeaders.clear();
}

function parseDurationMs(raw) {
  const s = raw.trim();
  if (!s) return null;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    switch (m[2]) {
      case "h": total += value * 3_600_000; break;
      case "m": total += value * 60_000; break;
      case "s": total += value * 1000; break;
      case "ms": total += value; break;
    }
  }
  return matched ? total : null;
}

function normalizeTokenReset(raw, nowMs) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/\d{4}-\d{2}-\d{2}/.test(s) && /[T:]/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  const durMs = parseDurationMs(s);
  return durMs === null ? null : nowMs + durMs;
}

function pickTokenTriple(headers, candidates) {
  for (const c of candidates) {
    const limitStr = headers[c.limit];
    const remainingStr = headers[c.remaining];
    if (limitStr === undefined || remainingStr === undefined) continue;
    const limit = Number(limitStr);
    const remaining = Number(remainingStr);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      return { limit, remaining, reset: headers[c.reset] };
    }
  }
  return null;
}

export function storeRateLimitHeaders(connectionId, provider, headers) {
  const key = `${provider}:${connectionId}`;

  const limitStr =
    headers["anthropic-ratelimit-requests-limit"] ??
    headers["x-ratelimit-limit-requests"] ??
    headers["x-ratelimit-limit"];
  const remainingStr =
    headers["anthropic-ratelimit-requests-remaining"] ??
    headers["x-ratelimit-remaining-requests"] ??
    headers["x-ratelimit-remaining"];

  if (limitStr && remainingStr) {
    const limit = Number(limitStr);
    const remaining = Number(remainingStr);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      _rateLimitHeaders.set(key, { limit, remaining, ts: Date.now() });
    }
  }

  const tokenTriple = pickTokenTriple(headers, [
    {
      limit: "anthropic-ratelimit-tokens-limit",
      remaining: "anthropic-ratelimit-tokens-remaining",
      reset: "anthropic-ratelimit-tokens-reset",
    },
    {
      limit: "x-ratelimit-limit-tokens",
      remaining: "x-ratelimit-remaining-tokens",
      reset: "x-ratelimit-reset-tokens",
    },
    {
      limit: "anthropic-ratelimit-input-tokens-limit",
      remaining: "anthropic-ratelimit-input-tokens-remaining",
      reset: "anthropic-ratelimit-input-tokens-reset",
    },
    {
      limit: "anthropic-ratelimit-output-tokens-limit",
      remaining: "anthropic-ratelimit-output-tokens-remaining",
      reset: "anthropic-ratelimit-output-tokens-reset",
    },
  ]);

  if (tokenTriple) {
    const now = Date.now();
    _tokenHeaders.set(key, {
      limit: tokenTriple.limit,
      remaining: tokenTriple.remaining,
      resetAt: normalizeTokenReset(tokenTriple.reset, now),
      ts: now,
    });
  }
}

export function getTokenHeaderSaturation(provider, connectionId) {
  const entry = _tokenHeaders.get(`${provider}:${connectionId}`);
  if (!entry || Date.now() - entry.ts > RL_HEADER_TTL_MS) return null;
  if (!(entry.limit > 0)) return null;
  const used = entry.limit - entry.remaining;
  const saturation = Math.min(1, Math.max(0, used / entry.limit));
  return { saturation, resetAt: entry.resetAt };
}

export function _clearSaturationCache() {
  _cache.clear();
}

function cacheKey(connectionId, provider, dim) {
  return `${provider}:${connectionId}:${dim.unit}:${dim.window}`;
}

function anthropicHeaderSaturation(connectionId) {
  const entry = _rateLimitHeaders.get(`anthropic:${connectionId}`);
  if (!entry || Date.now() - entry.ts > RL_HEADER_TTL_MS) return 0;
  const used = entry.limit - entry.remaining;
  return Math.min(1, Math.max(0, used / entry.limit));
}

async function fetchGenericSaturation(connectionId, provider) {
  try {
    const conn = { id: connectionId, provider };
    const result = await getUsageForProvider(conn);
    if (result && typeof result === "object") {
      const pct = typeof result.percentUsed === "number"
        ? result.percentUsed
        : typeof result.used_percent === "number"
          ? result.used_percent
          : null;
      if (pct !== null && Number.isFinite(pct)) {
        return Math.min(1, Math.max(0, pct));
      }
    }
  } catch {
    // fall through to token-header fallback
  }

  return getTokenHeaderSaturation(provider, connectionId)?.saturation ?? 0;
}

export async function getSaturation(connectionId, provider, dim, connection) {
  const key = cacheKey(connectionId, provider, dim);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  let value = 0;
  try {
    switch (provider) {
      case "anthropic":
      case "claude": {
        try {
          const conn = connection || { id: connectionId, provider: "claude" };
          const usage = await getUsageForProvider(conn);
          try {
            updateAccountBuckets(connectionId, usage, Date.now());
          } catch {
            // buckets are additive, never gate-breaking
          }
          const quotas = usage?.quotas;
          if (quotas && typeof quotas === "object") {
            const key = dim.window === "5h" ? "session (5h)" : dim.window === "weekly" ? "weekly (7d)" : null;
            if (key) {
              const entry = quotas[key];
              if (entry && typeof entry.used === "number") {
                value = Math.min(1, Math.max(0, entry.used / 100));
              }
            }
          }
          if (value === 0) value = anthropicHeaderSaturation(connectionId);
        } catch {
          value = anthropicHeaderSaturation(connectionId);
        }
        break;
      }
      default:
        value = await fetchGenericSaturation(connectionId, provider);
        break;
    }
  } catch {
    value = 0;
  }

  _cache.set(key, { value, ts: Date.now() });
  return value;
}
