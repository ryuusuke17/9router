// Shared validation functions for web-cookie providers.
// Returns { valid: boolean, error: string | null }.
// Each function accepts (apiKey, fetchFn) where fetchFn defaults to global fetch.

async function defaultFetch(url, opts) {
  return fetch(url, opts);
}

export async function validateChatgptWeb(apiKey, fetchFn = defaultFetch) {
  const sessionToken = apiKey.replace(/^__Secure-next-auth\.session-token=/, "").replace(/^__Host-authjs\.session-token=/, "");
  const res = await fetchFn("https://chatgpt.com/backend-api/models", {
    headers: {
      Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid session cookie — re-paste __Secure-next-auth.session-token from chatgpt.com" };
  }
  return { valid: true, error: null };
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
  const res = await fetchFn("https://www.kimi.com/api/user/info", {
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
  "chatgpt-web": validateChatgptWeb,
  "gemini-web": validateGeminiWeb,
  "deepseek-web": validateDeepseekWeb,
  "qwen-web": validateQwenWeb,
  "kimi-web": validateKimiWeb,
  "blackbox-web": validateBlackboxWeb,
  "zenmux-free": validateZenmuxFree,
  "perplexity-web": validatePerplexityWeb,
};

export function getWebCookieValidator(provider) {
  return validators[provider] || null;
}
