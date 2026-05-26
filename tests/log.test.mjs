// tests/log.test.mjs
// Append + rotate at the size cap. The log is a debug sidecar — losing a
// line is acceptable; unbounded growth is not.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, MAX_LOG_BYTES } from "../src/log.mjs";

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-log-${name}-`));
}

test("log appends to log.jsonl when no file exists yet", async () => {
  const dir = tmp("append-new");
  await log(dir, { event: "test", a: 1 });
  const body = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8");
  const parsed = JSON.parse(body.trim());
  assert.equal(parsed.event, "test");
  assert.equal(parsed.a, 1);
  assert.ok(parsed.ts, "timestamp present");
});

test("log appends additional lines without rotating when under the cap", async () => {
  const dir = tmp("append-under");
  for (let i = 0; i < 5; i++) await log(dir, { event: "test", i });
  const lines = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(fs.existsSync(path.join(dir, "log.jsonl.1")), false, "no rotation under cap");
});

test("log rotates to log.jsonl.1 when the current file exceeds MAX_LOG_BYTES", async () => {
  const dir = tmp("rotate");
  // Pre-seed the log just over the cap.
  const oversize = "x".repeat(MAX_LOG_BYTES + 1);
  fs.writeFileSync(path.join(dir, "log.jsonl"), oversize);
  await log(dir, { event: "post-rotate" });
  // The new log.jsonl contains only the post-rotate line.
  const fresh = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8");
  const parsed = JSON.parse(fresh.trim());
  assert.equal(parsed.event, "post-rotate");
  // The oversize content is preserved at log.jsonl.1.
  const rotated = fs.readFileSync(path.join(dir, "log.jsonl.1"), "utf8");
  assert.equal(rotated.length, oversize.length);
});

test("a second rotation overwrites the existing .1 (only one generation kept)", async () => {
  const dir = tmp("rotate-overwrite");
  fs.writeFileSync(path.join(dir, "log.jsonl"), "x".repeat(MAX_LOG_BYTES + 1));
  fs.writeFileSync(path.join(dir, "log.jsonl.1"), "old-rotation");
  await log(dir, { event: "second-rotate" });
  // The previous .1 is gone — the just-rotated file is the new .1.
  const rotated = fs.readFileSync(path.join(dir, "log.jsonl.1"), "utf8");
  assert.equal(rotated.startsWith("xxxx"), true, "rotated file holds the over-cap content");
  assert.ok(!rotated.startsWith("old-rotation"), "previous .1 was overwritten");
});

test("log swallows mkdir failures rather than throwing — best-effort guarantee", async () => {
  // Pass a path that can't be created (a file shadowing the dataDir).
  const dir = tmp("mkdir-blocked");
  const conflicting = path.join(dir, "blocked");
  fs.writeFileSync(conflicting, "x");
  // Using `conflicting` as a dataDir means mkdir would try to make it a
  // dir, but it's already a regular file. await must not reject.
  await log(conflicting, { event: "should-not-throw" });
  assert.ok(true, "log returned without throwing");
});
