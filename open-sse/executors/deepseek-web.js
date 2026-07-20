import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { U: Keccak } = require("../lib/deepseek-pow-solver.cjs");

const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;
const COMPLETION_URL = `${DEEPSEEK_API_BASE}/v0/chat/completion`;

const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: DEEPSEEK_WEB_BASE,
  Referer: `${DEEPSEEK_WEB_BASE}/`,
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "X-Client-Bundle-Id": "com.deepseek.chat",
  "X-Client-Locale": "en-US",
  "X-Client-Platform": "web",
  "X-Client-Version": "2.0.0",
};

// Token cache (keyed by userToken -> short-lived access token)
const tokenCache = new Map();
const sessionCache = new Map();

function extractUserToken(credentials) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.value === "string") return parsed.value;
  } catch {
    // not JSON, use raw
  }
  return raw;
}

function errorResponse(status, message, dsCode) {
  return new Response(JSON.stringify({
    error: { message, type: "upstream_error", code: dsCode ?? `HTTP_${status}` },
  }), { status, headers: { "Content-Type": "application/json" } });
}

function resolveModelOptions(model, bodyObj) {
  const m = (model || "").toLowerCase();
  const modelType = m.includes("pro") || m.includes("expert") ? "expert" : "default";
  const thinkingEnabled =
    m.includes("r1") || m.includes("think") || m.includes("reason") ||
    bodyObj?.thinking_enabled === true || bodyObj?.thinking === true || !!bodyObj?.reasoning_effort;
  const searchEnabled =
    m.includes("search") || bodyObj?.search_enabled === true ||
    bodyObj?.search === true || bodyObj?.web_search === true;
  return { modelType, thinkingEnabled, searchEnabled };
}

function generateFakeCookie() {
  const ts = Date.now();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const uid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`;
}

// PoW solver using Keccak (SHA3) matching DeepSeekHashV1 algorithm
function createKeccakHash() {
  const self = {};
  self._sponge = new Keccak({ capacity: 256, padding: 6 });
  self.update = (s) => {
    self._sponge.absorb(Buffer.from(s, "utf8"));
    return self;
  };
  self.digest = (fmt) => {
    return self._sponge.squeeze(6).toString(fmt || "hex");
  };
  self.copy = () => {
    const c = {};
    c._sponge = self._sponge.copy();
    c.update = (s) => {
      c._sponge.absorb(Buffer.from(s, "utf8"));
      return c;
    };
    c.digest = (fmt) => {
      return c._sponge.squeeze(6).toString(fmt || "hex");
    };
    return c;
  };
  return self;
}

async function solvePow(challenge) {
  const { algorithm, challenge: ch, salt, difficulty, expire_at, signature, target_path } = challenge;
  if (algorithm !== "DeepSeekHashV1") throw new Error(`Unsupported PoW algorithm: ${algorithm}`);
  const prefix = `${salt}_${expire_at}_`;
  const h = createKeccakHash();
  h.update(prefix);
  for (let nonce = 0; nonce < difficulty; nonce++) {
    if (h.copy().update(String(nonce)).digest("hex") === ch) {
      return btoa(JSON.stringify({
        algorithm, challenge: ch, salt, answer: nonce, signature, target_path,
      }));
    }
  }
  return btoa(JSON.stringify({
    algorithm, challenge: ch, salt, answer: 0, signature, target_path,
  }));
}

function extractMessageText(content) {
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return String(content || "");
}

function messagesToPrompt(messages, historyWindow = 0) {
  if (messages.length === 0) return "";
  const systemParts = [];
  const conversation = [];
  let lastUserContent = "";
  for (const m of messages) {
    const text = extractMessageText(m.content).trim();
    if (m.role === "system" || m.role === "developer") {
      if (text) systemParts.push(text);
    } else if (m.role === "user" || m.role === "assistant") {
      if (text) conversation.push({ role: m.role, text });
      if (m.role === "user") lastUserContent = text;
    }
  }
  const parts = [];
  if (systemParts.length > 0) parts.push(systemParts.join("\n\n"));
  if (historyWindow > 0 && conversation.length > 1) {
    const recent = conversation.slice(-historyWindow);
    const transcript = recent.map((turn) =>
      turn.role === "assistant" ? `Assistant: ${turn.text}` : `User: ${turn.text}`
    ).join("\n\n");
    parts.push(transcript);
  } else if (lastUserContent) {
    parts.push(lastUserContent);
  }
  return parts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");
}

// SSE transformation
function isThinkingModel(model) {
  return /r1|think|reason/i.test(model);
}

function isSearchModel(model) {
  return /search/i.test(model);
}

function formatStreamContent(raw, model) {
  return raw.replace(/^\s+/, "");
}

function appendSearchCitations(searchResults, model) {
  if (!searchResults || searchResults.length === 0) return "";
  const lines = searchResults.filter((r) => r?.title && r?.url).map((r, i) => {
    const idx = r.cite_index ?? i + 1;
    return `[${idx}] [${r.title}](${r.url})`;
  });
  return lines.length > 0 ? `\n\n**Sources:**\n${lines.join("\n")}` : "";
}

function createFinishOnceGuard(fn) {
  let finished = false;
  return {
    finishOnce: () => { if (!finished) { finished = true; fn(); } },
    hasFinished: () => finished,
  };
}

function createFinishedDrainScheduler(finishOnce) {
  let drainTimer = null;
  return {
    scheduleFinishAfterDrain: () => {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => { drainTimer = null; finishOnce(); }, 500);
    },
    clearFinishedDrain: () => { if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; } },
    isDrainPending: () => drainTimer !== null,
  };
}

function transformSSE(deepseekStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const streamModel = model || "deepseek-web";
  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  let emittedRole = false;
  let currentPath = "";
  const thinkingModel = isThinkingModel(streamModel);
  const searchResults = [];

  return new ReadableStream({
    async start(controller) {
      const reader = deepseekStream.getReader();
      let buffer = "";
      const emit = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const chunk = (delta, finish) => {
        emit({
          id, object: "chat.completion.chunk", created, model: streamModel,
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        });
      };
      const ensureRole = () => {
        if (!emittedRole) { emittedRole = true; chunk({ role: "assistant", content: "" }); }
      };
      const { finishOnce: finishStream, hasFinished } = createFinishOnceGuard(() => {
        const citations = appendSearchCitations(searchResults, streamModel);
        if (citations) { ensureRole(); chunk({ content: `\n\n${citations}` }); }
        ensureRole();
        chunk({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      });
      const { scheduleFinishAfterDrain, clearFinishedDrain, isDrainPending } = createFinishedDrainScheduler(finishStream);

      const sendByPath = (raw) => {
        const text = formatStreamContent(raw, streamModel);
        if (!text) return;
        ensureRole();
        let path = currentPath;
        if (!path && thinkingModel) path = "thinking";
        else if (!path && isSearchModel(streamModel)) path = "content";
        if (path === "thinking") chunk({ reasoning_content: text });
        else chunk({ content: text });
      };

      const handleFragment = (frag, setPathFromType) => {
        if (setPathFromType) {
          const type = String(frag?.type || "").toUpperCase();
          if (type === "THINK") currentPath = "thinking";
          else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
        }
        if (typeof frag?.content !== "string" || frag.content.length === 0) return;
        if (!setPathFromType) {
          const type = String(frag?.type || "").toUpperCase();
          if (type === "THINK") currentPath = "thinking";
          else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
        }
        sendByPath(frag.content);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
            const payload = line.replace(/^data:\s*/, "").trim();
            if (payload === "[DONE]") { finishStream(); return; }
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            const p = data?.p;
            const o = data?.o;
            const v = data?.v;

            if (v && typeof v === "object" && v.response) {
              if (v.response.thinking_enabled === true) currentPath = "thinking";
              else if (v.response.thinking_enabled === false) currentPath = "content";
              const fragments = v.response.fragments;
              if (Array.isArray(fragments)) {
                for (const frag of fragments) handleFragment(frag, false);
              }
            }

            if (p === "response/fragments") {
              if (Array.isArray(v)) { for (const frag of v) handleFragment(frag, true); }
              else if (v && typeof v === "object") handleFragment(v, true);
            }

            if (p === "response" && Array.isArray(v)) {
              for (const entry of v) {
                if (entry?.p === "response" && entry?.v?.thinking_enabled === true) currentPath = "thinking";
              }
            }

            if (p === "response/search_status") continue;

            if (p === "response/search_results" && Array.isArray(v)) {
              if (o !== "BATCH") { searchResults.length = 0; searchResults.push(...v); }
              else {
                for (const op of v) {
                  const match = String(op?.p || "").match(/^(\d+)\/cite_index$/);
                  if (match) { const idx = parseInt(match[1], 10); if (searchResults[idx]) searchResults[idx].cite_index = op.v; }
                }
              }
              continue;
            }

            if (typeof v === "string") sendByPath(v);
            else if (Array.isArray(v) && p === "response") {
              for (const entry of v) {
                if (Array.isArray(entry?.v)) {
                  const joined = entry.v.map((item) => item?.content || "").join("");
                  if (joined) sendByPath(joined);
                }
              }
            }

            if (p === "response/status" && v === "FINISHED") { scheduleFinishAfterDrain(); continue; }
            if (isDrainPending()) scheduleFinishAfterDrain();
          }
        }
      } catch (err) {
        clearFinishedDrain();
        if (!hasFinished()) controller.error(err);
        return;
      }
      finishStream();
    },
    cancel() {},
  }, { highWaterMark: 16384 });
}

async function collectSSEContent(deepseekStream, model) {
  const decoder = new TextDecoder();
  const reader = deepseekStream.getReader();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let currentPath = "";
  const streamModel = model || "deepseek-web";
  const thinkingModel = isThinkingModel(streamModel);
  const searchResults = [];

  const appendByPath = (raw) => {
    const text = formatStreamContent(raw, streamModel);
    if (!text) return;
    let path = currentPath;
    if (!path && thinkingModel) path = "thinking";
    else if (!path && isSearchModel(streamModel)) path = "content";
    if (path === "thinking") reasoningContent += text;
    else content += text;
  };

  const handleFragment = (frag, setPathFromType) => {
    if (setPathFromType) {
      const type = String(frag?.type || "").toUpperCase();
      if (type === "THINK") currentPath = "thinking";
      else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
    }
    if (typeof frag?.content !== "string" || frag.content.length === 0) return;
    if (!setPathFromType) {
      const type = String(frag?.type || "").toUpperCase();
      if (type === "THINK") currentPath = "thinking";
      else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
    }
    appendByPath(frag.content);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
      const payload = line.replace(/^data:\s*/, "").trim();
      try {
        const data = JSON.parse(payload);
        const p = data?.p;
        const v = data?.v;
        if (v && typeof v === "object" && v.response) {
          if (v.response.thinking_enabled === true) currentPath = "thinking";
          else if (v.response.thinking_enabled === false) currentPath = "content";
          if (Array.isArray(v.response.fragments)) {
            for (const frag of v.response.fragments) handleFragment(frag, false);
          }
        }
        if (p === "response/fragments") {
          if (Array.isArray(v)) { for (const frag of v) handleFragment(frag, true); }
          else if (v && typeof v === "object") handleFragment(v, true);
        }
        if (p === "response" && Array.isArray(v)) {
          for (const entry of v) {
            if (entry?.p === "response" && entry?.v?.thinking_enabled === true) currentPath = "thinking";
          }
        }
        if (p === "response/search_status") continue;
        if (p === "response/search_results" && Array.isArray(v)) {
          if (data?.o !== "BATCH") { searchResults.length = 0; searchResults.push(...v); }
          else {
            for (const op of v) {
              const match = String(op?.p || "").match(/^(\d+)\/cite_index$/);
              if (match) { const idx = parseInt(match[1], 10); if (searchResults[idx]) searchResults[idx].cite_index = op.v; }
            }
          }
          continue;
        }
        if (typeof v === "string") appendByPath(v);
        else if (Array.isArray(v) && p === "response") {
          for (const entry of v) {
            if (Array.isArray(entry?.v)) {
              const joined = entry.v.map((item) => item?.content || "").join("");
              if (joined) appendByPath(joined);
            }
          }
        }
      } catch { /* skip */ }
    }
  }
  const citations = appendSearchCitations(searchResults, streamModel);
  if (citations) content += `\n\n${citations}`;
  return { content, reasoningContent };
}

async function acquireAccessToken(userToken, signal, log) {
  const cached = tokenCache.get(userToken);
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) return cached.accessToken;

  log?.info?.("DEEPSEEK-WEB", "Acquiring access token from /users/current...");
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
    headers: { Authorization: `Bearer ${userToken}`, ...FAKE_HEADERS },
    signal: signal ?? undefined,
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Token invalid or expired — get a new userToken from DeepSeek localStorage");
  if (!resp.ok) throw new Error(`users/current HTTP ${resp.status}`);
  const json = await resp.json();
  if (json?.code && json.code !== 0) {
    const errMsg = json.msg || json?.data?.biz_msg || `error code ${json.code}`;
    tokenCache.delete(userToken);
    throw new Error(`DeepSeek rejected token: ${errMsg}`);
  }
  const bizData = json?.data?.biz_data || json?.biz_data;
  if (!bizData?.token) {
    const errMsg = json?.msg || json?.data?.biz_msg || "Unknown error";
    throw new Error(`Failed to acquire token: ${errMsg}`);
  }
  const accessToken = bizData.token;
  if (tokenCache.size >= 100) { const first = tokenCache.keys().next().value; if (first) tokenCache.delete(first); }
  tokenCache.set(userToken, { accessToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  log?.info?.("DEEPSEEK-WEB", `Access token acquired (${accessToken.length} chars)`);
  return accessToken;
}

async function createSession(accessToken, signal) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
    method: "POST",
    headers: { ...FAKE_HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, Cookie: generateFakeCookie() },
    body: JSON.stringify({}),
    signal: signal ?? undefined,
  });
  if (!resp.ok) throw new Error(`chat_session/create HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  const id = bizData?.chat_session?.id;
  if (!id) throw new Error(`No session id: code=${json?.code}`);
  return id;
}

async function deleteSessionOnDeepSeek(accessToken, sessionId) {
  try {
    await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/delete`, {
      method: "POST",
      headers: { ...FAKE_HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ chat_session_id: sessionId }),
    });
  } catch { /* best-effort */ }
}

function wrapStreamWithCleanup(responseStream, cleanup) {
  const reader = responseStream.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); cleanup().catch(() => {}); return; }
      controller.enqueue(value);
    },
    cancel() { reader.cancel(); cleanup().catch(() => {}); },
  });
}

async function getPowChallenge(accessToken, signal) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers: { ...FAKE_HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    signal: signal ?? undefined,
  });
  if (!resp.ok) throw new Error(`create_pow_challenge HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  if (!bizData?.challenge?.challenge) throw new Error(`No PoW challenge: code=${json?.code}`);
  return bizData.challenge;
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});

    // Tools not yet ported
    if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "DeepSeek Web does not support tool calling in this port — needs serializeDeepSeekToolPrompt/parseDeepSeekToolCalls from OmniRoute deepseekWebTools.ts", type: "not_implemented" },
      }), { status: 501, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: COMPLETION_URL, headers: {}, transformedBody: body };
    }

    const userToken = extractUserToken(credentials);
    if (!userToken) {
      return { response: errorResponse(400, "Invalid credentials: paste your userToken from DeepSeek localStorage (DevTools → Application → Local Storage → chat.deepseek.com → userToken)"), url: COMPLETION_URL, headers: {}, transformedBody: body };
    }

    const { modelType, thinkingEnabled, searchEnabled } = resolveModelOptions(model, bodyObj);
    const psd = (credentials?.providerSpecificData || {});
    const persistSession = psd.persistSession === true;
    const historyWindow = typeof psd.historyWindow === "number" && psd.historyWindow > 0 ? psd.historyWindow : 0;

    try {
      let t0 = Date.now();
      const accessToken = await acquireAccessToken(userToken, signal, log);
      log?.info?.("DEEPSEEK-WEB", `Token acquired in ${Date.now() - t0}ms`);

      const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
      const prompt = messagesToPrompt(messages, historyWindow);
      const refFileIds = Array.isArray(bodyObj.ref_file_ids) ? bodyObj.ref_file_ids : [];
      log?.info?.("DEEPSEEK-WEB", `model_type=${modelType}, thinking=${thinkingEnabled}, search=${searchEnabled}, files=${refFileIds.length}, stream=${stream !== false}, persist=${persistSession}, window=${historyWindow}`);

      const performCompletion = async (sid) => {
        const powChallenge = await getPowChallenge(accessToken, signal);
        const powAnswer = await solvePow(powChallenge);
        const reqHeaders = {
          ...FAKE_HEADERS, "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Ds-Pow-Response": powAnswer,
          "X-Client-Timezone-Offset": String(new Date().getTimezoneOffset() * -60),
          Cookie: generateFakeCookie(),
        };
        const requestPayload = {
          chat_session_id: sid, parent_message_id: null, model_type: modelType,
          prompt, ref_file_ids: refFileIds, thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled, preempt: false,
        };
        const resp = await fetch(COMPLETION_URL, {
          method: "POST", headers: reqHeaders, body: JSON.stringify(requestPayload), signal: signal ?? undefined,
        });
        return { resp, reqHeaders, requestPayload };
      };

      const acquireSession = async () => {
        if (persistSession) {
          const cached = sessionCache.get(userToken);
          if (cached) return { sessionId: cached.sessionId, reused: true };
          const created = await createSession(accessToken, signal);
          if (sessionCache.size >= 100) { const first = sessionCache.keys().next().value; if (first) sessionCache.delete(first); }
          sessionCache.set(userToken, { sessionId: created, createdAt: Date.now() });
          return { sessionId: created, reused: false };
        }
        return { sessionId: await createSession(accessToken, signal), reused: false };
      };

      t0 = Date.now();
      let { sessionId, reused: reusedSession } = await acquireSession();
      log?.info?.("DEEPSEEK-WEB", `Session ${reusedSession ? "reused" : "created"} in ${Date.now() - t0}ms`);

      t0 = Date.now();
      log?.info?.("DEEPSEEK-WEB", `POST ${COMPLETION_URL}`);
      let { resp, reqHeaders, requestPayload } = await performCompletion(sessionId);
      log?.info?.("DEEPSEEK-WEB", `Completion response in ${Date.now() - t0}ms, status=${resp.status}`);

      if (!resp.ok && persistSession && reusedSession) {
        log?.warn?.("DEEPSEEK-WEB", "Reused session failed — retrying with a fresh session");
        sessionCache.delete(userToken);
        sessionId = await createSession(accessToken, signal);
        if (sessionCache.size >= 100) { const first = sessionCache.keys().next().value; if (first) sessionCache.delete(first); }
        sessionCache.set(userToken, { sessionId, createdAt: Date.now() });
        reusedSession = false;
        ({ resp, reqHeaders, requestPayload } = await performCompletion(sessionId));
      }

      if (!resp.ok) {
        const status = resp.status;
        let errMsg = `DeepSeek API error (${status})`;
        if (status === 401 || status === 403) { tokenCache.delete(userToken); errMsg = "DeepSeek token expired — get a fresh userToken from localStorage."; }
        else if (status === 429) errMsg = "DeepSeek rate limited. Wait and retry.";
        log?.warn?.("DEEPSEEK-WEB", errMsg);
        try { const errBody = await resp.json(); if (errBody?.code && errBody.code !== 0) errMsg = `DeepSeek error ${errBody.code}: ${errBody.msg}`; } catch { /* ignore */ }
        if (persistSession) sessionCache.delete(userToken);
        deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {});
        return { response: errorResponse(status, errMsg), url: COMPLETION_URL, headers: reqHeaders, transformedBody: requestPayload };
      }

      // Check for HTTP 200 with error JSON
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          const json = await resp.json();
          if (json?.code && json.code !== 0) {
            const errMsg = `DeepSeek error ${json.code}: ${json.msg || json?.data?.biz_msg || ""}`;
            log?.warn?.("DEEPSEEK-WEB", errMsg);
            const status = json.code === 40003 ? 401 : json.code === 40002 ? 429 : 502;
            if (json.code === 40003) tokenCache.delete(userToken);
            if (persistSession) sessionCache.delete(userToken);
            deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {});
            return { response: errorResponse(status, errMsg, json.code), url: COMPLETION_URL, headers: reqHeaders, transformedBody: requestPayload };
          }
          if (!persistSession) deleteSessionOnDeepSeek(accessToken, sessionId).catch(() => {});
          return { response: new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } }), url: COMPLETION_URL, headers: reqHeaders, transformedBody: requestPayload };
        } catch { /* not JSON, continue */ }
      }

      const cleanupFn = persistSession ? async () => {} : () => deleteSessionOnDeepSeek(accessToken, sessionId);
      const clientModel = typeof model === "string" && model.trim() ? model.trim() : "deepseek-web";

      if (stream !== false) {
        const openaiStream = transformSSE(resp.body, clientModel);
        const wrappedStream = wrapStreamWithCleanup(openaiStream, cleanupFn);
        return {
          response: new Response(wrappedStream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }),
          url: COMPLETION_URL, headers: reqHeaders, transformedBody: requestPayload,
        };
      }

      const { content, reasoningContent } = await collectSSEContent(resp.body, clientModel);
      await cleanupFn();
      const message = { role: "assistant", content };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      return {
        response: new Response(JSON.stringify({
          id: `chatcmpl-${Date.now()}`, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: model || modelType,
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
        url: COMPLETION_URL, headers: reqHeaders, transformedBody: requestPayload,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.("DEEPSEEK-WEB", `Execute failed: ${msg}`);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { response: errorResponse(499, "Request cancelled"), url: COMPLETION_URL, headers: {}, transformedBody: body };
      }
      return { response: errorResponse(502, `DeepSeek error: ${msg}`), url: COMPLETION_URL, headers: {}, transformedBody: body };
    }
  }
}

export default DeepSeekWebExecutor;
