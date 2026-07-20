export default {
  id: "qwen-web",
  priority: 110,
  alias: "qwen-web",
  aliases: ["qw"],
  uiAlias: "qw",
  display: {
    name: "Qwen Web (Chat)",
    icon: "auto_awesome",
    color: "#645BFF",
    textIcon: "QW",
    website: "https://chat.qwen.ai",
    notice: {
      text: "Paste the full Cookie header from chat.qwen.ai (must include token, cna, ssxmod_itna).",
      signupUrl: "https://chat.qwen.ai",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste the full Cookie header from chat.qwen.ai (must include token, cna, ssxmod_itna, and _bl_uid)",
  transport: {
    baseUrl: "https://chat.qwen.ai/api/v2/chat/completions",
    format: "qwen-web",
    authType: "cookie",
  },
  models: [
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
  ],
};
