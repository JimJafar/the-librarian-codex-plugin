---
name: librarian
description: Durable memory + cross-harness session lifecycle. Use whenever you need to start/resume/checkpoint/end a Librarian session, recall or remember facts, or toggle off-record mode.
---

# The Librarian — operating manual for Codex

The Librarian is a remote MCP server that gives every harness (Codex, Claude
Code, Hermes, Pi, …) the **same** memory + session-lifecycle layer:

- **Sessions** bound a piece of work and capture a rolling summary, decisions,
  files touched, commands run, open questions, and next steps. They hand over
  cleanly between harnesses.
- **Memory** (`recall`, `remember`, `propose_memory`, `verify_memory`, …) is
  durable across sessions. Recalls are weighted by usefulness verdicts, so the
  store learns from how you actually use it.

This skill explains how to drive the **eight canonical `/lib:session <verb>`
verbs** (mapped to the eight MCP tools below) and the privacy invariants the
whole system depends on. The full contract lives at
[`docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md).

## Canonical verbs → MCP tools

When the user asks for any of these, call the matching MCP tool. Carry the
returned `session_id` in conversational state — subsequent verbs assume it as
the active session unless the user names another.

| When the user says… | Call this tool | Key args |
| --- | --- | --- |
| "start a session [titled X] [private]" | `start_session` | `title`, `harness: "codex"`, `cwd`, `source_ref` (see below), `visibility: "common"` or `"agent_private"`, `capture_mode: "summary"` |
| "list my sessions [--include-ended]" | `list_sessions` | `project_key` (inferred), `cwd`, `include_ended` (default false). Render as numbered entries; remind the user the numbers are scratch — every later call uses the canonical `session_id`. |
| "resume session [id or number]" | `continue_session` | `session_id`, `target_harness: "codex"`, `target_cwd`, `target_source_ref`, `attach: true`. If bare, do an inline list-and-select. Resume works on `ended` sessions (flips them to `paused`). |
| "checkpoint" | `checkpoint_session` | `session_id`, `summary`, `decisions`, `files_touched`, `commands_run`, `open_questions`, `next_steps`. Build the call yourself — the user didn't type the summary. Keeps session `active`. |
| "pause" | `pause_session` | `session_id`, `summary` (short pause note), `next_steps`. Activity later implicitly resumes the session. |
| "end" / "I'm done" | `end_session` | `session_id`, optional `summary`, `decisions`, `files_touched`, `commands_run`, `open_questions`, `next_steps`, `candidate_memories`. Surface candidate memories as a numbered list — **never auto-promote**. `ended` is not terminal; `resume` brings it back. |
| "search sessions \<query\>" | `search_sessions` | `query`, `project_key` (inferred), `limit: 5`, `include_ended` (default false) |
| "off the record" / "go private" / "back on the record" | **No MCP tool — local hook flips state.** | The plugin's `UserPromptSubmit` hook detects the marker and ends the attached session with reason `"switching to private mode"`. Acknowledge: "now private — recording paused" or "now public — recording resumed". |

`source_ref` for Codex follows
`codex:run:{CODEX_RUN_ID}:cwd:{absolute_path}` when a run id is set,
`cwd:{absolute_path}` otherwise.

## Memory tools (always available, not session-bound)

| When the user says… | Call this tool | Notes |
| --- | --- | --- |
| "what do I/we know about X" | `recall` | Returns the top hits. Use `include_ids: true` so you can verify afterwards. |
| "remember that …" | `remember` | Stores a durable fact. **Protected categories** (identity, relationship) auto-route to `propose_memory` server-side. |
| "propose / I'm not sure about …" | `propose_memory` | Adds a memory in `proposed` state for human approval. |
| "this memory is wrong / out of date" | `update_memory` | Edit in place. |
| (after using a recall hit in an answer) | `verify_memory` | **Mandatory** — see Invariants below. |

## Invariants

**Verify after recall.** Every time you use a recall hit in an answer, call
`verify_memory(memory_id, verdict)` afterwards. Verdicts are a single MCP call
each:

- `useful` — the hit was load-bearing. Boosts rank by 3.
- `not_useful` — distractor or stale framing. Drops rank by 3.
- `outdated` — wrong now. Archives the memory.

The whole memory-quality loop depends on these signals. Don't skip the verdict
because the recall already gave you the answer.

**Privacy is enforced by a hook, not by you.** When the user goes off-record,
the plugin's `UserPromptSubmit` hook ends the session and sets a local private
flag. While private, you must not call `record_session_event`,
`checkpoint_session`, `start_session`, or any other recording tool. `recall`
and `remember` calls **the user explicitly requests** are still allowed — the
gate is about automatic recording, not about blocking the user.

**Capture mode defaults to `summary`.** Never enable `capture_mode: "log"`
without explicit operator request — log captures raw turn content and is
reserved for debugging by the human, not the model.

**Sessions default to `common` visibility.** Before starting a `common`
session, scan the visible context for sensitivity signals (identity claims,
secrets, personal context). If signals are present and the user didn't ask for
`--private`, **confirm before starting**.

**Three-state model.** Sessions are `active | paused | ended`; memories are
`active | proposed | archived`. Retired verbs (`archive`, `restore`, `delete`,
`status`, `confirm_memory`, `reject_memory`) no longer exist.

## Cross-harness handover

The same `source_ref` shape lets Hermes, Claude Code, and Codex see each
other's sessions. `continue_session` accepts a `target_harness` so a Codex
session started here can be resumed in Claude Code (and vice versa) with
exactly the same handover prose.
