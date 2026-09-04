import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

function mockRefreshFetch() {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: "SYNTHETIC_REFRESHED_ACCESS_TOKEN",
      expires_in: 3600,
    }),
  }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.resetModules();
});

describe("ChatGPT Web OAuth executor", () => {
  it("uses ChatGPT Web refresh state and never sends cookies", async () => {
    mockRefreshFetch();
    const { ChatGPTWebExecutor } = await import("../../open-sse/executors/chatgpt-web.js");
    const executor = new ChatGPTWebExecutor();
    const credentials = {
      connectionId: "chatgpt-web-test",
      accessToken: "SYNTHETIC_ACCESS_TOKEN",
      refreshToken: "SYNTHETIC_REFRESH_TOKEN",
      lastRefreshAt: new Date().toISOString(),
      providerSpecificData: { chatgptAccountId: "SYNTHETIC_ACCOUNT_ID" },
    };

    expect(executor.provider).toBe("chatgpt-web");
    expect(executor.needsRefresh(credentials)).toBe(false);

    const refreshed = await executor.refreshCredentials(credentials, null);
    expect(refreshed.accessToken).toBe("SYNTHETIC_REFRESHED_ACCESS_TOKEN");

    const headers = executor.buildHeaders(credentials);
    expect(headers.Cookie).toBeUndefined();
    expect(headers["ChatGPT-Account-ID"]).toBe("SYNTHETIC_ACCOUNT_ID");
  });

  it("translates function tools and resolves ChatGPT Web catalog models", async () => {
    const { ChatGPTWebExecutor } = await import("../../open-sse/executors/chatgpt-web.js");
    const body = {
      model: "gpt-5.6-sol-review",
      input: "Ping",
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      }],
    };

    const result = new ChatGPTWebExecutor().transformRequest(
      body.model,
      body,
      false,
      { connectionId: "chatgpt-web-test" },
    );

    expect(result.stream).toBe(true);
    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.tools).toEqual([{
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
    }]);
  });
});
