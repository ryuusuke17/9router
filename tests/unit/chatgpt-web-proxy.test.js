import { describe, expect, it } from "vitest";

describe("ChatGPT Web OAuth provider", () => {
  it("reuses OpenAI OAuth configuration under its own provider ID", async () => {
    const { getProvider } = await import("@/lib/oauth/providers");
    const chatgptWeb = getProvider("chatgpt-web");
    const codex = getProvider("codex");

    expect(chatgptWeb).toBe(codex);
    expect(chatgptWeb.flowType).toBe("authorization_code_pkce");
  });

  it("rejects manual JWT access-token import", async () => {
    const { POST } = await import("@/app/api/oauth/[provider]/[action]/route.js");
    const response = await POST(
      new Request("https://9router.local/api/oauth/chatgpt-web/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "eyJ.SYNTHETIC.JWT" }),
      }),
      { params: Promise.resolve({ provider: "chatgpt-web", action: "exchange" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "ChatGPT Web requires OpenAI OAuth. Paste the authorization callback URL instead.",
    });
  });
});
