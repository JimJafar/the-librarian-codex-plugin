// src/handlers/stop.mjs
// Fires every time Codex finishes generating. Two responsibilities:
//   1. Record a lightweight per-turn event (`record_session_event` with
//      type=message, summary capped to 280 chars from last_assistant_message).
//   2. Apply the debounced checkpoint policy (≥10 min OR ≥20 turns since the
//      last checkpoint, see ./checkpoint-policy.mjs).
//
// Both are no-ops off-record / without an attached session / without a client.

import { shouldCheckpoint } from "./checkpoint-policy.mjs";

const SUMMARY_MAX_CHARS = 280;

export async function handleStop(payload, deps) {
  await deps.log({ event: "Stop", has_last_assistant: !!payload?.last_assistant_message });

  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "Stop", outcome: "skipped_private" });
    return {};
  }
  if (!state.session_id) {
    await deps.log({ event: "Stop", outcome: "no_session" });
    return {};
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "Stop", outcome: "no_client" });
    return {};
  }

  const summary = deriveTurnSummary(payload);
  // Acceptable race: `state.session_id` was read above without the lock. If
  // a concurrent UserPromptSubmit `goPrivate` slipped in between this read
  // and the network call, one last event records to the (now ended)
  // session. The alternative — holding the lock across a 15 s HTTP POST —
  // would block every other hook for that duration. Trade-off favours
  // responsiveness.
  try {
    await client.callTool("record_session_event", {
      session_id: state.session_id,
      type: "message",
      summary,
    });
  } catch (err) {
    await deps.log({ event: "Stop", outcome: "record_failed", error: String(err?.message ?? err) });
    return {}; // Skip the checkpoint too — best-effort, retry next turn.
  }

  // Update counters and conditionally checkpoint. One withLock pass keeps the
  // increment + maybe-checkpoint atomic with the read of state.
  await deps.withLock(async () => {
    const latest = await deps.loadState();
    const turns = (latest.turns_since_checkpoint ?? 0) + 1;
    const probe = { ...latest, turns_since_checkpoint: turns };
    const now = deps.now();

    if (shouldCheckpoint(probe, now)) {
      try {
        await client.callTool("checkpoint_session", {
          session_id: latest.session_id,
          summary: `Debounced checkpoint (${turns} turn${turns === 1 ? "" : "s"} since last).`,
        });
        await deps.saveState({
          ...latest,
          turns_since_checkpoint: 0,
          last_checkpoint_at: now,
        });
        await deps.log({ event: "Stop", outcome: "checkpointed", turns });
      } catch (err) {
        // Checkpoint failed; keep the turn counter incremented so the next
        // Stop will retry the threshold check.
        await deps.saveState({ ...latest, turns_since_checkpoint: turns });
        await deps.log({ event: "Stop", outcome: "checkpoint_failed", error: String(err?.message ?? err) });
      }
    } else {
      await deps.saveState({ ...latest, turns_since_checkpoint: turns });
    }
  });

  return {};
}

function deriveTurnSummary(payload) {
  const raw = (payload?.last_assistant_message ?? "").trim();
  if (!raw) return "(turn produced no assistant text — tool calls only)";
  if (raw.length <= SUMMARY_MAX_CHARS) return raw;
  return `${raw.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}
