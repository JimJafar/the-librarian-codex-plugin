// tests/post-compact.test.mjs
// PostCompact must checkpoint when a session is attached, never block, and
// silently skip when off-record / no session / no client / server outage.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handlePostCompact } from "../src/handlers/post-compact.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-pc-${name}-`));
}

function makeDeps(dir, { client = null, now = () => 9999 } = {}) {
  return {
    dataDir: dir,
    env: {},
    log: async () => {},
    loadState: () => loadState(dir),
    saveState: (s) => saveState(dir, s),
    withLock: (fn) => withLock(dir, fn),
    getClient: () => client,
    now,
    _client: client,
  };
}

function fakeClient(stub = () => "Session checkpointed.") {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args });
    },
  };
}

test("PostCompact calls checkpoint_session when a session is attached", async () => {
  const dir = tmp("happy");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_attached", turns_since_checkpoint: 5 });
  const client = fakeClient();
  const deps = makeDeps(dir, { client, now: () => 12345 });
  await handlePostCompact({ trigger: "manual" }, deps);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "checkpoint_session");
  assert.equal(client.calls[0].args.session_id, "ses_attached");
  assert.match(client.calls[0].args.summary, /User triggered/);
  // Debounce counters reset.
  const state = await loadState(dir);
  assert.equal(state.last_checkpoint_at, 12345);
  assert.equal(state.turns_since_checkpoint, 0);
});

test("PostCompact distinguishes auto vs manual trigger in the summary", async () => {
  const dir = tmp("auto");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_a" });
  const client = fakeClient();
  const deps = makeDeps(dir, { client });
  await handlePostCompact({ trigger: "auto" }, deps);
  assert.match(client.calls[0].args.summary, /auto-compacted/);
});

test("PostCompact is a no-op while off-record", async () => {
  const dir = tmp("private");
  await saveState(dir, { ...DEFAULT_STATE, private: true, session_id: "ses_x" });
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  await handlePostCompact({ trigger: "manual" }, deps);
  assert.equal(client.calls.length, 0);
});

test("PostCompact is a no-op when no session is attached", async () => {
  const dir = tmp("no-session");
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  await handlePostCompact({ trigger: "manual" }, deps);
  assert.equal(client.calls.length, 0);
});

test("PostCompact fails soft when checkpoint_session errors — state unchanged", async () => {
  const dir = tmp("fail-soft");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_a", last_checkpoint_at: 100 });
  const client = {
    calls: [],
    callTool: async (name, args) => {
      client.calls.push({ name, args });
      throw new Error("server down");
    },
  };
  const deps = makeDeps(dir, { client });
  await handlePostCompact({ trigger: "manual" }, deps);
  const state = await loadState(dir);
  assert.equal(state.last_checkpoint_at, 100, "debounce counters preserved when the call failed");
});
