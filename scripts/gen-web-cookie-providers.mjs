import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(import.meta.dirname, "..");

// ─── Provider definitions ───────────────────────────────────────────────────
const PROVIDERS = [
  { id: "zenmux-free",           category: "webCookie", name: "ZenMux Free (Web)",               alias: "zmf",      website: "https://zenmux.ai",               authType: "cookie", color: "#667eea",        textIcon: "ZF", authHint: "Export all cookies from zenmux.ai and paste the full Cookie header string",                       hasFree: true },
];

// ─── Registry entry template ────────────────────────────────────────────────
function genRegistry(p) {
  const extraFields = [];
  if (p.hasFree) extraFields.push(`  hasFree: true,`);
  if (p.subscriptionRisk) extraFields.push(`  subscriptionRisk: true,`);
  if (p.riskNotice) extraFields.push(`  riskNotice: true,`);
  return `// Auto-generated: ${p.id}
export default {
  id: "${p.id}",
  alias: "${p.alias}",
  name: "${p.name}",
  icon: "auto_awesome",
  color: "${p.color}",
  textIcon: "${p.textIcon}",
  website: "${p.website}",
  category: "${p.category}",
  authType: "${p.authType}",
  authHint: "${p.authHint}",
${extraFields.join("\n")}
  models: [],
  features: { usage: false },
};
`;
}

// ─── Generate all registry files ────────────────────────────────────────────
for (const p of PROVIDERS) {
  const path = join(ROOT, "open-sse/providers/registry", `${p.id}.js`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, genRegistry(p));
  console.log(`  registry/${p.id}.js`);
}

// ─── Generate all executor files ────────────────────────────────────────────
const REGISTRY_DIR = join(ROOT, "open-sse/providers/registry");

function genSseChunkHelper() {
  return `
function sseChunk(data) {
  return \`data: \${JSON.stringify(data)}\n\n\`;
}
`;
}

function genStreamingExecutor(id, { baseUrl, fetchUrl, fetchMethod="POST", headers, bodyBuilder, responseHandler, extraFunctions = "" }) {
  return `// Auto-generated: ${id}
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeSessionCookieHeader } from "../utils/webCookieAuth.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { sseChunk as _sseChunk } from "../utils/sse.js";

const BASE_URL = "${baseUrl || fetchUrl}";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

${extraFunctions}

export class ${id.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("") + "Executor"} extends BaseExecutor {
  constructor() {
    super("${id}", { id: "${id}", baseUrl: BASE_URL });
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = (body || {});
    const rawCookie = credentials?.apiKey || "";
    if (!rawCookie.trim()) {
      return { response: new Response(JSON.stringify({ error: { message: "Missing session cookie for ${id}" } }), { status: 401, headers: { "Content-Type": "application/json" } }), url: BASE_URL, headers: {}, transformedBody: bodyObj };
    }

    ${bodyBuilder}

    const headers = { ${headers} };

    try {
      const response = await fetch(${fetchUrl || `BASE_URL`}, {
        method: "${fetchMethod}",
        headers,
        body: JSON.stringify(requestBody),
        signal: signal || AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        let errMsg = \`${id} HTTP \${response.status}\`;
        if (response.status === 401 || response.status === 403) errMsg = "${id} auth failed — cookie may be expired";
        return { response: new Response(JSON.stringify({ error: { message: errMsg } }), { status: response.status, headers: { "Content-Type": "application/json" } }), url: BASE_URL, headers, transformedBody: requestBody };
      }

      ${responseHandler}
    } catch (err) {
      return { response: new Response(JSON.stringify({ error: { message: \`${id} connection failed: \${err.message}\` } }), { status: 502, headers: { "Content-Type": "application/json" } }), url: BASE_URL, headers, transformedBody: bodyObj };
    }
  }
}

export default ${id.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("") + "Executor"};
`;
}

// Write each executor (simplified, fetch-based)
for (const p of PROVIDERS) {
  const filePath = join(ROOT, "open-sse/executors", `${p.id}.js`);
  // Each executor gets a simplified implementation
  // (omitted for brevity — the generated script would be ~200KB)
  // Instead, I'll write concise simplified versions per executor
}

console.log("\nRegistry files created. Executors need manual porting.");
