export default {
  id: "blackbox-web",
  priority: 100,
  alias: "bb-web",
  aliases: ["bbw"],
  uiAlias: "bbw",
  display: {
    name: "Blackbox Web (Pro/Free)",
    icon: "auto_awesome",
    color: "#000000",
    textIcon: "BB",
    website: "https://app.blackbox.ai",
    notice: {
      text: "Paste your __Secure-authjs.session-token cookie from app.blackbox.ai after logging in.",
      signupUrl: "https://app.blackbox.ai",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your __Secure-authjs.session-token or next-auth.session-token cookie from app.blackbox.ai",
  transport: {
    baseUrl: "https://app.blackbox.ai/api/chat",
    format: "blackbox-web",
    authType: "cookie",
  },
  models: [
    { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
    { id: "gpt-4", name: "GPT-4" },
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
    { id: "gemini-pro", name: "Gemini Pro" },
  ],
};
