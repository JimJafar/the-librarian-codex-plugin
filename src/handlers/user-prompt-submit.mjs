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
// "ended" with no context. Never throws — privacy must always win. If the
// lock cannot be acquired (timeout under heavy contention), we fall back to
// a best-effort unlocked write so the off-record marker is never silently
// dropped. Worst-case bias is "we recorded too little", never "we recorded
// after the user said don't".
async function goPrivate(deps, { reason }) {
  try {
    await deps.withLock(async () => {
      const state = await deps.loadState();
      if (state.private) {
        await deps.log({ event: "UserPromptSubmit", outcome: "already_private", matched: reason });
        return;
      }
      await endAttachedSessionIfAny(state, deps);
      await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
      await deps.log({ event: "UserPromptSubmit", outcome: "entered_private", matched: reason });
    });
  } catch (err) {
    // Lock-acquisition failure (timeout, fs error). Privacy invariant beats
    // atomicity: write the private flag without the lock, end any session
    // we know about, log loudly.
    await deps.log({
      event: "UserPromptSubmit",
      outcome: "lock_failed_during_enter_private_falling_back",
      error: String(err?.message ?? err),
    });
    try {
      const state = await deps.loadState();
      await endAttachedSessionIfAny(state, deps);
      await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
    } catch (err2) {
      await deps.log({
        event: "UserPromptSubmit",
        outcome: "fallback_save_failed",
        error: String(err2?.message ?? err2),
      });
    }
  }
}

async function endAttachedSessionIfAny(state, deps) {
  if (!state.session_id) return;
  const client = deps.getClient();
  if (!client) return;
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

async function goPublic(deps, { reason }) {
  try {
    await deps.withLock(async () => {
      const state = await deps.loadState();
      if (!state.private) {
        await deps.log({ event: "UserPromptSubmit", outcome: "already_public", matched: reason });
        return;
      }
      await deps.saveState({ ...state, private: false });
      await deps.log({ event: "UserPromptSubmit", outcome: "exited_private", matched: reason });
    });
  } catch (err) {
    // Symmetry with goPrivate, but the bias here is opposite: a failed
    // exit-private leaves us private, which is the SAFER outcome. We still
    // try the unlocked write so the user isn't trapped in private mode.
    await deps.log({
      event: "UserPromptSubmit",
      outcome: "lock_failed_during_exit_private_falling_back",
      error: String(err?.message ?? err),
    });
    try {
      const state = await deps.loadState();
      if (state.private) await deps.saveState({ ...state, private: false });
    } catch {
      /* user can retry with another marker; logging done above */
    }
  }
}
