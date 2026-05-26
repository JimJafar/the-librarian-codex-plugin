# the-librarian-codex-plugin

A **[Codex](https://developers.openai.com/codex) plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory +
cross-harness session lifecycle, backed by a **remote** Librarian MCP server.

Sibling plugins:
[the-librarian-claude-plugin](https://github.com/JimJafar/the-librarian-claude-plugin) ·
[the-librarian-hermes-plugin](https://github.com/JimJafar/the-librarian-hermes-plugin).

It gives Codex:

- the Librarian **memory + session MCP tools** (`recall`, `remember`,
  `verify_memory`, `start_session`, `checkpoint_session`, …) over your remote
  endpoint;
- an umbrella **`@librarian` skill** that documents the canonical
  `/lib:session <verb>` contract and shows the model how to drive the tools;
- **automatic session lifecycle** — a session starts on the first prompt
  (`SessionStart`), records a per-turn message event on every `Stop`,
  checkpoints on `PostCompact` and on a debounced threshold (≥ 10 min OR
  ≥ 20 turns), and pauses stale active sessions on resume;
- an **off-record gate** — `off the record`, `keep this between us`,
  `don't remember this`, … (and `/lib-toggle-private`) end the attached
  session and suppress further recording until you go back on the record.

## Install

```sh
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin install the-librarian@the-librarian-codex-local
```

After install:

1. Set the two environment variables below in your shell profile.
2. **Approve the four hooks.** In Codex run `/hooks` and approve
   `SessionStart`, `UserPromptSubmit`, `PostCompact`, and `Stop` — each is
   hashed and will need re-approval after every plugin update.
3. Restart Codex (or the desktop app).

## Configure (environment variables)

Both the MCP tool calls and the lifecycle hooks read the **same two**
variables, so set them once in your shell profile (`~/.zshrc`, `~/.bashrc`,
…):

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token for the endpoint (only ever sent in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope for sessions |
| `CODEX_RUN_ID` | (set by Codex) | When present, included in `source_ref` so cross-harness handover lines up exactly |

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

## What it does

### Memory + sessions, on demand (`@librarian`)

Type `@librarian` to load the operating manual; the model then knows how to
drive the canonical verbs:

| Say | Tool called |
| --- | --- |
| "start a session [titled …] [private]" | `start_session` |
| "list my sessions" | `list_sessions` |
| "resume session …" | `continue_session` |
| "checkpoint" | `checkpoint_session` |
| "pause" | `pause_session` |
| "end" / "I'm done" | `end_session` |
| "search sessions …" | `search_sessions` |
| "what do I/we know about …" | `recall` |
| "remember that …" | `remember` |

The canonical contract lives at
[`docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md)
in the-librarian. Codex plugins can't register `/`-style slash commands, so
the `@librarian` skill is the surface here. All other Librarian harnesses
(Claude Code, Hermes, Pi) honour the same verb names.

### Automatic recording (the hooks)

Once installed and approved, the plugin records every Codex run as a
Librarian session without you having to ask:

- **First prompt in a project:** `SessionStart` starts a session bound to
  `source_ref = codex:run:<id>:cwd:<abs>`. The race with `UserPromptSubmit`
  (per [openai/codex#15266](https://github.com/openai/codex/issues/15266)) is
  resolved by an atomic-write + lock — exactly one session per first prompt.
- **Every turn:** `Stop` records a per-turn message event (one-sentence
  summary, capped at 280 chars from `last_assistant_message`).
- **On compaction:** `PostCompact` calls `checkpoint_session` — the rolling
  summary stays in sync with what Codex actually carries forward.
- **Idle:** Every 10 minutes OR every 20 turns since the last checkpoint,
  `Stop` also calls `checkpoint_session`. Tunable in
  `src/handlers/checkpoint-policy.mjs`.
- **Resume / clear:** `SessionStart(source=resume)` lists any active
  sessions for this `source_ref`, pauses them, then bootstraps a new
  one — so a hard exit doesn't leave you with two `active` sessions on the
  dashboard.

### Privacy (the off-record gate)

Natural-language markers in any user prompt flip the plugin to off-record:

- **Going private:** `off the record`, `keep this between us`,
  `don't remember this`, `do not remember this`, `don't save this`,
  `don't store this`, `private from here`, `this is a private session`. Also
  `/lib-toggle-private`.
- **Coming back:** `back on the record`, `you can remember again`,
  `end private mode`, `this can be remembered`. Also `/lib-toggle-private`.

While private, **no MCP recording call is ever made** — the attached session
is ended with a neutral reason on entering private, and `Stop` / `PostCompact`
become no-ops until you come back. The detector is the same one used by the
Hermes plugin; it errs toward privacy (a false-positive declines to record,
a false-negative trips on the very next sentence).

## Troubleshooting

**Codex shows the hook prompts every time I update the plugin.** That's
working as designed. Codex hashes each hook command; a rebuild changes the
hash, so re-approval is required. There's no signing.

**`@librarian` doesn't appear in the picker.** Check `codex plugin list`
shows the plugin enabled, and `~/.codex/config.toml` contains a
`[plugins."the-librarian@..."]` entry with `enabled = true`. Restart Codex
after install.

**The `/mcp` panel doesn't list `the-librarian`.** Verify
`LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` are set in the shell that
launched Codex (the desktop app inherits from your login shell, but a
`launchctl` env mismatch is a common gotcha on macOS). Test directly:

```sh
curl -X POST "$LIBRARIAN_MCP_URL" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Hooks silently do nothing.** Tail `$PLUGIN_DATA/log.jsonl`. Every hook
event writes a line there (best-effort, never throws). If the file isn't
being created, `scripts/dispatch.sh` couldn't find the bundle — usually
means a missing `PLUGIN_ROOT` env var.

**Two sessions appear on the dashboard for one Codex run.** The
SessionStart/UserPromptSubmit race should produce exactly one, but if a
previous run hard-exited without resume reconciliation kicking in (e.g.
crash before next launch), an old `active` session may linger. The next
`SessionStart(source=resume)` will pause it.

## Develop

```sh
npm install                # esbuild devDep only — runtime is zero-dep Node
npm test                   # all unit + handler tests (Node's built-in runner)
npm run validate           # manifest + hooks + marketplace shape gate
npm run smoke              # mock-Librarian end-to-end across the four events
npm run build              # esbuild → bin/librarian-codex-hook.js (committed)
```

The bundle is committed under `bin/` because users have no `npm install`
step. `bin/PROVENANCE.json` records the source SHA + esbuild version + build
date for traceability.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
