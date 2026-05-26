# Spec: the-librarian-codex-plugin

A Codex plugin for The Librarian — durable memory + cross-harness session
lifecycle, backed by the remote Librarian MCP server. Sibling to
[`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin)
and [`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin).

Status: **draft, awaiting human approval** before Phase 2 (Plan).

## Objective

Give Codex (CLI and desktop app) the same Librarian feature surface the Claude Code
plugin gives Claude Code:

- the Librarian **memory + session MCP tools** (`recall`, `remember`, `verify_memory`,
  `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`,
  `pause_session`, `end_session`, `record_session_event`, `search_sessions`, …) over the
  user's remote endpoint;
- an **umbrella `@librarian` skill** that documents the canonical `/lib:session <verb>`
  contract and shows the model how to drive the MCP tools (Codex plugins can't register
  `/`-style slash commands — only `@skills`);
- **automatic session lifecycle** — a session starts on the first prompt
  (`SessionStart` hook), checkpoints on compaction (`PostCompact`) and at turn end
  (`Stop`, debounced), and reconciles stale active sessions on next `SessionStart`
  with `source=resume` (Codex has no `SessionEnd` event);
- an **off-record gate** — "off the record" / natural-language markers in a
  user prompt end the attached session and suppress further recording until
  cleared (`UserPromptSubmit` hook, same detector as the Hermes `pre_gateway_dispatch`
  gate);
- **distribution via Codex marketplace** — `codex plugin marketplace add
  JimJafar/the-librarian-codex-plugin` for early users; submit to the official
  directory when OpenAI opens self-serve publishing.

### Non-goals

- We do not ship a local Librarian server — this is a **remote-MCP-only** plugin (same
  posture as the Claude plugin).
- We do not synthesise a fake `SessionEnd` event. Stale `active` sessions are reconciled
  at the next `SessionStart(source=resume)`.
- We do not invent a Codex-specific verb dialect; the `/lib:session <verb>` contract
  (from `docs/slash-commands.md` in the-librarian) carries over unchanged.

## Tech stack

- **Codex plugin spec** (May 2026): `.codex-plugin/plugin.json` manifest, `hooks/hooks.json`,
  plugin-bundled `.mcp.json`, `skills/<name>/SKILL.md`. Codex exposes `CLAUDE_PLUGIN_ROOT`
  as a compatibility alias for `PLUGIN_ROOT`, so any Claude-plugin script that already
  uses `${CLAUDE_PLUGIN_ROOT}` is portable.
- **Hook runtime:** Node 20+. Hooks are stdin-JSON / stdout-JSON executables; we bundle
  with esbuild into single files in `bin/` so users don't run `npm install`.
- **MCP transport:** HTTP via Codex's native `.mcp.json` (`type: "http"`), pointing at
  the user's `${LIBRARIAN_MCP_URL}` with `Authorization: Bearer ${LIBRARIAN_AGENT_TOKEN}`.
- **No Python.** Codex hooks are language-agnostic; Node mirrors the Claude plugin
  and lets us lift large chunks of `bin/librarian-claude-hook.js` verbatim.

## Commands

```sh
# Build the bundled hook + MCP-call scripts into bin/
npm run build           # node scripts/build-bundle.mjs   (esbuild)

# Validate the manifest + hooks.json + marketplace.json shape
npm run validate        # node scripts/validate.mjs

# End-to-end smoke against a mock Librarian HTTP server
npm run smoke           # node scripts/smoke.mjs

# Unit tests (privacy detector, dispatch routing, source_ref builder)
npm test                # node --test tests/

# Local install for hand-testing in Codex
codex plugin marketplace add file://$(pwd)
codex plugin install the-librarian@the-librarian-codex-local
```

No `dev` script — the plugin runs inside Codex, so the iteration loop is
`build → reload-plugin-in-Codex → test`.

## Project structure

```
the-librarian-codex-plugin/
├── .codex-plugin/
│   └── plugin.json                  # Codex manifest (name, version, skills, hooks, mcpServers pointers)
├── .mcp.json                        # MCP server: the-librarian → ${LIBRARIAN_MCP_URL}
├── hooks/
│   └── hooks.json                   # SessionStart / UserPromptSubmit / Stop / PostCompact → dispatch.sh
├── skills/
│   └── librarian/
│       └── SKILL.md                 # Umbrella skill: how to drive the 8 MCP tools + privacy
├── scripts/
│   ├── dispatch.sh                  # Reads stdin, sets env, exec's node bin/librarian-codex-hook.js
│   ├── build-bundle.mjs             # esbuild config
│   ├── validate.mjs                 # manifest + hooks + marketplace shape checks
│   └── smoke.mjs                    # mock-Librarian end-to-end smoke
├── bin/
│   ├── librarian-codex-hook.js      # Bundled dispatcher (event-name → handler)
│   ├── librarian-mcp-call.js        # Bundled MCP HTTP caller (lifted from Claude plugin)
│   └── PROVENANCE.json              # Source SHA, build date, esbuild version
├── src/                             # Pre-bundle sources (event handlers, privacy detector, source_ref builder)
│   ├── handlers/
│   │   ├── session-start.mjs
│   │   ├── user-prompt-submit.mjs
│   │   ├── stop.mjs
│   │   └── post-compact.mjs
│   ├── privacy-detector.mjs         # Ported from hermes-plugin/privacy.py
│   ├── source-ref.mjs               # codex:run:{id}:cwd:{abs} | cwd:{abs}
│   └── state-store.mjs              # ${PLUGIN_DATA}/state.json — attached session_id, private flag
├── tests/
│   ├── privacy-detector.test.mjs
│   ├── source-ref.test.mjs
│   ├── dispatch.test.mjs
│   └── state-store.test.mjs
├── .agents/
│   └── plugins/
│       └── marketplace.json         # Local marketplace entry (so `codex plugin marketplace add file://$(pwd)` works)
├── README.md                        # User-facing: install, env vars, what it does
├── LICENSE                          # Apache-2.0 (match siblings)
├── package.json                     # ESM, esbuild devDep, test script
├── .gitignore
└── SPEC.md                          # This file
```

## Code style

Match the Claude plugin (`bin/librarian-claude-hook.js`): strict ESM, no TypeScript,
small focused files with a top-of-file comment explaining purpose and the upstream
contract being honoured. Snake_case for on-wire field names (Codex's hook payloads use
snake_case); camelCase for internal JS identifiers.

```js
// src/handlers/user-prompt-submit.mjs
// Fires before Codex sends a user prompt to the model. We detect off-record markers
// and, if found, end the attached Librarian session and set the private flag.
// We always return `{}` (allow) — privacy means "stop recording", not "block the turn".

import { detectPrivacySignal } from "../privacy-detector.mjs";
import { loadState, saveState } from "../state-store.mjs";
import { callLibrarian } from "../../bin/librarian-mcp-call.js";

export async function handleUserPromptSubmit(payload) {
  const text = payload?.prompt ?? "";
  const signal = detectPrivacySignal(text);
  if (!signal) return {};

  const state = await loadState();
  if (signal === "enter" && !state.private) {
    if (state.session_id) {
      await callLibrarian("end_session", {
        session_id: state.session_id,
        reason: "switching to private mode",
      }).catch(() => {}); // fail-soft
    }
    await saveState({ ...state, private: true, session_id: null });
  } else if (signal === "exit" && state.private) {
    await saveState({ ...state, private: false });
  }
  return {}; // allow
}
```

## Testing strategy

- **Framework:** Node's built-in test runner (`node --test`) — zero deps, lines up with
  the no-runtime-install posture.
- **Test locations:** `tests/*.test.mjs`, one file per unit under test.
- **Coverage expectations:**
  - 100% line coverage on the **privacy detector** (it gates all recording — bugs here
    leak private content to the server).
  - 100% line coverage on the **source_ref builder** (it's the cross-harness primary key).
  - Smoke covers the four hook event paths end-to-end against a mock Librarian.
- **Levels:**
  - **Unit:** privacy detector, source_ref, state store, dispatch routing.
  - **Integration smoke:** `scripts/smoke.mjs` boots a localhost mock Librarian and
    pipes synthetic Codex hook payloads (`SessionStart`, `UserPromptSubmit`, `Stop`,
    `PostCompact`) into the built `bin/librarian-codex-hook.js`. Asserts the right MCP
    tool calls happen with the right args.
  - **Manual:** install in the Codex desktop app on this machine, drive each verb via
    `@librarian`, verify on the Librarian dashboard.

## Boundaries

**Always:**
- Bundle all runtime deps (esbuild) — users never run `npm install`.
- Fail-soft on every Librarian call: a 500 / timeout / network error becomes a logged
  warning, never a thrown exception that blocks a turn. (Same invariant as the Hermes
  provider.)
- Default `capture_mode: "summary"`; raw `log` is reserved for explicit operator request.
- Validate the manifest + hooks shape in CI before tagging a release.
- Open PRs from a topic branch — never push to `main` directly (per user CLAUDE.md).

**Ask first:**
- Any change to the canonical `/lib:session <verb>` contract (it's cross-harness).
- Adding a new MCP server beyond `the-librarian`.
- Bundling native binaries (we should stay pure-JS).
- Touching the Librarian server-side schema in support of this plugin.

**Never:**
- Log raw user prompts to disk or send them as `record_session_event` payloads while
  off-record.
- Bypass or disable the privacy gate.
- Commit secrets (tokens, endpoints) — `LIBRARIAN_AGENT_TOKEN` lives in the user's shell
  profile and is templated into `.mcp.json` via `${...}` syntax.
- Force-push to `main` / `master`.

## Success criteria

1. `codex plugin marketplace add JimJafar/the-librarian-codex-plugin` followed by
   `codex plugin install the-librarian@…` succeeds on a fresh Codex install.
2. After setting `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN` and restarting Codex,
   the first prompt in any project auto-starts a Librarian session whose
   `source_ref` is `codex:run:{run_id}:cwd:{abs}` (or `cwd:{abs}` fallback) and the
   session appears in `list_sessions`.
3. Typing "off the record" in a prompt ends the attached session within one turn and
   subsequent prompts produce no `record_session_event` entries until "back on the
   record" (or the inverse marker) is detected.
4. `@librarian` is discoverable in the Codex `@` picker and its `SKILL.md` correctly
   teaches the model to call the 8 MCP tools for the 8 canonical verbs.
5. A `PostCompact` event triggers `checkpoint_session` with an updated
   `rolling_summary`.
6. `Stop` events update a debounced `last_turn` counter and call `record_session_event`
   with `type: "message"` and a summary of the last assistant message (capture_mode
   summary), at most once per N seconds.
7. All hook scripts complete in < 500 ms p50 on this MacBook and < 2 s p99.
8. Hook scripts handle malformed stdin (parse error, missing fields) by exiting 0
   silently — never blocking a turn.
9. Unit tests pass; smoke test passes against the mock Librarian; manual install in
   the local Codex app works end-to-end.

## Open questions (to resolve in Phase 2: Plan)

- **Codex desktop vs CLI plugin parity.** OpenAI's docs describe the CLI plugin model;
  the desktop app at `~/.codex/` honours `[plugins."<name>@<marketplace>"]` entries in
  `config.toml` and a `~/.codex/plugins/` cache, which strongly suggests the same
  loader. Verify empirically as the first plan step.
- **`SessionStart` + `UserPromptSubmit` ordering on first prompt.** Per
  [openai/codex#15266](https://github.com/openai/codex/issues/15266) they fire
  simultaneously, which complicates "do we already have a session?" logic. The plan
  needs an idempotent guard (e.g., `state.session_id` written by whichever wins the
  race; the loser is a no-op).
- **Stop-event checkpoint frequency.** `Stop` fires every turn. Default is to record a
  lightweight `record_session_event` per turn and only call `checkpoint_session`
  on `PostCompact` and on the first `Stop` after ≥ N minutes of activity. Confirm N
  (suggest 10 minutes) in the Plan.
- **Stale-active reconciliation on resume.** No `SessionEnd` means we can leave the
  server with a stale `active` session if Codex exits hard. Plan should specify: on
  `SessionStart(source=resume)`, look up sessions for this `source_ref`; if one is
  `active`, pause it before starting / continuing.
- **`@librarian` skill content.** SKILL.md must be tight — Codex skills are loaded
  into the model context, so the canonical verb table + the verify-after-recall rule
  + the privacy invariants are in scope, but not the full Librarian docs.
- **Marketplace entry shape.** The CLI form is documented (`source: "url"`,
  `git-subdir`, `local`), but the per-plugin metadata fields (category, `policy.*`,
  `capabilities`) need a sample read from `~/.codex/.tmp/bundled-marketplaces/`.
  First Plan task should crib from a real OpenAI-shipped marketplace JSON.

## Cross-references

- Canonical verb contract: [`docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md) in the-librarian.
- Claude Code plugin (architectural sibling): [`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin).
- Hermes plugin (provider-pattern sibling, source of the privacy detector port):
  [`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin).
- Codex docs: [Build a plugin](https://developers.openai.com/codex/plugins/build) ·
  [Hooks](https://developers.openai.com/codex/hooks).
