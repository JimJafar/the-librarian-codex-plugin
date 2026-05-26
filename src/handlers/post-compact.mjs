// src/handlers/post-compact.mjs
// Codex's compaction is the single most-informative moment in a turn — a
// non-zero chunk of conversation just got summarised. We forward that signal
// to the Librarian as a `checkpoint_session` call so the session's rolling
// summary stays in sync.
//
// No-ops when off-record (privacy invariant) or no session is attached (the
// next bootstrap will create one). Fail-soft on server errors.

export async function handlePostCompact(payload, deps) {
  const trigger = payload?.trigger ?? null;
  await deps.log({ event: "PostCompact", trigger });

  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "PostCompact", outcome: "skipped_private" });
    return {};
  }
  if (!state.session_id) {
    await deps.log({ event: "PostCompact", outcome: "no_session" });
    return {};
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "PostCompact", outcome: "no_client" });
    return {};
  }

  const summary =
    trigger === "manual"
      ? "User triggered conversation compaction; rolling summary continues from here."
      : "Codex auto-compacted the conversation; rolling summary continues from here.";

  try {
    await client.callTool("checkpoint_session", {
      session_id: state.session_id,
      summary,
    });
  } catch (err) {
    await deps.log({ event: "PostCompact", outcome: "checkpoint_failed", error: String(err?.message ?? err) });
    return {};
  }

  // Reset the debounce counters — a fresh checkpoint just landed.
  await deps.withLock(async () => {
    const latest = await deps.loadState();
    await deps.saveState({
      ...latest,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0,
    });
  });
  await deps.log({ event: "PostCompact", outcome: "checkpointed", session_id: state.session_id });
  return {};
}
