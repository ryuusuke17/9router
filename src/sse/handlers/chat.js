import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { getApiKeyByValue } from "@/lib/db/index.js";
import { getProviderConnections } from "@/lib/localDb";
import { enforceQuotaShare } from "@/lib/quota/enforce.js";
import { scheduleRecordConsumption, buildConsumptionCost } from "@/lib/quota/spendRecorder.js";
import {
  isProviderInCooldown,
  isProviderFullyBlocked,
  getProviderShortestCooldownMs,
  recordProviderFailure,
  clearProviderFailure,
} from "open-sse/services/accountFallback.js";
import {
  acquire as acquireAccountSemaphore,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
  isSemaphoreCapacityError,
} from "open-sse/services/accountSemaphore.js";
import { getProxyHash } from "@/lib/network/connectionProxy.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

function checkCircuitBreaker(provider, proxyHash = null, enabled = true) {
  if (!enabled) return false;
  return proxyHash ? isProviderInCooldown(provider, proxyHash) : isProviderFullyBlocked(provider);
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Resolve API key ID for quota enforcement
  let apiKeyId = null;
  if (apiKey) {
    try {
      const record = await getApiKeyByValue(apiKey);
      if (record) apiKeyId = record.id;
    } catch {
      // quota enforcement skipped on lookup failure
    }
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  const chatSettings = await getSettings();
  const circuitBreakerEnabled = chatSettings.circuitBreakerEnabled !== false && chatSettings.circuitBreakerEnabled !== 0;

  // Pipeline gate: check circuit breaker state BEFORE credential lookup.
  if (checkCircuitBreaker(provider, null, circuitBreakerEnabled)) {
    const cooldownMs = getProviderShortestCooldownMs(provider);
    const retryAfterSec = Math.ceil(cooldownMs / 1000) || 30;
    const retryAfterTimestamp = new Date(Date.now() + cooldownMs).toISOString();
    log.warn("GATE", `${provider} circuit breaker OPEN on all proxy buckets — short-circuiting before credential lookup`);
    return unavailableResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}/${model}] Provider temporarily unavailable (circuit breaker open)`,
      retryAfterTimestamp,
      `${retryAfterSec}s`
    );
  }

  // Count configured accounts for this provider so chatCore can cap per-account retries
  let providerAccountCount = 0;
  try {
    const allProviderConnections = await getProviderConnections({ provider });
    providerAccountCount = allProviderConnections?.length || 0;
  } catch (e) {
    log?.warn?.("AUTH", `Failed to count provider connections for ${provider}: ${e.message}`);
  }

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastExcludedConnectionId = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Compute proxy bucket key for this account
    const proxyHash = getProxyHash(credentials.providerSpecificData);

    // Proxy-aware circuit breaker: skip THIS account if its proxy bucket is OPEN
    if (checkCircuitBreaker(provider, proxyHash, circuitBreakerEnabled)) {
      log.warn("AUTH", `${provider} proxy bucket ${proxyHash} circuit breaker OPEN — skipping account ${credentials.connectionName}`);
      excludeConnectionIds.add(credentials.connectionId);
      lastExcludedConnectionId = credentials.connectionId;
      continue;
    }

    log.info("AUTH", `Using ${provider} account: ${credentials.connectionName}`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Acquire account semaphore (concurrency limiter per provider:account:proxy)
    const semaphoreKey = resolveAccountSemaphoreKey({ provider, model, connectionId: credentials.connectionId, credentials: refreshedCredentials, proxyHash });
    const semaphoreMax = resolveAccountSemaphoreMaxConcurrency(refreshedCredentials);
    const semaphoreEnabled = chatSettings.semaphoreEnabled !== false && chatSettings.semaphoreEnabled !== 0;
    let semaphoreRelease = () => {};
    if (semaphoreEnabled && semaphoreKey && semaphoreMax != null) {
      try {
        semaphoreRelease = await acquireAccountSemaphore(semaphoreKey, { maxConcurrency: semaphoreMax, timeoutMs: 30_000 });
      } catch (e) {
        if (isSemaphoreCapacityError(e)) {
          log.warn("AUTH", `Account ${credentials.connectionName} at capacity, trying fallback`);
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
        throw e;
      }
    }

    // Enforce quota share before dispatching the upstream request
    if (apiKeyId) {
      try {
        const quotaResult = await enforceQuotaShare({
          apiKeyId,
          connectionId: credentials.connectionId,
          provider,
          model,
        });
        if (quotaResult.kind === "block") {
          const retryAfter = quotaResult.retryAfterSeconds ?? 30;
          log.warn("QUOTA", `[${provider}/${model}] Quota blocked: ${quotaResult.reason}`);
          semaphoreRelease();
          await markAccountUnavailable(
            credentials.connectionId,
            quotaResult.httpStatus || 429,
            quotaResult.reason,
            provider,
            model,
            Date.now() + retryAfter * 1000
          );
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
      } catch (err) {
        log.warn("QUOTA", `[${provider}/${model}] Quota check error: ${err.message}`);
      }
    }

    // Use shared chatCore — wrap in try/finally so semaphoreRelease() always runs
    let result;
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const loopGuardEnabled = chatSettings.loopGuardEnabled !== false && chatSettings.loopGuardEnabled !== 0;
    try {
      result = await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model, accountCount: providerAccountCount },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        headroomEnabled: !!chatSettings.headroomEnabled,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        headroomTimeoutMs: chatSettings.headroomTimeoutMs,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: !!chatSettings.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        loopGuardEnabled,
        providerThinking,
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
          clearProviderFailure(provider, proxyHash);
        }
      });
    } finally {
      semaphoreRelease();
    }

    if (result.success) {
      if (apiKeyId) {
        scheduleRecordConsumption(
          {
            apiKeyId,
            connectionId: credentials.connectionId,
            provider,
            model,
            cost: buildConsumptionCost(null, 0),
          },
          log
        );
      }
      return result.response;
    }

    // Normalize result.error to a string before passing to error matchers
    const errorText = result.error?.message || result.error;

    // Record provider-level failure for circuit breaker (skip for client-side errors)
    recordProviderFailure(provider, result.status, errorText, log, credentials.connectionId, proxyHash);

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, errorText, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorText;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
