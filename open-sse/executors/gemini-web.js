import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const GEMINI_URL = "https://gemini.google.com";
const STREAM_GENERATE_URL = `${GEMINI_URL}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const GEMINI_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function formatChatCompletion(content, model, finishReason) {
  return {
    id: `chatcmpl-${Date.now()}`, object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason || "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content, model, finishReason) {
  return sseChunk({
    id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason || null }],
  });
}

function parseStreamResponse(raw) {
  const lines = raw.split("\n");
  let lastText = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c) => typeof c === "string").join("");
      if (text) lastText = text;
    } catch { /* skip */ }
  }
  return lastText;
}

function normalizeGeminiCookieInput(raw, cookieName) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `${cookieName || "__Secure-1PSID"}=${trimmed}`;
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
  return "";
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const messages = bodyObj.messages || [];

    // Get cookies from credentials
    const rawCookie = credentials?.apiKey || credentials?.cookie || "";
    const psid = normalizeGeminiCookieInput(rawCookie, "__Secure-1PSID");
    const psidts = normalizeGeminiCookieInput(
      credentials?.providerSpecificData?.__Secure_1PSIDTS || credentials?.providerSpecificData?.["__Secure-1PSIDTS"],
      "__Secure-1PSIDTS"
    );
    const cookieParts = [psid, psidts].filter(Boolean);
    if (cookieParts.length === 0) {
      return { response: new Response(JSON.stringify({ error: "Missing Gemini cookies — paste __Secure-1PSID from gemini.google.com DevTools → Cookies" }), { status: 401, headers: { "Content-Type": "application/json" } }), url: GEMINI_URL, headers: {}, transformedBody: body };
    }
    const cookie = cookieParts.join("; ");

    // Extract last user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg ? extractMessageText(lastUserMsg.content) : "";
    if (!prompt) {
      return { response: new Response(JSON.stringify({ error: "No user message found" }), { status: 400, headers: { "Content-Type": "application/json" } }), url: GEMINI_URL, headers: {}, transformedBody: body };
    }

    // Build the request to Gemini's StreamGenerate endpoint
    // Format: f.req = encoded JSON array with conversation structure
    const reqBody = "f.req=" + encodeURIComponent(JSON.stringify([
      null,
      JSON.stringify([
        [prompt],
        null,
        [null, null, null, null, null, null, null, null],
      ]),
    ]));

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": GEMINI_USER_AGENT,
      Origin: GEMINI_URL,
      Referer: `${GEMINI_URL}/`,
      Cookie: cookie,
    };

    try {
      log?.info?.("GEMINI-WEB", `POST StreamGenerate (len=${prompt.length})`);
      const response = await fetch(STREAM_GENERATE_URL, {
        method: "POST", headers, body: reqBody, signal,
      });

      if (!response.ok) {
        let errMsg = `Gemini returned HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) errMsg = "Gemini auth failed — your __Secure-1PSID cookie may be expired. Re-paste from gemini.google.com.";
        log?.warn?.("GEMINI-WEB", errMsg);
        return { response: new Response(JSON.stringify({ error: { message: errMsg, type: "upstream_error" } }), { status: response.status, headers: { "Content-Type": "application/json" } }), url: STREAM_GENERATE_URL, headers, transformedBody: body };
      }

      const rawText = await response.text();
      const responseText = parseStreamResponse(rawText);

      if (!responseText) {
        return { response: new Response(JSON.stringify({ error: "No response from Gemini" }), { status: 502, headers: { "Content-Type": "application/json" } }), url: STREAM_GENERATE_URL, headers, transformedBody: body };
      }

      const modelId = model || "gemini-2.5-pro";

      if (stream) {
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(formatStreamChunk(responseText, modelId)));
            controller.enqueue(encoder.encode(formatStreamChunk("", modelId, "stop")));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          },
        });
        return { response: new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } }), url: STREAM_GENERATE_URL, headers, transformedBody: body };
      }

      return { response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), { status: 200, headers: { "Content-Type": "application/json" } }), url: STREAM_GENERATE_URL, headers, transformedBody: body };
    } catch (err) {
      const msg = err.message || String(err);
      log?.error?.("GEMINI-WEB", `Execute failed: ${msg}`);
      return { response: new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } }), url: STREAM_GENERATE_URL, headers: {}, transformedBody: body };
    }
  }
}

export default GeminiWebExecutor;
