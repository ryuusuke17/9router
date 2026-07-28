import { getDomainState, setDomainState } from "@/lib/db/index.js";

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BUFFER_SIZE = 1_000;

function getFlushIntervalMs() {
  const parsed = Number.parseInt(process.env.NINEROUTER_SPEND_FLUSH_INTERVAL_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FLUSH_INTERVAL_MS;
}

function getMaxBufferSize() {
  const parsed = Number.parseInt(process.env.NINEROUTER_SPEND_MAX_BUFFER_SIZE || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BUFFER_SIZE;
}

function normalizeEntry(entry) {
  if (!entry || !entry.apiKeyId || !Number.isFinite(entry.cost) || entry.cost <= 0) return null;
  return {
    apiKeyId: entry.apiKeyId,
    cost: entry.cost,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
  };
}

export class SpendBatchWriter {
  constructor(options = {}) {
    this.buffer = [];
    this.inFlightEntries = [];
    this.discardedApiKeyIds = new Set();
    this.timer = null;
    this.started = false;
    this.flushPromise = null;
    this.persistEntries = options.persistEntries || batchPersistCostEntries;
    this.logger = options.logger || console;
    this.flushIntervalMs = options.flushIntervalMs ?? getFlushIntervalMs();
    this.maxBufferSize = options.maxBufferSize ?? getMaxBufferSize();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  increment(apiKeyId, cost, timestamp = Date.now()) {
    const entry = normalizeEntry({ apiKeyId, cost, timestamp });
    if (!entry) return;
    this.start();
    this.discardedApiKeyIds.delete(entry.apiKeyId);
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  getBufferedEntries(apiKeyId, sinceTimestamp = 0, untilTimestamp = Number.POSITIVE_INFINITY) {
    const matchesWindow = (entry) =>
      entry.apiKeyId === apiKeyId &&
      entry.timestamp >= sinceTimestamp &&
      entry.timestamp < untilTimestamp;
    return [...this.inFlightEntries, ...this.buffer].filter(matchesWindow);
  }

  getPendingCostTotal(apiKeyId, sinceTimestamp = 0, untilTimestamp = Number.POSITIVE_INFINITY) {
    return this.getBufferedEntries(apiKeyId, sinceTimestamp, untilTimestamp).reduce(
      (sum, entry) => sum + entry.cost,
      0
    );
  }

  discardEntries(apiKeyId) {
    this.discardedApiKeyIds.add(apiKeyId);
    this.buffer = this.buffer.filter((e) => e.apiKeyId !== apiKeyId);
    this.inFlightEntries = this.inFlightEntries.filter((e) => e.apiKeyId !== apiKeyId);
  }

  async flush() {
    if (this.flushPromise) return this.flushPromise;
    if (this.buffer.length === 0) return { flushedEntries: 0, uniqueKeys: 0, requeued: false };

    const entriesToFlush = [...this.buffer];
    this.buffer = [];
    this.inFlightEntries = entriesToFlush;

    this.flushPromise = (async () => {
      const entriesToPersist = entriesToFlush.filter(
        (e) => !this.discardedApiKeyIds.has(e.apiKeyId)
      );
      const uniqueKeys = new Set(entriesToPersist.map((e) => e.apiKeyId)).size;
      try {
        if (entriesToPersist.length > 0) {
          await this.persistEntries(entriesToPersist);
        }
        this.logger.log(
          `[SpendWriter] Flushed ${entriesToPersist.length} cost entr${entriesToPersist.length === 1 ? "y" : "ies"} across ${uniqueKeys} key(s)`
        );
        return { flushedEntries: entriesToPersist.length, uniqueKeys, requeued: false };
      } catch (error) {
        this.buffer = [...entriesToPersist, ...this.buffer];
        this.logger.error(`[SpendWriter] Flush error: ${error instanceof Error ? error.message : String(error)}`);
        return { flushedEntries: 0, uniqueKeys, requeued: true };
      } finally {
        this.inFlightEntries = [];
        this.flushPromise = null;
      }
    })();
    return this.flushPromise;
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    return this.flush();
  }

  resetForTests() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.buffer = [];
    this.inFlightEntries = [];
    this.discardedApiKeyIds.clear();
    this.flushPromise = null;
  }
}

export async function batchPersistCostEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const grouped = {};
  for (const e of entries) {
    if (!grouped[e.apiKeyId]) grouped[e.apiKeyId] = [];
    grouped[e.apiKeyId].push({ cost: e.cost, timestamp: e.timestamp });
  }
  for (const [apiKeyId, newEntries] of Object.entries(grouped)) {
    const existing = await getDomainState("spendHistory", apiKeyId);
    const history = Array.isArray(existing) ? existing : [];
    history.push(...newEntries);
    await setDomainState("spendHistory", apiKeyId, history);
  }
}

export const spendBatchWriter = new SpendBatchWriter();

export function startSpendBatchWriter() {
  spendBatchWriter.start();
}

export async function flushSpendBatchWriter() {
  return spendBatchWriter.flush();
}

export async function stopSpendBatchWriter() {
  return spendBatchWriter.stop();
}

export function resetSpendBatchWriterForTests() {
  spendBatchWriter.resetForTests();
}

export function discardSpendBatchEntries(apiKeyId) {
  spendBatchWriter.discardEntries(apiKeyId);
}
