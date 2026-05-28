# Changelog

All notable changes to **the-librarian-codex-plugin** are documented in this
file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Sessions rethink — breaking change (sessions-rethink PR 3).** The
  whole session subsystem is replaced by a four-verb agent surface
  taught by the SKILL doc. Specifically:
  - **Removed hooks:** `SessionStart`, `PostCompact`, `Stop` registrations
    are gone. Only `UserPromptSubmit` survives, and its only job is now
    conv-state injection (spec §4.9).
  - **Removed source:** `src/handlers/session-start.mjs`,
    `session-bootstrap.mjs`, `checkpoint-policy.mjs`, `post-compact.mjs`,
    `stop.mjs`; `src/state-store.mjs`, `src/privacy-detector.mjs`,
    `src/mcp-parse.mjs`. The handler-side natural-language private
    detector (`off the record`, `keep this between us`, …) is retired —
    private mode is now an in-conversation `[librarian:private=on|off]`
    marker handled directly by the LLM via `/toggle-private`.
  - **Removed tests:** the matching unit tests for every deleted module.
  - **SKILL.md rewritten** to teach four verbs (`/handoff`, `/takeover`,
    `/learn`, `/toggle-private`) instead of the old `/lib:session` family.
  - **Server compatibility:** requires a Librarian server running the
    sessions-rethink PR 1 monorepo build (the `store_handoff` /
    `list_handoffs` / `claim_handoff` and `conv_state_*` MCP tools must
    exist).
  - **Migration:** existing operators should restart Codex after updating
    the plugin. The three retired hooks (`SessionStart`, `PostCompact`,
    `Stop`) need to be **un-approved** in Codex's `/hooks` UI; the new
    build refuses to register them but Codex's per-event approval cache
    is local.

### Added

- **Conv-state injection on every UserPromptSubmit.** Implements
  spec §4.9 of the upstream memory-domain-isolation rollout. After
  the existing privacy gate and session bootstrap, the handler now
  fetches the conv-state row for this Codex run (via the existing
  MCP client, keyed on `source_ref` since Codex doesn't expose a
  stable per-conversation id on hook payloads) and returns a
  `hookSpecificOutput.additionalContext` envelope carrying the
  canonical `<conversation-state>` block when a row exists. The LLM
  sees the current `domain` / `session_id` / `off_record` on every
  turn, defeating context-compaction-driven state loss. House-rule:
  no MCP call while off-record, fail-soft on every miss / network
  failure / parse error (AGENTS.md §2). Bundle rebuilt; PROVENANCE
  updated.

- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, CHANGELOG discipline, etc.) and the
  Codex-plugin-specific build / test / gotcha notes. Sibling
  AGENTS.md files in the four other Librarian repos share the same
  baseline.

### Changed

- **AGENTS.md §2** updated: the canonical TS privacy-detector source
  in `the-librarian/integrations/shared/librarian-lifecycle/` was
  deleted when the family went fully standalone. The privacy detector
  here (`src/privacy-detector.mjs`) is now one of five peer
  implementations across the family (Claude Code, this repo, Hermes,
  OpenCode, Pi). Coordinate any marker-list change across all five
  repos.

## [0.1.0] — 2026-05-26

Initial public release. Gives [Codex](https://developers.openai.com/codex)
the same Librarian memory + session lifecycle the
[Claude Code plugin](https://github.com/JimJafar/the-librarian-claude-plugin)
and the
[Hermes plugin](https://github.com/JimJafar/the-librarian-hermes-plugin) give
those harnesses.

### Added

- **Remote MCP tools.** `.mcp.json` registers `the-librarian` as an HTTP MCP
  server templated from `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`. All
  eight session verbs (`start_session`, `list_sessions`, `continue_session`,
  `checkpoint_session`, `pause_session`, `end_session`, `record_session_event`,
  `search_sessions`) plus the memory tools (`recall`, `remember`,
  `propose_memory`, `update_memory`, `verify_memory`) become available inside
  Codex.
- **`@librarian` umbrella skill** at `skills/librarian/SKILL.md`. ≤120 lines
  documenting the canonical verb table, memory tools, and three invariants
  (verify-after-recall, privacy enforced by hook, `capture_mode: "summary"`
  default). Cross-references the Claude / Hermes plugins.
- **Automatic session lifecycle** via four Codex hooks:
  - **SessionStart** auto-starts a session on `source=startup`/`compact`;
    bootstraps then reconciles stale active sessions on
    `source=resume`/`clear` (no `SessionEnd` event in Codex, so
    reconciliation closes the loop).
  - **UserPromptSubmit** detects off-record markers and flips state; calls
    `bootstrapSession` on non-marker prompts to mitigate
    [openai/codex#15266](https://github.com/openai/codex/issues/15266).
  - **PostCompact** checkpoints the session with an updated rolling summary.
  - **Stop** records a per-turn `record_session_event` (`type: "message"`,
    280-char summary cap) and conditionally checkpoints (≥ 10 min OR ≥ 20
    turns since last checkpoint).
- **Off-record gate.** Privacy markers ported from the Hermes plugin's
  `privacy.py` (13-case test matrix in lockstep with the canonical TS
  source). On enter-private the attached session is ended with a neutral
  "switching to private mode" reason; while private, no `record_session_event`
  / `checkpoint_session` / bootstrap fires. `/lib-toggle-private` is supported
  as a pure toggle command.
- **Bundled execution model.** `bin/librarian-codex-hook.js` is built from
  `src/dispatch.mjs` with esbuild and committed — users have no `npm install`
  step. `bin/PROVENANCE.json` records the source SHA, esbuild version, and
  build date.
- **Atomic state store** at `${PLUGIN_DATA}/state.json` with `withLock` mutex
  (POSIX-atomic `O_EXCL` on local filesystems; documented NFS gotcha).
- **Append-only log** at `${PLUGIN_DATA}/log.jsonl` with rotation at 5 MiB
  (one prior generation retained as `log.jsonl.1`).
- **`scripts/validate.mjs`** pre-commit gate covering manifest, `.mcp.json`,
  `hooks/hooks.json`, marketplace JSON, SKILL.md (120-line budget), and the
  bundled bin (no unbundled dependencies — checks CJS `require()`, ESM
  `import`, and dynamic `import()`).
- **`scripts/smoke.mjs`** end-to-end test driving the real bundled bin
  against a mock Librarian HTTP server across six scenarios.
- **CI** at `.github/workflows/ci.yml` runs test + validate + smoke + a
  bundle-drift check across Node 20 / 22 / 24.

### Security posture

- HTTP MCP client rejects: non-http(s) endpoints, endpoints with embedded
  credentials, endpoints with query strings.
- `redirect: "error"` so a 3xx never carries the bearer header cross-origin.
- 8 MiB response body cap; 15 s default per-call timeout.
- Bearer token only ever sent in the `Authorization` header — never logged,
  never echoed in error messages.
- Privacy detector errs toward privacy: false-positive declines to record,
  false-negative trips on the next sentence.

### Known limitations

- Codex has no `SessionEnd` event; hard exits leave a stale `active`
  session on the server that the next `SessionStart(source=resume)`
  reconciles by pausing.
- Privacy detector does not strip format characters (`Cf` / zero-width
  space). The same gap exists in the canonical TypeScript source and the
  Hermes Python port; addressing it requires a coordinated change in all
  three.
- Marketplace.json source schema diverges from the build docs — the
  `source` field is nested, not flat. Captured in `notes/marketplace-shape.md`.

[Unreleased]: https://github.com/JimJafar/the-librarian-codex-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JimJafar/the-librarian-codex-plugin/releases/tag/v0.1.0
