// src/handlers/session-bootstrap.mjs
// Shared bootstrap — called from both `SessionStart` and `UserPromptSubmit`
// to ensure a Librarian session is attached. Idempotent under the race
// documented in openai/codex#15266 (both hooks fire simultaneously on the
// first prompt): the lock-guarded read-then-write makes one caller win and
// the other observe `state.session_id` already set and bail.
//
// Off-record: returns the unchanged state without ever calling the server.
// A bootstrap is the start of a recording — if the user is private, doing
// nothing is correct.
//
// Fail-soft: a Librarian/network failure leaves state unchanged (no session
// attached) and logs. The next hook event will retry.

import { sourceRefFromPayload } from "../source-ref.mjs";
import { extractSessionId } from "../mcp-parse.mjs";

const HARNESS = "codex";

export async function bootstrapSession(payload, deps) {
  return deps.withLock(async () => {
    const state = await deps.loadState();
    if (state.private) {
      await deps.log({ event: "bootstrap", outcome: "skipped_private" });
      return state;
    }
    if (state.session_id) {
      await deps.log({ event: "bootstrap", outcome: "already_attached", session_id: state.session_id });
      return state;
    }
    const client = deps.getClient();
    if (!client) {
      await deps.log({ event: "bootstrap", outcome: "no_client" });
      return state;
    }

    const sourceRef = sourceRefFromPayload(payload, deps.env);
    const args = {
      harness: HARNESS,
      source_ref: sourceRef,
      cwd: payload?.cwd ?? deps.env.PWD ?? null,
      visibility: "common",
      capture_mode: "summary",
      start_summary: deriveStartSummary(payload),
    };
    if (deps.env.LIBRARIAN_PROJECT_KEY) args.project_key = deps.env.LIBRARIAN_PROJECT_KEY;

    let sessionId = null;
    try {
      const text = await client.callTool("start_session", args);
      sessionId = extractSessionId(text);
    } catch (err) {
      await deps.log({ event: "bootstrap", outcome: "start_failed", error: String(err?.message ?? err) });
      return state; // Fail-soft. Retry next hook.
    }

    if (!sessionId) {
      await deps.log({ event: "bootstrap", outcome: "no_session_id_in_response" });
      return state;
    }

    const updated = {
      ...state,
      session_id: sessionId,
      source_ref: sourceRef,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0,
    };
    await deps.saveState(updated);
    await deps.log({ event: "bootstrap", outcome: "started", session_id: sessionId, source_ref: sourceRef });
    return updated;
  });
}

function deriveStartSummary(payload) {
  // Build a one-paragraph baseline. Available signals: cwd (always present),
  // prompt (only on UserPromptSubmit-triggered bootstraps).
  const parts = [];
  if (payload?.cwd) parts.push(`Working in ${payload.cwd}.`);
  const prompt = (payload?.prompt ?? "").trim();
  if (prompt) {
    // Keep the seed short — the Librarian server already truncates and the
    // first prompt may contain a lot. 240 chars is enough for a meaningful
    // baseline without bloating the row.
    const seed = prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt;
    parts.push(`Opening prompt: ${seed}`);
  }
  if (parts.length === 0) return "Session opened from Codex with no visible context yet.";
  return parts.join(" ");
}
