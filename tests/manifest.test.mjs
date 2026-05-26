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

test("the @librarian skill exists with non-empty SKILL.md", () => {
  const skillPath = path.join(repoRoot, "skills/librarian/SKILL.md");
  assert.ok(fs.existsSync(skillPath), "skills/librarian/SKILL.md must exist");
  const body = fs.readFileSync(skillPath, "utf8");
  assert.ok(body.trim().length > 0, "SKILL.md must not be empty");
});
