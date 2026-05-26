// src/handlers/session-start.mjs
// Fires at session startup, resume, clear, and compact. Task 5 wires the
// `startup` path through the shared bootstrap. The `resume`/`clear` stale-
// active reconciliation lands in Task 9.

import { bootstrapSession } from "./session-bootstrap.mjs";

export async function handleSessionStart(payload, deps) {
  const source = payload?.source ?? null;
  await deps.log({ event: "SessionStart", source });

  // For `startup` and `compact`, ensure a session is attached. `resume` and
  // `clear` need the reconciliation pass first — handled in Task 9.
  if (source === "startup" || source === "compact" || source == null) {
    await bootstrapSession(payload, deps);
  }
  return {};
}
