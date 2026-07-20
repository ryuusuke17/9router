import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const CHATGPT_BASE = "https://chatgpt.com";
const SESSION_URL = `${CHATGPT_BASE}/api/auth/session`;
const SENTINEL_PREPARE_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements/prepare`;
const SENTINEL_CR_URL = `${CHATGPT_BASE}/backend-api/sentinel/chat-requirements`;
const CONV_URL = `${CHATGPT_BASE}/backend-api/f/conversation`;

const CHATGPT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";
const OAI_CLIENT_VERSION = "prod-81e0c5cdf6140e8c5db714d613337f4aeab94029";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map();

const MODEL_SLUGS = {
  "gpt-5.6-pro": "gpt-5-6-pro",
  "gpt-5.6-thinking": "gpt-5-6-thinking",
  "gpt-5.5-pro-extended": "gpt-5-5-pro-extended",
  "gpt-5.5-pro": "gpt-5-5-pro",
  "gpt-5.5-thinking": "gpt-5-5-thinking",
  "gpt-5.5": "gpt-5-5",
  "o3": "o3",
};

function browserHeaders() {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Origin: CHATGPT_BASE,
    Pragma: "no-cache",
    Referer: `${CHATGPT_BASE}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": CHATGPT_USER_AGENT,
  };
}

function oaiHeaders(deviceId) {
  return {
    "OAI-Language": "en-US",
    "OAI-Device-Id": deviceId,
    "OAI-Client-Version": OAI_CLIENT_VERSION,
  };
}

function deviceIdFor(cookie) {
  return crypto.randomUUID();
}

function buildSessionCookieHeader(rawInput) {
  let s = rawInput.trim();
  if (/^cookie\s*:\s*/i.test(s)) s = s.replace(/^cookie\s*:\s*/i, "");
  if (/__Secure-next-auth\.session-token(?:\.\d+)?\s*=/.test(s)) return s;
  return `__Secure-next-auth.session-token=${s}`;
}

async function exchangeSession(cookie, signal) {
  const headers = { ...browserHeaders(), Accept: "application/json", Cookie: buildSessionCookieHeader(cookie) };
  const response = await fetch(SESSION_URL, { method: "GET", headers, signal });
  if (response.status === 401 || response.status === 403) throw new Error("Invalid session cookie");
  if (response.status >= 400) throw new Error(`Session exchange failed (HTTP ${response.status})`);
  const data = await response.json().catch(() => ({}));
  if (!data.accessToken) throw new Error("Session response missing accessToken — cookie likely expired");
  const expiresAt = data.expires ? new Date(data.expires).getTime() : Date.now() + TOKEN_TTL_MS;
  return {
    accessToken: data.accessToken,
    accountId: data.user?.id || null,
    expiresAt: Math.min(expiresAt, Date.now() + TOKEN_TTL_MS),
  };
}

// Simplified PoW using SHA-256 (Web Crypto API)
async function solveProofOfWork(seed, difficulty, config, log) {
  const maxIter = 100000;
  const cfg = [...config];
  const encoder = new TextEncoder();
  for (let i = 0; i < maxIter; i++) {
    cfg[3] = i;
    const json = JSON.stringify(cfg);
    const b64 = btoa(json);
    const data = encoder.encode(seed + b64);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const hashHex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!difficulty || hashHex.slice(0, difficulty.length) <= difficulty.toLowerCase()) {
      return `gAAAAAB${b64}`;
    }
  }
  log?.warn?.("CGPT-WEB", "PoW exhausted iterations; submitting unsolved token");
  return `gAAAAAB${btoa(JSON.stringify(cfg))}`;
}

async function prepareChatRequirements(accessToken, deviceId, cookie, signal) {
  const headers = {
    ...browserHeaders(), ...oaiHeaders(deviceId),
    "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`,
    Cookie: buildSessionCookieHeader(cookie), Priority: "u=1, i",
  };
  // Simplified prekey config
  const config = [4000, new Date().toString(), 4294705152, 0, CHATGPT_USER_AGENT, "", "", "en-US", "en-US,en", 0, "webdriver-false", "location", "chrome", performance.now(), crypto.randomUUID(), "", 8, Date.now() - performance.now()];
  const p = await solveProofOfWork("", "0fffff", config, null);
  const prepResp = await fetch(SENTINEL_PREPARE_URL, { method: "POST", headers, body: JSON.stringify({ p }), signal });
  let prepData = {};
  try { prepData = await prepResp.json(); } catch {}
  if (!prepData.prepare_token) return prepData;
  const crResp = await fetch(SENTINEL_CR_URL, { method: "POST", headers, body: JSON.stringify({ p, prepare_token: prepData.prepare_token }), signal });
  try { const crData = await crResp.json(); return { ...crData, prepare_token: prepData.prepare_token }; } catch { return prepData; }
}

function parseOpenAIMessages(messages) {
  let systemMsg = "";
  const history = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    if (!content.trim()) continue;
    if (role === "system") systemMsg += (systemMsg ? "\n" : "") + content;
    else if (role === "user" || role === "assistant") history.push({ role, content });
  }
  let currentMsg = "";
  if (history.length > 0 && history[history.length - 1].role === "user") currentMsg = history.pop().content;
  return { systemMsg, history, currentMsg };
}

function buildConversationBody(parsed, modelSlug, parentMessageId) {
  const systemParts = [];
  if (parsed.systemMsg.trim()) systemParts.push(parsed.systemMsg.trim());
  if (parsed.history.length > 0) {
    const formatted = parsed.history.map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${h.content}`).join("\n\n");
    systemParts.push(`Prior conversation (for context — answer only the new user message below):\n\n${formatted}`);
  }
  const messages = [];
  if (systemParts.length > 0) {
    messages.push({ id: crypto.randomUUID(), author: { role: "system" }, content: { content_type: "text", parts: [systemParts.join("\n\n")] } });
  }
  messages.push({ id: crypto.randomUUID(), author: { role: "user" }, content: { content_type: "text", parts: [parsed.currentMsg || ""] } });
  return {
    action: "next", messages, model: modelSlug,
    conversation_id: null, parent_message_id: parentMessageId,
    timezone_offset_min: -new Date().getTimezoneOffset(),
    history_and_training_disabled: true, suggestions: [],
    websocket_request_id: crypto.randomUUID(),
    conversation_mode: { kind: "primary_assistant" },
    supports_buffering: true, force_parallel_switch: "auto",
    paragen_cot_summary_display_override: "allow",
  };
}

async function* readChatGptSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  let eventName = null;
  function flush() {
    if (dataLines.length === 0) { eventName = null; return null; }
    const payload = dataLines.join("\n"); dataLines = []; const sseName = eventName; eventName = null;
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return "done";
    try { const parsed = JSON.parse(trimmed); if (sseName && !parsed.type) parsed.type = sseName; return parsed; } catch { return null; }
  }
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") { const p = flush(); if (p === "done") return; if (p) yield p; continue; }
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) dataLines.push(buffer.trim().slice(5).trimStart());
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally { reader.releaseLock(); }
}

async function* extractContent(eventStream, signal) {
  let conversationId = null;
  let currentId = null;
  let currentParts = "";
  let emittedLen = 0;
  let isLive = false;

  for await (const event of readChatGptSseEvents(eventStream, signal)) {
    if (event.error) {
      yield { error: typeof event.error === "string" ? event.error : event.error.message || "ChatGPT stream error", done: true };
      return;
    }
    if (event.conversation_id) conversationId = event.conversation_id;
    const m = event.message;
    if (!m) continue;
    if (m.author?.role !== "assistant") continue;
    const id = m.id || null;
    const status = m.status || "";
    if (id && id !== currentId) { currentId = id; currentParts = ""; emittedLen = 0; isLive = false; }
    if (status === "in_progress") isLive = true;
    const parts = m.content?.parts || [];
    if (parts.length === 0) continue;
    const cumulative = parts.map((p) => (typeof p === "string" ? p : "")).join("");
    if (cumulative.length > currentParts.length) currentParts = cumulative;
    if (isLive && currentParts.length > emittedLen) {
      const delta = currentParts.slice(emittedLen);
      emittedLen = currentParts.length;
      yield { delta, answer: currentParts, conversationId: conversationId || undefined };
    }
  }
  yield { delta: "", answer: currentParts, conversationId: conversationId || undefined, done: true };
}

function buildStreamingResponse(eventStream, model, cid, created, signal) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseChunk({ id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }] })));
        for await (const chunk of extractContent(eventStream, signal)) {
          if (chunk.error) {
            controller.enqueue(encoder.encode(sseChunk({ id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta: { content: `[Error: ${chunk.error}]` }, finish_reason: null, logprobs: null }] })));
            break;
          }
          if (chunk.done) break;
          if (chunk.delta) {
            controller.enqueue(encoder.encode(sseChunk({ id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null, logprobs: null }] })));
          }
        }
        controller.enqueue(encoder.encode(sseChunk({ id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({ id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null, choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }] })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally { controller.close(); }
    },
  });
}

async function buildNonStreamingResponse(eventStream, model, cid, created, signal) {
  let fullContent = "";
  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.error) return new Response(JSON.stringify({ error: { message: chunk.error, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
    if (chunk.done) break;
    if (chunk.answer) fullContent = chunk.answer;
    else if (chunk.delta) fullContent += chunk.delta;
  }
  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created, model, system_fingerprint: null,
    choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: Math.ceil(fullContent.length / 4), completion_tokens: Math.ceil(fullContent.length / 4), total_tokens: Math.ceil(fullContent.length / 2) },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class ChatGPTWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", PROVIDERS["chatgpt-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing or empty messages array", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: {}, transformedBody: body };
    }

    const cookie = credentials?.apiKey || "";
    if (!cookie) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing session cookie — paste __Secure-next-auth.session-token from chatgpt.com DevTools → Cookies", type: "authentication_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: {}, transformedBody: body };
    }

    const modelSlug = MODEL_SLUGS[model] || model || "gpt-5-5-pro";
    const deviceId = deviceIdFor(cookie);

    try {
      // Step 1: Exchange cookie for JWT
      log?.info?.("CGPT-WEB", "Exchanging session cookie for access token...");
      const session = await exchangeSession(cookie, signal);
      log?.info?.("CGPT-WEB", `Access token acquired (${session.accessToken.length} chars)`);

      // Step 2: Get chat requirements (Sentinel)
      log?.info?.("CGPT-WEB", "Fetching chat requirements...");
      const requirements = await prepareChatRequirements(session.accessToken, deviceId, cookie, signal);

      // Step 3: Build conversation request
      const parsed = parseOpenAIMessages(messages);
      if (!parsed.currentMsg.trim()) {
        return { response: new Response(JSON.stringify({ error: { message: "No user message found", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: {}, transformedBody: body };
      }

      const parentMessageId = crypto.randomUUID();
      const convBody = buildConversationBody(parsed, modelSlug, parentMessageId);
      if (requirements?.token) convBody.conversation_mode.kind = "primary_assistant";

      const convHeaders = {
        ...browserHeaders(), ...oaiHeaders(deviceId),
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        Cookie: buildSessionCookieHeader(cookie),
        ...(requirements?.token ? { "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token } : {}),
        ...(requirements?.persona ? { "OpenAI-Sentinel-Persona": requirements.persona } : {}),
      };

      log?.info?.("CGPT-WEB", `POST conversation (model=${modelSlug}, msg=${parsed.currentMsg.length} chars)`);
      const convResp = await fetch(CONV_URL, {
        method: "POST", headers: convHeaders, body: JSON.stringify(convBody), signal,
      });

      if (!convResp.ok) {
        let errMsg = `ChatGPT returned HTTP ${convResp.status}`;
        if (convResp.status === 401 || convResp.status === 403) errMsg = "ChatGPT auth failed — session cookie expired. Re-paste from chatgpt.com DevTools → Cookies.";
        else if (convResp.status === 429) errMsg = "ChatGPT rate limited. Wait and retry.";
        log?.warn?.("CGPT-WEB", errMsg);
        return { response: new Response(JSON.stringify({ error: { message: errMsg, type: "upstream_error", code: `HTTP_${convResp.status}` } }), { status: convResp.status, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: convHeaders, transformedBody: convBody };
      }

      if (!convResp.body) {
        return { response: new Response(JSON.stringify({ error: { message: "ChatGPT returned empty response body", type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: convHeaders, transformedBody: convBody };
      }

      const cid = `chatcmpl-cgpt-${crypto.randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        const sseStream = buildStreamingResponse(convResp.body, model, cid, created, signal);
        return { response: new Response(sseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }), url: CONV_URL, headers: convHeaders, transformedBody: convBody };
      }

      const finalResponse = await buildNonStreamingResponse(convResp.body, model, cid, created, signal);
      return { response: finalResponse, url: CONV_URL, headers: convHeaders, transformedBody: convBody };
    } catch (err) {
      const msg = err.message || String(err);
      log?.error?.("CGPT-WEB", `Execute failed: ${msg}`);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { response: new Response(JSON.stringify({ error: { message: "Request cancelled", type: "upstream_error" } }), { status: 499, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: {}, transformedBody: body };
      }
      return { response: new Response(JSON.stringify({ error: { message: `ChatGPT error: ${msg}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: CONV_URL, headers: {}, transformedBody: body };
    }
  }
}

export default ChatGPTWebExecutor;
