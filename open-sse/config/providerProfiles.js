import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PROFILES = {
  oauth: {
    providerFailureThreshold: envInt("VANSROUTER_PROVIDER_FAILURE_OAUTH_THRESHOLD", 10),
    providerFailureWindowMs: envInt("VANSROUTER_PROVIDER_FAILURE_OAUTH_WINDOW_MS", 15 * 60 * 1000),
    providerCooldownMs: envInt("VANSROUTER_PROVIDER_FAILURE_OAUTH_COOLDOWN_MS", 5 * 60 * 1000),
  },
  apikey: {
    providerFailureThreshold: envInt("VANSROUTER_PROVIDER_FAILURE_APIKEY_THRESHOLD", 5),
    providerFailureWindowMs: envInt("VANSROUTER_PROVIDER_FAILURE_APIKEY_WINDOW_MS", 30 * 1000),
    providerCooldownMs: envInt("VANSROUTER_PROVIDER_FAILURE_APIKEY_COOLDOWN_MS", 30 * 1000),
  },
  local: {
    providerFailureThreshold: envInt("VANSROUTER_PROVIDER_FAILURE_LOCAL_THRESHOLD", 2),
    providerFailureWindowMs: envInt("VANSROUTER_PROVIDER_FAILURE_LOCAL_WINDOW_MS", 5 * 60 * 1000),
    providerCooldownMs: envInt("VANSROUTER_PROVIDER_FAILURE_LOCAL_COOLDOWN_MS", 60 * 1000),
  },
};

const _categoryCache = new Map();

function providerSetIncludes(providerSet, id) {
  if (Array.isArray(providerSet)) {
    return providerSet.some((p) => String(p).toLowerCase() === id);
  }
  if (providerSet && typeof providerSet === "object") {
    return Object.keys(providerSet).some((key) => String(key).toLowerCase() === id);
  }
  return false;
}

function resolveProviderCategory(provider) {
  if (!provider) return "apikey";
  if (_categoryCache.has(provider)) return _categoryCache.get(provider);

  const id = String(provider).toLowerCase();
  let category = "apikey";
  if (providerSetIncludes(OAUTH_PROVIDERS, id)) {
    category = "oauth";
  } else if (providerSetIncludes(APIKEY_PROVIDERS, id)) {
    category = "apikey";
  } else if (id === "ollama" || id === "local" || id === "lmstudio" || id === "kobold") {
    category = "local";
  }

  _categoryCache.set(provider, category);
  return category;
}

export function getProviderResilienceProfile(provider) {
  if (provider === "a6api" || provider === "a6api-cli") {
    return {
      providerFailureThreshold: envInt("VANSROUTER_PROVIDER_FAILURE_A6API_THRESHOLD", 5),
      providerFailureWindowMs: envInt("VANSROUTER_PROVIDER_FAILURE_A6API_WINDOW_MS", 30 * 1000),
      providerCooldownMs: 3000,
    };
  }
  return PROFILES[resolveProviderCategory(provider)] ?? PROFILES.apikey;
}

export function clearProviderResilienceCache() {
  _categoryCache.clear();
}
