// Shared validation functions for web-cookie providers.
// Returns { valid: boolean, error: string | null }.
// Each function accepts (apiKey, fetchFn) where fetchFn defaults to global fetch.

async function defaultFetch(url, opts) {
  return fetch(url, opts);
}

export async function validateGeminiWeb(apiKey, fetchFn = defaultFetch) {
  const psid = apiKey.replace(/^__Secure-1PSID=/, "");
  const res = await fetchFn("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", {
    method: "POST",
    headers: {
      Cookie: `__Secure-1PSID=${psid}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/",
    },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[null, "[[\"ping\"]", null, "[]"]])),
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid __Secure-1PSID cookie — re-paste from gemini.google.com DevTools → Cookies" };
  }
  return { valid: true, error: null };
}

export async function validateDeepseekWeb(apiKey, fetchFn = defaultFetch) {
  const userToken = apiKey.replace(/^userToken=/, "");
  const res = await fetchFn("https://chat.deepseek.com/api/v0/user/info", {
    headers: {
      Authorization: `Bearer ${userToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid userToken — re-paste from chat.deepseek.com DevTools → Application → Local Storage → userToken" };
  }
  return { valid: true, error: null };
}

export async function validateQwenWeb(apiKey, fetchFn = defaultFetch) {
  const res = await fetchFn("https://chat.qwen.ai/api/v2/chat/list", {
    headers: {
      Cookie: apiKey,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid Cookie header — re-paste full Cookie string from chat.qwen.ai DevTools" };
  }
  return { valid: true, error: null };
}

export async function validateKimiWeb(apiKey, fetchFn = defaultFetch) {
  const accessToken = apiKey.replace(/^access_token=/, "");
  const res = await fetchFn("https://www.kimi.com/api/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://www.kimi.com",
      Referer: "https://www.kimi.com/",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid access_token — re-paste from www.kimi.com DevTools → Application → Local Storage" };
  }
  return { valid: true, error: null };
}

export async function validateBlackboxWeb(apiKey, fetchFn = defaultFetch) {
  const sessionToken = apiKey.replace(/^__Secure-authjs\.session-token=/, "").replace(/^next-auth\.session-token=/, "");
  const res = await fetchFn("https://app.blackbox.ai/api/chat/user", {
    headers: {
      Cookie: `__Secure-authjs.session-token=${sessionToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://app.blackbox.ai",
      Referer: "https://app.blackbox.ai/",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid session cookie — re-paste __Secure-authjs.session-token from app.blackbox.ai DevTools → Cookies" };
  }
  return { valid: true, error: null };
}

export async function validateZenmuxFree(apiKey, fetchFn = defaultFetch) {
  const ctoken = apiKey.match(/ctoken=([^;]+)/)?.[1] || "";
  if (!ctoken) {
    return { valid: false, error: "ctoken not found in ZenMux cookie — cookie must include ctoken=... (plus sessionId=... and sessionId.sig=...). Re-export from zenmux.ai while logged in" };
  }
  const url = new URL("https://zenmux.ai/api/anthropic/v1/messages/models");
  url.searchParams.set("ctoken", ctoken);
  const zmRes = await fetchFn(url.toString(), {
    headers: {
      Cookie: apiKey,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Origin: "https://zenmux.ai",
      Referer: "https://zenmux.ai/platform/chat",
    },
  });
  const valid = zmRes.status !== 401 && zmRes.status !== 403;
  return { valid, error: valid ? null : "ZenMux Free: cookies expired or invalid — re-export ALL cookies from zenmux.ai (ctoken + sessionId + sessionId.sig)" };
}

export async function validateGrokWeb(apiKey, fetchFn = defaultFetch) {
  const token = apiKey.startsWith("sso=") ? apiKey.slice(4) : apiKey;
  // Cloudflare-bypass: send POST with same browser fingerprint headers as GrokWebExecutor
  const randomHex = (n) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const statsigId = Buffer.from("e:TypeError: Cannot read properties of null (reading 'children')").toString("base64");
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const res = await fetchFn("https://grok.com/rest/app-chat/conversations/new", {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      Cookie: `sso=${token}`,
      Origin: "https://grok.com",
      Pragma: "no-cache",
      Referer: "https://grok.com/",
      "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "x-statsig-id": statsigId,
      "x-xai-request-id": crypto.randomUUID(),
      traceparent: `00-${traceId}-${spanId}-00`,
    },
    body: JSON.stringify({
      temporary: true, modelName: "grok-4", modelMode: "MODEL_MODE_GROK_4", message: "ping",
      fileAttachments: [], imageAttachments: [],
      disableSearch: false, enableImageGeneration: false, returnImageBytes: false,
      returnRawGrokInXaiRequest: false, enableImageStreaming: false, imageGenerationCount: 0,
      forceConcise: false, toolOverrides: {}, enableSideBySide: true, sendFinalMetadata: true,
      isReasoning: false, disableTextFollowUps: true, disableMemory: true,
      forceSideBySide: false, isAsyncChat: false, disableSelfHarmShortCircuit: false,
    }),
  });
  // Cookie valid = any non-401/403 response (200, 400, 429 all mean cookie accepted)
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid SSO cookie — re-paste from grok.com DevTools → Cookies → sso" };
  }
  return { valid: true, error: null };
}

export async function validatePerplexityWeb(apiKey, fetchFn = defaultFetch) {
  let sessionToken = apiKey;
  if (sessionToken.startsWith("__Secure-next-auth.session-token=")) {
    sessionToken = sessionToken.slice("__Secure-next-auth.session-token=".length);
  }
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const res = await fetchFn("https://www.perplexity.ai/rest/sse/perplexity_ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "X-App-ApiClient": "default",
      "X-App-ApiVersion": "2.18",
      Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify({
      query_str: "ping",
      params: {
        query_str: "ping", search_focus: "internet", mode: "concise", model_preference: "pplx_pro",
        sources: ["web"], attachments: [],
        frontend_uuid: crypto.randomUUID(), frontend_context_uuid: crypto.randomUUID(),
        version: "2.18", language: "en-US", timezone: tz,
        search_recency_filter: null, is_incognito: true, use_schematized_api: true, last_backend_uuid: null,
      },
    }),
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid session cookie — re-paste __Secure-next-auth.session-token from perplexity.ai" };
  }
  return { valid: true, error: null };
}

const validators = {
  "gemini-web": validateGeminiWeb,
  "deepseek-web": validateDeepseekWeb,
  "qwen-web": validateQwenWeb,
  "kimi-web": validateKimiWeb,
  "blackbox-web": validateBlackboxWeb,
  "zenmux-free": validateZenmuxFree,
  "perplexity-web": validatePerplexityWeb,
  "grok-web": validateGrokWeb,
};

export function getWebCookieValidator(provider) {
  return validators[provider] || null;
}
