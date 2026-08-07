import { createHmac, createHash, randomUUID } from "node:crypto";

export const RAYCAST_CHAT_URL = "https://backend.raycast.com/api/v1/ai/chat_completions";
export const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
export const RAYCAST_DEFAULT_USER_AGENT =
  "Raycast/1.104.20 (macOS Version 26.5.1 (Build 25F80))";
export const RAYCAST_DEFAULT_EXPERIMENTAL = "chatBranching, mcpHTTPServer";

/** Community-extracted default; override via providerSpecificData.sigSecret or RAYCAST_SIG_SECRET. */
export const RAYCAST_DEFAULT_SIG_SECRET =
  "6bc455473576ce2cd6f70426caff867aabbe3f7291c1a79681af5e8ce0ca1408";

function rot13rot5(input) {
  return input.replace(/[A-Za-z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return String.fromCharCode(((code - 48 + 5) % 10) + 48);
  });
}

export function signatureV2(timestamp, deviceId, payload, secret) {
  const bodyHash = createHash("sha256").update(payload).digest("hex");
  const message = [timestamp, deviceId, bodyHash].map(rot13rot5).join(".");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function raycastJwt(aid, secret) {
  const iat = Date.now() / 1000;
  const header = base64UrlJson({ typ: "JWT", alg: "HS256" });
  const payload = base64UrlJson({ aid, exp: iat + 60, iat });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function decodeAidFromRaycastJwt(jwt) {
  const parts = String(jwt || "").trim().split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.aid || null;
  } catch {
    return null;
  }
}

export function resolveRaycastSecrets(credentials) {
  const psd = credentials.providerSpecificData || {};
  const bearerToken = (credentials.accessToken || "").trim();
  const deviceId = (psd.deviceId || "").trim();
  const aid = (psd.aid || deviceId || "").trim();
  const sigSecret = (psd.sigSecret || process.env.RAYCAST_SIG_SECRET || RAYCAST_DEFAULT_SIG_SECRET).trim();

  if (!bearerToken) throw new Error("Raycast bearer token is required");
  if (!deviceId) throw new Error("Raycast device ID is required");
  if (!sigSecret) throw new Error("Raycast signature secret is required");

  return { bearerToken, deviceId, aid, sigSecret };
}

export function buildRaycastHeaders(payload, credentials) {
  const { bearerToken, deviceId, aid, sigSecret } = resolveRaycastSecrets(credentials);
  const psd = credentials.providerSpecificData || {};
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const experimental = psd.experimental || RAYCAST_DEFAULT_EXPERIMENTAL;
  const userAgent = psd.userAgent || RAYCAST_DEFAULT_USER_AGENT;

  return {
    Accept: "application/json",
    Authorization: `Bearer ${bearerToken}`,
    "X-Raycast-Timestamp": timestamp,
    "Accept-Language": "en-US,en;q=0.9",
    "X-Raycast-DeviceId": deviceId,
    "Content-Type": "application/json",
    "X-Raycast-Signature-v2": signatureV2(timestamp, deviceId, payload, sigSecret),
    "X-Raycast-Experimental": experimental,
    "X-Raycast-Signature": raycastJwt(aid, sigSecret),
    "User-Agent": userAgent,
  };
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && part.type === "text") {
        return String(part.text || "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function convertOpenAiMessages(messages) {
  let systemInstruction = "markdown";
  const raycastMessages = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "system" && index === 0) {
      systemInstruction = contentToText(message.content);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      raycastMessages.push({
        author: message.role,
        content: { text: contentToText(message.content) },
      });
    }
  }
  return { raycastMessages, systemInstruction };
}

export function inferProviderInfo(modelId) {
  if (modelId.startsWith("openai_o1-")) {
    return { provider: "openai", model: modelId.slice("openai_o1-".length) };
  }
  const providers = [
    "anthropic", "baseten", "google", "groq", "mistral",
    "openai", "perplexity", "raycast", "together", "xai",
  ];
  for (const provider of providers) {
    const prefix = `${provider}-`;
    if (modelId.startsWith(prefix)) {
      return { provider, model: modelId.slice(prefix.length) };
    }
  }
  if (modelId.includes("/")) return { provider: "baseten", model: modelId };
  return { provider: "openai", model: modelId || "gpt-5-mini" };
}

export function buildRaycastChatBody(modelId, messages, temperature) {
  const { provider, model } = inferProviderInfo(modelId);
  const { raycastMessages, systemInstruction } = convertOpenAiMessages(messages);

  if (raycastMessages.length === 0) {
    throw new Error("Raycast requires at least one user or assistant message");
  }

  return JSON.stringify({
    model,
    provider,
    messages: raycastMessages,
    system_instruction: systemInstruction,
    temperature: temperature ?? 0.5,
    additional_system_instructions: "",
    debug: false,
    locale: "en-US",
    source: "ai_chat",
    thread_id: randomUUID(),
    tools: [],
  });
}

/**
 * Parse a Raycast chat SSE body. Returns text accumulated from `data:` chunks
 * and, if Raycast emitted an `event: error`, the surfaced error object (as sent)
 * plus its pre-extracted message/status so callers can produce a real failure
 * instead of a silent empty success.
 */
export function parseRaycastSseEvents(responseText) {
  let fullText = "";
  let currentEvent = "";
  for (const line of responseText.split("\n")) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
      continue;
    }
    if (!line.startsWith("data:") && !line.startsWith(":")) continue;
    const raw = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!raw) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Ignore malformed / comment SSE lines.
      currentEvent = null;
      continue;
    }
    if (currentEvent === "error") {
      return {
        text: fullText,
        error: {
          message:
            data?.error?.message ||
            data?.message ||
            String(data?.error?.type || data?.type || "Raycast upstream error"),
          status: data?.error?.http_status || data?.http_status || data?.error?.status || 401,
        },
      };
    }
    if (data.text) fullText += data.text;
    currentEvent = null;
  }
  return { text: fullText, error: null };
}

export function parseRaycastSseText(responseText) {
  return parseRaycastSseEvents(responseText).text;
}

/**
 * Probe Raycast's real chat endpoint with a single minimal request and surface
 * whether the stored credential actually authenticates. The models endpoint
 * returns a 200 + full model list even for an invalid / cookie-style token, so a
 * models probe alone cannot validate a token — a chat turn is the only reliable
 * check. Resolves `{ ok: true }` on a successful completion; resolves
 * `{ ok: false, message, status }` on an upstream auth/error SSE event or a
 * non-2xx upstream response.
 */
export async function probeRaycastChat(credentials, options = {}) {
  let payload;
  try {
    payload = buildRaycastChatBody(
      "openai-gpt-4o-mini",
      [{ role: "user", content: "ping" }],
      0
    );
  } catch (err) {
    return { ok: false, error: err.message, status: 400 };
  }

  let headers;
  try {
    headers = buildRaycastHeaders(payload, credentials);
  } catch (err) {
    return { ok: false, error: err.message, status: 400 };
  }

  let res;
  try {
    res = await fetch(RAYCAST_CHAT_URL, {
      method: "POST",
      headers,
      body: payload,
      signal: options.signal || undefined,
    });
  } catch (err) {
    return { ok: false, error: `Raycast probe request failed: ${err.message}`, status: 502 };
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, error: `Raycast probe HTTP ${res.status}: ${raw.slice(0, 200)}`, status: res.status };
  }

  const { error } = parseRaycastSseEvents(raw);
  if (error) {
    return { ok: false, error: error.message, status: Number(error.status) || 401 };
  }
  return { ok: true, error: null, status: res.status };
}

export async function fetchRaycastModels(credentials, options) {
  const headers = buildRaycastHeaders("{}", credentials);
  const res = await fetch(RAYCAST_MODELS_URL, { method: "GET", headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Raycast models error [${res.status}]: ${text.slice(0, 300)}`);
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Raycast models returned invalid JSON`);
  }
  // surface auth failures that the models endpoint reports as a 200 + error body
  if (data?.error && !Array.isArray(data?.models)) {
    throw new Error(
      `Raycast models auth error: ${String(data.error.message || data.error).slice(0, 300)}`
    );
  }
  const includePremium = options?.includePremium ?? true;
  const includeDeprecated = options?.includeDeprecated ?? true;
  return (data.models || []).filter((model) => {
    if (!includePremium && model.requires_better_ai) return false;
    if (!includeDeprecated && model.availability === "deprecated") return false;
    return true;
  });
}