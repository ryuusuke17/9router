const EMA_ALPHA = 0.3;

export function computeBurnRateFromWindow(consumedTotal, windowMs, remaining) {
  if (consumedTotal <= 0 || windowMs <= 0) {
    return { tokensPerSecond: 0, timeToExhaustionMs: null };
  }

  const nowMs = Date.now();
  const currentBucketIndex = Math.floor(nowMs / windowMs);
  const windowStartMs = currentBucketIndex * windowMs;
  const elapsedMs = Math.max(1, nowMs - windowStartMs);

  const safeRate = consumedTotal / (elapsedMs / 1000);
  const timeToExhaustionMs =
    safeRate > 0 && remaining !== undefined && remaining >= 0
      ? (remaining / safeRate) * 1000
      : null;

  return { tokensPerSecond: safeRate, timeToExhaustionMs };
}

export function computeBurnRate(history, remaining) {
  if (history.length < 2) {
    return { tokensPerSecond: 0, timeToExhaustionMs: null };
  }

  let emaRate = 0;
  let initialized = false;

  for (let i = 1; i < history.length; i++) {
    const deltaConsumed = history[i].consumed - history[i - 1].consumed;
    const deltaTs = history[i].ts - history[i - 1].ts;

    if (deltaTs <= 0) continue;

    const instantRate = deltaConsumed / (deltaTs / 1000);

    if (!initialized) {
      emaRate = instantRate;
      initialized = true;
    } else {
      emaRate = EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * emaRate;
    }
  }

  if (!initialized) {
    return { tokensPerSecond: 0, timeToExhaustionMs: null };
  }

  const safeRate = Math.max(0, emaRate);
  const timeToExhaustionMs =
    safeRate > 0 && remaining !== undefined && remaining >= 0
      ? (remaining / safeRate) * 1000
      : null;

  return { tokensPerSecond: safeRate, timeToExhaustionMs };
}
