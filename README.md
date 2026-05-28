# the-librarian-codex-plugin

A **[Codex](https://developers.openai.com/codex) plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory +
cross-harness narrative handoffs, backed by a **remote** Librarian MCP server.

Sibling plugins:
[the-librarian-claude-plugin](https://github.com/JimJafar/the-librarian-claude-plugin) ·
[the-librarian-hermes-plugin](https://github.com/JimJafar/the-librarian-hermes-plugin).

It gives Codex:

- the Librarian **memory MCP tools** (`recall`, `remember`, `propose_memory`,
  `verify_memory`, `update_memory`, `list_proposals`) over your remote endpoint;
- the **handoff MCP tools** (`store_handoff`, `list_handoffs`,
  `claim_handoff`) for atomic cross-harness handover;
- an umbrella **`@librarian` skill** that teaches the LLM four user-facing
  verbs — `/handoff`, `/takeover`, `/learn`, `/toggle-private` — to drive
  the tools;
- a **per-turn conv-state injection hook** that keeps the model aware of
  which domain its memory writes route to (multi-domain support survives
  compaction).

## Install

```sh
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin install the-librarian@the-librarian-codex-local
```

After install:

1. Set the two environment variables below in your shell profile.
2. **Approve the `UserPromptSubmit` hook.** In Codex run `/hooks` and
   approve `UserPromptSubmit`. The hook is hashed and will need re-approval
   after every plugin update.
3. Restart Codex (or the desktop app).

## Configure (environment variables)

Both the MCP tool calls and the conv-state injection hook read the **same
two** variables, so set them once in your shell profile (`~/.zshrc`,
`~/.bashrc`, …):

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token for the endpoint (only ever sent in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope |
| `CODEX_RUN_ID` | (set by Codex) | When present, included in the conv-state `conv_id` so cross-harness lookups line up |

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

## What it does

### Memory + handoffs, on demand (`@librarian`)

Type `@librarian` to load the operating manual; the model then knows how to
drive four user-facing verbs:

| User says… | What the agent does |
| --- | --- |
| "hand this off" / "we're done for now" | Author a five-section narrative and persist via `store_handoff` |
| "pick up where I left off" / "what was I doing" | Call `list_handoffs`, pick one, atomically claim with `claim_handoff` and inject the document |
| "save what we learned" / "remember the X pattern" | Extract durable lessons, propose them via `propose_memory` |
| "go private" / "back on the record" | Inject the `[librarian:private=on\|off]` marker — pure in-conversation, no server state |
| "what do I know about …" | `recall` |
| "remember that …" | `remember` |
| (after using a recall hit) | `verify_memory` — **mandatory** |

Codex plugins can't register `/`-style slash commands, so the `@librarian`
skill is the surface here. The same verbs work in every Librarian harness
(Claude Code, OpenCode, Hermes, Pi).

### Per-turn conv-state injection

The single registered `UserPromptSubmit` hook fetches the conv-state row for
this Codex run (keyed by `source_ref = codex:run:<id>:cwd:<abs>`) and, when
one exists, emits a `<conversation-state>` block via
`hookSpecificOutput.additionalContext`. That lets the model see the current
`domain` / `session_id` / `off_record` on every turn — even after a
context compaction that would otherwise drop the system message.

The hook never blocks a turn: a missing row, a network failure, or a
misconfigured token all return `{}` silently and the prompt reaches the
model unchanged.

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

**The hook silently does nothing.** Tail `$PLUGIN_DATA/log.jsonl`. Every
UserPromptSubmit writes a line there (best-effort, never throws). If the
file isn't being created, `scripts/dispatch.sh` couldn't find the bundle —
usually means a missing `PLUGIN_ROOT` env var.

**Codex prompts to approve `SessionStart` / `PostCompact` / `Stop`.** Those
hooks are retired (sessions-rethink PR 3). The new build registers only
`UserPromptSubmit`. If Codex still surfaces approval prompts for the old
events, run `/hooks` and un-approve the stale entries.

## Develop

```sh
npm install                # esbuild devDep only — runtime is zero-dep Node
npm test                   # all unit + handler tests (Node's built-in runner)
npm run validate           # manifest + hooks + marketplace shape gate
npm run smoke              # mock-Librarian end-to-end (conv-state injection)
npm run build              # esbuild → bin/librarian-codex-hook.js (committed)
```

`bin/librarian-codex-hook.js` is committed because users have no
`npm install` step. `bin/PROVENANCE.json` (source SHA + esbuild version +
build date) is generated by `npm run build` but **not** committed — it's
a local build receipt, not part of the shipped surface.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
