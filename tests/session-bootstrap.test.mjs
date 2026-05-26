// tests/session-bootstrap.test.mjs
// Race + fail-soft + privacy. The race covers openai/codex#15266 — two
// concurrent invocations of the bootstrap (one from SessionStart, one from
// UserPromptSubmit on the same first prompt) must produce exactly one
// `start_session` call.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapSession } from "../src/handlers/session-bootstrap.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-bootstrap-${name}-`));
}

function makeDeps(dir, { client, env = {}, now = () => 1000 } = {}) {
  return {
    dataDir: dir,
    env: { CODEX_RUN_ID: "r-test", ...env },
    log: async () => {},
    loadState: () => loadState(dir),
    saveState: (s) => saveState(dir, s),
    withLock: (fn) => withLock(dir, fn),
    getClient: () => client,
    now,
  };
}

function fakeClient(stub) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return await stub({ name, args, callCount: calls.length });
    },
  };
}

test("bootstrap starts a session when none is attached", async () => {
  const dir = tmp("first-start");
  const client = fakeClient(() => "Session started.\nID: ses_new1\nStatus: active\n");
  const deps = makeDeps(dir, { client });
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, "ses_new1");
  assert.equal(state.source_ref, "codex:run:r-test:cwd:/p");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "start_session");
  assert.equal(client.calls[0].args.harness, "codex");
  assert.equal(client.calls[0].args.visibility, "common");
  assert.equal(client.calls[0].args.capture_mode, "summary");
});

test("bootstrap is a no-op when a session is already attached", async () => {
  const dir = tmp("already");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_existing" });
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, "ses_existing");
  assert.equal(client.calls.length, 0);
});

test("bootstrap is a no-op while off-record", async () => {
  const dir = tmp("private");
  await saveState(dir, { ...DEFAULT_STATE, private: true });
  const client = fakeClient(() => { throw new Error("server should not be called"); });
  const deps = makeDeps(dir, { client });
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, null);
  assert.equal(state.private, true);
  assert.equal(client.calls.length, 0);
});

test("openai/codex#15266 race: two concurrent bootstraps produce one start_session call", async () => {
  const dir = tmp("race");
  let nextId = 0;
  const client = fakeClient(() => `Session started.\nID: ses_${++nextId}\nStatus: active\n`);
  const deps = makeDeps(dir, { client });
  // Hit it 5x concurrently — only one start_session call should be made,
  // the others must observe the attached session and bail.
  const tasks = [];
  for (let i = 0; i < 5; i++) tasks.push(bootstrapSession({ cwd: "/p" }, deps));
  await Promise.all(tasks);
  assert.equal(client.calls.length, 1, "exactly one start_session call across all racers");
  const final = await loadState(dir);
  assert.equal(final.session_id, "ses_1");
});

test("bootstrap fails soft when the server errors — no session attached, no throw", async () => {
  const dir = tmp("fail-soft");
  const client = fakeClient(() => { throw new Error("boom"); });
  const deps = makeDeps(dir, { client });
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, null, "no session attached after failure");
});

test("bootstrap fails soft when no MCP client is available (missing env vars)", async () => {
  const dir = tmp("no-client");
  const deps = makeDeps(dir, { client: null });
  deps.getClient = () => null;
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, null);
});

test("bootstrap fails soft when the server response has no session id", async () => {
  const dir = tmp("no-id");
  const client = fakeClient(() => "Some prose that does not include an ID line.");
  const deps = makeDeps(dir, { client });
  const state = await bootstrapSession({ cwd: "/p" }, deps);
  assert.equal(state.session_id, null);
});

test("start_summary seed includes the opening prompt when available", async () => {
  const dir = tmp("with-prompt");
  const client = fakeClient(() => "Session started.\nID: ses_x\nStatus: active\n");
  const deps = makeDeps(dir, { client });
  await bootstrapSession({ cwd: "/p", prompt: "fix the failing checkpoint policy test" }, deps);
  const summary = client.calls[0].args.start_summary;
  assert.match(summary, /Working in \/p\./);
  assert.match(summary, /Opening prompt: fix the failing checkpoint policy test/);
});
