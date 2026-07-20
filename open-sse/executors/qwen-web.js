import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { buildQwenCookieHeader, extractQwenToken } from "../utils/webCookieAuth.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const BASE_URL = "https://chat.qwen.ai";
const CHATS_NEW_URL = `${BASE_URL}/api/v2/chats/new`;
const CHAT_COMPLETIONS_URL = `${BASE_URL}/api/v2/chat/completions`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const BX_VERSION = "2.5.36";
const BX_UMIDTOKEN_FALLBACK = "T2gA0000000000000000000000000000000000000000";
const QWEN_SPA_VERSION = "0.2.66";

const MODEL_ALIASES = {
  "qwen-plus": "qwen3.7-plus",
  "qwen-max": "qwen3.7-max",
  "qwen-turbo": "qwen3.6-plus",
  "qwen3-plus": "qwen3.7-plus",
  "qwen3-max": "qwen3.7-max",
  "qwen3-flash": "qwen3.6-plus",
  "qwen3-coder-flash": "qwen3.6-plus",
  qwen: "qwen3.7-max",
  qwen3: "qwen3.7-max",
};

const DEFAULT_MODEL = "qwen3.7-max";

function uuid() {
  return crypto.randomUUID();
}

function extractMessageText(content) {
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return String(content || "");
}

function isWafResponse(status, contentType, bodyText) {
  if (contentType.includes("text/html")) return true;
  if (status === 504) return true;
  return /aliyun_waf|baxia|<html/i.test(bodyText);
}

const WAF_ERROR_MESSAGE = "Qwen session expired or blocked by Alibaba's WAF. Re-login at https://chat.qwen.ai and paste a fresh full Cookie header (must include cna, ssxmod_itna and token).";

function parseSseDelta(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return null;
  const phase = delta.phase;
  const content = typeof delta.content === "string" ? delta.content : "";
  if (phase === "think" || phase === "thinking_summary") {
    return { kind: "think", text: content };
  }
  if (phase === "answer" || phase === null || phase === undefined) {
    return { kind: "answer", text: content };
  }
  return null;
}

export class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", PROVIDERS["qwen-web"] || { baseUrl: BASE_URL });
  }

  buildHeaders(token, cookieHeader, chatId) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: chatId ? `${BASE_URL}/c/${chatId}` : `${BASE_URL}/`,
      source: "web",
      version: QWEN_SPA_VERSION,
      "x-request-id": uuid(),
      "bx-v": BX_VERSION,
      "bx-umidtoken": BX_UMIDTOKEN_FALLBACK,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    return headers;
  }

  contentToText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      }).filter(Boolean).join("\n");
    }
    return content == null ? "" : String(content);
  }

  foldMessages(messages) {
    let systemContent = "";
    let userContent = "";
    for (const m of messages) {
      const text = this.contentToText(m.content);
      if (m.role === "system" || m.role === "developer") {
        systemContent += (systemContent ? "\n\n" : "") + text;
      } else if (m.role === "user") {
        userContent = text;
      }
    }
    return systemContent ? `${systemContent}\n\nUser: ${userContent}` : userContent;
  }

  buildMessagePayload(chatId, modelId, prompt, requestedModel) {
    const fid = uuid();
    const enableThinking = /think|reason|r1/i.test(requestedModel);
    const featureConfig = {
      thinking_enabled: enableThinking,
      output_schema: "phase",
      auto_thinking: enableThinking,
      research_mode: "normal",
      auto_search: false,
    };
    return {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [],
          role: "user",
          content: prompt,
          user_action: "chat",
          files: [],
          timestamp: Math.floor(Date.now() / 1000),
          models: [modelId],
          chat_type: "t2t",
          feature_config: featureConfig,
          sub_chat_type: "t2t",
          parent_id: null,
        },
      ],
    };
  }

  async collectStream(upstream) {
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";
    if (!reader) return { content, reasoning };
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const delta = parseSseDelta(line);
          if (!delta) continue;
          if (delta.kind === "answer") content += delta.text;
          else if (delta.kind === "think") reasoning += delta.text;
        }
      }
    } catch {
      /* upstream closed mid-stream */
    }
    return { content, reasoning };
  }

  buildClientStream(upstream, modelId, signal) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const id = `chatcmpl-qwen-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const emitChunk = (delta, finishReason) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;

    return new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        let buffer = "";
        controller.enqueue(encoder.encode(emitChunk({ role: "assistant", content: "" }, null)));
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const delta = parseSseDelta(line);
              if (!delta || !delta.text) continue;
              if (delta.kind === "answer") {
                controller.enqueue(encoder.encode(emitChunk({ content: delta.text }, null)));
              } else if (delta.kind === "think") {
                controller.enqueue(encoder.encode(emitChunk({ reasoning_content: delta.text }, null)));
              }
            }
          }
        } catch (err) {
          if (!signal?.aborted) {
            controller.error(err);
            return;
          }
        }
        controller.enqueue(encoder.encode(emitChunk({}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  jsonResponse(modelId, message, finishReason, url, transformedBody) {
    return {
      response: new Response(JSON.stringify({
        id: `chatcmpl-qwen-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, message, finish_reason: finishReason }],
      }), { headers: { "Content-Type": "application/json" } }),
      url,
      headers: {},
      transformedBody,
    };
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const rawCred = String(credentials?.apiKey || "").trim();
    const cookieHeader = buildQwenCookieHeader(rawCred);
    let token = extractQwenToken(rawCred);
    if (!token && credentials?.accessToken) token = String(credentials.accessToken).trim();

    const messages = bodyObj.messages || [];
    const requestedModel = bodyObj.model || DEFAULT_MODEL;
    const modelId = MODEL_ALIASES[requestedModel] || requestedModel;

    // Tools not yet supported
    if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Qwen Web does not support tool calling in this port — needs prepareToolMessages from OmniRoute webTools.ts", type: "not_implemented" },
      }), { status: 501, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATS_NEW_URL, headers: {}, transformedBody: body };
    }

    const prompt = this.foldMessages(messages);

    // Step 1: create a chat
    let chatId;
    try {
      const newChatRes = await fetch(CHATS_NEW_URL, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader),
        body: JSON.stringify({
          title: "New Chat",
          models: [modelId],
          chat_mode: "normal",
          chat_type: "t2t",
          timestamp: Date.now(),
        }),
        signal,
      });

      const ct = newChatRes.headers.get("content-type") || "";
      if (!newChatRes.ok || ct.includes("text/html")) {
        const text = await newChatRes.text().catch(() => "");
        if (isWafResponse(newChatRes.status, ct, text)) {
          return { response: new Response(JSON.stringify({ error: { message: WAF_ERROR_MESSAGE, type: "upstream_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: CHATS_NEW_URL, headers: {}, transformedBody: body };
        }
        return { response: new Response(JSON.stringify({ error: { message: `Qwen create-chat failed: ${text.slice(0, 300)}`, type: "upstream_error" } }), { status: newChatRes.status || 502, headers: { "Content-Type": "application/json" } }), url: CHATS_NEW_URL, headers: {}, transformedBody: body };
      }

      const data = await newChatRes.json();
      chatId = data?.data?.id || "";
      if (!chatId) {
        return { response: new Response(JSON.stringify({ error: { message: "Qwen create-chat returned no chat id", type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: CHATS_NEW_URL, headers: {}, transformedBody: body };
      }
    } catch (err) {
      return { response: new Response(JSON.stringify({ error: { message: `Qwen create-chat error: ${err.message || "unknown"}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: CHATS_NEW_URL, headers: {}, transformedBody: body };
    }

    // Step 2: send the message
    const completionUrl = `${CHAT_COMPLETIONS_URL}?chat_id=${chatId}`;
    const msgPayload = this.buildMessagePayload(chatId, modelId, prompt, requestedModel);

    let upstream;
    try {
      upstream = await fetch(completionUrl, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader, chatId),
        body: JSON.stringify(msgPayload),
        signal,
      });
    } catch (err) {
      return { response: new Response(JSON.stringify({ error: { message: `Qwen completion fetch failed: ${err.message || "unknown"}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: completionUrl, headers: {}, transformedBody: msgPayload };
    }

    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || ct.includes("text/html")) {
      const errText = await upstream.text().catch(() => "");
      if (isWafResponse(upstream.status, ct, errText)) {
        return { response: new Response(JSON.stringify({ error: { message: WAF_ERROR_MESSAGE, type: "upstream_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: completionUrl, headers: {}, transformedBody: msgPayload };
      }
      return { response: new Response(JSON.stringify({ error: { message: `Qwen error: ${errText.slice(0, 300)}`, type: "upstream_error" } }), { status: upstream.status || 502, headers: { "Content-Type": "application/json" } }), url: completionUrl, headers: {}, transformedBody: msgPayload };
    }

    if (!stream) {
      const { content, reasoning } = await this.collectStream(upstream);
      const message = { role: "assistant", content };
      if (reasoning) message.reasoning_content = reasoning;
      return this.jsonResponse(modelId, message, "stop", completionUrl, msgPayload);
    }

    const sseStream = this.buildClientStream(upstream, modelId, signal);
    return {
      response: new Response(sseStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      }),
      url: completionUrl,
      headers: this.buildHeaders(token, cookieHeader, chatId),
      transformedBody: msgPayload,
    };
  }
}

export default QwenWebExecutor;
