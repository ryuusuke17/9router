import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";

const BASE_URL = "https://zenmux.ai";
const API_URL = "https://zenmux.ai/api/anthropic/v1/messages";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function normalizeCookie(raw) {
  return (raw || "").replace(/^Cookie:\s*/i, "").trim();
}

function collectAnthropicText(reader, decoder) {
  let buf = "";
  let fullText = "";
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const raw = t.slice(5).trim();
            if (raw === "[DONE]") continue;
            try {
              const parsed = JSON.parse(raw);
              if (parsed.type === "content_block_delta" && parsed.delta) {
                fullText += parsed.delta.text || parsed.delta.thinking || "";
              }
            } catch {}
          }
        }
        resolve(fullText);
      } catch (e) { reject(e); }
    })();
  });
}

export class ZenmuxFreeExecutor extends BaseExecutor {
  constructor() {
    super("zenmux-free", PROVIDERS["zenmux-free"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const rawCookie = normalizeCookie(credentials?.apiKey || "");
    if (!rawCookie) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing zenmux-free cookie" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: API_URL, headers: {}, transformedBody: bodyObj };
    }

    const ctoken = rawCookie.match(/ctoken=([^;]+)/)?.[1] || "";
    if (!ctoken) {
      return { response: new Response(JSON.stringify({ error: { message: "ZenMux Free: ctoken not found — export ALL cookies from zenmux.ai (ctoken + sessionId + sessionId.sig)" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: API_URL, headers: {}, transformedBody: bodyObj };
    }

    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const sysMessages = messages.filter(m => m.role === "system");
    const userMessages = messages.filter(m => m.role === "user");
    const lastUser = userMessages[userMessages.length - 1];
    const sysText = sysMessages.length > 0 ? (typeof sysMessages[0].content === "string" ? sysMessages[0].content : "") : "";
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const fullText = sysText ? sysText + "\n\n" + userText : userText;

    const requestBody = {
      model: model || "deepseek/deepseek-chat",
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: fullText }] }],
      stream: stream !== false,
    };
    if (bodyObj.temperature !== undefined) requestBody.temperature = bodyObj.temperature;

    const url = new URL(API_URL);
    url.searchParams.set("ctoken", ctoken);

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: stream !== false ? "text/event-stream" : "application/json",
      Cookie: rawCookie,
      Origin: BASE_URL,
      Referer: "https://zenmux.ai/platform/chat",
      "anthropic-version": "2023-06-01",
      "chat-request-id": "chatcmpl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      "x-zenmux-accept-processing": "true, true",
      "x-zenmux-apikey-source": "subscription",
    };

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: signal || AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        let errMsg = `zenmux-free HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) errMsg = "ZenMux Free: cookies expired or invalid — re-export ALL cookies from zenmux.ai (ctoken + sessionId + sessionId.sig)";
        else if (response.status === 402) errMsg = "ZenMux Free: free-tier quota exhausted";
        return { response: new Response(JSON.stringify({ error: { message: errMsg } }), { status: response.status, headers: { "Content-Type": "application/json" } }), url: url.toString(), headers, transformedBody: requestBody };
      }

      if (stream === false) {
        const decoder = new TextDecoder();
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const text = await collectAnthropicText(reader, decoder);
        const result = {
          id: "chatcmpl-zenmux-free-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model || "deepseek/deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        };
        return { response: new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } }), url: url.toString(), headers, transformedBody: requestBody };
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const outStream = new ReadableStream({
        async start(controller) {
          const reader = response.body?.getReader();
          if (!reader) { controller.close(); return; }
          let buf = "";
          const modelId = model || "deepseek/deepseek-chat";
          const cid = "chatcmpl-zenmux-free-" + Date.now();
          const created = Math.floor(Date.now() / 1000);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() || "";
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const raw = t.slice(5).trim();
                if (raw === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
                try {
                  const parsed = JSON.parse(raw);
                  if (parsed.type === "content_block_delta" && parsed.delta) {
                    const text = parsed.delta.text || parsed.delta.thinking || "";
                    if (text) {
                      controller.enqueue(encoder.encode("data: " + JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + "\n\n"));
                    }
                  } else if (parsed.type === "message_delta" && parsed.delta) {
                    controller.enqueue(encoder.encode("data: " + JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: parsed.delta.stop_reason || "stop" }] }) + "\n\n"));
                  }
                } catch {}
              }
            }
          } catch {}
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return { response: new Response(outStream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } }), url: url.toString(), headers, transformedBody: requestBody };

    } catch (err) {
      return { response: new Response(JSON.stringify({ error: { message: `zenmux-free connection failed: ${err.message}` } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: url.toString(), headers, transformedBody: bodyObj };
    }
  }
}

export default ZenmuxFreeExecutor;