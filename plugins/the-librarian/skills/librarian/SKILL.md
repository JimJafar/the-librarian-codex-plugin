---
name: librarian
description: Durable memory + cross-harness handoffs for Codex. Use whenever you need to recall or remember facts, hand off work to another agent, take over a handoff, extract durable lessons from a conversation, or toggle in-conversation private mode.
---

# The Librarian — operating manual for Codex

The Librarian is a remote MCP server that gives every harness (Codex,
Claude Code, Hermes, Pi, …) the same memory and handoff layer:

- **Memory** — `recall`, `remember`, `propose_memory`, `verify_memory`,
  `update_memory`. Durable across conversations; recall is weighted by
  usefulness verdicts so the store learns from how you use it.
- **Handoffs** — `store_handoff`, `list_handoffs`, `claim_handoff`.
  Self-contained narrative documents that the next agent (any harness)
  atomically claims and continues from.

The legacy session subsystem (start_session, checkpoint, pause, resume,
…) is retired. The four user-facing verbs below replace it.

## Four user-facing verbs

When the user asks for any of these, do the work directly — there is no
slash command surface; the LLM is the interface.

### `/handoff` (the user says "hand this off", "we're done for now", …)

1. Check the most recent `[librarian:private=on|off]` marker. If `on`,
   ask the user to confirm explicitly. Abort on no.
2. Author a five-section document and persist via `store_handoff`. The
   five headings are part of the contract and are validated server-side:
   - `## Start & intent`
   - `## Journey`
   - `## Current state`
   - `## What's left`
   - `## Open questions`
3. Carry these args: `title` (≤ 80 chars), `document_md`, `project_key`
   (inferred), `cwd`, `harness: "codex"`, `source_ref` (see below),
   optional `tags`.
4. Report the `handoff_id` and tell the user to `/takeover` in any agent
   on the same cwd.

### `/takeover` (the user says "pick up where I left off", "what was I doing", …)

1. Call `list_handoffs` with the current `project_key` and `cwd`. If
   empty, broaden by dropping `harness`, then `cwd`, then `project_key`.
2. Present candidates (title, source harness, age, tags) numbered. Ask
   the user to pick one.
3. Call `claim_handoff` with the chosen `handoff_id`. On 200, inject
   the returned `document_md` as system context and continue from there.
   On `error: "already_claimed"`, surface the existing claim. On
   `error: "not_found"`, offer to re-list.

### `/learn` (the user says "save what we learned", "remember the X pattern", …)

1. Check the private marker — same gate as `/handoff`.
2. Find durable facts in the conversation: user facts ("user is X"),
   project facts, validated patterns the user confirmed, explicit user
   corrections.
3. Present as a numbered multi-select list. Ask which to keep.
4. For each chosen lesson, call `propose_memory` (not `remember`) with
   `title`, `body`, `tags`, `applies_to`.

### `/toggle-private` (the user says "go private", "back on the record", …)

Pure in-conversation. Inject a system message announcing the new state
and include the canonical marker so the LLM (and any compaction
fallback) sees it:

- ON: `Private mode is ON. [librarian:private=on] — do not call remember or propose_memory until told otherwise. Recall is still allowed. /handoff and /learn require explicit confirmation. Remain in this state until explicitly toggled off.`
- OFF: `Private mode is OFF. [librarian:private=off] — normal operation resumed.`

No MCP call, no server flag, no hook.

## Memory tools

| User says… | Call | Notes |
| --- | --- | --- |
| "what do I know about X" | `recall` | Use `include_ids: true` so you can `verify_memory` afterwards. |
| "remember that …" | `remember` | Protected categories (identity, relationship) auto-route to a proposal. |
| "propose / I'm not sure about …" | `propose_memory` | Adds in `proposed` state for human approval. |
| "this memory is wrong" | `update_memory` | Edit in place. |
| (after using a recall hit in an answer) | `verify_memory` | **Mandatory** — see Invariants. |

## Invariants

**Verify after recall.** Every time you use a recall hit in an answer,
call `verify_memory(memory_id, verdict)` afterwards. Verdicts:

- `useful` — load-bearing in the answer. Boosts rank by 3.
- `not_useful` — distractor or stale framing. Drops rank by 3.
- `outdated` — wrong now. Archives the memory.

The whole memory-quality loop depends on these signals. Don't skip the
verdict because the recall already gave you the answer.

**Private mode is in-conversation only.** While `[librarian:private=on]`
is the most recent marker, you must not call `remember` or
`propose_memory`. `recall` is still allowed. `/handoff` and `/learn`
require explicit user confirmation. Compaction can drop the marker —
documented limitation; default falls back to OFF.

**Three-state memory model.** Memories are `active | proposed |
archived`. Proposals are accepted / rejected via the dashboard or
`update_memory`; deletion is `archive_memory`.

**`source_ref` for Codex** is
`codex:run:{CODEX_RUN_ID}:cwd:{absolute_path}` when a run id is set,
`cwd:{absolute_path}` otherwise.

## Cross-harness handover

The same `source_ref` shape lets Hermes, Claude Code, Codex, OpenCode,
and Pi share the same handoff and memory store. A handoff stored from
Codex can be claimed by Claude Code (and vice versa) in the same cwd.
