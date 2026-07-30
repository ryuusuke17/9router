export const RATE_LIMIT_COOLDOWN_MS = 60_000;
export const QUOTA_EXHAUSTED_COOLDOWN_MS = 3_600_000;

const DAILY_QUOTA_PATTERNS = [
  /today'?s quota/i,
  /daily quota (exhaust|exceed|reached|used)/i,
  /daily limit (exhaust|exceed|reached|used)/i,
  /per.?day (limit|quota)/i,
  /daily.*exhaust/i,
  /exhaust.*daily/i,
  /daily.*cap/i,
  /cap.*daily/i,
  /reset.*tomorrow/i,
  /try again tomorrow/i,
  /come back tomorrow/i,
  /free.*usage.*exhaust/i,
  /used all.*free usage/i,
];

const QUOTA_EXHAUSTED_PATTERNS = [
  /monthly.*limit/i,
  /monthly.*quota/i,
  /per.?month.*limit/i,
  /quota.*exceed/i,
  /exceed.*quota/i,
  /insufficient.*quota/i,
  /billing.*cap/i,
  /credit.*exhaust/i,
  /out of credits/i,
  /hard.?limit/i,
  /plan.*limit/i,
  /resource.*exhaust/i,
  /check.*quota/i,
  /individual quota reached/i,
  /enable overages/i,
  /402.*billing/i,
  /billing.*required/i,
  /payment.*required/i,
];

function bodyToText(body) {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

export function looksLikeDailyQuota(body) {
  const text = bodyToText(body);
  if (!text) return false;
  return DAILY_QUOTA_PATTERNS.some((pat) => pat.test(text));
}

export function looksLikeQuotaExhausted(body) {
  const text = bodyToText(body);
  if (!text) return false;
  return QUOTA_EXHAUSTED_PATTERNS.some((pat) => pat.test(text));
}

export function isGeminiGenericRateLimit(errorText) {
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  if (!text) return false;
  const isGenericResourceExhausted = /resource has been exhausted/i.test(text);
  const isGenericQuotaExceeded = /exceeded your (current )?quota/i.test(text);
  if (!isGenericResourceExhausted && !isGenericQuotaExceeded) return false;
  const hasSpecificQualifier = /per[- ]?minute|rpm|daily quota|per[- ]?day|monthly|user[- ]?project|billing required|payment required|reset (tomorrow|at)|will reset/i.test(text);
  return !hasSpecificQualifier;
}

export function getMsUntilTomorrowMidnightUTC(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return Math.max(1, next.getTime() - now.getTime());
}

export function classify429(response) {
  if (!response) {
    return { kind: "rate_limit", cooldownMs: RATE_LIMIT_COOLDOWN_MS };
  }
  if (
    (response.provider === "gemini" || response.provider === "gemini-cli") &&
    isGeminiGenericRateLimit(response.body)
  ) {
    return { kind: "rate_limit", cooldownMs: RATE_LIMIT_COOLDOWN_MS };
  }
  if (looksLikeDailyQuota(response.body)) {
    return { kind: "daily_quota", cooldownMs: getMsUntilTomorrowMidnightUTC() };
  }
  if (looksLikeQuotaExhausted(response.body)) {
    return { kind: "quota_exhausted", cooldownMs: QUOTA_EXHAUSTED_COOLDOWN_MS };
  }
  return { kind: "rate_limit", cooldownMs: RATE_LIMIT_COOLDOWN_MS };
}

export function classify429FromError(err) {
  if (err === null || typeof err !== "object") return null;
  const e = err;

  let status;
  let body;

  if (typeof e.status === "number") {
    status = e.status;
  } else if (typeof e.statusCode === "number") {
    status = e.statusCode;
  }

  if (e.response && typeof e.response === "object") {
    const resp = e.response;
    if (typeof resp.status === "number" && status === undefined) {
      status = resp.status;
    }
    if (resp.data !== undefined) {
      body = resp.data;
    } else if (resp.body !== undefined) {
      body = resp.body;
    }
  }

  if (body === undefined) {
    if (e.body !== undefined) {
      body = e.body;
    } else if (typeof e.message === "string") {
      body = e.message;
    }
  }

  if (typeof status === "number" && status !== 429) return null;

  return classify429({ status: status ?? 429, body });
}

export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return null;

  const relMatch = trimmed.match(/^(\d+)([smh])$/i);
  if (relMatch) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    if (Number.isFinite(n)) {
      if (unit === "s") return n;
      if (unit === "m") return n * 60;
      if (unit === "h") return n * 3600;
    }
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(0, Math.floor((ts - Date.now()) / 1000));
  }

  return null;
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  if (typeof headers.get === "function") {
    const v = headers.get(name);
    if (v) return v;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

export function retryAfterFromResponse(response) {
  if (!response) return null;
  return parseRetryAfter(getHeader(response.headers, "retry-after"));
}
