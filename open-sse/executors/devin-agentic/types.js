export class DevinAgenticBridgeError extends Error {
  constructor(message, code = "devin_agentic_error", status = 400) {
    super(message);
    this.name = "DevinAgenticBridgeError";
    this.code = code;
    this.status = status;
  }
}

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil((String(text) || "").length / 4));
}