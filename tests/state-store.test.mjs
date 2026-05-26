// tests/state-store.test.mjs
// Atomicity + race resolution for the plugin's local state file.
// State on disk gates the lifecycle (attached session_id, off-record flag,
// checkpoint debounce counters); a half-written file or a lost update there
// would silently desync the plugin from the Librarian server.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.mjs";

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-codex-${name}-`));
}

test("loadState returns DEFAULT_STATE when no file exists", async () => {
  const dir = tmpDir("load-empty");
  const state = await loadState(dir);
  assert.deepEqual(state, DEFAULT_STATE);
});

test("loadState returns DEFAULT_STATE when the file is malformed JSON", async () => {
  const dir = tmpDir("load-malformed");
  fs.writeFileSync(path.join(dir, "state.json"), "{ not json", "utf8");
  const state = await loadState(dir);
  // We reset rather than crash — a corrupt state must never block every
  // subsequent hook on parse.
  assert.deepEqual(state, DEFAULT_STATE);
});

test("loadState fills missing fields with DEFAULT_STATE values", async () => {
  const dir = tmpDir("load-partial");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ session_id: "ses_abc" }), "utf8");
  const state = await loadState(dir);
  assert.equal(state.session_id, "ses_abc");
  assert.equal(state.private, false);
  assert.equal(state.last_checkpoint_at, 0);
  assert.equal(state.turns_since_checkpoint, 0);
});

test("saveState writes atomically and leaves no .tmp residue", async () => {
  const dir = tmpDir("save-atomic");
  await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_one" });
  const round = await loadState(dir);
  assert.equal(round.session_id, "ses_one");
  // The temp file must not be left behind on success.
  const residue = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("concurrent saveState calls don't corrupt the file", async () => {
  const dir = tmpDir("save-concurrent");
  // Fire 20 saves in parallel. The last one wins, but the file must remain
  // valid JSON throughout — no half-written rename.
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(saveState(dir, { ...DEFAULT_STATE, session_id: `ses_${i}` }));
  }
  await Promise.all(writes);
  const final = await loadState(dir);
  assert.match(final.session_id, /^ses_\d+$/, "final file must parse to a valid state");
});

test("withLock serialises mutators — only one critical section runs at a time", async () => {
  const dir = tmpDir("with-lock");
  let inside = 0;
  let maxConcurrent = 0;
  const work = async () => {
    inside++;
    maxConcurrent = Math.max(maxConcurrent, inside);
    await new Promise((r) => setTimeout(r, 25));
    inside--;
    return "done";
  };
  const tasks = [];
  for (let i = 0; i < 5; i++) tasks.push(withLock(dir, work));
  const results = await Promise.all(tasks);
  assert.equal(maxConcurrent, 1, "no two critical sections may overlap");
  assert.deepEqual(results, ["done", "done", "done", "done", "done"]);
});

test("withLock releases the lock even when the body throws", async () => {
  const dir = tmpDir("with-lock-throw");
  await assert.rejects(() => withLock(dir, async () => { throw new Error("boom"); }), /boom/);
  // The very next call must acquire without timing out.
  const ok = await withLock(dir, async () => "released");
  assert.equal(ok, "released");
});
