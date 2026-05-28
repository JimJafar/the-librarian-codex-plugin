# Codex marketplace + plugin schema — empirical reference

Cribbed from the bundled marketplace at
`~/.codex/.tmp/bundled-marketplaces/openai-bundled/` on 2026-05-26.

The docs at [developers.openai.com/codex/plugins/build](https://developers.openai.com/codex/plugins/build)
imply some flatter shapes than what's actually shipped — these are real files.

## `.agents/plugins/marketplace.json`

```json
{
  "name": "openai-bundled",
  "interface": {
    "displayName": "OpenAI Bundled"
  },
  "plugins": [
    {
      "name": "browser",
      "source": {
        "source": "local",
        "path": "./plugins/browser"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Engineering"
    },
    {
      "name": "latex",
      "source": {
        "source": "local",
        "path": "./plugins/latex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Research"
    }
  ]
}
```

### Field-by-field

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string (kebab-case) | Marketplace identifier |
| `interface.displayName` | ✅ | string | Shown in the Codex Plugins UI |
| `plugins[]` | ✅ | array | One entry per plugin this marketplace ships |
| `plugins[].name` | ✅ | string | Must match `plugin.json` `name` |
| `plugins[].source` | ✅ | object | **Note: nested under `source` — not a flat `source: "local"` + `path`** as the docs imply |
| `plugins[].source.source` | ✅ | `"local" \| "url" \| "git-subdir"` | Discriminator |
| `plugins[].source.path` | ✅ for `local`, `git-subdir` | string | Relative to the marketplace root |
| `plugins[].source.url` | ✅ for `url`, `git-subdir` | string | Git remote URL |
| `plugins[].source.ref` | optional | string | Git ref; defaults to default branch |
| `plugins[].policy.installation` | ✅ | `"AVAILABLE"` (observed) | Probably `"DEPRECATED"`, `"BETA"` exist too |
| `plugins[].policy.authentication` | ✅ | `"ON_INSTALL" \| "ON_USE"` | **Confirmed enum** (Codex rejects anything else with `unknown variant`). No `"NONE"`. |
| `plugins[].category` | ✅ | string | Observed: `"Engineering"`, `"Research"`. We'll use `"Engineering"`. |

⭐ **For our marketplace.json** we'll populate: `name`, `interface.displayName`,
plus one `plugins[]` entry with `name`, `source.source = "local"` (for the
local-source install path) **or** `source.source = "url"` (for the GitHub
install path), `policy.installation = "AVAILABLE"`, `policy.authentication =
"ON_INSTALL"` (the enum only accepts `ON_INSTALL` or `ON_USE`; we use
`ON_INSTALL` to match the bundled plugins even though our token is supplied
via the `LIBRARIAN_AGENT_TOKEN` env var, not collected by Codex at install),
`category = "Engineering"`.

## `.codex-plugin/plugin.json`

From `plugins/latex/.codex-plugin/plugin.json` (most complete example):

```json
{
  "name": "latex",
  "version": "0.2.0",
  "description": "Compile LaTeX with bundled Tectonic …",
  "author": { "name": "OpenAI" },
  "homepage": "https://github.com/openai/openai/tree/master/plugins/latex",
  "repository": "https://github.com/openai/openai/tree/master/plugins/latex",
  "license": "Proprietary",
  "keywords": ["latex", "tectonic", "…"],
  "skills": "./skills/",
  "interface": {
    "displayName": "LaTeX",
    "shortDescription": "Compile LaTeX with Tectonic or TeX Live",
    "longDescription": "LaTeX workflows for Codex that use bundled Tectonic first …",
    "developerName": "OpenAI",
    "category": "Research",
    "capabilities": ["Interactive", "Read", "Write"],
    "websiteURL": "https://openai.com/",
    "privacyPolicyURL": "https://openai.com/policies/row-privacy-policy/",
    "termsOfServiceURL": "https://openai.com/policies/row-terms-of-use/",
    "defaultPrompt": [
      "Use latex-doctor to check whether this machine can compile LaTeX.",
      "Use latex-compile to build the main TeX file in this project, …"
    ],
    "brandColor": "#2563EB",
    "logo": "./assets/latex-logo.svg",
    "screenshots": []
  }
}
```

### Field-by-field

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string (kebab-case) | Must match the marketplace entry's `plugins[].name` |
| `version` | ✅ | string (semver) | The `browser` plugin uses `"26.519.31651"` (date-coded) — semver is OK |
| `description` | ✅ | string | Free text |
| `author` | ✅ | object `{ name }` | |
| `homepage` | optional | URL | |
| `repository` | optional | URL | |
| `license` | optional | string | SPDX identifier or `"Proprietary"` |
| `keywords[]` | optional | string[] | |
| `skills` | optional | string | Path to skills dir, e.g. `"./skills/"` |
| `mcpServers` | optional | string | Path to bundled `.mcp.json`. **Codex's parser treats URL strings as literals — no `${VAR}` expansion.** For deployments where the URL is per-user, omit this field and have users register via `codex mcp add` (see Caveats). |
| `hooks` | optional | string | Path to `hooks/hooks.json` — **not used by bundled examples; per docs** |
| `interface.displayName` | ✅ | string | Plugins UI title |
| `interface.shortDescription` | ✅ | string | One-liner under title |
| `interface.longDescription` | optional | string | Paragraph |
| `interface.developerName` | ✅ | string | |
| `interface.category` | ✅ | string | Matches marketplace category |
| `interface.capabilities[]` | ✅ | string[] | Controlled vocab observed: `"Interactive"`, `"Read"`, `"Write"` |
| `interface.websiteURL` | optional | URL | |
| `interface.privacyPolicyURL` | optional | URL | |
| `interface.termsOfServiceURL` | optional | URL | |
| `interface.defaultPrompt[]` | optional | string[] | **Array of suggested prompts** — NOT a single string as the docs hint |
| `interface.brandColor` | optional | hex | |
| `interface.composerIcon` | optional | path | Small icon shown in the composer |
| `interface.logo` | optional | path | Main plugin logo |
| `interface.screenshots[]` | optional | string[] | Probably paths to PNGs |

⭐ **For our plugin.json** we'll populate: `name = "the-librarian"`, `version`,
`description`, `author`, `homepage`, `repository`, `license = "Apache-2.0"`,
`keywords`, `skills = "./skills/"`, `hooks = "./hooks/hooks.json"` (per docs),
`interface.displayName = "The Librarian"`, `shortDescription`,
`longDescription`, `developerName = "Jim Sangwine"`,
`category = "Engineering"`, `capabilities = ["Read", "Write"]` (no
interactive UI), `defaultPrompt = ["Start a Librarian session and recall
what we know about the current project."]`. **No `mcpServers`** — see
Caveat 4 (Codex doesn't expand `${VAR}` in MCP URLs, and Librarian
endpoints are per-user, so users register via `codex mcp add`).

## Plugin directory layout (observed)

```
plugins/<name>/
├── .codex-plugin/
│   └── plugin.json             # Manifest
├── skills/
│   └── <skill-name>/
│       └── SKILL.md            # One per skill; multiple skills allowed
├── scripts/                    # Free-form executables called from skills
├── bin/                        # Bundled binaries / pre-built artefacts
├── assets/                     # logo, composer-icon, screenshots
└── README.md                   # User-facing
```

⭐ Our layout will mirror this, adding `.mcp.json` and `hooks/hooks.json` at
plugin root (per docs — neither bundled OpenAI plugin uses these so we have
no real example to crib from for those two files).

## Caveats

1. **Neither bundled plugin uses `.mcp.json` or `hooks/hooks.json`.** We're
   reliant on the public docs for those shapes — first time we'll know if
   we got them right is when we install in Codex.
2. **Source-type discriminator is the inner `source` field**, not the outer
   key. The docs sometimes write `"source": "local"` flat — that's wrong; the
   shipped marketplace uses `"source": { "source": "local", "path": "…" }`.
3. **`policy.authentication` enum is `ON_INSTALL | ON_USE` only.** Confirmed
   2026-05-28 — Codex rejects `"NONE"` with
   `unknown variant 'NONE', expected 'ON_INSTALL' or 'ON_USE'`. We ship
   `"ON_INSTALL"` to match the bundled plugins; the actual auth is the
   `LIBRARIAN_AGENT_TOKEN` env var, not anything Codex collects.
4. **Codex's `.mcp.json` parser does NOT expand `${VAR}` in URLs.** Confirmed
   2026-05-28 — a bundled `.mcp.json` with `url: "${LIBRARIAN_MCP_URL}"`
   produced `MCP startup failed: ... http/request url is invalid: relative
   URL without a base` at Codex startup. Per
   [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp),
   the documented schema is literal `url` + `bearer_token_env_var` (env
   var **name**, not `${...}` template). Where the URL is per-user (true
   for Librarian — every deployment is different), do NOT bundle
   `.mcp.json`; have users register the server once via
   `codex mcp add <name> --url "$VAR" --bearer-token-env-var TOKEN_VAR`.
5. **Plugins must live in a subdirectory (`plugins/<name>/`), not at the
   marketplace root.** Confirmed 2026-05-28 — `path: "./"` and `path: "."`
   both produced `plugin "<name>" was not found in marketplace`. The
   bundled OpenAI plugins both use `path: "./plugins/<name>"`.

## Next-task seed

Task 1 manifest skeleton (will be expanded in Task 2/3/12):

```json
{
  "name": "the-librarian",
  "version": "0.1.0",
  "description": "Durable memory + cross-harness session lifecycle for Codex, backed by a remote Librarian MCP server.",
  "author": { "name": "Jim Sangwine", "email": "jim@sangwine.net" },
  "license": "Apache-2.0",
  "keywords": ["memory", "sessions", "mcp", "librarian", "recall", "handover"],
  "skills": "./skills/",
  "interface": {
    "displayName": "The Librarian",
    "shortDescription": "Durable memory + automatic session lifecycle for Codex",
    "developerName": "Jim Sangwine",
    "category": "Engineering",
    "capabilities": ["Read", "Write"]
  }
}
```
