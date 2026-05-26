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
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJsonOrFail(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
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
  if (m.mcpServers && m.mcpServers !== "./.mcp.json") {
    fail(`.codex-plugin/plugin.json: mcpServers must equal './.mcp.json'`);
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

function checkMcpJson() {
  const m = readJsonOrFail(".mcp.json");
  if (!m) return;
  const srv = m.mcpServers?.["the-librarian"];
  if (!srv) {
    fail(`.mcp.json: must register a server named 'the-librarian' (namespaced)`);
    return;
  }
  if (srv.type !== "http") fail(`.mcp.json: server type must be 'http'`);
  if (srv.url !== "${LIBRARIAN_MCP_URL}") fail(`.mcp.json: url must be \${LIBRARIAN_MCP_URL} (env-templated)`);
  if (srv.headers?.Authorization !== "Bearer ${LIBRARIAN_AGENT_TOKEN}") {
    fail(`.mcp.json: Authorization header must be 'Bearer \${LIBRARIAN_AGENT_TOKEN}'`);
  }
}

function checkHooksJson() {
  const m = readJsonOrFail("hooks/hooks.json");
  if (!m) return;
  const required = ["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"];
  for (const event of required) {
    const list = m.hooks?.[event];
    if (!Array.isArray(list) || list.length === 0) {
      fail(`hooks/hooks.json: missing or empty entry for ${event}`);
      continue;
    }
    const cmd = list[0]?.hooks?.[0]?.command ?? "";
    if (!cmd.endsWith("/scripts/dispatch.sh")) {
      fail(`hooks/hooks.json: ${event} must dispatch to scripts/dispatch.sh (got '${cmd}')`);
    }
  }
}

function checkMarketplaceJson() {
  const m = readJsonOrFail(".agents/plugins/marketplace.json");
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
  const p = path.join(repoRoot, "skills/librarian/SKILL.md");
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
  const bin = path.join(repoRoot, "bin/librarian-codex-hook.js");
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
checkMcpJson();
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
