// src/source-ref.mjs
// The `source_ref` is the cross-harness primary key for a session — it lets
// the same session hand over cleanly between Codex, Claude Code, and Hermes.
// Per the user's AGENTS.md the Codex form is:
//
//   codex:run:{CODEX_RUN_ID}:cwd:{absolute_path}     when the run id is set
//   cwd:{absolute_path}                              otherwise
//
// The fallback exists because the run id is only available after the first
// API turn — SessionStart fires before that. The cwd-only form is still a
// stable key per project on this machine.

import path from "node:path";

export function buildSourceRef({ cwd, runId }) {
  const absCwd = path.resolve(cwd || process.cwd());
  if (typeof runId === "string" && runId.length > 0) {
    return `codex:run:${runId}:cwd:${absCwd}`;
  }
  return `cwd:${absCwd}`;
}

// Convenience for handlers: pull cwd from the hook payload (Codex passes it
// as a common field) and runId from the env (CODEX_RUN_ID when set).
export function sourceRefFromPayload(payload, env = process.env) {
  return buildSourceRef({
    cwd: payload?.cwd,
    runId: env.CODEX_RUN_ID,
  });
}
