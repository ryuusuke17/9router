import { getDomainState } from "@/lib/db/index.js";
import { getKnownPlan } from "./planRegistry.js";

const PLAN_OVERRIDE_SCOPE = "providerPlan";

export async function resolvePlan(connectionId, provider) {
  try {
    const dbPlan = await getDomainState(PLAN_OVERRIDE_SCOPE, connectionId);
    if (dbPlan && Array.isArray(dbPlan.dimensions) && dbPlan.dimensions.length > 0) {
      return {
        connectionId: dbPlan.connectionId ?? connectionId,
        provider: dbPlan.provider ?? provider,
        dimensions: dbPlan.dimensions,
        source: "manual",
      };
    }
  } catch {
    // DB unavailable — fall through to catalog
  }

  const catalogPlan = getKnownPlan(provider);
  if (catalogPlan) {
    return {
      connectionId: null,
      provider: catalogPlan.provider,
      dimensions: catalogPlan.dimensions,
      source: "auto",
    };
  }

  return {
    connectionId: null,
    provider,
    dimensions: [],
    source: "manual",
  };
}
