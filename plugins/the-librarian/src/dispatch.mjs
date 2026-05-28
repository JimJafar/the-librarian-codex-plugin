// src/dispatch.mjs
//
// Single entry point bundled into bin/librarian-codex-hook.js. Reads the
// Codex hook payload from stdin, routes by `hook_event_name` to a handler,
// writes the JSON result (or `{}` on any failure) to stdout, and exits 0.
//
// sessions-rethink PR 3 — the only registered handler now is the
// UserPromptSubmit conv-state injector (spec §4.9). The legacy
// SessionStart / PostCompact / Stop hooks are retired with the rest of the
// session subsystem.
//
// Two invariants every hook obeys:
//  1. Always exit 0. A non-zero exit blocks Codex's turn; the four
//     user-facing verbs (/handoff, /takeover, /learn, /toggle-private)
//     are now pure agent operations and never run through a hook.
//  2. Stdout is hook protocol. Never print stray debug output: a stray
//     line on `UserPromptSubmit` would be injected into the model's
//     context. All diagnostics go through src/log.mjs to a sidecar
//     log.jsonl.

import { handleUserPromptSubmit } from "./handlers/user-prompt-submit.mjs";
import { log as fileLog } from "./log.mjs";
import { createMcpClient } from "./mcp-client.mjs";

const HANDLERS = {
  UserPromptSubmit: handleUserPromptSubmit,
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

  // Build the MCP client lazily: a hook that doesn't need to call the
  // server shouldn't fail just because the env var is unset. The conv-
  // state inject handler fail-softs and logs.
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
    log: dataDir ? (entry) => fileLog(dataDir, entry) : async () => {},
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
