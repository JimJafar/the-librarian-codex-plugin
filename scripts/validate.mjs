#!/usr/bin/env node
// scripts/validate.mjs
// Pre-commit / pre-tag sanity for the static plugin artefacts. Manifest +
// hooks.json + marketplace.json shape; bundled bin/* has no unbundled
// `require`/`import` of node_modules; the bundled .mcp.json declares the
// stdio proxy with the env_vars allowlist (and no remote ${VAR}-in-url).
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
  // The plugin bundles the Librarian MCP server as a stdio↔HTTP proxy and
  // declares it here. Codex can't expand ${VAR} into a remote HTTP url, but
  // it CAN forward named shell env vars into a bundled stdio server via the
  // .mcp.json `env_vars` allowlist — that's the mechanism we use.
  if (m.mcpServers !== "./.mcp.json") {
    fail(`.codex-plugin/plugin.json: mcpServers must equal './.mcp.json' (the bundled stdio proxy declaration)`);
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
  // The bundled .mcp.json declares ONE stdio server (the proxy). It must NOT
  // use a remote `url`/`type: http` with a ${VAR} template — Codex doesn't
  // expand env vars into a remote URL (openai/codex#7521), which is the bug
  // that retired the old http-typed .mcp.json. The working mechanism is a
  // stdio `command` + the `env_vars` allowlist that forwards the user's
  // URL + token into the spawned proxy.
  const m = readJsonOrFail(".mcp.json");
  if (!m) return;
  const servers = m.mcpServers ?? m.mcp_servers;
  if (!servers || typeof servers !== "object") {
    fail(`.mcp.json: must declare an 'mcpServers' (or 'mcp_servers') object`);
    return;
  }
  const names = Object.keys(servers);
  if (names.length !== 1) {
    fail(`.mcp.json: expected exactly one server, found ${names.length}`);
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.command !== "node") {
      fail(`.mcp.json: server '${name}' must use command 'node' (the bundled proxy is a Node script)`);
    }
    if (!Array.isArray(entry.args) || entry.args.length === 0) {
      fail(`.mcp.json: server '${name}' must pass the proxy path in 'args'`);
    } else if (!entry.args.some((a) => typeof a === "string" && a.includes("bin/librarian-mcp-proxy.js"))) {
      fail(`.mcp.json: server '${name}' args must invoke bin/librarian-mcp-proxy.js`);
    } else if (!entry.args.some((a) => typeof a === "string" && a.includes("${PLUGIN_ROOT}"))) {
      // The path must resolve relative to the plugin install dir; the only
      // portable handle Codex documents is ${PLUGIN_ROOT}.
      fail(`.mcp.json: server '${name}' args must resolve the proxy via \${PLUGIN_ROOT}`);
    }
    // A remote URL field would mean we're back on the broken http path.
    if ("url" in entry || entry.type === "http" || entry.type === "streamable-http") {
      fail(`.mcp.json: server '${name}' must be a stdio server — no remote 'url'/'type: http' (Codex can't expand \${VAR} into a URL)`);
    }
    // The whole point: the per-user URL + token reach the proxy via the
    // env_vars allowlist, not hardcoded anywhere.
    const allow = entry.env_vars;
    for (const v of ["LIBRARIAN_MCP_URL", "LIBRARIAN_AGENT_TOKEN"]) {
      if (!Array.isArray(allow) || !allow.includes(v)) {
        fail(`.mcp.json: server '${name}' env_vars must allowlist ${v}`);
      }
    }
    // No secret may be baked into the manifest.
    const blob = JSON.stringify(entry);
    if (/Bearer\s+\S/.test(blob) || /token["']?\s*[:=]\s*["'][^$]/.test(blob)) {
      fail(`.mcp.json: server '${name}' must not embed a literal token/bearer`);
    }
  }
}

function checkProxyBundle() {
  const bin = path.join(pluginRoot, "bin/librarian-mcp-proxy.js");
  if (!fs.existsSync(bin)) {
    fail(`bin/librarian-mcp-proxy.js: missing — run 'npm run build'`);
    return;
  }
  const body = fs.readFileSync(bin, "utf8");
  if (!body.startsWith("#!/usr/bin/env node")) {
    fail(`bin/librarian-mcp-proxy.js: missing shebang banner`);
  }
  scanBundleDeps(bin, body);
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

// The bundles must be self-contained: any unresolved external import would
// crash at runtime on the user's machine because we don't ship node_modules.
// Allow only Node built-ins. The esbuild output is ESM, so we scan both CJS
// `require()` AND ESM `import … from "…"` / dynamic `import("…")` — checking
// only require() would miss an accidentally-`external`-marked dependency.
function scanBundleDeps(binPath, body) {
  const rel = path.relative(pluginRoot, binPath);
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
      if (!builtins.has(dep)) fail(`${rel}: unbundled dependency '${dep}'`);
    }
  }
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
  scanBundleDeps(bin, body);
}

checkPluginJson();
checkMcpJson();
checkHooksJson();
checkMarketplaceJson();
checkSkillMd();
checkBundle();
checkProxyBundle();

if (errors.length === 0) {
  console.log("OK");
  process.exit(0);
}
console.error(`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
