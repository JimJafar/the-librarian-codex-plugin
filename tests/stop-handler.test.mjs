// tests/stop-handler.test.mjs
// Stop must record every turn (cheap, makes recording "automatic") and
// debounce checkpoint_session to the policy in checkpoint-policy.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleStop } from "../src/handlers/stop.mjs";
import {
  CHECKPOINT_MAX_TURNS,
  CHECKPOINT_MIN_INTERVAL_MS,
} from "../src/handlers/checkpoint-policy.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-stop-${name}-`));
}

function fakeClient(stub = () => "ok") {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args });
    },
  };
}

function makeDeps(dir, { client = fakeClient(), now = 1_000_000 } = {}) {
  let _now = now;
  return {
    dataDir: dir,
    env: {},
    log: async () => {},
    loadState: () => loadState(dir),
    saveState: (s) => saveState(dir, s),
    withLock: (fn) => withLock(dir, fn),
    getClient: () => client,
    now: () => _now,
    setNow: (t) => { _now = t; },
    _client: client,
  };
}

test("Stop records a per-turn message event when attached", async () => {
  const dir = tmp("record");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", last_checkpoint_at: 1_000_000 });
  const deps = makeDeps(dir);
  await handleStop({ last_assistant_message: "Wrote the spec." }, deps);
  const recordCalls = deps._client.calls.filter((c) => c.name === "record_session_event");
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].args.session_id, "ses_x");
  assert.equal(recordCalls[0].args.type, "message");
  assert.equal(recordCalls[0].args.summary, "Wrote the spec.");
  // Below both thresholds — no checkpoint yet.
  const checkpointCalls = deps._client.calls.filter((c) => c.name === "checkpoint_session");
  assert.equal(checkpointCalls.length, 0);
  // Turn counter incremented.
  const state = await loadState(dir);
  assert.equal(state.turns_since_checkpoint, 1);
});

test("a long last_assistant_message is truncated to 280 chars with an ellipsis", async () => {
  const dir = tmp("truncate");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x" });
  const deps = makeDeps(dir);
  const long = "x".repeat(500);
  await handleStop({ last_assistant_message: long }, deps);
  const summary = deps._client.calls[0].args.summary;
  assert.equal(summary.length, 280);
  assert.ok(summary.endsWith("…"));
});

test("a tool-only turn (no assistant text) records a placeholder summary", async () => {
  const dir = tmp("tool-only");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x" });
  const deps = makeDeps(dir);
  await handleStop({ last_assistant_message: "" }, deps);
  const summary = deps._client.calls[0].args.summary;
  assert.match(summary, /tool calls only/);
});

test("Stop checkpoints after CHECKPOINT_MAX_TURNS-1 prior turns (the next bumps to the threshold)", async () => {
  const dir = tmp("turns-threshold");
  await saveState(dir, {
    ...DEFAULT_STATE,
    session_id: "ses_x",
    last_checkpoint_at: 1_000_000,
    turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1,
  });
  const deps = makeDeps(dir);
  await handleStop({ last_assistant_message: "step N" }, deps);
  const checkpointCalls = deps._client.calls.filter((c) => c.name === "checkpoint_session");
  assert.equal(checkpointCalls.length, 1);
  const state = await loadState(dir);
  assert.equal(state.turns_since_checkpoint, 0, "checkpoint resets the turn counter");
});

test("Stop checkpoints after CHECKPOINT_MIN_INTERVAL_MS has elapsed", async () => {
  const dir = tmp("interval-threshold");
  await saveState(dir, {
    ...DEFAULT_STATE,
    session_id: "ses_x",
    last_checkpoint_at: 0,
    turns_since_checkpoint: 1,
  });
  const deps = makeDeps(dir, { now: CHECKPOINT_MIN_INTERVAL_MS + 1 });
  await handleStop({ last_assistant_message: "after a long pause" }, deps);
  const checkpointCalls = deps._client.calls.filter((c) => c.name === "checkpoint_session");
  assert.equal(checkpointCalls.length, 1);
});

test("Stop is a no-op while off-record", async () => {
  const dir = tmp("private");
  await saveState(dir, { ...DEFAULT_STATE, private: true, session_id: "ses_x" });
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  await handleStop({ last_assistant_message: "secret" }, deps);
  assert.equal(client.calls.length, 0);
});

test("Stop is a no-op when no session is attached", async () => {
  const dir = tmp("no-session");
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  await handleStop({ last_assistant_message: "anything" }, deps);
  assert.equal(client.calls.length, 0);
});

test("Stop fails soft when record_session_event errors — checkpoint NOT attempted", async () => {
  const dir = tmp("record-fails");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1 });
  const client = {
    calls: [],
    callTool: async (name) => {
      client.calls.push({ name });
      throw new Error("server down");
    },
  };
  const deps = makeDeps(dir, { client });
  await handleStop({ last_assistant_message: "anything" }, deps);
  // Only the record attempt — no checkpoint follow-up after the record failed.
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "record_session_event");
});

test("checkpoint failure leaves the turn counter incremented so the next Stop retries the threshold", async () => {
  const dir = tmp("checkpoint-fails");
  await saveState(dir, {
    ...DEFAULT_STATE,
    session_id: "ses_x",
    last_checkpoint_at: 0,
    turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1,
  });
  let callCount = 0;
  const client = {
    calls: [],
    callTool: async (name, args) => {
      callCount++;
      client.calls.push({ name, args });
      if (name === "checkpoint_session") throw new Error("server down");
      return "ok";
    },
  };
  const deps = makeDeps(dir, { client });
  await handleStop({ last_assistant_message: "x" }, deps);
  // record_session_event succeeded, checkpoint_session failed.
  assert.equal(client.calls.filter((c) => c.name === "record_session_event").length, 1);
  assert.equal(client.calls.filter((c) => c.name === "checkpoint_session").length, 1);
  const state = await loadState(dir);
  assert.equal(state.turns_since_checkpoint, CHECKPOINT_MAX_TURNS, "counter still at threshold so the next Stop retries");
});
