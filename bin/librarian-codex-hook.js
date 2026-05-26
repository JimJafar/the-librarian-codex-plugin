#!/usr/bin/env node

// src/handlers/session-start.mjs
async function handleSessionStart(payload, deps) {
  await deps.log({ event: "SessionStart", source: payload?.source ?? null });
  return {};
}

// src/handlers/user-prompt-submit.mjs
async function handleUserPromptSubmit(payload, deps) {
  await deps.log({ event: "UserPromptSubmit", prompt_len: (payload?.prompt ?? "").length });
  return {};
}

// src/handlers/post-compact.mjs
async function handlePostCompact(payload, deps) {
  await deps.log({ event: "PostCompact", trigger: payload?.trigger ?? null });
  return {};
}

// src/handlers/stop.mjs
async function handleStop(payload, deps) {
  await deps.log({ event: "Stop", has_last_assistant: !!payload?.last_assistant_message });
  return {};
}

// src/log.mjs
import fs from "node:fs";
import path from "node:path";
var LOG_FILENAME = "log.jsonl";
async function log(dataDir, entry) {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(path.join(dataDir, LOG_FILENAME), line, "utf8");
  } catch {
  }
}

// src/state-store.mjs
import fs2 from "node:fs";
import path2 from "node:path";
var STATE_FILENAME = "state.json";
var LOCK_FILENAME = "state.json.lock";
var DEFAULT_STATE = Object.freeze({
  session_id: null,
  // ses_… of the currently-attached Librarian session
  private: false,
  // off-record flag — UserPromptSubmit hook flips this
  last_checkpoint_at: 0,
  // epoch ms; used by the debounced-checkpoint policy
  turns_since_checkpoint: 0,
  // event count since the last checkpoint
  source_ref: null
  // canonical source_ref the session was started against
});
function statePath(dataDir) {
  return path2.join(dataDir, STATE_FILENAME);
}
function lockPath(dataDir) {
  return path2.join(dataDir, LOCK_FILENAME);
}
async function loadState(dataDir) {
  await fs2.promises.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs2.promises.readFile(statePath(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_STATE };
    if (err instanceof SyntaxError) return { ...DEFAULT_STATE };
    throw err;
  }
}
async function saveState(dataDir, state) {
  await fs2.promises.mkdir(dataDir, { recursive: true });
  const final = statePath(dataDir);
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs2.promises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs2.promises.rename(tmp, final);
}
async function withLock(dataDir, fn, { timeoutMs = 2e3, staleMs = 5e3 } = {}) {
  await fs2.promises.mkdir(dataDir, { recursive: true });
  const lock = lockPath(dataDir);
  const start = Date.now();
  let handle = null;
  while (handle === null) {
    try {
      handle = await fs2.promises.open(lock, "wx");
      await handle.writeFile(`${process.pid}
${Date.now()}
`);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = await fs2.promises.stat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs2.promises.unlink(lock).catch(() => {
          });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`state-store: could not acquire lock within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
    }
    await fs2.promises.unlink(lock).catch(() => {
    });
  }
}

// src/mcp-client.mjs
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

// src/dispatch.mjs
var HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PostCompact: handlePostCompact,
  Stop: handleStop
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
    loadState: dataDir ? () => loadState(dataDir) : async () => ({}),
    saveState: dataDir ? (state) => saveState(dataDir, state) : async () => {
    },
    withLock: dataDir ? (fn) => withLock(dataDir, fn) : (fn) => fn(),
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
var entryName = (process.argv[1] ?? "").split("/").pop() ?? "";
if (entryName === "librarian-codex-hook.js" || entryName === "dispatch.mjs") {
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
