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

test("plugin manifest does NOT declare an mcpServers pointer", () => {
  // Codex's .mcp.json parser doesn't expand ${VAR} in URLs, so we can't
  // ship a portable bundled .mcp.json. Users register the server once
  // via `codex mcp add` (see README). A stale mcpServers field would
  // re-introduce the "relative URL without a base" startup failure.
  const m = readJson(".codex-plugin/plugin.json");
  assert.equal("mcpServers" in m, false, "mcpServers must NOT be declared");
});

test("no bundled .mcp.json ships with the plugin", () => {
  const p = path.join(pluginRoot, ".mcp.json");
  assert.equal(fs.existsSync(p), false, ".mcp.json must NOT exist — Codex's parser doesn't expand env vars in URLs");
});

test("the @librarian skill exists with non-empty SKILL.md", () => {
  const skillPath = path.join(pluginRoot, "skills/librarian/SKILL.md");
  assert.ok(fs.existsSync(skillPath), "skills/librarian/SKILL.md must exist");
  const body = fs.readFileSync(skillPath, "utf8");
  assert.ok(body.trim().length > 0, "SKILL.md must not be empty");
});

test("@librarian SKILL.md stays within the 120-line budget and covers the required sections", () => {
  const body = fs.readFileSync(path.join(pluginRoot, "skills/librarian/SKILL.md"), "utf8");
  const lines = body.split("\n").length;
  assert.ok(lines <= 120, `SKILL.md is ${lines} lines — budget is 120 (per PLAN.md Q5)`);
  // YAML frontmatter required so Codex's skill loader picks up the name + description
  assert.match(body, /^---\nname: librarian\n/, "SKILL.md must start with name=librarian frontmatter");
  assert.match(body, /description:/, "frontmatter must include a description");
  // sessions-rethink PR 3 — the four user-facing verbs replace the
  // old `/lib:session` family. The skill must teach each one.
  for (const verb of ["/handoff", "/takeover", "/learn", "/toggle-private"]) {
    assert.match(body, new RegExp(verb.replace("/", "\\/")), `must document the ${verb} verb`);
  }
  // Memory tools + invariants still required
  assert.match(body, /Memory tools/i, "must document the memory tools");
  assert.match(body, /Invariants/i, "must document the invariants (verify-after-recall, private mode)");
  // Specific invariants the system depends on
  assert.match(body, /verify_memory/, "must teach verify-after-recall");
  assert.match(
    body,
    /\[librarian:private=on\|off\]|private mode/i,
    "must document the in-conversation private marker",
  );
});
