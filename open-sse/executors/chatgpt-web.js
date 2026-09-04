import { CodexExecutor } from "./codex.js";

export class ChatGPTWebExecutor extends CodexExecutor {
  constructor() {
    super("chatgpt-web");
  }
}

export default ChatGPTWebExecutor;
