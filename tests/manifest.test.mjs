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
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

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

test("plugin manifest declares the skills pointer", () => {
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal(m.skills, "./skills/", "skills must point at the conventional dir for the Codex loader to find SKILL.md files");
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
  const m = readJson(".agents/plugins/marketplace.json");
  assert.equal(typeof m.name, "string");
  assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 1);
  const entry = m.plugins.find((p) => p.name === "the-librarian");
  assert.ok(entry, "marketplace.json must list the-librarian as a plugin");
  // Source is nested — see notes/marketplace-shape.md
  assert.equal(typeof entry.source, "object", "source must be an object (not a flat string)");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./", "local source points at the repo root");
  assert.equal(typeof entry.policy, "object");
});

test("plugin manifest points at the bundled MCP servers file", () => {
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal(m.mcpServers, "./.mcp.json", "mcpServers must point at the plugin-bundled .mcp.json so Codex auto-registers the-librarian on install");
});

test(".mcp.json declares the-librarian as an HTTP MCP server templated from env vars", () => {
  const m = readJson(".mcp.json");
  assert.equal(typeof m.mcpServers, "object");
  const server = m.mcpServers["the-librarian"];
  assert.ok(server, "server must be registered under the namespaced name 'the-librarian'");
  assert.equal(server.type, "http", "transport is HTTP (remote Librarian)");
  assert.equal(server.url, "${LIBRARIAN_MCP_URL}", "url is templated from the user's env so the same plugin works against any deployment");
  assert.equal(typeof server.headers, "object");
  assert.equal(
    server.headers.Authorization,
    "Bearer ${LIBRARIAN_AGENT_TOKEN}",
    "bearer token comes from env — never committed",
  );
});

test("the @librarian skill exists with non-empty SKILL.md", () => {
  const skillPath = path.join(repoRoot, "skills/librarian/SKILL.md");
  assert.ok(fs.existsSync(skillPath), "skills/librarian/SKILL.md must exist");
  const body = fs.readFileSync(skillPath, "utf8");
  assert.ok(body.trim().length > 0, "SKILL.md must not be empty");
});

test("@librarian SKILL.md stays within the 120-line budget and covers the required sections", () => {
  const body = fs.readFileSync(path.join(repoRoot, "skills/librarian/SKILL.md"), "utf8");
  const lines = body.split("\n").length;
  assert.ok(lines <= 120, `SKILL.md is ${lines} lines — budget is 120 (per PLAN.md Q5)`);
  // YAML frontmatter required so Codex's skill loader picks up the name + description
  assert.match(body, /^---\nname: librarian\n/, "SKILL.md must start with name=librarian frontmatter");
  assert.match(body, /description:/, "frontmatter must include a description");
  // Three required sections: verb table, memory tools, invariants
  assert.match(body, /Canonical verbs/i, "must document the canonical verbs");
  assert.match(body, /Memory tools/i, "must document the memory tools");
  assert.match(body, /Invariants/i, "must document the invariants (verify-after-recall, privacy, capture mode)");
  // Specific invariants the system depends on
  assert.match(body, /verify_memory/, "must teach verify-after-recall");
  assert.match(body, /off the record/i, "must reference the privacy markers");
  assert.match(body, /capture_mode/, "must document capture_mode default");
});
