// src/handlers/session-start.mjs
// Codex's SessionStart fires four ways, distinguished by `source`:
//   - "startup": fresh process. Bootstrap a session if none is attached.
//   - "compact": post-compaction restart. Treated like startup (PostCompact
//     itself handles the checkpoint).
//   - "resume": user explicitly resumed. There MAY be a stale `active`
//     session for this source_ref on the server (no SessionEnd hook means
//     a hard exit leaves one). Bootstrap first, THEN pause anything else
//     active for this source_ref — the inverted order closes the
//     reconcile-vs-bootstrap race against a concurrent UserPromptSubmit
//     that may have already started a fresh session.
//   - "clear": context was cleared. Same as resume.

import { bootstrapSession } from "./session-bootstrap.mjs";
import { sourceRefFromPayload } from "../source-ref.mjs";
import { parseSessionList } from "../mcp-parse.mjs";

const RECONCILE_SOURCES = new Set(["resume", "clear"]);

export async function handleSessionStart(payload, deps) {
  const source = payload?.source ?? null;
  await deps.log({ event: "SessionStart", source });

  // Bootstrap first. Whether this attaches a new session or finds one
  // already attached, the subsequent reconcile knows exactly which session
  // is "ours" and won't pause it. This inversion fixes the race where the
  // old order (reconcile, then bootstrap) could pause a session a
  // concurrent UserPromptSubmit had just attached.
  await bootstrapSession(payload, deps);

  if (RECONCILE_SOURCES.has(source)) {
    await reconcileStaleActive(payload, deps);
  }
  return {};
}

async function reconcileStaleActive(payload, deps) {
  // Off-record: nothing to reconcile. No-client: can't reach the server —
  // fail-soft.
  const stateBefore = await deps.loadState();
  if (stateBefore.private) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_skipped_private" });
    return;
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_skipped_no_client" });
    return;
  }

  const sourceRef = sourceRefFromPayload(payload, deps.env);
  let listText = "";
  try {
    listText = await client.callTool("list_sessions", {
      source_ref: sourceRef,
      status: "active",
    });
  } catch (err) {
    await deps.log({
      event: "SessionStart",
      outcome: "reconcile_list_failed",
      error: String(err?.message ?? err),
    });
    return;
  }

  const sessions = parseSessionList(listText);
  // Re-read state under lock to capture whichever session was attached
  // (could have been started by either this SessionStart's bootstrap or a
  // concurrent UserPromptSubmit's bootstrap). Anything in the list that
  // isn't ours is a stale active to pause.
  const ourSessionId = await deps.withLock(async () => {
    const s = await deps.loadState();
    return s.session_id;
  });
  const stale = sessions.filter((s) => s.id !== ourSessionId);

  if (stale.length === 0) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_no_active" });
    return;
  }

  // Pause each one. Fail-soft per session — a single 500 shouldn't stop us
  // from pausing the rest.
  let paused = 0;
  for (const s of stale) {
    try {
      await client.callTool("pause_session", {
        session_id: s.id,
        summary: "codex resume reconciliation",
      });
      paused += 1;
    } catch (err) {
      await deps.log({
        event: "SessionStart",
        outcome: "pause_failed",
        session_id: s.id,
        error: String(err?.message ?? err),
      });
    }
  }
  await deps.log({ event: "SessionStart", outcome: "reconciled", paused });
}
