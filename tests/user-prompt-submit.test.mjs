// tests/user-prompt-submit.test.mjs
//
// sessions-rethink PR 3 — the handler is now conv-state-injection only.
// Covers spec §4.9: on a hit, prepend the canonical <conversation-state>
// block via additionalContext; on miss / no-client / bad shape / thrown
// error, return `{}` so the prompt reaches the model unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { handleUserPromptSubmit } from "../plugins/the-librarian/src/handlers/user-prompt-submit.mjs";

function makeClient(stub) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args });
    },
  };
}

function makeDeps({ client = null, env = {} } = {}) {
  return {
    env: { CODEX_RUN_ID: "r1", ...env },
    log: async () => {},
    getClient: () => client,
    now: () => 1000,
  };
}

const CONV_STATE_JSON = JSON.stringify({
  conv_id: "codex:run:r1:cwd:/p",
  harness: "codex",
  domain: "coding",
  session_id: "ses_attached",
  off_record: false,
  created_at: "2026-05-27T00:00:00.000Z",
  updated_at: "2026-05-27T00:00:00.000Z",
});

test("conv_state_get hit returns the canonical block as additionalContext", async () => {
  const client = makeClient(({ name }) =>
    name === "conv_state_get" ? CONV_STATE_JSON : "",
  );
  const deps = makeDeps({ client });
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  assert.equal(result.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  const block = result.hookSpecificOutput.additionalContext;
  // The block is exactly conv_id + off_record — the retired domain/session_id
  // lines are dropped even when present on the server row.
  assert.equal(
    block,
    [
      "<conversation-state>",
      "  conv_id: codex:run:r1:cwd:/p",
      "  off_record: false",
      "</conversation-state>",
    ].join("\n"),
  );
  assert.ok(!block.includes("domain"));
  assert.ok(!block.includes("session_id"));
  // Only one MCP call — conv_state_get. No bootstrap, no privacy gating.
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "conv_state_get");
});

test("conv_state_get miss returns {} (no leak into the model's context)", async () => {
  const client = makeClient(() => "No conversation state for conv_id codex:run:r1:cwd:/p");
  const deps = makeDeps({ client });
  const result = await handleUserPromptSubmit({ prompt: "hi", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("no MCP client (misconfig) returns {}", async () => {
  const deps = makeDeps({ client: null });
  const result = await handleUserPromptSubmit({ prompt: "hi", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("a thrown MCP call returns {} (fail-soft)", async () => {
  const client = {
    callTool: async () => {
      throw new Error("network down");
    },
  };
  const deps = makeDeps({ client });
  const result = await handleUserPromptSubmit({ prompt: "hi", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("a malformed JSON payload returns {} rather than crashing", async () => {
  const client = makeClient(() => "{ not json }");
  const deps = makeDeps({ client });
  const result = await handleUserPromptSubmit({ prompt: "hi", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("source_ref falls back to cwd:<absolute> when no run id is set (always derivable)", async () => {
  // The Codex source_ref form is `codex:run:{RUN_ID}:cwd:{abs}` when
  // CODEX_RUN_ID is set, else `cwd:{abs}` (resolved from payload.cwd or
  // process.cwd()). It never returns null, so the inject path always
  // calls conv_state_get when a client is available.
  const client = makeClient(({ args }) =>
    args.conv_id.startsWith("cwd:") ? CONV_STATE_JSON : "No conversation state.",
  );
  // Override the default `CODEX_RUN_ID: "r1"` baked into makeDeps so we
  // exercise the fallback branch.
  const deps = {
    env: {},
    log: async () => {},
    getClient: () => client,
    now: () => 1000,
  };
  const result = await handleUserPromptSubmit({ prompt: "hi", cwd: "/p" }, deps);
  assert.ok(result.hookSpecificOutput?.additionalContext?.includes("<conversation-state>"));
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].args.conv_id, "cwd:/p");
});
