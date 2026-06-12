// tests/manifest.test.mjs
// Shape tests for the static plugin artefacts. These run before any code is
// bundled and gate every commit — they catch a typo'd field name long before
// `codex plugin install` tries to load the plugin.
//
// Schema reference: notes/marketplace-shape.md.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins/the-librarian");
const readJson = (rel, base = pluginRoot) => JSON.parse(fs.readFileSync(path.join(base, rel), "utf8"));

test("plugin manifest declares the required core fields", () => {
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal(m.name, "the-librarian", "name must match kebab-case slug used by the marketplace entry");
  assert.match(m.version, /^\d+\.\d+\.\d+$/, "version must be semver");
  assert.equal(typeof m.description, "string");
  assert.ok(m.description.length > 0, "description must not be empty");
  assert.equal(typeof m.author, "object");
  assert.equal(typeof m.author.name, "string");
  assert.equal(m.license, "Apache-2.0");
  assert.ok(Array.isArray(m.keywords) && m.keywords.length > 0);
});

test("plugin manifest carries no skills pointer (bundled skill retired, ADR 0006 #6)", () => {
  const m = readJson(".codex-plugin/plugin.json");
  assert.ok(!("skills" in m), "the skills key must be absent — the plugin no longer ships a bundled skill");
  assert.ok(!fs.existsSync(path.join(pluginRoot, "skills")), "the skills/ directory must be gone");
});

test("plugin manifest declares the interface block the Codex UI needs", () => {
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal(typeof m.interface, "object");
  assert.equal(typeof m.interface.displayName, "string");
  assert.equal(typeof m.interface.shortDescription, "string");
  assert.equal(typeof m.interface.developerName, "string");
  assert.equal(typeof m.interface.category, "string");
  assert.ok(Array.isArray(m.interface.capabilities), "capabilities is an array per the bundled-plugin observation");
});

test("marketplace.json points at this plugin as a local source", () => {
  const m = readJson(".agents/plugins/marketplace.json", repoRoot);
  assert.equal(typeof m.name, "string");
  assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 1);
  const entry = m.plugins.find((p) => p.name === "the-librarian");
  assert.ok(entry, "marketplace.json must list the-librarian as a plugin");
  // Source is nested — see notes/marketplace-shape.md
  assert.equal(typeof entry.source, "object", "source must be an object (not a flat string)");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./plugins/the-librarian", "plugin lives in the conventional plugins/<name>/ subdirectory");
  assert.equal(typeof entry.policy, "object");
});

test("plugin manifest points mcpServers at the bundled .mcp.json", () => {
  // The plugin now bundles the Librarian MCP server as a stdio↔HTTP proxy.
  // Codex can't expand ${VAR} into a remote http url, but it CAN forward
  // named shell env vars into a bundled stdio server via the .mcp.json
  // `env_vars` allowlist — so the per-user URL + token reach the proxy
  // without any manual `codex mcp add`.
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal(m.mcpServers, "./.mcp.json", "mcpServers must point at the bundled .mcp.json");
});

test("the bundled .mcp.json declares one stdio proxy server with the env_vars allowlist", () => {
  const p = path.join(pluginRoot, ".mcp.json");
  assert.ok(fs.existsSync(p), ".mcp.json must exist (it declares the bundled stdio proxy)");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  const servers = m.mcpServers ?? m.mcp_servers;
  assert.equal(typeof servers, "object", "must declare an mcpServers/mcp_servers object");
  const names = Object.keys(servers);
  assert.equal(names.length, 1, "exactly one bundled server");
  const entry = servers[names[0]];
  assert.equal(entry.command, "node", "the proxy is a Node script");
  assert.ok(
    entry.args.some((a) => a.includes("bin/librarian-mcp-proxy.js")),
    "args invoke the bundled proxy",
  );
  assert.ok(
    entry.args.some((a) => a.includes("${PLUGIN_ROOT}")),
    "the proxy path resolves via ${PLUGIN_ROOT}",
  );
  // The whole mechanism: per-user URL + token forwarded via the allowlist.
  for (const v of ["LIBRARIAN_MCP_URL", "LIBRARIAN_AGENT_TOKEN"]) {
    assert.ok(Array.isArray(entry.env_vars) && entry.env_vars.includes(v), `env_vars must allowlist ${v}`);
  }
  // No remote url (the broken http path) and no literal secret.
  assert.ok(!("url" in entry), "stdio server must not carry a remote url");
  assert.ok(!/Bearer\s+\S/.test(JSON.stringify(entry)), "no literal bearer token in the manifest");
});

test("no bundled skill ships with the plugin (ADR 0006 #6)", () => {
  // The auto-loaded "how to use" skill was retired: the per-turn conv-state
  // primer and the MCP tools' own descriptions are now the teaching surface.
  assert.ok(
    !fs.existsSync(path.join(pluginRoot, "skills")),
    "skills/ must be gone — the bundled librarian skill was removed",
  );
});
