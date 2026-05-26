// src/handlers/session-start.mjs
// Task 4 stub. Wired in Task 5 (auto-start) and extended in Task 9 (resume
// reconciliation). For now: just record that the event was seen.

export async function handleSessionStart(payload, deps) {
  await deps.log({ event: "SessionStart", source: payload?.source ?? null });
  return {};
}
