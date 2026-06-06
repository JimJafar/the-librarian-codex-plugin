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
//
// spec 041 A4 — the same single conv_state_get response now carries a
// top-level `primer` string (the operator-authored awareness primer that
// reminds the agent it has durable memory). When non-empty it's emitted as
// a byte-identical <librarian> block ALONGSIDE the conv-state block, from
// the SAME response (no second fetch). The primer block is emitted even
// when there's no conv-state row. Empty primer / parse failure / network
// failure → no block (fail-soft).

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
    // Combine the two blocks from the SINGLE response: conv-state first
    // (per-conversation context), then the global awareness primer floor.
    // Either may be absent — a row without a primer, or a primer with no
    // row (A2's no-row `{ primer }` shape). Nothing → silent `{}`.
    const blocks = [];
    if (parsed.state) blocks.push(renderConvStateBlock(parsed.state));
    const primerBlock = renderAwarenessPrimer(parsed.primer);
    if (primerBlock) blocks.push(primerBlock);
    if (blocks.length === 0) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: blocks.join("\n"),
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

// The MCP client returns conv_state_get's `content[0].text` (a string), but
// callers may pass the raw envelope too — accept both.
//
// A2 made conv_state_get ALWAYS return a JSON object: with a row →
// `{ ...rowFields, primer }`; with no row → `{ primer }` (the old
// "No conversation state…" prose is gone). Always JSON.parse, then split:
//   - `state`  = the row, present ONLY when `conv_id` is a string (else null)
//   - `primer` = the top-level awareness primer when a string (else "")
// A non-object / unparseable payload → null (no block; fail-soft).
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
  if (typeof text !== "string") return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  return {
    state: typeof obj.conv_id === "string" ? obj : null,
    primer: typeof obj.primer === "string" ? obj.primer : "",
  };
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

// Byte-identical with the family-wide canonical <librarian> block (spec 041
// Decision 2). Non-empty primer → exactly three lines, col-0 tags, the
// primer text VERBATIM (NOT indented — it's prose, unlike conv-state's
// 2-space-indented key: value fields), \n-joined. Empty / falsy → "".
export function renderAwarenessPrimer(primer) {
  if (!primer) return "";
  return ["<librarian>", primer, "</librarian>"].join("\n");
}
