#!/usr/bin/env node

// src/source-ref.mjs
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

// src/mcp-parse.mjs
var ID_RE = /^ID:\s*(ses_[A-Za-z0-9-]+)/m;
function extractSessionId(text) {
  const m = (text ?? "").match(ID_RE);
  return m ? m[1] : null;
}
function parseSessionList(text) {
  const lines = (text ?? "").split("\n");
  const sessions = [];
  let pending = null;
  for (const line of lines) {
    const head = line.match(/^\d+\.\s*\[([^\]]+)\]\s*(.*)$/);
    if (head) {
      pending = { status: head[1].trim(), title: head[2].trim() };
      continue;
    }
    const idLine = line.match(/^\s*id:\s*(ses_[A-Za-z0-9-]+)/);
    if (idLine && pending) {
      sessions.push({ id: idLine[1], ...pending });
      pending = null;
    }
  }
  return sessions;
}

// src/handlers/session-bootstrap.mjs
var HARNESS = "codex";
async function bootstrapSession(payload, deps) {
  return deps.withLock(async () => {
    const state = await deps.loadState();
    if (state.private) {
      await deps.log({ event: "bootstrap", outcome: "skipped_private" });
      return state;
    }
    if (state.session_id) {
      await deps.log({ event: "bootstrap", outcome: "already_attached", session_id: state.session_id });
      return state;
    }
    const client = deps.getClient();
    if (!client) {
      await deps.log({ event: "bootstrap", outcome: "no_client" });
      return state;
    }
    const sourceRef = sourceRefFromPayload(payload, deps.env);
    const args = {
      harness: HARNESS,
      source_ref: sourceRef,
      cwd: payload?.cwd ?? deps.env.PWD ?? null,
      visibility: "common",
      capture_mode: "summary",
      start_summary: deriveStartSummary(payload)
    };
    if (deps.env.LIBRARIAN_PROJECT_KEY) args.project_key = deps.env.LIBRARIAN_PROJECT_KEY;
    let sessionId = null;
    try {
      const text = await client.callTool("start_session", args);
      sessionId = extractSessionId(text);
    } catch (err) {
      await deps.log({ event: "bootstrap", outcome: "start_failed", error: String(err?.message ?? err) });
      return state;
    }
    if (!sessionId) {
      await deps.log({ event: "bootstrap", outcome: "no_session_id_in_response" });
      return state;
    }
    const updated = {
      ...state,
      session_id: sessionId,
      source_ref: sourceRef,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0
    };
    await deps.saveState(updated);
    await deps.log({ event: "bootstrap", outcome: "started", session_id: sessionId, source_ref: sourceRef });
    return updated;
  });
}
function deriveStartSummary(payload) {
  const parts = [];
  if (payload?.cwd) parts.push(`Working in ${payload.cwd}.`);
  const prompt = (payload?.prompt ?? "").trim();
  if (prompt) {
    const seed = prompt.length > 240 ? `${prompt.slice(0, 240)}\u2026` : prompt;
    parts.push(`Opening prompt: ${seed}`);
  }
  if (parts.length === 0) return "Session opened from Codex with no visible context yet.";
  return parts.join(" ");
}

// src/handlers/session-start.mjs
var RECONCILE_SOURCES = /* @__PURE__ */ new Set(["resume", "clear"]);
async function handleSessionStart(payload, deps) {
  const source = payload?.source ?? null;
  await deps.log({ event: "SessionStart", source });
  if (RECONCILE_SOURCES.has(source)) {
    await reconcileStaleActive(payload, deps);
  }
  await bootstrapSession(payload, deps);
  return {};
}
async function reconcileStaleActive(payload, deps) {
  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_skipped_private" });
    return;
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_skipped_no_client" });
    return;
  }
  const sourceRef = sourceRefFromPayload(payload, deps.env);
  let listText = "";
  try {
    listText = await client.callTool("list_sessions", {
      source_ref: sourceRef,
      status: "active"
    });
  } catch (err) {
    await deps.log({
      event: "SessionStart",
      outcome: "reconcile_list_failed",
      error: String(err?.message ?? err)
    });
    return;
  }
  const sessions = parseSessionList(listText);
  if (sessions.length === 0) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_no_active" });
    return;
  }
  let paused = 0;
  for (const s of sessions) {
    try {
      await client.callTool("pause_session", {
        session_id: s.id,
        summary: "codex resume reconciliation"
      });
      paused += 1;
    } catch (err) {
      await deps.log({
        event: "SessionStart",
        outcome: "pause_failed",
        session_id: s.id,
        error: String(err?.message ?? err)
      });
    }
  }
  if (state.session_id && sessions.some((s) => s.id === state.session_id)) {
    await deps.withLock(async () => {
      const latest = await deps.loadState();
      await deps.saveState({ ...latest, session_id: null, source_ref: null });
    });
  }
  await deps.log({ event: "SessionStart", outcome: "reconciled", paused });
}

// src/privacy-detector.mjs
var DEFAULT_PRIVATE_MARKERS = Object.freeze([
  "this is a private session",
  "don't remember this",
  "do not remember this",
  "don't save this",
  "do not save this",
  "don't store this",
  "off the record",
  "keep this between us",
  "private from here"
]);
var DEFAULT_PUBLIC_MARKERS = Object.freeze([
  "you can remember again",
  "end private mode",
  "back on the record",
  "this can be remembered"
]);
var TOGGLE_COMMANDS = Object.freeze(["/lib-toggle-private", "/lib:toggle-private"]);
var SUBSTANTIVE_MIN_CHARS = 3;
var NON_ALNUM_GLOBAL = /[^a-z0-9]+/g;
function normalise(text) {
  return (text ?? "").normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase();
}
function hasSubstantiveRemainder(normalisedPrompt, normalisedMarker) {
  const idx = normalisedPrompt.indexOf(normalisedMarker);
  const without = idx === -1 ? normalisedPrompt : `${normalisedPrompt.slice(0, idx)} ${normalisedPrompt.slice(idx + normalisedMarker.length)}`;
  return without.replace(NON_ALNUM_GLOBAL, "").length >= SUBSTANTIVE_MIN_CHARS;
}
function firstMatch(normalisedPrompt, markers) {
  for (const marker of markers) {
    if (normalisedPrompt.includes(normalise(marker))) return marker;
  }
  return null;
}
function detectPrivacySignal(prompt, { privateMarkers, publicMarkers } = {}) {
  const normalised = normalise(prompt);
  const trimmed = normalised.trim();
  if (TOGGLE_COMMANDS.includes(trimmed)) {
    return { signal: "toggle", matched: trimmed, hasSubstantiveContent: false };
  }
  const privates = privateMarkers ?? DEFAULT_PRIVATE_MARKERS;
  const enter = firstMatch(normalised, privates);
  if (enter !== null) {
    return {
      signal: "enter-private",
      matched: enter,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(enter))
    };
  }
  const publics = publicMarkers ?? DEFAULT_PUBLIC_MARKERS;
  const exit = firstMatch(normalised, publics);
  if (exit !== null) {
    return {
      signal: "exit-private",
      matched: exit,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(exit))
    };
  }
  return { signal: "none", matched: null, hasSubstantiveContent: false };
}

// src/handlers/user-prompt-submit.mjs
async function handleUserPromptSubmit(payload, deps) {
  const prompt = payload?.prompt ?? "";
  await deps.log({ event: "UserPromptSubmit", prompt_len: prompt.length });
  const signal = detectPrivacySignal(prompt);
  if (signal.signal === "enter-private" || signal.signal === "toggle") {
    await applyEnterPrivate(deps, signal);
    return {};
  }
  if (signal.signal === "exit-private") {
    await applyExitPrivate(deps, signal);
    return {};
  }
  await bootstrapSession(payload, deps).catch(async (err) => {
    await deps.log({ event: "UserPromptSubmit", outcome: "bootstrap_threw", error: String(err?.message ?? err) });
  });
  return {};
}
async function applyEnterPrivate(deps, signal) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    if (signal.signal === "toggle" && state.private) {
      await deps.saveState({ ...state, private: false });
      await deps.log({ event: "UserPromptSubmit", outcome: "exited_private_via_toggle" });
      return;
    }
    if (state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_private" });
      return;
    }
    if (state.session_id) {
      const client = deps.getClient();
      if (client) {
        try {
          await client.callTool("end_session", {
            session_id: state.session_id,
            summary: "switching to private mode"
          });
        } catch (err) {
          await deps.log({
            event: "UserPromptSubmit",
            outcome: "end_session_failed_during_enter_private",
            error: String(err?.message ?? err)
          });
        }
      }
    }
    await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
    await deps.log({ event: "UserPromptSubmit", outcome: "entered_private", matched: signal.matched });
  });
}
async function applyExitPrivate(deps, signal) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    if (!state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_public", matched: signal.matched });
      return;
    }
    await deps.saveState({ ...state, private: false });
    await deps.log({ event: "UserPromptSubmit", outcome: "exited_private", matched: signal.matched });
  });
}

// src/handlers/post-compact.mjs
async function handlePostCompact(payload, deps) {
  const trigger = payload?.trigger ?? null;
  await deps.log({ event: "PostCompact", trigger });
  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "PostCompact", outcome: "skipped_private" });
    return {};
  }
  if (!state.session_id) {
    await deps.log({ event: "PostCompact", outcome: "no_session" });
    return {};
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "PostCompact", outcome: "no_client" });
    return {};
  }
  const summary = trigger === "manual" ? "User triggered conversation compaction; rolling summary continues from here." : "Codex auto-compacted the conversation; rolling summary continues from here.";
  try {
    await client.callTool("checkpoint_session", {
      session_id: state.session_id,
      summary
    });
  } catch (err) {
    await deps.log({ event: "PostCompact", outcome: "checkpoint_failed", error: String(err?.message ?? err) });
    return {};
  }
  await deps.withLock(async () => {
    const latest = await deps.loadState();
    await deps.saveState({
      ...latest,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0
    });
  });
  await deps.log({ event: "PostCompact", outcome: "checkpointed", session_id: state.session_id });
  return {};
}

// src/handlers/checkpoint-policy.mjs
var CHECKPOINT_MIN_INTERVAL_MS = 10 * 60 * 1e3;
var CHECKPOINT_MAX_TURNS = 20;
function shouldCheckpoint(state, now) {
  if (!state) return false;
  const elapsed = now - (state.last_checkpoint_at ?? 0);
  if (elapsed >= CHECKPOINT_MIN_INTERVAL_MS) return true;
  if ((state.turns_since_checkpoint ?? 0) >= CHECKPOINT_MAX_TURNS) return true;
  return false;
}

// src/handlers/stop.mjs
var SUMMARY_MAX_CHARS = 280;
async function handleStop(payload, deps) {
  await deps.log({ event: "Stop", has_last_assistant: !!payload?.last_assistant_message });
  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "Stop", outcome: "skipped_private" });
    return {};
  }
  if (!state.session_id) {
    await deps.log({ event: "Stop", outcome: "no_session" });
    return {};
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "Stop", outcome: "no_client" });
    return {};
  }
  const summary = deriveTurnSummary(payload);
  try {
    await client.callTool("record_session_event", {
      session_id: state.session_id,
      type: "message",
      summary
    });
  } catch (err) {
    await deps.log({ event: "Stop", outcome: "record_failed", error: String(err?.message ?? err) });
    return {};
  }
  await deps.withLock(async () => {
    const latest = await deps.loadState();
    const turns = (latest.turns_since_checkpoint ?? 0) + 1;
    const probe = { ...latest, turns_since_checkpoint: turns };
    const now = deps.now();
    if (shouldCheckpoint(probe, now)) {
      try {
        await client.callTool("checkpoint_session", {
          session_id: latest.session_id,
          summary: `Debounced checkpoint (${turns} turn${turns === 1 ? "" : "s"} since last).`
        });
        await deps.saveState({
          ...latest,
          turns_since_checkpoint: 0,
          last_checkpoint_at: now
        });
        await deps.log({ event: "Stop", outcome: "checkpointed", turns });
      } catch (err) {
        await deps.saveState({ ...latest, turns_since_checkpoint: turns });
        await deps.log({ event: "Stop", outcome: "checkpoint_failed", error: String(err?.message ?? err) });
      }
    } else {
      await deps.saveState({ ...latest, turns_since_checkpoint: turns });
    }
  });
  return {};
}
function deriveTurnSummary(payload) {
  const raw = (payload?.last_assistant_message ?? "").trim();
  if (!raw) return "(turn produced no assistant text \u2014 tool calls only)";
  if (raw.length <= SUMMARY_MAX_CHARS) return raw;
  return `${raw.slice(0, SUMMARY_MAX_CHARS - 1)}\u2026`;
}

// src/log.mjs
import fs from "node:fs";
import path2 from "node:path";
var LOG_FILENAME = "log.jsonl";
async function log(dataDir, entry) {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(path2.join(dataDir, LOG_FILENAME), line, "utf8");
  } catch {
  }
}

// src/state-store.mjs
import fs2 from "node:fs";
import path3 from "node:path";
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
  return path3.join(dataDir, STATE_FILENAME);
}
function lockPath(dataDir) {
  return path3.join(dataDir, LOCK_FILENAME);
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
