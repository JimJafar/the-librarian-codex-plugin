// src/dispatch.mjs
// Single entry point bundled into bin/librarian-codex-hook.js. Reads the
// Codex hook payload from stdin, routes by `hook_event_name` to a handler,
// writes the JSON result (or `{}` on any failure) to stdout, and exits 0.
//
// Two invariants every hook obeys:
//  1. Always exit 0. A non-zero exit blocks Codex's turn and we are not in
//     the business of that — the privacy gate is "don't record", not "stop
//     the model".
//  2. Stdout is hook protocol. Never print stray debug output: a stray line
//     on `UserPromptSubmit` would be injected into the model's context.
//     All diagnostics go through src/log.mjs to a sidecar log.jsonl.

import { handleSessionStart } from "./handlers/session-start.mjs";
import { handleUserPromptSubmit } from "./handlers/user-prompt-submit.mjs";
import { handlePostCompact } from "./handlers/post-compact.mjs";
import { handleStop } from "./handlers/stop.mjs";
import { log as fileLog } from "./log.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "./state-store.mjs";
import { createMcpClient } from "./mcp-client.mjs";

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PostCompact: handlePostCompact,
  Stop: handleStop,
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

  // Build the MCP client lazily: a hook that doesn't need to call the server
  // (e.g. when off-record) shouldn't fail just because the env var is unset.
  // Handlers that need the client will fail-soft and log.
  //
  // Critical safety: if dataDir is missing we cannot persist state across hook
  // invocations, which means we cannot detect "session already attached" —
  // bootstrapping a session would spam start_session every turn. So we refuse
  // to construct the MCP client at all without a dataDir. Recording is
  // disabled, but @librarian-driven explicit calls (which go through Codex's
  // own MCP layer, not this client) still work.
  let _client = null;
  const getClient = () => {
    if (_client) return _client;
    if (!dataDir) return null;
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
    log: dataDir ? (entry) => fileLog(dataDir, entry) : async () => {},
    // When dataDir is missing we still return DEFAULT_STATE (not `{}`) so
    // handlers reading `state.private` / `state.session_id` see the sane
    // defaults rather than `undefined` — which would coerce to false/null
    // anyway but reads worse and trips strict assertions.
    loadState: dataDir ? () => loadState(dataDir) : async () => ({ ...DEFAULT_STATE }),
    saveState: dataDir ? (state) => saveState(dataDir, state) : async () => {},
    withLock: dataDir ? (fn) => withLock(dataDir, fn) : (fn) => fn(),
    getClient,
    now: () => Date.now(),
    env: process.env,
  };
}

export async function dispatch(payload) {
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
    // A handler that throws is a bug. Log it but still return {} so the
    // turn proceeds.
    await deps.log({ event, error: String(err?.message ?? err), stack: err?.stack });
    return {};
  }
}

export async function main() {
  const payload = await readStdinJson();
  const result = await dispatch(payload);
  // Stdout is protocol — `{}` is the universal allow/no-op response.
  process.stdout.write(JSON.stringify(result));
}

// Run main() only when invoked as the entry point — never on test imports.
// The canonical ESM pattern: compare import.meta.url to the URL form of
// process.argv[1]. Works for both `node src/dispatch.mjs` and the bundled
// `node bin/librarian-codex-hook.js`.
import { pathToFileURL } from "node:url";

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // Never let an uncaught reject blow up — always write `{}` and exit 0.
  main().catch(async (err) => {
    try {
      const dataDir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
      if (dataDir) await fileLog(dataDir, { event: "fatal", error: String(err?.message ?? err) });
    } catch {
      /* swallow */
    }
    process.stdout.write("{}");
  });
}
