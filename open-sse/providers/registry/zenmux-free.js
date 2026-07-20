export default {
  id: "zenmux-free",
  priority: 85,
  alias: "zmf",
  aliases: ["zmw"],
  uiAlias: "zmf",
  display: {
    name: "ZenMux Free (Web)",
    icon: "auto_awesome",
    color: "#667eea",
    textIcon: "ZF",
    website: "https://zenmux.ai",
    notice: {
      text: "Free tier. Export ALL cookies from zenmux.ai after logging in — ctoken alone is NOT enough (needs sessionId + sessionId.sig too).",
      signupUrl: "https://zenmux.ai",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Export ALL cookies from zenmux.ai (ctoken + sessionId + sessionId.sig) as the full Cookie header",
  authFields: [
  {
    "key": "apiKey",
    "label": "Full Cookie Header",
    "type": "textarea",
    "required": true,
    "storeIn": "apiKey",
    "placeholder": "locale=en-US; sessionId=...; sessionId.sig=...; ctoken=...; ...",
    "helper": "1. Go to zenmux.ai and sign up/sign in\n2. Open DevTools → Network tab\n3. Click on any XHR request to zenmux.ai\n4. Find the 'Cookie' request header under Request Headers\n5. Copy the ENTIRE Cookie header value (must include ctoken=..., sessionId=..., AND sessionId.sig=... — ctoken alone will fail with 403)"
  }
],
  transport: {
    baseUrl: "https://zenmux.ai/api/anthropic/v1/messages",
    format: "zenmux-free",
    authType: "cookie",
  },
  models: [
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3.2 (Non-thinking)" },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek V3.2 (Thinking)",
      supportsReasoning: true },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro",
      supportsReasoning: true },
    { id: "kuaishou/kat-coder-pro-v1-free", name: "KAT Coder Pro V1 Free" },
    { id: "z-ai/glm-4.7-flash-free", name: "GLM 4.7 Flash Free" },
    { id: "moonshotai/kimi-k3-free", name: "Kimi K3 Free" },
    { id: "z-ai/glm-4.6v-flash-free", name: "GLM 4.6V Flash Free" },
    { id: "stepfun/step-3.5-flash-free", name: "Step 3.5 Flash Free" },
    { id: "inclusionai/ling-1t", name: "Ling 1T" },
    { id: "inclusionai/ling-mini-2.0", name: "Ling Mini 2.0" },
    { id: "inclusionai/ring-1t", name: "Ring 1T" },
    { id: "sapiens-ai/agnes-1.5-lite", name: "Agnes 1.5 Lite" },
    { id: "sapiens-ai/agnes-1.5-pro", name: "Agnes 1.5 Pro" },
  ],
};
