import crypto from "node:crypto";

function signPayload(payload, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export async function deliverWebhook(url, payload, secret, maxRetries = 3) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "9Router-Webhook/1.0",
    "X-Webhook-Event": payload.event,
    "X-Webhook-Timestamp": payload.timestamp,
  };
  if (secret) {
    headers["X-Webhook-Signature"] = signPayload(body, secret);
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      let res;
      try {
        res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (res.ok || res.status < 500) {
        return { success: res.ok, status: res.status };
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    } catch {
      if (attempt === maxRetries) {
        return { success: false, status: 0, error: "Max retries exceeded" };
      }
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  return { success: false, status: 0, error: "Max retries exceeded" };
}

export function notifyWebhookEvent(event, data) {
  dispatchQuotaEvent(event, data).catch(() => {});
}

export async function dispatchQuotaEvent(event, data) {
  const { getDomainState } = await import("@/lib/db/index.js");
  const config = await getDomainState("webhooks", "quota");
  if (!config || !config.url) return;
  await deliverWebhook(
    config.url,
    { event, timestamp: new Date().toISOString(), data },
    config.secret
  );
}
