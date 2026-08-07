import { BaseExecutor } from "./base.js";
import { buildErrorBody } from "../utils/error.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  RAYCAST_CHAT_URL,
  buildRaycastChatBody,
  buildRaycastHeaders,
  parseRaycastSseEvents,
} from "../services/raycast.js";

function sanitizeMessage(message) {
  return String(message || "").split("\n")[0].slice(0, 4096);
}

function makeErrorResult(status, message, body, transformedBody) {
  const errorInfo = buildErrorBody(status, sanitizeMessage(message));
  errorInfo.error.type = "upstream_error";
  errorInfo.error.code = `HTTP_${status}`;
  return {
    response: new Response(JSON.stringify(errorInfo), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    url: RAYCAST_CHAT_URL,
    headers: {},
    transformedBody,
  };
}

export class RaycastExecutor extends BaseExecutor {
  constructor() {
    super("raycast", { id: "raycast", baseUrl: RAYCAST_CHAT_URL });
  }

  buildUrl() {
    return RAYCAST_CHAT_URL;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const reqBody = body || {};
    const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    let payload;
    try {
      payload = buildRaycastChatBody(model, messages, reqBody.temperature);
    } catch (err) {
      return makeErrorResult(400, err.message, body, body);
    }

    let headers;
    try {
      headers = buildRaycastHeaders(payload, credentials || {});
    } catch (err) {
      return makeErrorResult(400, err.message, body, body);
    }

    let raycastResponse;
    try {
      raycastResponse = await proxyAwareFetch(
        RAYCAST_CHAT_URL,
        { method: "POST", headers, body: payload, signal: signal || undefined },
        proxyOptions
      );
    } catch (err) {
      return makeErrorResult(502, err.message, body, payload);
    }

    if (!raycastResponse.ok) {
      const errorText = await raycastResponse.text().catch(() => "");
      return makeErrorResult(
        raycastResponse.status,
        `Raycast API error (${raycastResponse.status})${errorText ? `: ${errorText.slice(0, 300)}` : ""}`,
        body,
        payload
      );
    }

    const responseId = `chatcmpl-raycast-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = model;

    if (stream !== false) {
      const raycastBody = raycastResponse.body;
      if (!raycastBody) {
        return makeErrorResult(502, "Raycast returned empty stream body", body, payload);
      }

      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const reader = raycastBody.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let currentEvent = "";
          let streamErrored = false;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              let newlineIndex;
              while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (line.startsWith("event:")) {
                  currentEvent = line.slice("event:".length).trim();
                  continue;
                }
                if (!line.startsWith("data:")) continue;

                try {
                  const data = JSON.parse(line.slice(5).trim());
                  if (currentEvent === "error") {
                    streamErrored = true;
                    const message = data?.error?.message || data?.message || "Raycast upstream error";
                    const errChunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model: modelId,
                      choices: [
                        {
                          index: 0,
                          delta: {},
                          finish_reason: "stop",
                        },
                      ],
                      error: { message: String(message).slice(0, 4096) },
                    };
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`)
                    );
                    break;
                  }
                  currentEvent = null;

                  const hasContent = typeof data.text === "string" && data.text.length > 0;
                  const hasFinishReason =
                    data.finish_reason !== undefined && data.finish_reason !== null;
                  if (data.complete || (!hasContent && !hasFinishReason)) continue;

                  const chunk = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelId,
                    choices: [
                      {
                        index: 0,
                        delta: { content: data.text || "" },
                        finish_reason: hasFinishReason ? data.finish_reason : null,
                      },
                    ],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch {
                  // Ignore malformed SSE data.
                }
                if (streamErrored) break;
              }
              if (streamErrored) break;
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return {
        response: new Response(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: RAYCAST_CHAT_URL,
        headers,
        transformedBody: payload,
      };
    }

    const responseText = await raycastResponse.text();
    const { text: content, error } = parseRaycastSseEvents(responseText);

    if (error) {
      return makeErrorResult(
        Number(error.status) || 502,
        `Raycast upstream error: ${error.message}`,
        body,
        payload
      );
    }

    return {
      response: new Response(
        JSON.stringify({
          id: responseId,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content, refusal: null },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: RAYCAST_CHAT_URL,
      headers,
      transformedBody: payload,
    };
  }
}

export default RaycastExecutor;