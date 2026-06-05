// src/handlers/user-prompt-submit.mjs
//
// sessions-rethink PR 3 — the handler's only remaining job is conv-state
// injection (spec §4.9). Privacy gating, session bootstrap, and the
// natural-language private detector are all retired.
//
// Fetch the conv-state row keyed by the Codex run's source_ref and, when
// present, emit a `hookSpecificOutput.additionalContext` envelope so the
// LLM sees the current `conv_id` / `off_record` on every
// turn (defeats context-compaction-driven state loss). On miss / network
// failure / misconfig, return `{}` — the prompt reaches the model
// unchanged. Fail-soft per AGENTS.md §2.

import { sourceRefFromPayload } from "../source-ref.mjs";

export async function handleUserPromptSubmit(payload, deps) {
  const prompt = payload?.prompt ?? "";
  await deps.log({ event: "UserPromptSubmit", prompt_len: prompt.length });
  return await injectConvState(payload, deps);
}

async function injectConvState(payload, deps) {
  try {
    const client = deps.getClient();
    if (!client) return {};
    // Codex doesn't expose a stable per-conversation id on the hook
    // payload (CODEX_RUN_ID is set only after the first API turn). We
    // reuse `source_ref` as the conv-id — stable per Codex run/cwd and
    // matches what the dashboard renders.
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
// or a JSON-stringified state row. Accept both shapes.
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
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}
