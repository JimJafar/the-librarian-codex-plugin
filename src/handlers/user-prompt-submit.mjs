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
import { sourceRefFromPayload } from "../source-ref.mjs";
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
      return await injectConvState(payload, deps);
  }
}

// Spec §4.9 — fetch the conv-state row for this Codex session and return
// a hookSpecificOutput.additionalContext envelope so the LLM sees the
// current `domain` / `session_id` / `off_record` on every turn (defeats
// context-compaction-driven state loss). On miss / network failure /
// misconfig, returns `{}` — the prompt reaches the model unchanged.
//
// Fail-soft per AGENTS.md §2: every error path logs and returns `{}`.
async function injectConvState(payload, deps) {
  try {
    // House-rule: no MCP call while off-record. The block's `off_record`
    // field can't be the reason we hit the server during privacy mode.
    const state = await deps.loadState();
    if (state?.private) return {};

    const client = deps.getClient();
    if (!client) return {};
    // Codex doesn't expose a stable per-conversation id on the hook
    // payload (CODEX_RUN_ID is set only after the first API turn). We
    // reuse `source_ref` as the conv-id — the cross-harness primary key
    // is stable per Codex run/cwd and is what the session machinery
    // already keys on. Same `codex:run:.../cwd:...` shape, so the
    // dashboard can render it intelligibly.
    const convId = sourceRefFromPayload(payload, deps.env);
    if (!convId) return {};
    let toolResult;
    try {
      toolResult = await client.callTool("conv_state_get", { conv_id: convId });
    } catch (err) {
      await deps.log({
        event: "UserPromptSubmit",
        outcome: "conv_state_lookup_failed",
        error: String(err?.message ?? err),
      });
      return {};
    }
    const parsed = parseConvState(toolResult);
    if (!parsed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderConvStateBlock(parsed),
      },
    };
  } catch (err) {
    await deps.log({
      event: "UserPromptSubmit",
      outcome: "conv_state_inject_threw",
      error: String(err?.message ?? err),
    });
    return {};
  }
}

// The MCP client returns the tool result envelope; conv_state_get's
// `content[0].text` is either "No conversation state for conv_id ..."
// or a JSON-stringified state row. We accept both shapes — clients may
// return the raw text or the unwrapped envelope.
function parseConvState(result) {
  if (!result) return null;
  let text;
  if (typeof result === "string") {
    text = result;
  } else if (result?.content?.[0]?.text) {
    text = result.content[0].text;
  } else if (typeof result?.text === "string") {
    text = result.text;
  } else {
    return null;
  }
  if (typeof text !== "string" || text.startsWith("No conversation state")) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && typeof obj.conv_id === "string" ? obj : null;
  } catch {
    return null;
  }
}

// Byte-identical with the family-wide canonical block (spec §4.9).
function renderConvStateBlock(state) {
  const sessionId = state.session_id ?? "none";
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  domain: ${state.domain}`,
    `  session_id: ${sessionId}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
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
