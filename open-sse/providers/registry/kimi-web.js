export default {
  id: "kimi-web",
  priority: 105,
  alias: "kimi-web",
  aliases: ["kw"],
  uiAlias: "kw",
  display: {
    name: "Kimi Web (Chat)",
    icon: "auto_awesome",
    color: "#3B82F6",
    textIcon: "KW",
    website: "https://www.kimi.com",
    notice: {
      text: "Paste your access_token from www.kimi.com localStorage.",
      signupUrl: "https://www.kimi.com",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your access_token from www.kimi.com DevTools → Application → Local Storage",
  transport: {
    baseUrl: "https://www.kimi.com",
    format: "kimi-web",
    authType: "cookie",
  },
  models: [
    { id: "k3", name: "K3" },
    { id: "k2.6", name: "K2.6" },
    { id: "k2.5", name: "K2.5" },
  ],
};
