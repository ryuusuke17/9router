export default {
  id: "gemini-web",
  priority: 120,
  alias: "gweb",
  aliases: ["gmw"],
  uiAlias: "gweb",
  display: {
    name: "Gemini Web (Free/Pro)",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
    notice: {
      text: "Paste your __Secure-1PSID cookie from gemini.google.com after signing in.",
      signupUrl: "https://gemini.google.com",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your __Secure-1PSID cookie value from gemini.google.com DevTools → Cookies",
  transport: {
    baseUrl: "https://gemini.google.com/app",
    format: "gemini-web",
    authType: "cookie",
  },
  models: [
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" },
  ],
};
