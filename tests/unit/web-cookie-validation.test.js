/**
 * Unit tests for perplexity-web cookie validation logic
 *
 * Covers:
 *  - Cookie prefix stripping (__Secure-next-auth.session-token=)
 *  - 401/403 → invalid with error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

async function validatePerplexityWeb(apiKey) {
  let sessionToken = apiKey;
  if (sessionToken.startsWith("__Secure-next-auth.session-token=")) {
    sessionToken = sessionToken.slice("__Secure-next-auth.session-token=".length);
  }
  const res = await fetch("https://www.perplexity.ai/rest/sse/perplexity_ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify({ query_str: "ping" }),
  });
  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid session cookie — re-paste __Secure-next-auth.session-token from perplexity.ai" };
  }
  return { valid: true, error: null };
}

describe("perplexity-web validation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { global.fetch = originalFetch; });

  it("should return valid:true when response is 200", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200 });
    const result = await validatePerplexityWeb("test-token");
    expect(result.valid).toBe(true);
  });

  it("should return valid:false when response is 401", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401 });
    const result = await validatePerplexityWeb("bad-token");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid session cookie");
  });

  it("should return valid:false when response is 403", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 403 });
    const result = await validatePerplexityWeb("bad-token");
    expect(result.valid).toBe(false);
  });

  it("should strip __Secure-next-auth.session-token= prefix", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200 });
    await validatePerplexityWeb("__Secure-next-auth.session-token=xyz789");
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.Cookie).toBe("__Secure-next-auth.session-token=xyz789");
  });

  it("should accept raw token without prefix", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200 });
    await validatePerplexityWeb("xyz789");
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.Cookie).toBe("__Secure-next-auth.session-token=xyz789");
  });

  it("should POST to /rest/sse/perplexity_ask", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200 });
    await validatePerplexityWeb("token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://www.perplexity.ai/rest/sse/perplexity_ask",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
