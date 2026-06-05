#!/usr/bin/env node

// plugins/the-librarian/src/source-ref.mjs
import path from "node:path";
function buildSourceRef({ cwd, runId }) {
  const absCwd = path.resolve(cwd || process.cwd());
  if (typeof runId === "string" && runId.length > 0) {
    return `codex:run:${runId}:cwd:${absCwd}`;
  }
  return `cwd:${absCwd}`;
}
function sourceRefFromPayload(payload, env = process.env) {
  return buildSourceRef({
    cwd: payload?.cwd,
    runId: env.CODEX_RUN_ID
  });
}

// plugins/the-librarian/src/handlers/user-prompt-submit.mjs
async function handleUserPromptSubmit(payload, deps) {
  const prompt = payload?.prompt ?? "";
  await deps.log({ event: "UserPromptSubmit", prompt_len: prompt.length });
  return await injectConvState(payload, deps);
}
async function injectConvState(payload, deps) {
  try {
    const client = deps.getClient();
    if (!client) return {};
    const convId = sourceRefFromPayload(payload, deps.env);
    if (!convId) return {};
    let toolResult;
    try {
      toolResult = await client.callTool("conv_state_get", { conv_id: convId });
    } catch (err) {
      await deps.log({
        event: "UserPromptSubmit",
        outcome: "conv_state_lookup_failed",
        error: String(err?.message ?? err)
      });
      return {};
    }
    const parsed = parseConvState(toolResult);
    if (!parsed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderConvStateBlock(parsed)
      }
    };
  } catch (err) {
    await deps.log({
      event: "UserPromptSubmit",
      outcome: "conv_state_inject_threw",
      error: String(err?.message ?? err)
    });
    return {};
  }
}
function parseConvState(result) {
  if (!result) return null;
  let text;
  if (typeof result === "string") {
    text = result;
  } else if (result?.content?.[0]?.text) {
    text = result.content[0].text;
  } else if (typeof result?.text === "string") {
    text = result.text;
  } else {
    return null;
  }
  if (typeof text !== "string" || text.startsWith("No conversation state")) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && typeof obj.conv_id === "string" ? obj : null;
  } catch {
    return null;
  }
}
function renderConvStateBlock(state) {
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>"
  ].join("\n");
}

// plugins/the-librarian/src/log.mjs
import fs from "node:fs";
import path2 from "node:path";
var LOG_FILENAME = "log.jsonl";
var ROTATED_FILENAME = "log.jsonl.1";
var MAX_LOG_BYTES = 5 * 1024 * 1024;
async function log(dataDir, entry) {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const file = path2.join(dataDir, LOG_FILENAME);
    await rotateIfNeeded(dataDir, file);
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(file, line, "utf8");
  } catch {
  }
}
async function rotateIfNeeded(dataDir, file) {
  let size;
  try {
    const stat = await fs.promises.stat(file);
    size = stat.size;
  } catch (err) {
    if (err.code === "ENOENT") return;
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  const rotated = path2.join(dataDir, ROTATED_FILENAME);
  try {
    await fs.promises.rename(file, rotated);
  } catch {
  }
}

// plugins/the-librarian/src/mcp-client.mjs
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var McpClientError = class extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "McpClientError";
    this.kind = kind;
    this.status = extra.status;
  }
};
function createMcpClient(config, transport) {
  const url = parseEndpoint(config.endpoint);
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);
  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args }
      });
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`
      };
      let response;
      try {
        response = await send({ url: config.endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError) throw err;
        if (isTimeout(err)) {
          throw new McpClientError("timeout", `${name} timed out after ${timeoutMs}ms`);
        }
        throw new McpClientError("network", `${name} could not reach the Librarian at ${safeEndpoint}`);
      }
      if (response.status !== 200) {
        throw new McpClientError("http", `${name} returned HTTP ${response.status}`, {
          status: response.status
        });
      }
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new McpClientError("malformed", `${name} returned non-JSON`);
      }
      if (isRecord(payload) && payload.error != null) {
        const rpc = payload.error;
        const code = isRecord(rpc) ? rpc.code : void 0;
        const msg = isRecord(rpc) ? String(rpc.message ?? "").slice(0, 200) : "";
        throw new McpClientError("rpc", `${name} failed: ${msg} (code ${String(code)})`);
      }
      const text = extractText(payload);
      if (text === null) {
        throw new McpClientError("malformed", `${name} response had no text content`);
      }
      return text;
    }
  };
}
function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpClientError("config", "Librarian endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientError(
      "config",
      `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`
    );
  }
  if (url.username || url.password) {
    throw new McpClientError("config", "Librarian endpoint must not embed credentials");
  }
  if (url.search) {
    throw new McpClientError("config", "Librarian endpoint must not include a query string");
  }
  return url;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isTimeout(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ETIMEDOUT";
}
function extractText(payload) {
  if (!isRecord(payload)) return null;
  const result = payload.result;
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
}
function defaultTransport(maxResponseBytes) {
  return async ({ url, body, headers, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        // Never follow a 3xx — fetch would carry the bearer header to the
        // redirect target and leak the token cross-origin.
        redirect: "error",
        signal: controller.signal
      });
      return { status: response.status, body: await readCapped(response, maxResponseBytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}
async function readCapped(response, cap) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > cap) {
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    return buffer.toString("utf8");
  }
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// plugins/the-librarian/src/dispatch.mjs
import { pathToFileURL } from "node:url";
var HANDLERS = {
  UserPromptSubmit: handleUserPromptSubmit
};
async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function buildDeps(payload) {
  const dataDir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const endpoint = process.env.LIBRARIAN_MCP_URL;
  const token = process.env.LIBRARIAN_AGENT_TOKEN;
  let _client = null;
  const getClient = () => {
    if (_client) return _client;
    if (!endpoint || !token) return null;
    try {
      _client = createMcpClient({ endpoint, token });
    } catch {
      _client = null;
    }
    return _client;
  };
  return {
    dataDir,
    payload,
    log: dataDir ? (entry) => log(dataDir, entry) : async () => {
    },
    getClient,
    now: () => Date.now(),
    env: process.env
  };
}
async function dispatch(payload) {
  const event = payload?.hook_event_name;
  const handler = HANDLERS[event];
  const deps = buildDeps(payload);
  if (!handler) {
    await deps.log({ event: "unknown", payload_event: event });
    return {};
  }
  try {
    const result = await handler(payload, deps);
    return result ?? {};
  } catch (err) {
    await deps.log({ event, error: String(err?.message ?? err), stack: err?.stack });
    return {};
  }
}
async function main() {
  const payload = await readStdinJson();
  const result = await dispatch(payload);
  process.stdout.write(JSON.stringify(result));
}
var isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch(async (err) => {
    try {
      const dataDir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
      if (dataDir) await log(dataDir, { event: "fatal", error: String(err?.message ?? err) });
    } catch {
    }
    process.stdout.write("{}");
  });
}
export {
  dispatch,
  main
};
