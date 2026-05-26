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
  `/lib:session <verb>` contract and shows the model how to drive the tools
  (Codex plugins don't expose `/`-style commands — `@skill` is the surface);
- **automatic session lifecycle** — sessions start on first prompt
  (`SessionStart`), checkpoint on compaction (`PostCompact`) and at idle turn
  boundaries (`Stop`), and reconcile cleanly on resume;
- an **off-record gate** — natural-language privacy markers in a user prompt
  end the attached session and suppress further recording until cleared.

> **Status:** under active development on `build/initial-implementation`.
> Sections marked _(coming soon)_ land in later tasks of `PLAN.md`.

## Install

```sh
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin install the-librarian@the-librarian-codex-local
```

Then set the two environment variables (below) and restart Codex.

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

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

## What it does _(coming soon)_

Full feature documentation lands with Task 12 of the implementation plan.
Until then see `SPEC.md` and `PLAN.md` in the repo root.

## License

Apache-2.0. See `LICENSE`.
