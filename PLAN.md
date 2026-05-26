# Implementation Plan: the-librarian-codex-plugin

Companion to [`SPEC.md`](./SPEC.md). Status: **draft, awaiting human approval**
before Phase 3 (Tasks → Implement).

## Overview

Ship a Codex plugin that gives Codex parity with `the-librarian-claude-plugin`:
remote Librarian MCP, an umbrella `@librarian` skill, auto session lifecycle via
hooks, and an off-record privacy gate. Distributed as a GitHub-backed Codex
marketplace until OpenAI opens self-serve publishing.

## Architecture decisions

| Decision | Rationale |
|---|---|
| **One plugin, one umbrella skill, 8 MCP tools** | Codex plugins can't register `/`-style commands. Cribbing per-Codex advice: the SKILL is the operating manual; the verbs are the existing MCP tools the model already has access to. |
| **MCP server registered as `the-librarian`** (namespaced) | Sidesteps any collision with a hand-rolled `[mcp_servers.librarian]` in `~/.codex/config.toml`. Codex namespaces under `plugins.the-librarian.mcp_servers.the-librarian` anyway. |
| **Node 20+ hooks, bundled with esbuild** | Mirrors the Claude plugin; lifts large chunks of `bin/librarian-claude-hook.js` verbatim. Codex exposes `CLAUDE_PLUGIN_ROOT` as a compat alias for `PLUGIN_ROOT`, so the dispatch.sh is portable. |
| **Hook entrypoint is a single bundled JS, routed by `hook_event_name`** | One file to bundle, one to validate; matches the Claude plugin's `librarian-claude-hook.js` shape. |
| **State persisted to `${PLUGIN_DATA}/state.json`** with atomic rename | Single source of truth for attached `session_id`, `private` flag, `last_checkpoint_at`, `turns_since_checkpoint`. Atomic writes resolve the SessionStart/UserPromptSubmit race (see below). |
| **Fail-soft everywhere** | A Librarian outage degrades to a no-op log line; no hook ever blocks a turn or returns non-zero. Same invariant as the Hermes provider. |
| **No SessionEnd faking** | Reconcile stale active sessions on next `SessionStart(source=resume)` instead. |

## Open questions — resolved

### Q1. Does the Codex desktop app honour the same plugin loader as the CLI?

**Decision: verify empirically as Task 1 (risk-first).** Evidence is strong it
does — `~/.codex/config.toml` already contains `[plugins."<name>@<marketplace>"]`
entries for the bundled OpenAI plugins (`documents`, `browser`, `github`, …) and
the desktop app reads from `~/.codex/plugins/cache/` — but we don't ship anything
else until a hello-world install proves it.

### Q2. `SessionStart` + `UserPromptSubmit` race on first prompt (openai/codex#15266)

**Decision: idempotent state writes.** Both handlers share one code path that:

1. Reads `state.json`.
2. If `state.session_id` is set → no-op.
3. Otherwise, calls `start_session`, then writes `state.json` via atomic
   rename (`write tmp → rename`). On rename collision (other handler won),
   re-read and discard our `session_id` with `end_session(reason: "duplicate")`.

This makes the race a benign double-start that self-heals within one turn.
Documented in `src/handlers/session-bootstrap.mjs` and covered by a test that
runs both handlers concurrently.

### Q3. `Stop`-event checkpoint frequency

**Decision: per-turn event, debounced checkpoint.**

- **Every `Stop`** → `record_session_event` with `type: "message"` and a
  one-sentence summary of `last_assistant_message` (matches the Hermes provider's
  `sync_turn` shape and the recent `fix-sync-turn-event-type` work in
  hermes-plugin). Cheap; this is what makes recording "automatic."
- **`checkpoint_session`** fires only when one of:
  - `PostCompact` fires (always — compaction is the most informative moment), OR
  - ≥ 10 minutes have elapsed since `state.last_checkpoint_at`, OR
  - ≥ 20 `record_session_event` calls since the last checkpoint.

Thresholds live in `src/handlers/checkpoint-policy.mjs` as named constants so
they can be tuned without touching handlers.

### Q4. Stale-active reconciliation on resume

**Decision: pause-then-continue on `SessionStart(source=resume)`.**

On a `resume` (or `clear`) source, the handler:

1. Calls `list_sessions({ source_ref: <current>, status: "active" })`.
2. For each returned session, calls `pause_session({ session_id, reason: "codex resume reconciliation" })`.
3. Then either continues the named session (if `state.session_id` matches one)
   or starts a fresh one.

This makes hard exits safe at the cost of one extra MCP call per resume.

### Q5. `@librarian` SKILL.md scope

**Decision: tight, ≤120 lines, three sections.**

1. **What it is** — one paragraph linking to the-librarian repo and explaining
   that this skill instructs the model to drive the bundled MCP tools.
2. **Canonical verb table** — 8 rows: verb → tool → args → when. Mirrors
   `docs/slash-commands.md` but rephrased as model-facing instructions.
3. **Invariants** — verify-after-recall, privacy ("if the user says off the
   record, don't call record_session_event"), capture_mode summary default.

Verification: a model with only this skill in context should be able to satisfy
the 9 success criteria from SPEC.md without further prompting.

### Q6. Marketplace JSON shape

**Decision: crib from `~/.codex/.tmp/bundled-marketplaces/openai-bundled/`.**
Task 0 reads one of the bundled marketplace files to lock down the real schema
(category, `policy.installation`, `policy.authentication`, capabilities array,
brand fields), then we author ours to match.

## Dependency graph

```
Task 0: Read bundled marketplace + decide shape
   │
Task 1: Hello-world plugin (manifest only, no hooks) ──── verifies Codex desktop loader
   │
   ├── Task 2: .mcp.json + remote MCP verification
   │       │
   │       └── Task 3: @librarian SKILL.md
   │
   ├── Task 4: Hook scaffolding (dispatch.sh, bin/, esbuild, state store)
   │       │
   │       ├── Task 5: source_ref + SessionStart handler (auto-start)
   │       │       │
   │       │       └── Task 6: Privacy detector + UserPromptSubmit handler
   │       │               │
   │       │               └── Task 7: PostCompact checkpoint
   │       │                       │
   │       │                       └── Task 8: Stop handler (per-turn event + debounced checkpoint)
   │       │                               │
   │       │                               └── Task 9: SessionStart(resume) stale-active reconciliation
   │
   └── Task 10: validate.mjs (manifest + hooks.json + marketplace.json shape)
           │
           └── Task 11: smoke.mjs (mock Librarian, all four event paths)
                   │
                   └── Task 12: README + LICENSE + .gitignore + package.json
                           │
                           └── Task 13: Marketplace publish (push to GitHub, document install)
```

Vertical slices: Tasks 2+3 are an independently-shippable MVP (MCP + skill, no
hooks). Tasks 4–9 layer on automatic lifecycle. Tasks 10–13 are ship-readiness.

## Task list

### Phase 1: Foundation + risk-front-loading

#### Task 0: Inspect bundled marketplaces

**Description:** Read OpenAI's shipped marketplace files at
`~/.codex/.tmp/bundled-marketplaces/openai-bundled/` and the runtime marketplace
at `~/.cache/codex-runtimes/codex-primary-runtime/plugins/`. Document the real
JSON schema for marketplace entries — required vs optional fields, plugin
metadata fields (`category`, `policy.*`, `capabilities`, `displayName`,
`shortDescription`, brand fields), and source-type discriminators.

**Acceptance:**
- A `notes/marketplace-shape.md` file in this repo capturing one full real entry
  and a per-field commentary.
- All fields used by the bundled marketplaces are catalogued; the ones we'll
  populate are starred.

**Verification:** Manual diff against the `Build a plugin` docs page — flag any
field present in the bundled file but absent from the docs.

**Files touched:** `notes/marketplace-shape.md` (new).

**Scope:** XS. Pure reading + a note file.

#### Task 1: Hello-world plugin install

**Description:** Ship a single-skill plugin (no hooks, no MCP) and install it
in the local Codex desktop app via `codex plugin marketplace add file://$(pwd)`.
Proves the desktop loader honours the documented plugin layout before we build
anything against it.

**Acceptance:**
- `.codex-plugin/plugin.json` with `name: "the-librarian"`, `version: "0.1.0"`.
- `skills/librarian/SKILL.md` with placeholder content ("Hello from
  the-librarian-codex-plugin").
- `.agents/plugins/marketplace.json` referencing this plugin as a local source.
- Plugin appears in the Codex app's Plugins UI and the `@librarian` skill is
  invocable.

**Verification:**
- `codex plugin marketplace add file:///Users/jim/code/the-librarian-codex-plugin` succeeds.
- `codex plugin install the-librarian@the-librarian-codex-local` succeeds.
- Restart Codex, type `@librarian` — the placeholder skill content surfaces.
- Inspect `~/.codex/config.toml`: a `[plugins."the-librarian@..."]` entry was added.

**Files touched:** `.codex-plugin/plugin.json`, `skills/librarian/SKILL.md`,
`.agents/plugins/marketplace.json`.

**Scope:** S. **Risk-front-loaded.** If this fails, the entire plan changes.

#### Task 2: Bundle the remote MCP server

**Description:** Add `.mcp.json` declaring `the-librarian` as an HTTP MCP server
pointing at `${LIBRARIAN_MCP_URL}` with the bearer token from
`${LIBRARIAN_AGENT_TOKEN}`. Verify the 11+ Librarian tools show up in
Codex's `/mcp` listing.

**Acceptance:**
- `.mcp.json` matches the Claude plugin's shape but uses `the-librarian` as the
  server name.
- Manifest's `mcpServers` pointer wired to `./.mcp.json`.
- README placeholder section listing the two required env vars.

**Verification:**
- `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN` exported in shell; restart Codex.
- `/mcp` lists `the-librarian` and includes `recall`, `remember`,
  `start_session`, etc. (≥ 11 tools).
- Call `recall("test")` from inside Codex — receives a real response.

**Files touched:** `.mcp.json`, `.codex-plugin/plugin.json` (mcpServers
pointer), `README.md` (stub).

**Scope:** S. Depends on Task 1.

#### Task 3: `@librarian` SKILL.md

**Description:** Replace the placeholder skill body with the production version:
the three-section structure from Open Question 5. Includes the canonical verb
table and the privacy + verify-after-recall invariants.

**Acceptance:**
- `skills/librarian/SKILL.md` ≤ 120 lines.
- Each of the 8 verbs maps to its MCP tool with example arguments.
- Privacy and verify-after-recall invariants stated explicitly.
- References `docs/slash-commands.md` in the-librarian as canonical contract.

**Verification:**
- Render the skill in Codex and ask: "start a private librarian session titled
  `codex plugin spec`." Model calls `start_session({title: "codex plugin
  spec", visibility: "agent_private"})`.
- Ask: "list my sessions." Model calls `list_sessions({})`.
- Ask: "remember that I prefer Node over Python for hooks." Model calls
  `propose_memory` or `remember` per the protected-categories rule.

**Files touched:** `skills/librarian/SKILL.md`.

**Scope:** S. Depends on Task 2.

### Checkpoint A: MVP (Tasks 0–3)

- [ ] Plugin installs from local path in Codex desktop.
- [ ] `@librarian` skill is discoverable and instructs the model correctly.
- [ ] All 11+ Librarian MCP tools are callable from Codex.
- [ ] No hooks yet — sessions are still created manually by the model on user
      request, not automatically.
- [ ] **Review with human before proceeding to Phase 2.**

### Phase 2: Automatic session lifecycle

#### Task 4: Hook scaffolding (no event logic yet)

**Description:** Stand up the hook pipeline: `hooks/hooks.json` routing all four
events to `scripts/dispatch.sh`, which exec's a single bundled
`bin/librarian-codex-hook.js`. Includes the build pipeline (esbuild),
`librarian-mcp-call.js` (lifted from Claude plugin), the state store
(`src/state-store.mjs`) with atomic writes, and a no-op handler that logs the
event name to `${PLUGIN_DATA}/log.jsonl`.

**Acceptance:**
- `package.json` with `build`, `validate`, `smoke`, `test` scripts.
- `scripts/build-bundle.mjs` esbuild config.
- `scripts/dispatch.sh` reads stdin, sets env, exec's node.
- `bin/librarian-codex-hook.js` bundled and committed (so end-users don't run
  `npm install`).
- `bin/librarian-mcp-call.js` bundled and committed.
- `src/state-store.mjs` with `loadState`, `saveState` (atomic), `withLock`.
- `hooks/hooks.json` registers `SessionStart`, `UserPromptSubmit`,
  `PostCompact`, `Stop` → `dispatch.sh`.
- Approve all four hooks in Codex via `/hooks`.

**Verification:**
- `npm run build` succeeds.
- Reinstall the plugin in Codex; `/hooks` lists the four entries.
- Approve all four; type a prompt; `${PLUGIN_DATA}/log.jsonl` has one
  `UserPromptSubmit` entry and one `Stop` entry.
- `node --test tests/state-store.test.mjs` passes (atomic write under contention).

**Files touched:** `package.json`, `.gitignore`, `scripts/build-bundle.mjs`,
`scripts/dispatch.sh`, `src/state-store.mjs`, `src/log.mjs`,
`bin/librarian-codex-hook.js`, `bin/librarian-mcp-call.js`,
`hooks/hooks.json`, `tests/state-store.test.mjs`.

**Scope:** M (~7 files). Foundational — every later task builds on this.

#### Task 5: `SessionStart` handler — auto-start

**Description:** Implement `source_ref` builder (`codex:run:{run_id}:cwd:{abs}`
with `cwd:` fallback) and the `SessionStart` bootstrap logic. On
`source: "startup"`, if `state.session_id` is null, call `start_session` and
persist. Idempotent under the race with `UserPromptSubmit`.

**Acceptance:**
- `src/source-ref.mjs` with 100% test coverage.
- `src/handlers/session-bootstrap.mjs` callable from both SessionStart and
  UserPromptSubmit handlers.
- `start_session` is called with `harness: "codex"`, the computed `source_ref`,
  `visibility: "common"`, `capture_mode: "summary"`, and a `start_summary`
  derived from `cwd` basename + the user's first prompt if available.
- Atomic state write resolves the race; concurrent test passes.

**Verification:**
- `node --test tests/source-ref.test.mjs tests/session-bootstrap.test.mjs` passes.
- Reinstall plugin in a fresh project dir; first prompt creates exactly one
  session on the Librarian dashboard with the expected `source_ref`.
- Second prompt does NOT create another session.

**Files touched:** `src/source-ref.mjs`, `src/handlers/session-start.mjs`,
`src/handlers/session-bootstrap.mjs`, `bin/librarian-codex-hook.js` (re-bundle),
`tests/source-ref.test.mjs`, `tests/session-bootstrap.test.mjs`.

**Scope:** M.

#### Task 6: `UserPromptSubmit` — off-record gate

**Description:** Port the Hermes privacy detector (`privacy.py`) to
`src/privacy-detector.mjs`. Wire to the `UserPromptSubmit` handler:
detect enter/exit signals, call `end_session` on entering private mode, flip
`state.private`. Always return `{}` (allow — privacy never blocks the turn).
Also calls the shared `session-bootstrap` for the auto-start race path.

**Acceptance:**
- `src/privacy-detector.mjs` with the same test matrix as
  `tests/test_privacy.py` in hermes-plugin (port the test fixtures
  verbatim).
- Handler returns `{}` always; on "off the record" detection, the attached
  session is ended within the same turn.
- Subsequent prompts while `state.private` is true cause NO `record_session_event`
  calls in the Stop handler.

**Verification:**
- `node --test tests/privacy-detector.test.mjs` passes (same fixtures as hermes).
- Manual: type "off the record — what's my password manager strategy?" in Codex.
  Session ends on the dashboard. Type a follow-up. No new session events.
  Type "back on the record." Next prompt auto-starts a fresh session.

**Files touched:** `src/privacy-detector.mjs`, `src/handlers/user-prompt-submit.mjs`,
`bin/librarian-codex-hook.js` (re-bundle), `tests/privacy-detector.test.mjs`.

**Scope:** M.

#### Task 7: `PostCompact` — checkpoint on compaction

**Description:** On `PostCompact`, if `state.session_id` is set and not private,
call `checkpoint_session` with a summary derived from the post-compaction
context. Update `state.last_checkpoint_at`.

**Acceptance:**
- `src/handlers/post-compact.mjs` calls `checkpoint_session({session_id,
  summary})`.
- `state.last_checkpoint_at` updated atomically.
- No-op when off-record or no attached session.

**Verification:**
- Manual: trigger a compaction in Codex; the session on the dashboard shows
  an updated `rolling_summary` within one turn.
- Smoke test asserts the call.

**Files touched:** `src/handlers/post-compact.mjs`,
`bin/librarian-codex-hook.js` (re-bundle), `tests/post-compact.test.mjs`.

**Scope:** S.

#### Task 8: `Stop` — per-turn event + debounced checkpoint

**Description:** On `Stop`, if not private and a session is attached:

1. Call `record_session_event({session_id, type: "message", summary})`
   with `summary` derived from `last_assistant_message` (≤ 280 chars).
2. Increment `state.turns_since_checkpoint`.
3. Apply the debounced checkpoint policy (Open Question 3): if ≥ 10 min OR
   ≥ 20 turns since last checkpoint, call `checkpoint_session`.

**Acceptance:**
- `src/handlers/stop.mjs` implements step 1–3.
- `src/handlers/checkpoint-policy.mjs` exposes
  `shouldCheckpoint(state, now)` returning a boolean.
- Constants `CHECKPOINT_MIN_INTERVAL_MS` (600_000) and
  `CHECKPOINT_MAX_TURNS` (20) live in checkpoint-policy.mjs.
- Off-record: no `record_session_event` call.

**Verification:**
- `node --test tests/checkpoint-policy.test.mjs` covers the OR-of-conditions
  matrix.
- Manual: drive 5 turns over 1 minute → 5 message events, 0 checkpoints.
  Drive a 21st turn → checkpoint fires.

**Files touched:** `src/handlers/stop.mjs`, `src/handlers/checkpoint-policy.mjs`,
`bin/librarian-codex-hook.js` (re-bundle), `tests/checkpoint-policy.test.mjs`,
`tests/stop-handler.test.mjs`.

**Scope:** M.

#### Task 9: `SessionStart(source=resume)` reconciliation

**Description:** Extend the SessionStart handler. On `source: "resume"` or
`"clear"`: call `list_sessions({source_ref, status: "active"})`,
`pause_session` each result with `reason: "codex resume reconciliation"`,
then proceed with the normal bootstrap (which will start a new session because
no active ones remain).

**Acceptance:**
- `src/handlers/session-start.mjs` branches on `source`.
- All previously-active sessions for this `source_ref` are paused before a new
  one starts.
- `compact` source is treated like `startup` (no reconciliation — the session
  continues).

**Verification:**
- Manual: start a session, force-kill Codex (`kill -9` the app), restart, send
  a prompt. The Librarian dashboard shows the old session as `paused` and a
  new session as `active`.

**Files touched:** `src/handlers/session-start.mjs` (extend),
`bin/librarian-codex-hook.js` (re-bundle), `tests/session-start-resume.test.mjs`.

**Scope:** S.

### Checkpoint B: Automatic lifecycle (Tasks 4–9)

- [ ] First prompt in a fresh project starts a session automatically.
- [ ] "off the record" ends the session and suppresses recording until cleared.
- [ ] PostCompact triggers a checkpoint with updated rolling_summary.
- [ ] Per-turn message events appear in the session.
- [ ] Stale active sessions are reconciled to paused on resume.
- [ ] All unit tests pass; smoke test passes.
- [ ] **Review with human before Phase 3.**

### Phase 3: Ship-readiness

#### Task 10: validate.mjs

**Description:** Build the manifest/hooks/marketplace shape validator (port
from Claude plugin's `scripts/validate.mjs`). Checks: required fields,
kebab-case `name`, semver `version`, all hook commands resolvable, no
unbundled deps in `bin/*.js`.

**Acceptance:**
- `npm run validate` exits 0 on a valid repo, non-zero with a clear error on
  a broken one.
- A pre-commit hook (optional) wires this to lefthook / similar.

**Verification:**
- Deliberately break the manifest (drop `version`); validator reports it.
- Repair; validator passes.

**Files touched:** `scripts/validate.mjs`.

**Scope:** S.

#### Task 11: smoke.mjs

**Description:** Build a mock Librarian HTTP server (express, in-script) that
responds to the MCP tools we use. The smoke script:

1. Starts the mock on `localhost:PORT`.
2. Sets `LIBRARIAN_MCP_URL=http://localhost:PORT/mcp` +
   `LIBRARIAN_AGENT_TOKEN=test`.
3. Pipes synthetic Codex hook payloads (`SessionStart startup`,
   `UserPromptSubmit`, `Stop`, `PostCompact`, `SessionStart resume`) into the
   built `bin/librarian-codex-hook.js`.
4. Asserts the right MCP tool calls happened with the right args.

**Acceptance:**
- `npm run smoke` exits 0 on green.
- Each of the four hook event paths is exercised.
- The resume reconciliation path is exercised.

**Verification:**
- CI-equivalent local run: `npm ci && npm run build && npm test && npm run validate && npm run smoke` is a green pipeline.

**Files touched:** `scripts/smoke.mjs`, `tests/fixtures/*.json`.

**Scope:** M.

#### Task 12: README + LICENSE + .gitignore + package.json polish

**Description:** Final user-facing docs. Mirror the Claude plugin's README
structure (what it does, install, configure, slash commands → **skill +
tools**). Apache-2.0 license. .gitignore for `node_modules/`, `*.log`,
`${PLUGIN_DATA}` artifacts. PROVENANCE.json in bin/ with source SHA + esbuild
version + build date.

**Acceptance:**
- README has install one-liner, env var table, "what it does" section, a
  troubleshooting section for `/hooks` approval, and a link to the canonical
  contract.
- LICENSE present (Apache-2.0).
- `bin/PROVENANCE.json` regenerated by the build script.

**Verification:**
- Fresh-eyes read: a teammate who has never seen The Librarian can install
  the plugin from README alone.

**Files touched:** `README.md`, `LICENSE`, `.gitignore`, `package.json`,
`scripts/build-bundle.mjs` (PROVENANCE step).

**Scope:** S.

#### Task 13: Publish

**Description:** Push the repo to `github.com/JimJafar/the-librarian-codex-plugin`,
tag `v0.1.0`, document the install path for users. Optionally cross-check the
marketplace JSON with `@plugin-creator` as a sanity pass.

**Acceptance:**
- Repo public at the canonical URL.
- README install instructions work end-to-end on a clean Codex install (test
  by uninstalling the local-source version and installing from GitHub).
- v0.1.0 tag points at a commit where all checkpoints pass.

**Verification:**
- `codex plugin marketplace add JimJafar/the-librarian-codex-plugin` on this
  machine after removing the `file://` source works.
- `codex plugin install the-librarian@…` succeeds.
- Auto-session-start works end-to-end.

**Files touched:** None code-side; this is a publish + verify step.

**Scope:** S.

### Checkpoint C: Shipped

- [ ] All success criteria from SPEC.md satisfied.
- [ ] `codex plugin marketplace add JimJafar/the-librarian-codex-plugin` works.
- [ ] README is sufficient for a new user.
- [ ] PR'd and merged (no direct-to-main push, per user CLAUDE.md).

## Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Codex desktop app honours a different plugin loader than the CLI docs describe | High | Medium | **Task 1 fails fast.** If it does, we adapt the manifest format before building any of Phase 2. |
| `SessionStart` and `UserPromptSubmit` race produces duplicate sessions ([#15266](https://github.com/openai/codex/issues/15266)) | Medium | High (on first prompt) | Atomic state writes + idempotent bootstrap (Task 5). Concurrent test in `tests/session-bootstrap.test.mjs`. |
| `/hooks` trust UX confuses users on first install | Low | High | README has a dedicated section showing the four hashes to approve and the `/hooks` command. |
| Codex updates the plugin schema and breaks us | Medium | Medium | Pin the spec date in README (`Built against the Codex plugin spec as of May 2026`). Validator (Task 10) catches breakages in CI. |
| Mock Librarian (smoke) drifts from real server | Medium | Medium | Smoke uses real tool names and arg names; treat any prod failure of the mock test path as a smoke-spec gap. Manual install loop is the regression backstop. |
| `Stop`-event-per-turn floods the Librarian with low-value events | Low | Medium | Summary mode + 280-char cap + the model receives no further prompting. The Librarian server already handles this load from Claude/Hermes. |
| `PLUGIN_DATA` not writable on first run (cold start) | Low | Low | `loadState` creates the dir on demand; `saveState` retries once on ENOENT. |
| Off-record detector false-positive ends a session unintentionally | Medium | Low | Port the hermes test fixtures verbatim; require the marker to be at sentence start / explicit phrase, never inside code blocks. |

## Open questions (deferred to implementation)

- **Plugin display metadata** (`displayName`, `category`, `brandColor`,
  `composerIcon`, `logo`, `screenshots`): defer until Task 12 (README) — we'll
  copy the Claude plugin's branding then.
- **Optional marketplace category:** "memory" vs "developer-tools" vs "agents".
  Decide once we see what the bundled marketplaces use (Task 0).
- **Whether to also publish to the `~/.agents/plugins/marketplace.json`
  personal-marketplace path** as an alternate install route: probably yes, but
  it's a one-liner in README. Defer.

## Parallelization

If we ever want to fan this out across multiple sessions:

- **Safe to parallelize:** Tasks 0 + 1 (read inspection + manifest); Tasks 10
  + 12 (validator + README) after Phase 2 lands; Task 11 (smoke) can run in
  parallel with Tasks 7–9 once Task 5 lands.
- **Must be sequential:** Tasks 4 → 5 → 6 → 7 → 8 → 9 (each layers on shared
  state).
- **Needs coordination:** None — single-repo, single-author.

Realistically a single-session sequential pass is faster than coordinating
parallel work.
