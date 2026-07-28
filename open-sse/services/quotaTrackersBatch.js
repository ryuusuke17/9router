import { shouldThrottleFetch, markFetchTime } from "./quotaFetchThrottle.js";

export async function batchFetchQuota(accounts, provider, fetcher) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  if (typeof fetcher !== "function") return [];

  const results = [];

  for (const account of accounts) {
    const connectionId = typeof account === "string" ? account : account.id;
    if (!connectionId) continue;

    if (shouldThrottleFetch(connectionId, provider)) {
      continue;
    }

    try {
      markFetchTime(connectionId, provider);
      const quota = await fetcher(connectionId, account);
      results.push({
        connectionId,
        provider,
        quota,
        success: true,
      });
    } catch (err) {
      results.push({
        connectionId,
        provider,
        quota: null,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export async function batchFetchAllQuotas(accountsByProvider) {
  const allResults = [];

  for (const [provider, accounts] of Object.entries(accountsByProvider)) {
    const { getQuotaFetcher } = await import("./quotaPreflight.js");
    const fetcher = getQuotaFetcher(provider);
    if (!fetcher) continue;

    const results = await batchFetchQuota(accounts, provider, fetcher);
    allResults.push(...results);
  }

  return allResults;
}
