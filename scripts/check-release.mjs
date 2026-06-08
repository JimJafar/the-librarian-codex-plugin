#!/usr/bin/env node
// Release-hygiene guard — the "every merge to main IS a release" model.
// (Ported from the-librarian monorepo; see its docs/release.md.)
//
// This repo has NO `## [Unreleased]` CHANGELOG section and NO separate
// "cut a release" PR. Every PR that merges to `main` bumps the version and
// files its notes under a dated `## [X.Y.Z] — YYYY-MM-DD` heading; the push to
// `main` then auto-cuts the git tag + GitHub release (.github/workflows/release.yml),
// and the existing tag-triggered flows take it from there.
//
// Codex carries the version in TWO files that must agree: `package.json` and
// `.codex-plugin/plugin.json`.
//
// ── Checks (working-tree only, no network) ───────────────────────────────────
//   1. CHANGELOG.md has NO `## [Unreleased]` heading or `[Unreleased]:` link.
//   2. package.json and .codex-plugin/plugin.json carry the SAME version.
//   3. The TOP-MOST `## [X.Y.Z] — YYYY-MM-DD` heading === that version.
//   4. The date is a real ISO-8601 calendar date.
//   5. A `[X.Y.Z]:` compare-link exists at the bottom for that version.
//   Plus, when RELEASE_BASE_VERSION is set (CI passes the base-main version on
//   PR branches): the version must be strictly greater (the PR actually bumped).
//
// Usage:
//   node scripts/check-release.mjs            # guard (exit 1 on any violation)
//   node scripts/check-release.mjs --notes    # print the top version's notes body

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const pkgPath = path.join(repoRoot, "package.json");
const pluginPath = path.join(repoRoot, "plugins", "the-librarian", ".codex-plugin", "plugin.json");

const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
const pluginVersion = JSON.parse(fs.readFileSync(pluginPath, "utf8")).version;
const changelog = fs.readFileSync(changelogPath, "utf8");
const lines = changelog.split("\n");

const HEADING = /^## \[(\d+\.\d+\.\d+)\]\s*[—-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
const HEADING_LOOSE = /^## \[(\d+\.\d+\.\d+)\]/;

function findTopHeading() {
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_LOOSE.test(lines[i])) return { line: lines[i], index: i };
  }
  return null;
}

if (process.argv.includes("--notes")) {
  const top = findTopHeading();
  if (!top) {
    console.error("[check-release] no release heading found in CHANGELOG.md");
    process.exit(1);
  }
  const body = [];
  for (let i = top.index + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  process.stdout.write(`${body.join("\n").trim()}\n`);
  process.exit(0);
}

const failures = [];

if (/^## \[Unreleased\]/m.test(changelog) || /^\[Unreleased\]:/m.test(changelog)) {
  failures.push(
    "CHANGELOG.md still has an `## [Unreleased]` heading or an `[Unreleased]:` link " +
      "reference. File your notes directly under a dated `## [X.Y.Z] — YYYY-MM-DD` " +
      "heading for the version this PR ships, and link it as `[X.Y.Z]:` at the bottom.",
  );
}

if (pkgVersion !== pluginVersion) {
  failures.push(
    `Version mismatch between files: package.json is ${pkgVersion} but ` +
      `.codex-plugin/plugin.json is ${pluginVersion}. Bump both together.`,
  );
}

const top = findTopHeading();
if (!top) {
  failures.push("CHANGELOG.md has no `## [X.Y.Z]` release heading at all.");
} else {
  const strict = top.line.match(HEADING);
  if (!strict) {
    failures.push(
      `Top CHANGELOG heading is malformed: "${top.line.trim()}". ` +
        "Expected `## [X.Y.Z] — YYYY-MM-DD` (e.g. `## [0.4.1] — 2026-06-08`).",
    );
  } else {
    const [, headingVersion, date] = strict;

    if (headingVersion !== pkgVersion) {
      failures.push(
        `Version mismatch: package.json is ${pkgVersion} but the top CHANGELOG ` +
          `entry is [${headingVersion}]. The version you ship must be the newest section.`,
      );
    }

    const d = new Date(`${date}T00:00:00Z`);
    const roundTrips = !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
    if (!roundTrips) {
      failures.push(
        `Top CHANGELOG entry has an invalid date "${date}" (expected a real YYYY-MM-DD).`,
      );
    }

    const linkRef = new RegExp(`^\\[${headingVersion.replace(/\./g, "\\.")}\\]:\\s+https?://`, "m");
    if (!linkRef.test(changelog)) {
      failures.push(
        `Missing the \`[${headingVersion}]:\` compare-link at the bottom of CHANGELOG.md.`,
      );
    }
  }
}

const baseVersion = (process.env.RELEASE_BASE_VERSION || "").trim();
if (baseVersion && top) {
  if (!semverGt(pkgVersion, baseVersion)) {
    failures.push(
      `Version was not bumped: this branch is ${pkgVersion} but base main is ` +
        `${baseVersion}. Every PR must raise the version (PATCH at minimum).`,
    );
  }
}

if (failures.length) {
  console.error("[check-release] FAIL — release hygiene violated:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nThe model: every PR bumps the version (package.json + .codex-plugin/plugin.json) " +
      "+ files a dated `## [X.Y.Z]` CHANGELOG entry (no `[Unreleased]`); merging to main " +
      "auto-cuts the tag + release.",
  );
  process.exit(1);
}

console.log(
  `[check-release] OK: v${pkgVersion} is the top CHANGELOG entry, dated, linked, no [Unreleased]` +
    (baseVersion ? ` (bumped from base ${baseVersion}).` : "."),
);

function semverGt(a, b) {
  const core = (v) => v.split(/[-+]/)[0].split(".").map(Number);
  const [a1, a2, a3] = core(a);
  const [b1, b2, b3] = core(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
