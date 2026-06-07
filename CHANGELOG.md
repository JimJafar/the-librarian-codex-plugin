# Changelog

All notable changes to **the-librarian-codex-plugin** are documented in this
file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bundled MCP server — no more manual `codex mcp add`.** The plugin now
  ships the Librarian MCP server as a bundled **stdio↔HTTP JSON-RPC proxy**
  (`src/mcp-stdio-proxy.mjs` → committed `bin/librarian-mcp-proxy.js`) and
  declares it in `.mcp.json` with the `env_vars` allowlist
  `["LIBRARIAN_MCP_URL", "LIBRARIAN_AGENT_TOKEN"]`. Codex spawns the proxy
  and forwards both per-user vars into it; the proxy relays each JSON-RPC
  message to the user's remote endpoint. This works around Codex not
  expanding `${VAR}` into a remote HTTP `url`
  ([openai/codex#7521](https://github.com/openai/codex/issues/7521)) — the
  reason the old bundled `.mcp.json` was removed in #11 — while still
  supporting a per-user URL + token with nothing hardcoded. The proxy reuses
  the hook's HTTP path (shared `createRpcSender` in `mcp-client.mjs`:
  `Authorization` header only, `redirect: "error"`, no creds in the URL, size
  cap) and is fail-soft (transport/HTTP/parse errors become id-correlated
  JSON-RPC errors; the token never reaches stdout/stderr). The manual
  `codex mcp add` registration remains documented as a legacy fallback.

  > The bundled server's `command`/`args` path uses `${PLUGIN_ROOT}` (mirroring
  > the hook wiring); whether Codex expands that for MCP `args` is pending
  > maintainer verification in a live Codex before release.

## [0.3.0] — 2026-06-07

### Added

- **Awareness primer injected every turn.** On `UserPromptSubmit`, the same
  single `conv_state_get` response now also carries the operator-authored
  awareness primer (a short note reminding the agent it has durable,
  cross-session memory and which verbs to use). When non-empty it's emitted
  as a byte-identical `<librarian>` block via `additionalContext`, alongside
  the `<conversation-state>` block (conv-state first, then the primer). The
  primer block appears even when there's no conversation-state row; an empty
  primer or any fetch/parse failure emits no block and the turn proceeds
  unchanged (fail-soft). Parsing is adapted to the server's JSON-only
  response shape (no-row is now `{ primer }`, not the retired
  "No conversation state…" prose). No new MCP call and no new hook.

### Changed

- **Conv-state block trimmed to `conv_id` + `off_record`.** The injected
  `<conversation-state>` block drops the retired `domain` and `session_id`
  lines (lockstep with the rest of the Librarian family). AGENTS.md's
  cross-repo contract is updated from the retired `/lib:session` verbs to
  the current handoff model (`/handoff`, `/takeover`, `/learn`,
  `/toggle-private`; memory states `active | proposed | archived`).
  SKILL.md and README drop the retired `conv_id` / `domain` / `session_id`
  residue (`conv_id` was a D16 domain-routing arg, now gone).
- **Marketplace install plumbing aligned with Codex.** Four discoveries
  while landing the first working install (see
  [`notes/marketplace-shape.md`](notes/marketplace-shape.md) caveats 3–5):
  - `policy.authentication` enum is `ON_INSTALL | ON_USE` only — `"NONE"`
    is rejected. Now ships `"ON_INSTALL"`.
  - Marketplace name + display: `the-librarian-codex-local` →
    `the-librarian-codex`, displayName → `The Librarian`.
  - Plugin must live in a subdirectory — moved from repo root into
    `plugins/the-librarian/` to match the bundled OpenAI convention.
  - Codex's `.mcp.json` parser does NOT expand `${VAR}` in URLs, and
    Librarian endpoints are per-user, so the bundled `.mcp.json` and the
    `mcpServers` manifest pointer are **removed**. README now documents a
    one-time `codex mcp add the-librarian --url "$LIBRARIAN_MCP_URL"
    --bearer-token-env-var LIBRARIAN_AGENT_TOKEN` at install. Codex reads
    the token from env on every tool call.

## [0.2.0] — 2026-05-28

### Added

- **Release runbook + per-repo release doc.** A new
  [`docs/release.md`](docs/release.md) captures the per-repo release
  steps (two version files in lockstep, CHANGELOG move, tag + GitHub
  release). AGENTS.md is thinned and points at it; the cross-family
  runbook lives in the monorepo at
  [`the-librarian/docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).

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

[Unreleased]: https://github.com/JimJafar/the-librarian-codex-plugin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/JimJafar/the-librarian-codex-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JimJafar/the-librarian-codex-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JimJafar/the-librarian-codex-plugin/releases/tag/v0.1.0
