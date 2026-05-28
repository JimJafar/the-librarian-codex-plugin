#!/usr/bin/env node
// scripts/validate.mjs
// Pre-commit / pre-tag sanity for the static plugin artefacts. Manifest +
// hooks.json + marketplace.json shape; bundled bin/* has no unbundled
// `require`/`import` of node_modules; .mcp.json env templating intact.
//
// Exits 0 with `OK` on success; exits 1 with a list of findings on failure.
// Reuses the test-runner-friendly checks in tests/manifest.test.mjs so we
// have a single source of truth for the expected shape.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins/the-librarian");
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJsonOrFail(rel, base = pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, rel), "utf8"));
  } catch (err) {
    fail(`${rel}: ${err.code === "ENOENT" ? "missing" : `invalid JSON (${err.message})`}`);
    return null;
  }
}

function checkPluginJson() {
  const m = readJsonOrFail(".codex-plugin/plugin.json");
  if (!m) return;
  const required = ["name", "version", "description", "author", "license", "skills", "interface"];
  for (const f of required) if (!(f in m)) fail(`.codex-plugin/plugin.json: missing required field '${f}'`);
  if (m.name && !/^[a-z][a-z0-9-]*$/.test(m.name)) fail(`.codex-plugin/plugin.json: name must be kebab-case`);
  if (m.version && !/^\d+\.\d+\.\d+/.test(m.version)) fail(`.codex-plugin/plugin.json: version must be semver`);
  if (m.skills !== "./skills/") fail(`.codex-plugin/plugin.json: skills must equal './skills/'`);
  if ("mcpServers" in m) {
    // Codex's .mcp.json parser doesn't expand ${VAR} in URLs, so users
    // register the MCP server manually via `codex mcp add` (see README).
    // A stale mcpServers pointer would re-introduce the "relative URL
    // without a base" startup failure.
    fail(`.codex-plugin/plugin.json: must NOT declare mcpServers (Codex registers it manually; see README)`);
  }
  if (m.hooks && m.hooks !== "./hooks/hooks.json") {
    fail(`.codex-plugin/plugin.json: hooks must equal './hooks/hooks.json'`);
  }
  if (m.interface) {
    for (const f of ["displayName", "shortDescription", "developerName", "category", "capabilities"]) {
      if (!(f in m.interface)) fail(`.codex-plugin/plugin.json: interface.${f} is required`);
    }
    if (!Array.isArray(m.interface.capabilities)) fail(`.codex-plugin/plugin.json: interface.capabilities must be an array`);
  }
}

function checkMcpJsonAbsent() {
  // See checkPluginJson: bundled .mcp.json was retired because Codex's
  // parser treats ${LIBRARIAN_MCP_URL} as a literal. Guard against
  // accidentally re-introducing it.
  const p = path.join(pluginRoot, ".mcp.json");
  if (fs.existsSync(p)) {
    fail(`plugins/the-librarian/.mcp.json: must NOT exist (Codex doesn't expand \${VAR} in URLs; users register via 'codex mcp add')`);
  }
}

function checkHooksJson() {
  const m = readJsonOrFail("hooks/hooks.json");
  if (!m) return;
  // sessions-rethink PR 3 — only UserPromptSubmit survives. The retired
  // SessionStart / PostCompact / Stop hooks must NOT be registered (an
  // operator who already approved them in Codex would still see them
  // fire; this guard catches stale config drift).
  const list = m.hooks?.UserPromptSubmit;
  if (!Array.isArray(list) || list.length === 0) {
    fail(`hooks/hooks.json: missing or empty entry for UserPromptSubmit`);
  } else {
    const cmd = list[0]?.hooks?.[0]?.command ?? "";
    if (!cmd.endsWith("/scripts/dispatch.sh")) {
      fail(`hooks/hooks.json: UserPromptSubmit must dispatch to scripts/dispatch.sh (got '${cmd}')`);
    }
  }
  for (const retired of ["SessionStart", "PostCompact", "Stop"]) {
    if (m.hooks?.[retired]) {
      fail(`hooks/hooks.json: retired ${retired} hook is still registered`);
    }
  }
}

function checkMarketplaceJson() {
  const m = readJsonOrFail(".agents/plugins/marketplace.json", repoRoot);
  if (!m) return;
  if (!m.name) fail(`.agents/plugins/marketplace.json: missing 'name'`);
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) {
    fail(`.agents/plugins/marketplace.json: 'plugins' must be a non-empty array`);
    return;
  }
  const entry = m.plugins.find((p) => p.name === "the-librarian");
  if (!entry) {
    fail(`.agents/plugins/marketplace.json: must list a plugin named 'the-librarian'`);
    return;
  }
  if (typeof entry.source !== "object" || !entry.source.source) {
    // Per notes/marketplace-shape.md the source is nested, not flat.
    fail(`.agents/plugins/marketplace.json: entry.source must be an object with a nested 'source' discriminator`);
  }
  if (!entry.policy?.installation || !entry.policy?.authentication) {
    fail(`.agents/plugins/marketplace.json: entry.policy.installation and .authentication are required`);
  }
}

function checkSkillMd() {
  const p = path.join(pluginRoot, "skills/librarian/SKILL.md");
  if (!fs.existsSync(p)) {
    fail(`skills/librarian/SKILL.md: missing`);
    return;
  }
  const body = fs.readFileSync(p, "utf8");
  if (body.trim().length === 0) fail(`skills/librarian/SKILL.md: empty`);
  if (!/^---\nname: librarian\n/.test(body)) fail(`skills/librarian/SKILL.md: must start with 'name: librarian' frontmatter`);
  const lines = body.split("\n").length;
  if (lines > 120) fail(`skills/librarian/SKILL.md: ${lines} lines exceeds the 120-line budget`);
}

function checkBundle() {
  const bin = path.join(pluginRoot, "bin/librarian-codex-hook.js");
  if (!fs.existsSync(bin)) {
    fail(`bin/librarian-codex-hook.js: missing — run 'npm run build'`);
    return;
  }
  const body = fs.readFileSync(bin, "utf8");
  if (!body.startsWith("#!/usr/bin/env node")) {
    fail(`bin/librarian-codex-hook.js: missing shebang banner`);
  }
  // The bundle must be self-contained: any unresolved external import would
  // crash at hook runtime on the user's machine because we don't ship
  // node_modules. Allow only Node built-ins. The esbuild output is ESM, so
  // we have to scan both CJS `require()` AND ESM `import … from "…"` /
  // dynamic `import("…")` — checking only require() would miss an
  // accidentally-`external`-marked dependency.
  const builtins = new Set([
    "node:fs", "node:path", "node:url", "node:os", "node:child_process",
    "node:module", "node:buffer", "node:stream", "node:events", "node:crypto",
    "fs", "path", "url", "os", "child_process", "module", "buffer", "stream",
    "events", "crypto", "node:async_hooks",
  ]);
  const patterns = [
    /require\(["']([^"']+)["']\)/g,
    /(?:^|[\s;])(?:import|export)\s[\s\S]*?from\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  let m;
  for (const re of patterns) {
    re.lastIndex = 0;
    while ((m = re.exec(body))) {
      const dep = m[1];
      if (!builtins.has(dep)) fail(`bin/librarian-codex-hook.js: unbundled dependency '${dep}'`);
    }
  }
}

checkPluginJson();
checkMcpJsonAbsent();
checkHooksJson();
checkMarketplaceJson();
checkSkillMd();
checkBundle();

if (errors.length === 0) {
  console.log("OK");
  process.exit(0);
}
console.error(`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
