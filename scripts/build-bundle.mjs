// scripts/build-bundle.mjs
// Bundle src/dispatch.mjs into bin/librarian-codex-hook.js with esbuild. The
// bundle is committed (it's what users actually run — there's no `npm install`
// at install time on user machines). Also writes bin/PROVENANCE.json so we
// can recover the source SHA + esbuild version that produced the bundle.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const entry = path.join(repoRoot, "src/dispatch.mjs");
const outfile = path.join(repoRoot, "bin/librarian-codex-hook.js");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  outfile,
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  sourcemap: false,
  minify: false, // keep the bundle readable — hook bugs get debugged on user machines
});

fs.chmodSync(outfile, 0o755);

const esbuildVersion = require("esbuild/package.json").version;
let sourceSha = "unknown";
try {
  sourceSha = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
} catch {
  /* git not available — leave as "unknown" */
}

const provenance = {
  source_sha: sourceSha,
  esbuild_version: esbuildVersion,
  built_at: new Date().toISOString(),
  entry: path.relative(repoRoot, entry),
  outfile: path.relative(repoRoot, outfile),
};
fs.writeFileSync(path.join(repoRoot, "bin/PROVENANCE.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");

console.log(`Built ${path.relative(repoRoot, outfile)} (esbuild ${esbuildVersion}, source ${sourceSha.slice(0, 8)})`);
