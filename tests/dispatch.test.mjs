// tests/dispatch.test.mjs
//
// Routing + fault-tolerance of the hook dispatcher. Every code path must end
// in a `{}` (or other valid JSON) result — never an exception, never a
// non-zero exit. The dispatch() function is the unit; main() is exercised
// by the smoke test.
//
// sessions-rethink PR 3 — only UserPromptSubmit is registered. The legacy
// SessionStart / PostCompact / Stop routes are retired with the rest of
// the session subsystem.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../plugins/the-librarian/src/dispatch.mjs";

function withTmpDataDir(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `librarian-codex-disp-${name}-`));
  const prev = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prev;
  });
}

test("dispatch returns {} for an unknown hook event and logs it", async () => {
  await withTmpDataDir("unknown", async (dir) => {
    const result = await dispatch({ hook_event_name: "DoesNotExist" });
    assert.deepEqual(result, {});
    const lines = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.event, "unknown");
    assert.equal(entry.payload_event, "DoesNotExist");
  });
});

test("dispatch returns {} for the retired SessionStart / PostCompact / Stop events", async () => {
  await withTmpDataDir("retired-events", async (dir) => {
    for (const name of ["SessionStart", "PostCompact", "Stop"]) {
      const result = await dispatch({ hook_event_name: name });
      assert.deepEqual(result, {});
    }
    const events = fs
      .readFileSync(path.join(dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Every retired event takes the "unknown" path now.
    assert.ok(events.every((e) => e.event === "unknown"));
  });
});

test("dispatch routes UserPromptSubmit and logs the canonical event line", async () => {
  await withTmpDataDir("user-prompt-submit", async (dir) => {
    const result = await dispatch({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
    // UserPromptSubmit injects the standing librarian awareness primer (spec 041).
    assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(result.hookSpecificOutput.additionalContext, /<librarian>/);
    const events = fs
      .readFileSync(path.join(dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.event === "UserPromptSubmit"));
  });
});

test("dispatch returns {} on an empty / missing payload", async () => {
  await withTmpDataDir("empty", async () => {
    const result = await dispatch({});
    assert.deepEqual(result, {});
  });
});
