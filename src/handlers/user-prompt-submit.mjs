// src/handlers/user-prompt-submit.mjs
// Task 4 stub. Wired in Task 6 (off-record gate + shared session-bootstrap).
// Always returns {} (allow) — privacy means "stop recording", not "block".

export async function handleUserPromptSubmit(payload, deps) {
  await deps.log({ event: "UserPromptSubmit", prompt_len: (payload?.prompt ?? "").length });
  return {};
}
