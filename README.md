# the-librarian-codex-plugin

A **[Codex](https://developers.openai.com/codex) plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory +
cross-harness narrative handoffs, backed by a **remote** Librarian MCP server.

Sibling plugins:
[the-librarian-claude-plugin](https://github.com/JimJafar/the-librarian-claude-plugin) ·
[the-librarian-hermes-plugin](https://github.com/JimJafar/the-librarian-hermes-plugin).

It gives Codex:

- the Librarian **memory MCP tools** (`recall`, `remember`, `propose_memory`,
  `verify_memory`, `update_memory`, `list_proposals`) over your remote
  endpoint — **auto-configured** via a bundled stdio proxy (no manual
  `codex mcp add`);
- the **handoff MCP tools** (`store_handoff`, `list_handoffs`,
  `claim_handoff`) for atomic cross-harness handover;
- an umbrella **`@librarian` skill** that teaches the LLM four user-facing
  verbs — `/handoff`, `/takeover`, `/learn`, `/toggle-private` — to drive
  the tools;
- a **per-turn conv-state injection hook** that keeps the model aware of
  its current conv-state — `conv_id` and the `off_record` flag, keyed by
  harness — so that state survives compaction.

## Install

```sh
# 1. Add the marketplace + plugin
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin add the-librarian@the-librarian-codex

# 2. Set the two environment variables in your shell profile (~/.zshrc, ~/.bashrc, …)
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

That's it — **no manual `codex mcp add`**. The plugin **bundles** the
Librarian MCP server (see [Bundled MCP server](#bundled-mcp-server) below):
Codex forwards your `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN` into the
bundled server automatically, so the Librarian tools (`recall`, `remember`,
…) appear in `/mcp` once you restart Codex.

After install:

1. **Approve the `UserPromptSubmit` hook.** In Codex run `/hooks` and
   approve `UserPromptSubmit`. The hook is hashed and will need re-approval
   after every plugin update.
2. Restart Codex (or the desktop app). The `/mcp` panel should now list
   `librarian` (no longer "No plugin MCP servers").

### Bundled MCP server

Codex can't interpolate `${VAR}` into a *remote* HTTP MCP `url`
([openai/codex#7521](https://github.com/openai/codex/issues/7521)), and the
Librarian endpoint is **per-user**, so a literal URL can't be shipped either.
What Codex *does* support is the **`env_vars` allowlist** for **stdio**
servers: it forwards named shell env vars into a bundled stdio subprocess.

So the plugin ships a tiny **stdio↔HTTP JSON-RPC proxy**
(`bin/librarian-mcp-proxy.js`, built from `src/mcp-stdio-proxy.mjs`) and
declares it as a bundled stdio server in
[`.mcp.json`](plugins/the-librarian/.mcp.json):

```json
{
  "mcpServers": {
    "librarian": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/bin/librarian-mcp-proxy.js"],
      "env_vars": ["LIBRARIAN_MCP_URL", "LIBRARIAN_AGENT_TOKEN"]
    }
  }
}
```

Codex spawns the proxy, forwards both env vars into it, and the proxy relays
each JSON-RPC message to your remote endpoint — reusing the same HTTP path as
the hook (`Authorization: Bearer …` header only, `redirect: "error"`, no
credentials in the URL). The bearer token is never written to stdout or
stderr.

> **Pending maintainer verification.** The exact resolution of a bundled
> stdio server's `command`/`args` path in Codex is documented for *hook*
> commands (`${PLUGIN_ROOT}`) but not yet shown for MCP `args` in the public
> docs. We use `${PLUGIN_ROOT}` to mirror the hook wiring; if your Codex
> build doesn't expand it for MCP `args`, fall back to the legacy
> registration below and please open an issue.

### Legacy / fallback: manual registration

If the bundled server doesn't show up (older Codex, or `${PLUGIN_ROOT}` not
expanded for MCP `args` in your build), register the server manually. This is
the old path and remains supported:

```sh
codex mcp add the-librarian \
  --url "$LIBRARIAN_MCP_URL" \
  --bearer-token-env-var LIBRARIAN_AGENT_TOKEN
```

## Environment variables

The hook and the bundled MCP proxy share the same two variables. The hook
reads them directly; Codex forwards both into the bundled stdio proxy via the
`env_vars` allowlist (no `codex mcp add`, no literal URL captured anywhere).

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp`. Read by the hook; forwarded into the bundled proxy via `env_vars`. |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token. Read by the hook on every event; forwarded into the bundled proxy, which sends it only in the request `Authorization` header — never to stdout/stderr or any log. |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope |
| `CODEX_RUN_ID` | (set by Codex) | When present, included in the conv-state `conv_id` so cross-harness lookups line up |

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
`conv_id` / `off_record` on every turn — even after a
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

**The `/mcp` panel doesn't list `librarian`.** Verify
`LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` are set in the shell that
launched Codex (the desktop app inherits from your login shell, but a
`launchctl` env mismatch is a common gotcha on macOS). First test the remote
server directly:

```sh
curl -X POST "$LIBRARIAN_MCP_URL" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then test the **bundled proxy** in isolation — it should produce the same
`tools/list` result on stdout (replace the path with your install location):

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | LIBRARIAN_MCP_URL="$LIBRARIAN_MCP_URL" \
    LIBRARIAN_AGENT_TOKEN="$LIBRARIAN_AGENT_TOKEN" \
    node "$(codex plugin path the-librarian)/bin/librarian-mcp-proxy.js"
```

A healthy response is a single JSON line:
`{"jsonrpc":"2.0","id":1,"result":{"tools":[…]}}`. A
`{"jsonrpc":"2.0","id":1,"error":{…}}` line means the proxy reached the
Librarian but got an error (check the token); a "not configured" error means
one of the env vars is unset. If the proxy works here but Codex still shows
nothing, your Codex build may not expand `${PLUGIN_ROOT}` for MCP `args` —
use the [legacy registration](#legacy--fallback-manual-registration).

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
npm run build              # esbuild → bin/librarian-codex-hook.js + bin/librarian-mcp-proxy.js (both committed)
```

Both `plugins/the-librarian/bin/librarian-codex-hook.js` (the hook) and
`plugins/the-librarian/bin/librarian-mcp-proxy.js` (the bundled MCP proxy)
are committed because
users have no `npm install` step. `plugins/the-librarian/bin/PROVENANCE.json`
(source SHA + esbuild version + build date) is generated by `npm run build`
but **not** committed — it's a local build receipt, not part of the shipped
surface.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
