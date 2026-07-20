import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeSessionCookieHeader } from "../utils/webCookieAuth.js";

const BLACKBOX_CHAT_API = "https://app.blackbox.ai/api/chat";
const BLACKBOX_DEFAULT_COOKIE = "next-auth.session-token";
const BLACKBOX_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const SESSION_CACHE_TTL_MS = 5 * 60_000;
const sessionCache = new Map();

function extractMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "input_text" && typeof part.text === "string") return part.text;
    return "";
  }).filter((p) => p.trim().length > 0).join("\n").trim();
}

function parseOpenAIMessages(messages, chatId) {
  const systemParts = [];
  const parsed = [];
  for (const message of messages) {
    const role = String(message.role || "user");
    const content = extractMessageText(message.content);
    if (!content) continue;
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }
    if (role === "assistant" || role === "user") {
      parsed.push({ id: role === "user" ? chatId : crypto.randomUUID(), role, content });
    }
  }
  if (systemParts.length > 0) {
    const prefix = `System instructions:\n${systemParts.join("\n\n")}`;
    const firstUserIndex = parsed.findIndex((m) => m.role === "user");
    if (firstUserIndex >= 0) {
      parsed[firstUserIndex] = { ...parsed[firstUserIndex], content: `${prefix}\n\n${parsed[firstUserIndex].content}` };
    } else {
      parsed.unshift({ id: chatId, role: "user", content: prefix });
    }
  }
  return parsed;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

function readTextResponse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return new Promise((resolve, reject) => {
    function read() {
      reader.read().then(({ done, value }) => {
        if (signal?.aborted) {
          reader.cancel();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (done) { resolve(text); return; }
        text += decoder.decode(value, { stream: true });
        read();
      }).catch(reject);
    }
    read();
  });
}

function buildStreamingResponse(responseText, model, id, created) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
      })}\n\n`));
      if (responseText) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: responseText }, finish_reason: null, logprobs: null }],
        })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }, { highWaterMark: 16384 });
}

function buildNonStreamingResponse(responseText, model, id, created) {
  const completionTokens = estimateTokens(responseText);
  return new Response(JSON.stringify({
    id, object: "chat.completion", created, model, system_fingerprint: null,
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: completionTokens, completion_tokens: completionTokens, total_tokens: completionTokens * 2 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class BlackboxWebExecutor extends BaseExecutor {
  constructor() {
    super("blackbox-web", PROVIDERS["blackbox-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const messages = bodyObj.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({ error: { message: "Missing or empty messages array", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers: {}, transformedBody: body };
    }

    // Tools not yet ported
    if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Blackbox Web does not support tool calling in this port — needs prepareToolMessages from OmniRoute webTools.ts", type: "not_implemented" },
      }), { status: 501, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers: {}, transformedBody: body };
    }

    const chatId = crypto.randomUUID().slice(0, 7);
    const parsedMessages = parseOpenAIMessages(messages, chatId);
    if (parsedMessages.length === 0) {
      const errResp = new Response(JSON.stringify({ error: { message: "Empty query after processing messages", type: "invalid_request" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers: {}, transformedBody: body };
    }

    const cookieHeader = normalizeSessionCookieHeader(credentials.apiKey || "", BLACKBOX_DEFAULT_COOKIE);
    const baseHeaders = {
      Accept: "application/json",
      Cookie: cookieHeader,
      Origin: "https://app.blackbox.ai",
      "User-Agent": BLACKBOX_USER_AGENT,
    };

    // Fetch session + subscription (cached per cookie)
    let sessionData = null;
    let subscriptionCache = null;
    let teamAccount = "";
    const cacheKey = cookieHeader;
    const cached = sessionCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL_MS) {
      sessionData = cached.sessionData;
      subscriptionCache = cached.subscriptionCache;
      teamAccount = cached.teamAccount;
      log?.debug?.("BLACKBOX-WEB", `Session cache hit (${teamAccount || "no email"})`);
    } else {
      const sideSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      try {
        const sessionRes = await fetch("https://app.blackbox.ai/api/auth/session", {
          method: "GET", headers: { ...baseHeaders, Accept: "application/json" }, signal: sideSignal,
        });
        sessionData = sessionRes.ok ? await sessionRes.json() : null;
        const email = sessionData?.user?.email;
        teamAccount = email || "";
        log?.debug?.("BLACKBOX-WEB", `Session email: ${email ?? "none"}`);

        if (email) {
          const subRes = await fetch("https://app.blackbox.ai/api/check-subscription", {
            method: "POST", headers: { ...baseHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ email }), signal: sideSignal,
          });
          const rawSub = subRes.ok ? await subRes.json() : null;
          if (rawSub) {
            subscriptionCache = {
              status: rawSub.hasActiveSubscription ? "PREMIUM" : "FREE",
              customerId: rawSub.customerId || null,
              expiryTimestamp: rawSub.expiryTimestamp || null,
              lastChecked: Date.now(),
              isTrialSubscription: rawSub.isTrialSubscription || false,
              hasPaymentVerificationFailure: false,
              verificationFailureTimestamp: null,
              requiresAuthentication: false,
              isTeam: rawSub.isTeam || false,
              numSeats: rawSub.numSeats || 1,
              provider: rawSub.provider || null,
              previouslySubscribed: rawSub.previouslySubscribed || false,
              activeInsuffientCredits: rawSub.activeInsuffientCredits || false,
            };
            log?.debug?.("BLACKBOX-WEB", `Subscription: ${subscriptionCache.status}`);
          }
        }
        sessionCache.set(cacheKey, { sessionData, subscriptionCache, teamAccount, fetchedAt: Date.now() });
        if (sessionCache.size > 100) {
          const firstKey = sessionCache.keys().next().value;
          if (firstKey) sessionCache.delete(firstKey);
        }
      } catch (diagErr) {
        log?.debug?.("BLACKBOX-WEB", `Session/subscription fetch failed (non-fatal): ${diagErr}`);
      }
    }

    const headers = {
      ...baseHeaders,
      Accept: "text/plain, */*",
      "Content-Type": "application/json",
      Referer: `https://app.blackbox.ai/chat/${chatId}`,
    };

    const transformedBody = {
      messages: parsedMessages,
      id: chatId,
      previewToken: null,
      userId: credentials?.providerSpecificData?.userId || null,
      codeModelMode: true,
      trendingAgentMode: {},
      isMicMode: false,
      userSystemPrompt: null,
      maxTokens: Number(bodyObj.max_tokens) || 1024,
      playgroundTopP: null,
      playgroundTemperature: null,
      isChromeExt: false,
      githubToken: "",
      clickedAnswer2: false,
      clickedAnswer3: false,
      clickedForceWebSearch: false,
      visitFromDelta: false,
      isMemoryEnabled: false,
      mobileClient: false,
      userSelectedModel: model || null,
      userSelectedAgent: "VscodeAgent",
      validated: crypto.randomUUID(),
      imageGenerationMode: false,
      imageGenMode: "autoMode",
      webSearchModePrompt: false,
      deepSearchMode: false,
      promptSelection: "",
      domains: null,
      vscodeClient: false,
      codeInterpreterMode: false,
      customProfile: { name: "", occupation: "", traits: [], additionalInfo: "", enableNewChats: false },
      webSearchModeOption: { autoMode: true, webMode: false, offlineMode: false },
      session: sessionData,
      isPremium: subscriptionCache ? subscriptionCache.status === "PREMIUM" : (credentials?.providerSpecificData?.isPremium ?? true),
      teamAccount,
      subscriptionCache,
      beastMode: false,
      reasoningMode: false,
      designerMode: false,
      workspaceId: "",
      asyncMode: false,
      integrations: {},
      isTaskPersistent: false,
      selectedElement: null,
    };

    const timeoutSignal = AbortSignal.timeout(120_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(BLACKBOX_CHAT_API, {
        method: "POST", headers, body: JSON.stringify(transformedBody), signal: combinedSignal,
      });
    } catch (error) {
      const message = error.message || String(error);
      log?.error?.("BLACKBOX-WEB", `Fetch failed: ${message}`);
      const errResp = new Response(JSON.stringify({ error: { message: `Blackbox Web connection failed: ${message}`, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers, transformedBody };
    }

    if (!upstreamResponse.ok) {
      const status = upstreamResponse.status;
      let message = `Blackbox Web returned HTTP ${status}`;
      const errorBody = await upstreamResponse.text().catch(() => "");
      if (status === 401 || status === 403) {
        message = "Blackbox Web auth failed — your app.blackbox.ai session cookie may be missing or expired.";
      } else if (status === 429) {
        message = "Blackbox Web rate limited the session. Wait a moment and retry.";
      }
      const errResp = new Response(JSON.stringify({ error: { message, type: "upstream_error", code: `HTTP_${status}` } }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers, transformedBody };
    }

    if (!upstreamResponse.body) {
      const errResp = new Response(JSON.stringify({ error: { message: "Blackbox Web returned an empty response body", type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers, transformedBody };
    }

    const responseText = (await readTextResponse(upstreamResponse.body, signal)).trim();

    // Check for in-band error messages
    const lowerText = responseText.toLowerCase();
    const isAuthError = /please login|login required|authentication required/i.test(responseText);
    const isRateLimit = /rate limit|too many requests/i.test(responseText);

    if (isAuthError) {
      const errResp = new Response(JSON.stringify({ error: { message: "Blackbox session is not authenticated — re-paste next-auth.session-token from app.blackbox.ai", type: "upstream_error", code: "BLACKBOX_AUTH_REQUIRED" } }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers, transformedBody };
    }
    if (isRateLimit) {
      const errResp = new Response(JSON.stringify({ error: { message: "Blackbox Web rate limited. Wait a moment and retry.", type: "upstream_error", code: "BLACKBOX_RATE_LIMIT" } }), { status: 429, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: BLACKBOX_CHAT_API, headers, transformedBody };
    }

    const id = `chatcmpl-blackbox-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    const finalResponse = stream
      ? new Response(buildStreamingResponse(responseText, model, id, created), {
          status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
        })
      : buildNonStreamingResponse(responseText, model, id, created);

    return { response: finalResponse, url: BLACKBOX_CHAT_API, headers, transformedBody };
  }
}

export default BlackboxWebExecutor;
