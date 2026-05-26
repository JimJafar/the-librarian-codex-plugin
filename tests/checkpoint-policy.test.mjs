// tests/checkpoint-policy.test.mjs
// Exhaustive cases for the debounced-checkpoint OR-of-conditions matrix.
// Wrong thresholds here would either spam the Librarian with checkpoints
// every turn (defeating the purpose of the debounce) or never checkpoint
// at all (losing rolling-summary updates between PostCompact events).

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKPOINT_MAX_TURNS,
  CHECKPOINT_MIN_INTERVAL_MS,
  shouldCheckpoint,
} from "../src/handlers/checkpoint-policy.mjs";

test("returns false on null/undefined state", () => {
  assert.equal(shouldCheckpoint(null, 0), false);
  assert.equal(shouldCheckpoint(undefined, 0), false);
});

test("returns false when both elapsed and turns are below threshold", () => {
  const state = { last_checkpoint_at: 1000, turns_since_checkpoint: 1 };
  assert.equal(shouldCheckpoint(state, 2000), false);
});

test("returns true when elapsed since last checkpoint meets the interval threshold", () => {
  const state = { last_checkpoint_at: 0, turns_since_checkpoint: 0 };
  assert.equal(shouldCheckpoint(state, CHECKPOINT_MIN_INTERVAL_MS), true);
  // Strictly above the threshold too.
  assert.equal(shouldCheckpoint(state, CHECKPOINT_MIN_INTERVAL_MS + 1), true);
});

test("returns true when turns_since_checkpoint meets the turns threshold", () => {
  const state = { last_checkpoint_at: 1_000_000_000, turns_since_checkpoint: CHECKPOINT_MAX_TURNS };
  assert.equal(shouldCheckpoint(state, 1_000_000_000), true);
});

test("returns false strictly below either threshold", () => {
  const state = { last_checkpoint_at: 0, turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1 };
  assert.equal(shouldCheckpoint(state, CHECKPOINT_MIN_INTERVAL_MS - 1), false);
});

test("missing fields default to zero (fresh state)", () => {
  // Fresh state right after a checkpoint: now = epoch, last_checkpoint_at
  // missing, turns missing. Elapsed = now, so for now >= threshold we
  // checkpoint. This is the 'first checkpoint right after server boot'
  // edge case — fine to fire because the elapsed time IS huge.
  const state = {};
  assert.equal(shouldCheckpoint(state, CHECKPOINT_MIN_INTERVAL_MS), true);
  assert.equal(shouldCheckpoint(state, 0), false);
});
