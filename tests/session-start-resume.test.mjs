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

test("source=resume bootstraps first, then pauses one stale active session", async () => {
  const dir = tmp("resume-one");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_ONE_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["start_session", "list_sessions", "pause_session"], "bootstrap precedes reconcile so a concurrent UPS can't have its session paused");
  // list filter is active + this source_ref
  assert.equal(client.calls[1].args.status, "active");
  assert.equal(client.calls[1].args.source_ref, "codex:run:r-test:cwd:/p");
  // pause targets the listed id (which is NOT our newly bootstrapped session)
  assert.equal(client.calls[2].args.session_id, "ses_old1");
  assert.match(client.calls[2].args.summary, /reconciliation/i);
  // bootstrap attached the new session
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new");
});

test("source=resume pauses each stale active session AFTER bootstrap", async () => {
  const dir = tmp("resume-multi");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_TWO_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.equal(seq[0], "start_session");
  const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
  assert.equal(pauseCalls.length, 2);
  assert.deepEqual(
    pauseCalls.map((c) => c.args.session_id).sort(),
    ["ses_old1", "ses_old2"],
  );
});

test("source=resume with no stale active sessions just bootstraps", async () => {
  const dir = tmp("resume-empty");
  const client = makeClient({
    list_sessions: () => LIST_PROSE_EMPTY,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["start_session", "list_sessions"]);
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
  assert.deepEqual(seq, ["start_session", "list_sessions", "pause_session"]);
});

test("RACE GUARD: reconcile must NEVER pause the session we just bootstrapped", async () => {
  // Simulate the worst-case interleave: a concurrent UserPromptSubmit
  // bootstrap won the lock first, started ses_new, persisted state. Then
  // list_sessions returns BOTH ses_new (the just-started one) AND an old
  // stale one. The reconcile must filter ours out.
  const dir = tmp("race-guard");
  const listBoth =
    "Sessions:\n\n" +
    "1. [active] ours — proj — codex — cwd:/p — 2026-05-26 — n\n   id: ses_new\n" +
    "2. [active] stale — proj — codex — cwd:/p — 2026-05-26 — n\n   id: ses_stale\n";
  const client = makeClient({
    start_session: () => START_PROSE,
    list_sessions: () => listBoth,
    pause_session: () => PAUSE_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
  const pausedIds = pauseCalls.map((c) => c.args.session_id);
  assert.deepEqual(pausedIds, ["ses_stale"], "ses_new (our just-bootstrapped session) must not be paused");
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new", "we remain attached to our session");
});

test("if a stale session matches state.session_id from a prior run, it gets paused too", async () => {
  // Pre-existing state pointing at a session that the server still says is
  // active. After bootstrap reads state and finds nothing — wait, state is
  // pre-seeded. So the bootstrap will be a no-op (already_attached). Then
  // reconcile lists [ses_old1] and ses_old1 IS our attached. So we should
  // NOT pause it — that's the same race-guard semantics.
  const dir = tmp("preseeded-attached");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_old1", source_ref: "stale" });
  const client = makeClient({
    list_sessions: () => LIST_PROSE_ONE_ACTIVE,
    pause_session: () => PAUSE_PROSE,
    start_session: () => START_PROSE,
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  // bootstrap is a no-op (already attached), then reconcile lists ses_old1
  // and filters it out as "ours" — so no pauses.
  const startCalls = client.calls.filter((c) => c.name === "start_session");
  assert.equal(startCalls.length, 0, "bootstrap is a no-op when already attached");
  const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
  assert.equal(pauseCalls.length, 0, "the only listed session matches state.session_id so nothing to pause");
});

test("a failed list_sessions during reconciliation doesn't undo the bootstrap (fail-soft)", async () => {
  const dir = tmp("list-fails");
  const client = makeClient({
    start_session: () => START_PROSE,
    list_sessions: () => { throw new Error("server down"); },
  });
  const deps = makeDeps(dir, { client });
  await handleSessionStart({ source: "resume", cwd: "/p" }, deps);
  // bootstrap fired first and attached; list failed, no pauses.
  const seq = client.calls.map((c) => c.name);
  assert.deepEqual(seq, ["start_session", "list_sessions"]);
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_new");
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
