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

  const { signal, matched } = detectPrivacySignal(prompt);

  switch (signal) {
    case "enter-private":
      await goPrivate(deps, { reason: matched });
      return {};
    case "exit-private":
      await goPublic(deps, { reason: matched });
      // Don't bootstrap on the same turn that exits private — the marker
      // turn itself isn't recorded. The next non-marker turn will.
      return {};
    case "toggle": {
      const state = await deps.loadState();
      if (state.private) await goPublic(deps, { reason: "toggle" });
      else await goPrivate(deps, { reason: "toggle" });
      return {};
    }
    case "none":
    default:
      await bootstrapSession(payload, deps).catch(async (err) => {
        // bootstrapSession is itself fail-soft, but belt-and-braces: a
        // thrown error here must never block the turn.
        await deps.log({
          event: "UserPromptSubmit",
          outcome: "bootstrap_threw",
          error: String(err?.message ?? err),
        });
      });
      return {};
  }
}

// Transition to private mode. End any attached session with a neutral reason
// so the dashboard reads "switching to private mode" rather than just
// "ended" with no context. Never throws — privacy must always win.
async function goPrivate(deps, { reason }) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    if (state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_private", matched: reason });
      return;
    }
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
    await deps.log({ event: "UserPromptSubmit", outcome: "entered_private", matched: reason });
  });
}

async function goPublic(deps, { reason }) {
  await deps.withLock(async () => {
    const state = await deps.loadState();
    if (!state.private) {
      await deps.log({ event: "UserPromptSubmit", outcome: "already_public", matched: reason });
      return;
    }
    await deps.saveState({ ...state, private: false });
    await deps.log({ event: "UserPromptSubmit", outcome: "exited_private", matched: reason });
  });
}
