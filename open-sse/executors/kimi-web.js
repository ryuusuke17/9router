import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { extractKimiAccessToken } from "../utils/webCookieAuth.js";

const BASE_URL = "https://www.kimi.com";
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const MAX_FRAME_LEN = 8 * 1024 * 1024;

// Model config for Kimi Web
const MODEL_CONFIGS = {
  "k3": { scenario: "kimi", kimiPlusId: null, name: "K3", contextLengths: ["8k", "16k", "32k", "128k"] },
  "k2.6": { scenario: "kimi", kimiPlusId: null, name: "K2.6", contextLengths: ["8k", "16k", "32k", "128k"] },
  "k2.5": { scenario: "kimi", kimiPlusId: null, name: "K2.5", contextLengths: ["8k", "16k", "32k", "128k"] },
};

function resolveKimiWebModelConfig(modelId) {
  const key = (modelId || "").toLowerCase();
  return MODEL_CONFIGS[key] || null;
}

function resolveKimiWebReasoningEffort(reasoningEffort, modelConfig) {
  if (!reasoningEffort || reasoningEffort === "none" || reasoningEffort === "auto") return undefined;
  if (reasoningEffort === "low") return "LOW";
  if (reasoningEffort === "medium" || reasoningEffort === "high") return "NONE";
  return undefined;
}

function resolveKimiWebContextLength(contextLength, modelConfig) {
  if (!contextLength) return undefined;
  if (modelConfig?.contextLengths?.includes(contextLength)) return contextLength;
  return undefined;
}

function frameConnectMessage(json) {
  const payload = new TextEncoder().encode(json);
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = 0;
  const len = payload.length;
  framed[1] = (len >>> 24) & 0xff;
  framed[2] = (len >>> 16) & 0xff;
  framed[3] = (len >>> 8) & 0xff;
  framed[4] = len & 0xff;
  framed.set(payload, 5);
  return framed;
}

function decodeConnectFrame(buf, byteOffset) {
  if (byteOffset + 5 > buf.length) return { consumed: 0, frame: null };
  const flags = buf[byteOffset];
  const len = (buf[byteOffset + 1] << 24) | (buf[byteOffset + 2] << 16) | (buf[byteOffset + 3] << 8) | buf[byteOffset + 4];
  const msgLen = len < 0 ? len + 0x100000000 : len;
  if (msgLen > MAX_FRAME_LEN) return { consumed: -1, frame: null };
  if (byteOffset + 5 + msgLen > buf.length) return { consumed: 0, frame: null };
  const payload = buf.subarray(byteOffset + 5, byteOffset + 5 + msgLen);
  let message = null;
  if (msgLen > 0) {
    try { message = JSON.parse(new TextDecoder().decode(payload)); }
    catch (e) { throw new Error(`Kimi Connect frame contained invalid JSON: ${e.message}`); }
  }
  return { consumed: 5 + msgLen, frame: { flags, message } };
}

function getConnectEndStreamError(frame) {
  if ((frame.flags & 0x02) === 0) return null;
  const error = frame.message?.error;
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" ? error.code : "unknown";
  const message = typeof error.message === "string" ? error.message : "upstream error";
  return `${code}: ${message}`;
}

function extractDelta(msg) {
  if (!msg) return null;
  const op = String(msg.op || "");
  const mask = String(msg.mask || "");
  const block = (msg.block || {});
  if (op === "append") {
    if (mask === "block.text.content") {
      const text = String(((block.text || {})).content || "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think.content") {
      const text = String(((block.think || {})).content || "");
      return text ? { kind: "think", text } : null;
    }
    return null;
  }
  if (op === "set") {
    if (mask === "block.text") {
      const text = String(((block.text || {})).content || "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think") {
      const text = String(((block.think || {})).content || "");
      return text ? { kind: "think", text } : null;
    }
  }
  return null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Kimi Web only supports text message content");
  return content.map((part) => {
    if (!part || typeof part !== "object") throw new Error("Kimi Web only supports text message content");
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") return part.text;
    throw new Error("Kimi Web does not support image, audio, file, or tool content");
  }).join("");
}

function foldMessages(messages) {
  const systemParts = [];
  const conversationParts = [];
  for (const message of messages) {
    if (message.role === "tool" || message.role === "function") throw new Error("Kimi Web does not support tool result messages");
    if (message.tool_calls !== undefined) throw new Error("Kimi Web does not support assistant tool calls");
    const text = textFromContent(message.content);
    if (message.role === "system" || message.role === "developer") {
      if (text) systemParts.push(text);
    } else if (message.role === "user") {
      if (text) conversationParts.push(conversationParts.length > 0 ? `User: ${text}` : text);
    } else if (message.role === "assistant") {
      if (text) conversationParts.push(`Assistant: ${text}`);
    } else {
      throw new Error(`Kimi Web does not support message role ${message.role}`);
    }
  }
  return { prompt: conversationParts.join("\n\n").trim(), systemPrompt: systemParts.join("\n\n").trim() };
}

export class KimiWebExecutor extends BaseExecutor {
  constructor() {
    super("kimi-web", PROVIDERS["kimi-web"]);
  }

  buildKimiHeaders(accessToken) {
    const headers = {
      "Content-Type": "application/connect+json",
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      "connect-protocol-version": "1",
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    return headers;
  }

  buildRequestBody(messages, config, reasoningEffort, contextLength) {
    const options = {
      thinking: true,
      enable_plugin: false,
      ...(messages.systemPrompt ? { system_prompt: messages.systemPrompt } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(contextLength ? { context_length: contextLength } : {}),
    };
    return JSON.stringify({
      chat_id: "",
      ...(config.kimiPlusId ? { kimiplus_id: config.kimiPlusId } : {}),
      scenario: config.scenario,
      tools: [],
      message: {
        id: "", parent_id: "", children_message_ids: [],
        role: "user",
        blocks: [{ id: "", message_id: "", text: { content: messages.prompt } }],
        scenario: config.scenario,
        labels: [], references: [], is_goal: false,
      },
      options,
      project_id: "",
    });
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const rawCredential = String(credentials?.accessToken || credentials?.apiKey || "").trim();
    const accessToken = extractKimiAccessToken(rawCredential);
    if (!accessToken) {
      const errResp = new Response(JSON.stringify({ error: { message: "Missing Kimi access_token — log in at www.kimi.com and capture access_token from localStorage.", type: "authentication_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    const modelId = String(model || bodyObj.model || "");
    const modelConfig = resolveKimiWebModelConfig(modelId);
    if (!modelConfig) {
      const errResp = new Response(JSON.stringify({ error: { message: `Unsupported Kimi Web model: ${modelId}`, type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    // Tools not supported
    if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
      const errResp = new Response(JSON.stringify({ error: { message: "Kimi Web does not support OpenAI function tools", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    let foldedMessages, reasoningEffort, contextLength;
    try {
      const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
      foldedMessages = foldMessages(messages);
      if (!foldedMessages.prompt) throw new Error("Kimi Web requires a non-empty user message");
      reasoningEffort = resolveKimiWebReasoningEffort(bodyObj.reasoning_effort, modelConfig);
      contextLength = resolveKimiWebContextLength(bodyObj.context_length, modelConfig);
    } catch (error) {
      const errResp = new Response(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Invalid Kimi Web request", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: {}, transformedBody: body };
    }

    const reqBody = this.buildRequestBody(foldedMessages, modelConfig, reasoningEffort, contextLength);
    const reqHeaders = this.buildKimiHeaders(accessToken);
    const framedBody = frameConnectMessage(reqBody);

    let upstream;
    try {
      upstream = await fetch(CHAT_URL, {
        method: "POST", headers: reqHeaders, body: framedBody, signal,
      });
    } catch (err) {
      const errResp = new Response(JSON.stringify({ error: { message: `Kimi fetch failed: ${err.message || "unknown"}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: reqHeaders, transformedBody: JSON.parse(reqBody) };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      const errResp = new Response(JSON.stringify({ error: { message: `Kimi error: ${errText.slice(0, 500)}`, type: "upstream_error" } }), { status: upstream.status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: reqHeaders, transformedBody: JSON.parse(reqBody) };
    }

    const encoder = new TextEncoder();
    const id = `chatcmpl-kimi-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const emitChunk = (controller, delta, finish) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      })}\n\n`));
    };

    const sourceStream = upstream.body ?? new ReadableStream({ start: (c) => c.close() });

    if (stream) {
      const outStream = new ReadableStream({
        async start(controller) {
          const reader = sourceStream.getReader();
          let buffer = new Uint8Array(0);
          let emittedRole = false;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                const merged = new Uint8Array(buffer.length + value.length);
                merged.set(buffer, 0);
                merged.set(value, buffer.length);
                buffer = merged;
                let offset = 0;
                while (offset < buffer.length) {
                  const { consumed, frame } = decodeConnectFrame(buffer, offset);
                  if (consumed === -1) throw new Error("Kimi Connect frame exceeded MAX_FRAME_LEN");
                  if (consumed === 0) break;
                  offset += consumed;
                  if (!frame) continue;
                  if ((frame.flags & 0x02) !== 0) {
                    const endStreamError = getConnectEndStreamError(frame);
                    if (endStreamError) throw new Error(`Kimi Connect EndStream error: ${endStreamError}`);
                    if (!emittedRole) emitChunk(controller, { role: "assistant", content: "" });
                    emitChunk(controller, {}, "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                  if (!frame.message) continue;
                  const delta = extractDelta(frame.message);
                  if (delta) {
                    if (!emittedRole) { emittedRole = true; emitChunk(controller, { role: "assistant", content: "" }); }
                    if (delta.kind === "think") emitChunk(controller, { reasoning_content: delta.text });
                    else emitChunk(controller, { content: delta.text });
                  }
                }
                buffer = buffer.subarray(offset);
              }
            }
            throw new Error("Kimi Connect stream ended without a successful EndStream frame");
          } catch (err) {
            if (signal?.aborted) { try { controller.close(); } catch {} }
            else { try { controller.error(err); } catch {} }
          }
        },
      });
      return {
        response: new Response(outStream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } }),
        url: CHAT_URL, headers: reqHeaders, transformedBody: JSON.parse(reqBody),
      };
    }

    // Non-streaming
    let answer = "";
    let reasoning = "";
    const reader = sourceStream.getReader();
    let buffer = new Uint8Array(0);
    let sawSuccessfulEndStream = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;
        let offset = 0;
        while (offset < buffer.length) {
          const { consumed, frame } = decodeConnectFrame(buffer, offset);
          if (consumed === -1) throw new Error("Kimi Connect frame exceeded MAX_FRAME_LEN");
          if (consumed === 0) break;
          offset += consumed;
          if (!frame) continue;
          if ((frame.flags & 0x02) !== 0) {
            const endStreamError = getConnectEndStreamError(frame);
            if (endStreamError) throw new Error(`Kimi Connect EndStream error: ${endStreamError}`);
            sawSuccessfulEndStream = true;
            break;
          }
          if (!frame.message) continue;
          const delta = extractDelta(frame.message);
          if (delta) {
            if (delta.kind === "think") reasoning += delta.text;
            else answer += delta.text;
          }
        }
        buffer = buffer.subarray(offset);
        if (sawSuccessfulEndStream) break;
      }
      if (!sawSuccessfulEndStream) throw new Error("Kimi Connect stream ended without a successful EndStream frame");
    } catch (error) {
      const errResp = new Response(JSON.stringify({ error: { message: `Kimi Connect protocol error: ${error.message || "unknown"}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHAT_URL, headers: reqHeaders, transformedBody: JSON.parse(reqBody) };
    }

    const message = { role: "assistant", content: answer };
    if (reasoning) message.reasoning_content = reasoning;
    return {
      response: new Response(JSON.stringify({
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message, finish_reason: "stop" }],
      }), { headers: { "Content-Type": "application/json" } }),
      url: CHAT_URL, headers: reqHeaders, transformedBody: JSON.parse(reqBody),
    };
  }
}

export default KimiWebExecutor;
