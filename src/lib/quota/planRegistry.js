const KNOWN_PLANS = {
  codex: {
    provider: "codex",
    dimensions: [
      { unit: "percent", window: "5h", limit: 100 },
      { unit: "percent", window: "weekly", limit: 100 },
    ],
  },
  claude: {
    provider: "claude",
    dimensions: [
      { unit: "percent", window: "5h", limit: 100 },
      { unit: "percent", window: "weekly", limit: 100 },
    ],
  },
  glm: {
    provider: "glm",
    dimensions: [
      { unit: "tokens", window: "5h", limit: Number.EPSILON },
      { unit: "tokens", window: "weekly", limit: Number.EPSILON },
    ],
  },
  minimax: {
    provider: "minimax",
    dimensions: [
      { unit: "tokens", window: "5h", limit: Number.EPSILON },
      { unit: "tokens", window: "weekly", limit: Number.EPSILON },
    ],
  },
  deepseek: {
    provider: "deepseek",
    dimensions: [{ unit: "usd", window: "monthly", limit: Number.EPSILON }],
  },
  bailian: {
    provider: "bailian",
    dimensions: [
      { unit: "percent", window: "5h", limit: 100 },
      { unit: "percent", window: "weekly", limit: 100 },
      { unit: "percent", window: "monthly", limit: 100 },
    ],
  },
  kimi: {
    provider: "kimi",
    dimensions: [{ unit: "requests", window: "hourly", limit: 1500 }],
  },
  "kimi-coding": {
    provider: "kimi-coding",
    dimensions: [
      { unit: "tokens", window: "5h", limit: Number.EPSILON },
      { unit: "tokens", window: "weekly", limit: Number.EPSILON },
    ],
  },
  "xiaomi-mimo": {
    provider: "xiaomi-mimo",
    dimensions: [{ unit: "tokens", window: "monthly", limit: 4_100_000_000 }],
  },
  alibaba: {
    provider: "alibaba",
    dimensions: [{ unit: "requests", window: "monthly", limit: 90_000 }],
  },
  "grok-cli": {
    provider: "grok-cli",
    dimensions: [
      { unit: "requests", window: "daily", limit: 864 },
      { unit: "tokens", window: "daily", limit: 18_000_000 },
      { unit: "requests", window: "weekly", limit: 6048 },
      { unit: "tokens", window: "weekly", limit: 126_000_000 },
    ],
  },
  ollama: {
    provider: "ollama",
    dimensions: [
      { unit: "requests", window: "5h", limit: Number.EPSILON },
      { unit: "tokens", window: "5h", limit: Number.EPSILON },
      { unit: "requests", window: "7d", limit: Number.EPSILON },
      { unit: "tokens", window: "7d", limit: Number.EPSILON },
    ],
  },
  "ollama-local": {
    provider: "ollama-local",
    dimensions: [
      { unit: "requests", window: "hourly", limit: Number.EPSILON },
      { unit: "tokens", window: "hourly", limit: Number.EPSILON },
    ],
  },
};

export function getKnownPlan(provider) {
  return KNOWN_PLANS[provider] ?? null;
}

export function knownProviders() {
  return Object.keys(KNOWN_PLANS);
}
