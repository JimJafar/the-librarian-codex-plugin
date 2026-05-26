// src/handlers/session-start.mjs
// Codex's SessionStart fires four ways, distinguished by `source`:
//   - "startup": fresh process. Bootstrap a session if none is attached.
//   - "compact": post-compaction restart. Treated like startup (PostCompact
//     itself handles the checkpoint).
//   - "resume": user explicitly resumed. There MAY be a stale `active`
//     session for this source_ref on the server (no SessionEnd hook means
//     a hard exit leaves one). Pause it before bootstrapping a new one.
//   - "clear": context was cleared. Same as resume — reconcile, then start
//     fresh.

import { bootstrapSession } from "./session-bootstrap.mjs";
import { sourceRefFromPayload } from "../source-ref.mjs";
import { parseSessionList } from "../mcp-parse.mjs";

const RECONCILE_SOURCES = new Set(["resume", "clear"]);

export async function handleSessionStart(payload, deps) {
  const source = payload?.source ?? null;
  await deps.log({ event: "SessionStart", source });

  if (RECONCILE_SOURCES.has(source)) {
    await reconcileStaleActive(payload, deps);
  }
  await bootstrapSession(payload, deps);
  return {};
}

async function reconcileStaleActive(payload, deps) {
  // Off-record: nothing to reconcile (we wouldn't have started a session
  // anyway). No-client: can't reach the server — fail-soft.
  const state = await deps.loadState();
  if (state.private) {
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
  if (sessions.length === 0) {
    await deps.log({ event: "SessionStart", outcome: "reconcile_no_active" });
    return;
  }

  // Pause each one. Fail-soft per session — a single 500 shouldn't stop us
  // from pausing the rest.
  let paused = 0;
  for (const s of sessions) {
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

  // If state.session_id pointed at one of the just-paused sessions, clear it
  // so the bootstrap that follows opens a fresh session.
  if (state.session_id && sessions.some((s) => s.id === state.session_id)) {
    await deps.withLock(async () => {
      const latest = await deps.loadState();
      await deps.saveState({ ...latest, session_id: null, source_ref: null });
    });
  }
  await deps.log({ event: "SessionStart", outcome: "reconciled", paused });
}
