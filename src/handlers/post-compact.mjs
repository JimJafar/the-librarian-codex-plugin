// src/handlers/post-compact.mjs
// Task 4 stub. Wired in Task 7 (checkpoint_session on compaction).

export async function handlePostCompact(payload, deps) {
  await deps.log({ event: "PostCompact", trigger: payload?.trigger ?? null });
  return {};
}
