import { recordConsumption } from "./enforce.js";

export function scheduleRecordConsumption(input, log) {
  setImmediate(() => {
    recordConsumption(input).catch((err) => {
      if (log?.warn) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[quotaShare] recordConsumption failed (drift expected)"
        );
      }
    });
  });
}

export function buildConsumptionCost(usage, estimatedCost) {
  const u = usage && typeof usage === "object" ? usage : null;
  const tokens = u
    ? (Number(u.prompt_tokens ?? 0) || 0) + (Number(u.completion_tokens ?? 0) || 0)
    : 0;
  return {
    tokens,
    usd: estimatedCost > 0 ? estimatedCost : 0,
    requests: 1,
  };
}

export async function recordStreamingConsumption(params, deps) {
  const { apiKeyId, connectionId, provider, model, streamUsage, streamStatus, serviceTier } = params;
  if (!apiKeyId || !connectionId || streamStatus !== 200) return;

  const schedule = deps.schedule ?? scheduleRecordConsumption;
  const resolvedProvider = provider ?? "unknown";

  let estimatedCost = 0;
  if (streamUsage && typeof streamUsage === "object") {
    try {
      estimatedCost = await deps.calculateCost(
        resolvedProvider,
        model,
        streamUsage,
        { serviceTier }
      );
    } catch {
      estimatedCost = 0;
    }
  }

  schedule(
    {
      apiKeyId,
      connectionId,
      provider: resolvedProvider,
      model: model || undefined,
      cost: buildConsumptionCost(streamUsage, estimatedCost),
    },
    deps.log
  );
}
