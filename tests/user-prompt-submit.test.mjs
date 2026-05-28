// tests/user-prompt-submit.test.mjs
// Integration tests for the UserPromptSubmit handler — the off-record gate +
// the race-safe bootstrap call.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleUserPromptSubmit } from "../src/handlers/user-prompt-submit.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-ups-${name}-`));
}

function makeClient(stub = () => "Session started.\nID: ses_x\nStatus: active\n") {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args });
    },
  };
}

function makeDeps(dir, { client = makeClient(), env = {}, now = () => 1000 } = {}) {
  return {
    dataDir: dir,
    env: { CODEX_RUN_ID: "r1", ...env },
    log: async () => {},
    loadState: () => loadState(dir),
    saveState: (s) => saveState(dir, s),
    withLock: (fn) => withLock(dir, fn),
    getClient: () => client,
    now,
    _client: client,
  };
}

test("a non-marker prompt triggers a bootstrap when none is attached", async () => {
  const dir = tmp("bootstrap-fresh");
  const deps = makeDeps(dir);
  const result = await handleUserPromptSubmit({ prompt: "hello world", cwd: "/p" }, deps);
  // Default stub returns start_session text for ALL calls — conv_state_get
  // parses that as JSON-error → no block prepended → `{}`. So the result
  // shape is identical to pre-injection.
  assert.deepEqual(result, {});
  const calls = deps._client.calls;
  // Two calls now: start_session (bootstrap) then conv_state_get (inject).
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "start_session");
  assert.equal(calls[1].name, "conv_state_get");
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_x");
});

// Conv-state injection — spec §4.9 of memory-domain-isolation.

const CONV_STATE_JSON = JSON.stringify({
  conv_id: "codex:run:r1:cwd:/p",
  harness: "codex",
  domain: "coding",
  session_id: "ses_attached",
  off_record: false,
  created_at: "2026-05-27T00:00:00.000Z",
  updated_at: "2026-05-27T00:00:00.000Z",
});

test("conv_state_get hit prepends the canonical block to additionalContext", async () => {
  const dir = tmp("inject-hit");
  const client = {
    calls: [],
    callTool: async (name, args) => {
      client.calls.push({ name, args });
      if (name === "conv_state_get") return CONV_STATE_JSON;
      return "Session started.\nID: ses_x\nStatus: active\n";
    },
  };
  const deps = makeDeps(dir, { client });
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  assert.equal(result.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  const ctx = result.hookSpecificOutput?.additionalContext;
  assert.ok(ctx?.startsWith("<conversation-state>"), `missing block: ${ctx}`);
  assert.ok(ctx.includes("conv_id: codex:run:r1:cwd:/p"));
  assert.ok(ctx.includes("domain: coding"));
  assert.ok(ctx.includes("session_id: ses_attached"));
  assert.ok(ctx.includes("off_record: false"));
  const convCall = client.calls.find((c) => c.name === "conv_state_get");
  assert.equal(convCall.args.conv_id, "codex:run:r1:cwd:/p");
});

test("malformed conv_state (missing domain) renders `domain: unknown`, never the literal `undefined`", async () => {
  const dir = tmp("inject-malformed");
  const malformed = JSON.stringify({
    conv_id: "codex:run:r1:cwd:/p",
    harness: "codex",
    // `domain` deliberately absent — simulates a backend regression
    // that drops the field from the wire payload.
    session_id: "ses_attached",
    off_record: false,
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
  });
  const client = {
    calls: [],
    callTool: async (name) => {
      client.calls.push({ name });
      if (name === "conv_state_get") return malformed;
      return "Session started.\nID: ses_x\nStatus: active\n";
    },
  };
  const deps = makeDeps(dir, { client });
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  const ctx = result.hookSpecificOutput?.additionalContext ?? "";
  assert.ok(ctx.includes("domain: unknown"), `expected "domain: unknown", got: ${ctx}`);
  assert.ok(!ctx.includes("undefined"), `block must not contain "undefined": ${ctx}`);
});

test("conv_state_get miss (no state) returns plain {} — no envelope", async () => {
  const dir = tmp("inject-miss");
  const client = {
    calls: [],
    callTool: async (name) => {
      client.calls.push({ name });
      if (name === "conv_state_get") return "No conversation state for conv_id codex:run:r1:cwd:/p.";
      return "Session started.\nID: ses_x\nStatus: active\n";
    },
  };
  const deps = makeDeps(dir, { client });
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("conv_state_get failure is fail-soft — the turn proceeds", async () => {
  const dir = tmp("inject-fail");
  const client = {
    calls: [],
    callTool: async (name, args) => {
      client.calls.push({ name });
      if (name === "conv_state_get") throw new Error("server down");
      return "Session started.\nID: ses_x\nStatus: active\n";
    },
  };
  const deps = makeDeps(dir, { client });
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("no MCP client → no conv-state injection, just `{}`", async () => {
  const dir = tmp("inject-no-client");
  const deps = makeDeps(dir, { client: makeClient() });
  // Override the client getter to return null (mimics missing dataDir / env).
  deps.getClient = () => null;
  const result = await handleUserPromptSubmit({ prompt: "hello", cwd: "/p" }, deps);
  assert.deepEqual(result, {});
});

test("'off the record' ends the attached session and flips state.private", async () => {
  const dir = tmp("enter-private");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_attached", source_ref: "cwd:/p" });
  const deps = makeDeps(dir);
  const result = await handleUserPromptSubmit({ prompt: "off the record" }, deps);
  assert.deepEqual(result, {});
  const calls = deps._client.calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "end_session");
  assert.equal(calls[0].args.session_id, "ses_attached");
  assert.match(calls[0].args.summary, /private/i);
  const state = await loadState(dir);
  assert.equal(state.private, true);
  assert.equal(state.session_id, null);
});

test("entering private mode with no session attached is still a clean flip", async () => {
  const dir = tmp("enter-private-no-session");
  const deps = makeDeps(dir);
  await handleUserPromptSubmit({ prompt: "keep this between us" }, deps);
  // No end_session call (nothing was attached), but state.private flipped.
  assert.equal(deps._client.calls.filter((c) => c.name === "end_session").length, 0);
  const state = await loadState(dir);
  assert.equal(state.private, true);
});

test("'back on the record' flips state.private to false but does NOT start a session", async () => {
  const dir = tmp("exit-private");
  await saveState(dir, { ...DEFAULT_STATE, private: true });
  const deps = makeDeps(dir);
  await handleUserPromptSubmit({ prompt: "back on the record" }, deps);
  // Exit-marker turns must not record themselves — no MCP call at all on this turn.
  assert.equal(deps._client.calls.length, 0);
  const state = await loadState(dir);
  assert.equal(state.private, false);
  assert.equal(state.session_id, null, "the exit turn doesn't auto-start a session — the next non-marker turn will");
});

test("a non-marker prompt while private does NOT bootstrap a session", async () => {
  const dir = tmp("non-marker-while-private");
  await saveState(dir, { ...DEFAULT_STATE, private: true });
  const deps = makeDeps(dir);
  await handleUserPromptSubmit({ prompt: "what time is it" }, deps);
  assert.equal(deps._client.calls.length, 0, "no MCP call while private");
  const state = await loadState(dir);
  assert.equal(state.session_id, null);
  assert.equal(state.private, true);
});

test("/lib-toggle-private toggles correctly: public → private → public", async () => {
  const dir = tmp("toggle");
  // First toggle: public → private (no session attached to end)
  let deps = makeDeps(dir);
  await handleUserPromptSubmit({ prompt: "/lib-toggle-private" }, deps);
  let state = await loadState(dir);
  assert.equal(state.private, true);
  // Second toggle: private → public
  deps = makeDeps(dir, { client: makeClient() }); // fresh client to reset calls
  await handleUserPromptSubmit({ prompt: "/lib-toggle-private" }, deps);
  state = await loadState(dir);
  assert.equal(state.private, false);
  assert.equal(deps._client.calls.length, 0, "toggle alone shouldn't call MCP tools");
});

test("end_session failure during enter-private is fail-soft — state still flips private", async () => {
  const dir = tmp("end-fails");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x" });
  const client = {
    calls: [],
    callTool: async (name, args) => {
      client.calls.push({ name, args });
      throw new Error("server down");
    },
  };
  const deps = makeDeps(dir, { client });
  await handleUserPromptSubmit({ prompt: "off the record" }, deps);
  const state = await loadState(dir);
  assert.equal(state.private, true, "privacy must always win — server outage cannot leave us recording");
});
