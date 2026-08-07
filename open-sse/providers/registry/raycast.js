// NOTE: still needs fixing — import is validated only via chat-probe; auto-import is
// macOS-only; no real token verified end-to-end. Not production-ready.
export default {
  id: "raycast",
  alias: "rc",
  display: {
    name: "Raycast Pro AI",
    icon: "auto_awesome",
    color: "#FF6363",
    textIcon: "RC",
    website: "https://raycast.com",
    notice: {
      signupUrl: "https://www.raycast.com/pro",
      text: "Raycast Pro AI (unofficial/reverse-engineered API). OAuth via token import: provide a Bearer token, X-Raycast-DeviceId, and optional X-Raycast-Signature JWT captured from backend.raycast.com traffic.",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  oauth: {
    apiEndpoint: "https://backend.raycast.com",
    chatEndpoint: "/api/v1/ai/chat_completions",
    modelsEndpoint: "/api/v1/ai/models",
    clientType: "macos-app",
    captureInstructions:
      "macOS only: use Auto-Import (Keychain + Raycast DB) or capture Bearer, X-Raycast-DeviceId, and optional X-Raycast-Signature JWT from backend.raycast.com traffic.",
  },
  transport: {
    baseUrl: "https://backend.raycast.com/api/v1/ai/chat_completions",
    format: "openai",
    authHeader: "bearer",
  },
  models: [
    { id: "openai-gpt-5-mini", name: "GPT-5 Mini" },
    { id: "openai-gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "anthropic-claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "google-gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "raycast-ray1", name: "Ray1" },
    { id: "raycast-ray1-mini", name: "Ray1 Mini" },
    { id: "perplexity-sonar", name: "Sonar" },
    { id: "perplexity-sonar-pro", name: "Sonar Pro" },
    { id: "mistral-open-mistral-nemo", name: "Mistral Nemo" },
    { id: "xai-grok-3-mini", name: "Grok 3 Mini" },
  ],
};