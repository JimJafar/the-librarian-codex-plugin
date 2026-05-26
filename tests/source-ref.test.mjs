// tests/source-ref.test.mjs
// 100% coverage on source_ref — it's the cross-harness primary key, and a
// drift here would silently fork sessions per machine quirks.

import test from "node:test";
import assert from "node:assert/strict";
import { buildSourceRef, sourceRefFromPayload } from "../src/source-ref.mjs";

test("buildSourceRef prefers the codex:run:… form when CODEX_RUN_ID is set", () => {
  const ref = buildSourceRef({ cwd: "/Users/jim/code/foo", runId: "abc123" });
  assert.equal(ref, "codex:run:abc123:cwd:/Users/jim/code/foo");
});

test("buildSourceRef falls back to cwd:{abs} when no run id is set", () => {
  assert.equal(buildSourceRef({ cwd: "/Users/jim/code/foo" }), "cwd:/Users/jim/code/foo");
  assert.equal(buildSourceRef({ cwd: "/Users/jim/code/foo", runId: "" }), "cwd:/Users/jim/code/foo");
  assert.equal(buildSourceRef({ cwd: "/Users/jim/code/foo", runId: null }), "cwd:/Users/jim/code/foo");
});

test("buildSourceRef resolves relative cwds against the process cwd", () => {
  const ref = buildSourceRef({ cwd: ".", runId: null });
  assert.ok(ref.startsWith("cwd:/"), `expected absolute path, got ${ref}`);
});

test("sourceRefFromPayload reads cwd from payload and runId from env", () => {
  const ref = sourceRefFromPayload({ cwd: "/tmp/x" }, { CODEX_RUN_ID: "r1" });
  assert.equal(ref, "codex:run:r1:cwd:/tmp/x");
});

test("sourceRefFromPayload falls back to cwd:{process.cwd()} when payload has no cwd", () => {
  const ref = sourceRefFromPayload({}, {});
  assert.ok(ref.startsWith("cwd:/"));
});
