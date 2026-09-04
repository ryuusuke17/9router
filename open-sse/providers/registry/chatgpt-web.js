import {
  CODEX_MODELS,
  CODEX_OAUTH,
  CODEX_TRANSPORT,
} from "./codex.js";

export default {
  id: "chatgpt-web",
  priority: 130,
  alias: "cgptw",
  uiAlias: "cgptw",
  display: {
    name: "ChatGPT Web (Pro/Plus)",
    icon: "smart_toy",
    color: "#10A37F",
    textIcon: "CW",
    website: "https://chatgpt.com",
    notice: {
      text: "Sign in through OpenAI OAuth. Browser-cookie import is not supported.",
      signupUrl: "https://chatgpt.com",
    },
  },
  category: "oauth",
  transport: CODEX_TRANSPORT,
  models: CODEX_MODELS,
  serviceKinds: ["llm", "image"],
  oauth: CODEX_OAUTH,
};
