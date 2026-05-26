// src/handlers/user-prompt-submit.mjs
// Two responsibilities, in this order:
//   1. Privacy gate. Detect off-record markers; flip state.private; end any
//      attached session on enter-private. Never block the turn — privacy
//      means "stop recording", not "stop the model". Always return {}.
//   2. Race-safe session bootstrap. Codex fires SessionStart and
//      UserPromptSubmit simultaneously on the first prompt (openai/codex#15266).
//      We call the shared bootstrap; whichever handler wins the lock starts
//      the session, the loser observes session_id and bails.

import { detectPrivacySignal } from "../privacy-detector.mjs";
import { bootstrapSession } from "./session-bootstrap.mjs";

export async function handleUserPromptSubmit(payload, deps) {
  const prompt = payload?.prompt ?? "";
  await deps.log({ event: "UserPromptSubmit", prompt_len: prompt.length });

  const signal = detectPrivacySignal(prompt);
  if (signal.signal === "enter-private" || signal.signal === "toggle") {
    await applyEnterPrivate(deps, signal);
    return {};
  }
  if (signal.signal === "exit-private") {
    await applyExitPrivate(deps, signal);
    // Don't bootstrap on the same turn that exits private — the user may not
    // want this prompt itself recorded. The next non-marker prompt's
    // UserPromptSubmit (or a SessionStart on resume) will bootstrap.
    return {};
  }

  // Non-marker prompt. Bootstrap if not already attached + not private.
  await bootstrapSession(payload, deps).catch(async (err) => {
    // bootstrapSession is itself fail-soft, but belt-and-braces: a thrown
    // error here must never block the turn.
    await deps.log({ event: "UserPromptSubmit", outcome: "bootstrap_threw", error: String(err?.message ?? err) });
  });
  return {};
}

async function applyEnterPrivate(deps, signal) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    // Toggle in private mode → going public.
    if (signal.signal === "toggle" && state.private) {
      await deps.saveState({ ...state, private: false });
      await deps.log({ event: "UserPromptSubmit", outcome: "exited_private_via_toggle" });
      return;
    }
    if (state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_private" });
      return;
    }
    // Going private. End any attached session with a neutral reason so the
    // dashboard reads "switching to private mode" rather than "ended" with
    // no context.
    if (state.session_id) {
      const client = deps.getClient();
      if (client) {
        try {
          await client.callTool("end_session", {
            session_id: state.session_id,
            summary: "switching to private mode",
          });
        } catch (err) {
          await deps.log({
            event: "UserPromptSubmit",
            outcome: "end_session_failed_during_enter_private",
            error: String(err?.message ?? err),
          });
        }
      }
    }
    await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
    await deps.log({ event: "UserPromptSubmit", outcome: "entered_private", matched: signal.matched });
  });
}

async function applyExitPrivate(deps, signal) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    if (!state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_public", matched: signal.matched });
      return;
    }
    await deps.saveState({ ...state, private: false });
    await deps.log({ event: "UserPromptSubmit", outcome: "exited_private", matched: signal.matched });
  });
}
