// Cookie normalization helpers for web-cookie providers
// Adapted from OmniRoute/src/lib/providers/webCookieAuth.ts for 9router's JS/ESM style.

export function stripCookieInputPrefix(rawValue) {
  const trimmed = (rawValue || "").trim();
  if (!trimmed) return "";
  const withoutBearer = trimmed.replace(/^bearer\s+/i, "");
  return withoutBearer.replace(/^cookie:/i, "").trim();
}

export function normalizeSessionCookieHeader(rawValue, defaultCookieName) {
  const normalized = stripCookieInputPrefix(rawValue);
  if (!normalized) return "";
  if (normalized.includes("=")) return normalized;
  return `${defaultCookieName}=${normalized}`;
}

export function extractCookieValue(rawValue, cookieName) {
  const trimmed = stripCookieInputPrefix(rawValue);
  if (!trimmed) return "";
  if (trimmed.includes(";")) {
    const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = trimmed.match(new RegExp("(?:^|;\\s*)" + escaped + "=([^;\\s]+)"));
    return match ? match[1] : "";
  }
  const prefix = `${cookieName}=`;
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  return trimmed;
}

export function buildGrokCookieHeader(rawValue) {
  const sso = extractCookieValue(rawValue, "sso");
  if (!sso) return "";
  const parts = [`sso=${sso}`];
  for (const name of ["sso-rw", "cf_clearance", "__cf_bm"]) {
    if (new RegExp("(?:^|;\\s*)" + name + "=").test(rawValue)) {
      const value = extractCookieValue(rawValue, name);
      if (value) parts.push(`${name}=${value}`);
    }
  }
  return parts.join("; ");
}

export function buildQwenCookieHeader(rawValue) {
  const trimmed = stripCookieInputPrefix(rawValue);
  if (!trimmed || !trimmed.includes("=")) return "";
  return trimmed;
}

export function extractQwenToken(rawValue) {
  const trimmed = stripCookieInputPrefix(rawValue);
  if (!trimmed) return "";
  if (!trimmed.includes("=")) return trimmed;
  const match = trimmed.match(/(?:^|;\s*)token=([^;\s]+)/);
  return match ? match[1] : "";
}

export function extractKimiAccessToken(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "";
  const bearer = raw.match(/^(?:authorization:\s*)?bearer\s+([^;\s]+)/i);
  if (bearer) return bearer[1];
  const trimmed = stripCookieInputPrefix(raw);
  for (const key of ["access_token", "kimi-auth"]) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = trimmed.match(new RegExp(`(?:^|[\\s;])${escaped}=([^;\\s]+)`));
    if (match) return match[1];
  }
  return !trimmed.includes("=") && !trimmed.includes(";") ? trimmed : "";
}

export function normalizeSessionCookieHeaders(rawValues, defaultCookieName) {
  const seen = new Set();
  const normalizedHeaders = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") continue;
    const normalized = normalizeSessionCookieHeader(rawValue, defaultCookieName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedHeaders.push(normalized);
  }
  return normalizedHeaders;
}
