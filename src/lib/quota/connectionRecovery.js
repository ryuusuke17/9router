const RECOVERABLE_COOLDOWN_STATUS = "unavailable";

const TERMINAL_CONNECTION_STATUSES = new Set([
  "banned",
  "expired",
  "credits_exhausted",
]);

function cooldownUntilMs(rateLimitedUntil) {
  if (!rateLimitedUntil) return null;
  // ISO 8601 string
  const iso = Date.parse(rateLimitedUntil);
  if (Number.isFinite(iso)) return iso;
  // numeric epoch string
  const numeric = Number(rateLimitedUntil);
  if (Number.isFinite(numeric)) return numeric;
  return null;
}

function normalizeStatus(value) {
  return (value || "").trim().toLowerCase();
}

function hasElapsedCooldown(rateLimitedUntil, nowMs) {
  if (!rateLimitedUntil) return false;
  const ms = cooldownUntilMs(rateLimitedUntil);
  return Number.isFinite(ms) && ms <= nowMs;
}

export function isRecoverableCooldownConnection(connection, nowMs) {
  if (!connection || typeof connection.id !== "string" || connection.id.length === 0) {
    return false;
  }
  const status = normalizeStatus(connection.testStatus);
  if (status !== RECOVERABLE_COOLDOWN_STATUS) return false;
  if (TERMINAL_CONNECTION_STATUSES.has(status)) return false;
  return hasElapsedCooldown(connection.rateLimitedUntil, nowMs);
}

export function selectRecoverableConnections(connections, nowMs) {
  if (!Array.isArray(connections)) return [];
  return connections.filter((c) => isRecoverableCooldownConnection(c, nowMs));
}

export async function runConnectionRecoveryTick(deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const result = { scanned: 0, recovered: 0, recoveredIds: [] };

  let connections;
  try {
    const load =
      deps.loadConnections ??
      (async () => {
        const { getProviderConnections } = await import("@/lib/db/index.js");
        const rows = await getProviderConnections();
        return (Array.isArray(rows) ? rows : []).map((row) => ({
          id: typeof row.id === "string" ? row.id : "",
          testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
          rateLimitedUntil: typeof row.rateLimitedUntil === "string" ? row.rateLimitedUntil : null,
        }));
      });
    connections = await load();
  } catch (err) {
    deps.logger?.warn?.(
      `[ConnectionRecovery] failed to load connections: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }

  result.scanned = connections.length;
  const recoverable = selectRecoverableConnections(connections, nowMs);
  if (recoverable.length === 0) return result;

  const clear =
    deps.clearConnectionError ??
    (async (connectionId) => {
      const { getProviderConnectionById, updateProviderConnection } = await import("@/lib/db/index.js");
      const conn = await getProviderConnectionById(connectionId);
      if (conn) {
        await updateProviderConnection(connectionId, {
          testStatus: "ok",
          rateLimitedUntil: null,
        });
      }
    });

  for (const connection of recoverable) {
    try {
      await clear(connection.id, connection);
      result.recovered += 1;
      result.recoveredIds.push(connection.id);
    } catch (err) {
      deps.logger?.warn?.(
        `[ConnectionRecovery] failed to recover ${connection.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (result.recovered > 0) {
    (deps.logger?.info ?? console.log)(
      `[ConnectionRecovery] proactively restored ${result.recovered} connection(s) with elapsed cooldown`
    );
  }
  return result;
}

const DEFAULT_TICK_MS = 60 * 1000;
const MIN_TICK_MS = 5 * 1000;
const RECOVERY_LOG_PREFIX = "[ConnectionRecovery]";

let _recoveryState = { initialized: false, interval: null };

function resolveRecoveryIntervalMs() {
  const raw = typeof process !== "undefined" ? process.env.OMNIROUTE_CONNECTION_RECOVERY_INTERVAL_MS : undefined;
  if (!raw) return DEFAULT_TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_MS;
  return Math.max(MIN_TICK_MS, Math.floor(parsed));
}

export function initConnectionRecoveryScheduler() {
  if (_recoveryState.initialized) return;
  _recoveryState.initialized = true;

  const tickMs = resolveRecoveryIntervalMs();
  const tickLogger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  };

  const runTick = () => {
    runConnectionRecoveryTick({ logger: tickLogger }).catch((err) => {
      console.warn(`${RECOVERY_LOG_PREFIX} tick error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  console.log(
    `${RECOVERY_LOG_PREFIX} Starting proactive cooldown recovery (tick every ${Math.round(tickMs / 1000)}s)`
  );

  const timer = setTimeout(() => {
    runTick();
    _recoveryState.interval = setInterval(runTick, tickMs);
    if (_recoveryState.interval?.unref) _recoveryState.interval.unref();
  }, 15_000);
  if (timer?.unref) timer.unref();
}

export function stopConnectionRecoveryScheduler() {
  if (_recoveryState.interval) {
    clearInterval(_recoveryState.interval);
    _recoveryState.interval = null;
  }
  _recoveryState.initialized = false;
}
