// src/handlers/checkpoint-policy.mjs
// Decides when the Stop handler should call `checkpoint_session` in addition
// to the per-turn `record_session_event`. Stop fires every turn; checkpoint
// every turn would flood the Librarian's rolling-summary update with noise.
//
// Policy (per PLAN.md Open Question 3):
//   - Always checkpoint on PostCompact (handled in that handler).
//   - From a Stop event, checkpoint when EITHER:
//       a) ≥ CHECKPOINT_MIN_INTERVAL_MS have elapsed since last_checkpoint_at,
//       b) ≥ CHECKPOINT_MAX_TURNS record_session_event calls since last
//          checkpoint.
//
// Constants live here as named exports so they can be tuned without touching
// the handler.

export const CHECKPOINT_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const CHECKPOINT_MAX_TURNS = 20;

export function shouldCheckpoint(state, now) {
  if (!state) return false;
  const elapsed = now - (state.last_checkpoint_at ?? 0);
  if (elapsed >= CHECKPOINT_MIN_INTERVAL_MS) return true;
  if ((state.turns_since_checkpoint ?? 0) >= CHECKPOINT_MAX_TURNS) return true;
  return false;
}
