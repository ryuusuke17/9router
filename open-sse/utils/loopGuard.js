const SINGLE_REPEAT_THRESHOLD = 3;
const SEQUENCE_REPEAT_THRESHOLD = 2;
const MIN_SEQUENCE_LENGTH = 2;

const TEXT_MESSAGE_REPEAT_THRESHOLD = 3;
const TEXT_SENTENCE_REPEAT_THRESHOLD = 3;
const MIN_TEXT_LENGTH = 12;

function normalizeArgs(argsStr) {
  try {
    const obj = JSON.parse(argsStr);
    return JSON.stringify(obj, Object.keys(obj).sort());
  } catch {
    return argsStr || "";
  }
}

function toolCallHash(tc) {
  const name = tc?.function?.name || tc?.name || "";
  const args = normalizeArgs(tc?.function?.arguments || tc?.arguments || "");
  return `${name}::${args}`;
}

function extractToolCallSequence(messages) {
  const seq = [];
  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        seq.push(toolCallHash(tc));
      }
    }
  }
  return seq;
}

function detectSingleRepeat(seq) {
  const counts = new Map();
  for (const h of seq) {
    counts.set(h, (counts.get(h) || 0) + 1);
    if (counts.get(h) >= SINGLE_REPEAT_THRESHOLD) return h;
  }
  return null;
}

function detectSequenceRepeat(seq) {
  const n = seq.length;
  for (let len = Math.floor(n / 2); len >= MIN_SEQUENCE_LENGTH; len--) {
    for (let start = 0; start <= n - len * 2; start++) {
      const pattern = seq.slice(start, start + len).join("|");
      let count = 0;
      let pos = 0;
      while (pos <= n - len) {
        const window = seq.slice(pos, pos + len).join("|");
        if (window === pattern) {
          count++;
          pos += len;
        } else {
          pos++;
        }
      }
      if (count >= SEQUENCE_REPEAT_THRESHOLD) return pattern;
    }
  }
  return null;
}

function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

function splitSentences(text) {
  return String(text || "")
    .split(/[\n.!?…]+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= MIN_TEXT_LENGTH);
}

function extractAssistantTexts(messages) {
  const texts = [];
  for (const msg of messages) {
    if (msg?.role === "assistant") {
      const t = messageText(msg);
      if (t.length >= MIN_TEXT_LENGTH) texts.push(t);
    }
  }
  return texts;
}

function detectTextRepeat(messages) {
  const texts = extractAssistantTexts(messages);
  if (texts.length < TEXT_MESSAGE_REPEAT_THRESHOLD) return { detected: false, hint: null };

  const msgCounts = new Map();
  for (const t of texts) {
    const norm = normalizeText(t);
    if (norm.length < MIN_TEXT_LENGTH) continue;
    const count = (msgCounts.get(norm) || 0) + 1;
    msgCounts.set(norm, count);
    if (count >= TEXT_MESSAGE_REPEAT_THRESHOLD) {
      return {
        detected: true,
        hint: "You have repeated the same response multiple times without making progress. This is a text loop — you are NOT moving forward. STOP repeating yourself. Either call a tool to act, or give your final answer now with the information you already have."
      };
    }
  }

  const sentenceCounts = new Map();
  for (const t of texts) {
    for (const s of splitSentences(t)) {
      const count = (sentenceCounts.get(s) || 0) + 1;
      sentenceCounts.set(s, count);
      if (count >= TEXT_SENTENCE_REPEAT_THRESHOLD) {
        return {
          detected: true,
          hint: "You keep repeating the same planning statement without acting on it. STOP planning in circles. Either execute a tool call NOW, or provide your final answer with current knowledge. Do not restate your plan again."
        };
      }
    }
  }

  return { detected: false, hint: null };
}

export function detectLoop(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { detected: false, hint: null };

  const seq = extractToolCallSequence(messages);
  if (seq.length >= SINGLE_REPEAT_THRESHOLD) {
    const singleRepeat = detectSingleRepeat(seq);
    if (singleRepeat) {
      return {
        detected: true,
        hint: "You have called the same tool with identical arguments multiple times with no new progress. STOP repeating. Summarize findings from existing results or change your strategy."
      };
    }

    const seqRepeat = detectSequenceRepeat(seq);
    if (seqRepeat) {
      return {
        detected: true,
        hint: "You have repeated the same sequence of tool calls multiple times. This is a loop. STOP this pattern immediately. Summarize what you have already found or take a completely different approach."
      };
    }
  }

  const textLoop = detectTextRepeat(messages);
  if (textLoop.detected) return textLoop;

  return { detected: false, hint: null };
}
