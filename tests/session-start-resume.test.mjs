// tests/session-start-resume.test.mjs
// Resume / clear paths must pause any stale `active` sessions for the
// current source_ref before bootstrapping a new one. Startup / compact
// must NOT.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSessionStart } from "../src/handlers/session-start.mjs";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-resume-${name}-`));
}

function makeClient(routes) {
  // routes: { tool_name: (args) => responseText | throw }
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const fn = routes[name];
      if (!fn) throw new Error(`unexpected tool call: ${name}`);
      return fn(args);
    },
  };
}

function makeDeps(dir, { client, env = {} } = {}) {
  return {
    dataDir: dir,
    env: { CODEX_RUN_ID: "r-test", ...env },
    log: async () => {},
    loadState: () => loadState(dir),
    saveState: (s) => saveState(dir, s),
    withLock: (fn) => withLock(dir, fn),
    getClient: () => client,
    now: () => 1000,
    _client: client,
  };
}

const LIST_PROSE_ONE_ACTIVE = `Sessions:

1. [active] resumed session — proj — codex — cwd:/p — 2026-05-26 — next step
   id: ses_old1
`;

const LIST_PROSE_TWO_ACTIVE = `Sessions:

1. [active] one — proj — codex — cwd:/p — 2026-05-26 — n
   id: ses_old1
2. [active] two — proj — codex — cwd:/p — 2026-05-26 — n
   id: ses_old2
`;

const LIST_PROSE_EMPTY = `No sessions found.\n`;
const START_PROSE = `Session started.\nID: ses_new\nStatus: active\n`;
const PAUSE_PROSE = `Session paused.`;

test("source=startup bootstraps without a reconciliation pass", async () => {
  const dir = tmp("startup");
  const client = makeClient({ start_session: () => START_PROSE });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "startup", cwd: "/p" }, deps);
  const callNames = client.calls.map((c) => c.name);
  assert.deepEqual(callNames, ["start_session"], "no list/pause on startup");
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new");
});

test("source=compact bootstraps without a reconciliation pass", async () => {
  const dir = tmp("compact");
  const client = makeClient({ start_session: () => START_PROSE });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "compact", cwd: "/p" }, deps);
  const callNames = client.calls.map((c) => c.name);
  assert.deepEqual(callNames, ["start_session"]);
});

test("source=resume with one stale active session pauses it before bootstrapping", async () => {
  const dir = tmp("resume-one");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_ONE_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["list_sessions", "pause_session", "start_session"]);
  // list filter is active + this source_ref
  assert.equal(client.calls[0].args.status, "active");
  assert.equal(client.calls[0].args.source_ref, "codex:run:r-test:cwd:/p");
  // pause targets the listed id
  assert.equal(client.calls[1].args.session_id, "ses_old1");
  assert.match(client.calls[1].args.summary, /reconciliation/i);
  // bootstrap attached the new session
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new");
});

test("source=resume with multiple stale active sessions pauses each before bootstrapping", async () => {
  const dir = tmp("resume-multi");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_TWO_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
  assert.equal(pauseCalls.length, 2);
  assert.deepEqual(
    pauseCalls.map((c) => c.args.session_id).sort(),
    ["ses_old1", "ses_old2"],
  );
});

test("source=resume with no stale active sessions skips straight to bootstrap", async () => {
  const dir = tmp("resume-empty");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_EMPTY,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["list_sessions", "start_session"]);
});

test("source=clear behaves like resume", async () => {
  const dir = tmp("clear");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_ONE_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "clear", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["list_sessions", "pause_session", "start_session"]);
});

test("if state.session_id matched a just-paused session it gets cleared before bootstrap", async () => {
  const dir = tmp("clears-attached");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_old1", source_ref: "stale" });
  const client = makeClient({
    list_sessions: () => LIST_PROSE_ONE_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  // The new session attached (bootstrap saw session_id null after we cleared it).
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new");
});

test("a failed list_sessions during reconciliation falls through to bootstrap (fail-soft)", async () => {
  const dir = tmp("list-fails");
  const client = makeClient({
    list_sessions: () => { throw new Error("server down"); },
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["list_sessions", "start_session"]);
});

test("a failed pause_session on one session doesn't stop the rest from being paused", async () => {
  const dir = tmp("pause-fail-partial");
  let pauseCount = 0;
  const client = makeClient({
    list_sessions: () => LIST_PROSE_TWO_ACTIVE,
    pause_session: () => {
      pauseCount++;
      if (pauseCount === 1) throw new Error("flaky");
      return PAUSE_PROSE;
    },
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
  assert.equal(pauseCalls.length, 2, "both pauses were attempted even though one failed");
});

test("resume while off-record skips reconciliation AND bootstrap", async () => {
  const dir = tmp("resume-private");
  await saveState(dir, { ...DEFAULT_STATE, private: true });
  const client = makeClient({}); // any tool call would throw
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  assert.equal(client.calls.length, 0);
});
