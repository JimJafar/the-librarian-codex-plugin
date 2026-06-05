# AGENTS.md

You're an AI agent working on this repo. It's part of
[The Librarian](https://github.com/JimJafar/the-librarian) — a portable
memory + handoff layer for AI agents, open source, designed for
production use by people we'll never meet. Read this before your first
commit. Follow it on every change.

## 1. What this repo is

A [Codex](https://developers.openai.com/codex) plugin for The
Librarian — gives Codex remote memory tools, automatic session
lifecycle (four hooks: `SessionStart`, `UserPromptSubmit`,
`PostCompact`, `Stop`), and an off-record privacy gate. Distributed
via the Codex plugin marketplace; users install with
`codex plugin marketplace add JimJafar/the-librarian-codex-plugin`.

## 2. House rules

### Be honest about what you ran

Never claim "tests pass" without running them. Never say a build works
because it "should." If a step was skipped, say so. If something is
unverified, label it. Your next session, and every contributor reading
your PR, inherits whatever you said — make sure it's true.

### Privacy beats convenience

This is The Librarian. Privacy is the product, not a feature. The
off-record gate stops all automatic recording — never bypass it, never
"just for debugging." Bearer tokens go in headers, never in URLs or
logs or error messages. The privacy-marker list is shared across all
five Librarian plugins (Claude Code, Codex, Hermes, OpenCode, Pi) —
**five peer implementations of the same behaviour, no single canonical
source any longer.** Any marker-list change must land coordinated
across all five repos in one go (or none).

### Fail-soft, never block the user's turn

A Librarian / network / parse failure must never throw out of a harness
hook, never block a prompt from reaching the model, never leak a stack
trace into the model's context. Log to the local sidecar, return the
no-op response, move on. The Librarian server can be down for an hour
and the user's day shouldn't notice.

### The cross-repo contracts are sacred

Three things stay consistent across the family. Don't change any of
them in one repo without changing all of them in the same coordinated
push, and never invent new ones unilaterally:

- **Slash commands:** `/handoff`, `/takeover`, `/learn`, and
  `/toggle-private`. Same four verbs across every harness. Canonical
  contract: [`the-librarian/docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md).
- **Memory state model:** memories are `active | proposed | archived`.
  Proposals are accepted / rejected via the dashboard or `update_memory`;
  deletion is `archive_memory`. The retired verbs (`confirm_memory`,
  `reject_memory`, `resolve_conflict`) are gone for good.
- **`source_ref` shape:** `<harness>:<run-id>:cwd:<abs>` when the run
  id is available, else `cwd:<abs>`. This is the cross-harness primary
  key for handoffs and memory.

### Respect your consumers

Open source means people depend on what we ship. Treat that with care.

- **Every user-visible change updates `CHANGELOG.md`.** Add an entry
  under `## [Unreleased]` in the same PR that ships the change — not
  a follow-up. Internal-only refactors can skip; when unsure, add the
  entry (cheap, erasable).
- **Error messages teach.** "Invalid input" is not an error message.
  "Expected ISO-8601 timestamp, got '2026-13-99'" is. Assume the
  reader is new and tired.
- **README is the contract.** If it says one-liner install, that has
  to work on a fresh machine. If it claims a feature, the feature
  exists.

### Open a PR, never push to main

Always branch and PR. One change per PR. Conventional commit subject
(`<type>(<scope>): <subject>`) and a body that explains the *why*; the
diff explains the *what*. When an AI agent meaningfully contributed,
include a `Co-Authored-By:` trailer.

### Releases

User-visible PRs need a release. Bump-size rule (PATCH / MINOR / MAJOR),
trigger criteria, and the full per-repo procedure (two version files
in lockstep — `.codex-plugin/plugin.json` + `package.json` — CHANGELOG
move, tag, GitHub release) live in [`docs/release.md`](./docs/release.md);
the cross-family runbook covering all six repos is at the monorepo's
[`docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).
Read those before cutting a release — don't reinvent the steps.

### Tests are part of the change

Bug fix? Write a regression test first that fails, then make it pass.
New behaviour? It has tests. Trivial doesn't exempt it. Test names
describe behaviour, not function names — `"off the record ends the
attached session within one turn"` beats `"test_handler_3"`. Flakey
tests are bugs; don't paper over with retries.

### Never commit secrets

Tokens, API keys, passwords — they live in environment variables or
the user's secret store, never in code, tests, fixtures, or commit
messages. Bearer tokens never appear in stderr, log files, error
responses, or telemetry. `redirect: "error"` on every outbound HTTPS
call that carries credentials, so a 3xx can't leak the token
cross-origin.

### Don't touch what you don't understand

Comments that say "this is here because of X," tests asserting
non-obvious invariants, ostensibly-dead code with a `// HACK:` or
`// race:` nearby — read them twice. Most of the surprising code in
this family exists because of a real race or a real exploit. Verify
with the human before deleting "obvious dead code."

### When unsure, ask

You don't get points for confidence. You get points for being right.
Surface trade-offs instead of guessing: *"option A is faster but
loses event ordering on a crash; option B is durable but slower —
which matters here?"* Asking makes you a better collaborator, not
a worse one.

## 3. Build, test, verify

```sh
npm install
npm test            # unit tests via node:test
npm run validate    # manifest + hooks + marketplace + bundle shape gate
npm run build       # esbuild → plugins/the-librarian/bin/librarian-codex-hook.js
npm run smoke       # mock-Librarian end-to-end across all 4 hook events
```

CI runs all four on Node 20 / 22 / 24 plus a bundle-drift check.

## 4. Gotchas (repo-specific)

- **`plugins/the-librarian/bin/librarian-codex-hook.js` IS committed.**
  Users don't run `npm install` — they execute the bundled file directly.
  Always rebuild before committing source changes; CI gates this.
- **`plugins/the-librarian/bin/PROVENANCE.json` is NOT committed.** It's a build receipt
  that embeds the current commit SHA and timestamp, so it drifts every
  commit. Gitignored; regenerated locally and by CI.
- **Hook stdout is protocol.** Don't `console.log` from a handler —
  on `UserPromptSubmit` it would be injected into the model's context.
  All diagnostics go through `src/log.mjs` to a sidecar log.
- **Codex hashes each hook and requires re-approval after every
  plugin update.** Mention this in the PR body when behaviour changes
  so the release note reflects it.
