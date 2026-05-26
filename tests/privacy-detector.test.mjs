// tests/privacy-detector.test.mjs
// Parity tests for the ported privacy-marker detector. Mirrors:
//   - the Hermes plugin's tests/test_privacy.py (Python port)
//   - the canonical TypeScript source at
//     the-librarian/integrations/shared/librarian-lifecycle/tests/privacy.test.ts.
//
// All three implementations MUST stay in lockstep — a single missed marker on
// the Codex side would silently record content the user expected to be off
// the record.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRIVATE_MARKERS,
  DEFAULT_PUBLIC_MARKERS,
  detectPrivacySignal,
} from "../src/privacy-detector.mjs";

test("each private marker alone is detected as enter-private", () => {
  for (const marker of DEFAULT_PRIVATE_MARKERS) {
    const d = detectPrivacySignal(marker);
    assert.equal(d.signal, "enter-private", `marker: ${marker}`);
    assert.equal(d.matched, marker);
  }
});

test("a private marker with substantive content is enter-private + hasSubstantiveContent", () => {
  const d = detectPrivacySignal("off the record, my api key is abc123 — what do you think?");
  assert.equal(d.signal, "enter-private");
  assert.equal(d.hasSubstantiveContent, true);
});

test("a bare private marker has no substantive content", () => {
  const d = detectPrivacySignal("  Off The Record.  ");
  assert.equal(d.signal, "enter-private");
  assert.equal(d.hasSubstantiveContent, false);
});

test("curly apostrophe contractions match the straight-quoted marker list", () => {
  const d = detectPrivacySignal("don’t remember this");
  assert.equal(d.signal, "enter-private");
});

test("each public marker alone is detected as exit-private", () => {
  for (const marker of DEFAULT_PUBLIC_MARKERS) {
    const d = detectPrivacySignal(marker);
    assert.equal(d.signal, "exit-private", `marker: ${marker}`);
  }
});

test("a public marker with trailing content is exit-private + hasSubstantiveContent", () => {
  const d = detectPrivacySignal("you can remember again — let's get back to the refactor");
  assert.equal(d.signal, "exit-private");
  assert.equal(d.hasSubstantiveContent, true);
});

test("a bare public marker with only punctuation is sub-threshold for substantive content", () => {
  const d = detectPrivacySignal("end private mode!");
  assert.equal(d.signal, "exit-private");
  assert.equal(d.hasSubstantiveContent, false);
});

test("toggle command in hyphen and colon forms", () => {
  assert.equal(detectPrivacySignal("/lib-toggle-private").signal, "toggle");
  assert.equal(detectPrivacySignal("  /lib:toggle-private  ").signal, "toggle");
});

test("toggle command embedded in prose is NOT a toggle", () => {
  assert.equal(detectPrivacySignal("run /lib-toggle-private to flip mode").signal, "none");
});

test("no false positive on unrelated prose that mentions 'private'", () => {
  const d = detectPrivacySignal("Please refactor the private fields in this class to be readonly.");
  assert.equal(d.signal, "none");
});

test("an empty or undefined prompt is signal=none", () => {
  assert.equal(detectPrivacySignal("").signal, "none");
  assert.equal(detectPrivacySignal(undefined).signal, "none");
  assert.equal(detectPrivacySignal(null).signal, "none");
});

test("a private marker takes precedence over an exit marker in the same prompt", () => {
  const d = detectPrivacySignal("you can remember again but actually keep this between us");
  assert.equal(d.signal, "enter-private");
});

test("custom marker lists are honoured", () => {
  const d = detectPrivacySignal("zip it", { privateMarkers: ["zip it"], publicMarkers: ["unzip"] });
  assert.equal(d.signal, "enter-private");
});
