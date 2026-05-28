#!/usr/bin/env bash
# scripts/dispatch.sh — the command every Codex hook event runs. Routes to
# the single bundled bin/librarian-codex-hook.js.
#
# NEVER blocks or pollutes stdout — UserPromptSubmit stdout would be injected
# into the model's context. The bundled bin writes its `{}` response on
# stdout itself; we just guard the spawn.
#
# Codex exposes PLUGIN_ROOT (and CLAUDE_PLUGIN_ROOT as a compat alias). We
# accept either so a single bundle works on both harnesses.

set -u

plugin_root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
[ -n "${plugin_root}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

hook_bin="${plugin_root}/bin/librarian-codex-hook.js"
[ -f "${hook_bin}" ] || exit 0

# Propagate PLUGIN_DATA so the bundle can resolve $PLUGIN_DATA (Codex sets it;
# the CLAUDE_PLUGIN_DATA alias may also exist).
export PLUGIN_DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"

# Node receives the hook JSON on stdin; its single line of stdout (`{}`)
# becomes the hook response. Stderr is left for the transcript so a real
# misconfiguration (missing env var) is visible.
node "${hook_bin}" || true
exit 0
