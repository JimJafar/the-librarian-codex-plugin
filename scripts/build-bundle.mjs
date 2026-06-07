// scripts/build-bundle.mjs
// Bundle the plugin's two committed entry points with esbuild:
//   - src/dispatch.mjs        → bin/librarian-codex-hook.js  (the hook)
//   - src/mcp-stdio-proxy.mjs → bin/librarian-mcp-proxy.js   (the bundled
//                               stdio↔HTTP MCP server Codex spawns)
// Both bundles are committed (it's what users actually run — there's no
// `npm install` at install time on user machines). Also writes
// bin/PROVENANCE.json so we can recover the source SHA + esbuild version that
// produced the bundles.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins/the-librarian");
const require = createRequire(import.meta.url);

const targets = [
  { entry: path.join(pluginRoot, "src/dispatch.mjs"), outfile: path.join(pluginRoot, "bin/librarian-codex-hook.js") },
  { entry: path.join(pluginRoot, "src/mcp-stdio-proxy.mjs"), outfile: path.join(pluginRoot, "bin/librarian-mcp-proxy.js") },
];

for (const { entry, outfile } of targets) {
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
    minify: false, // keep the bundles readable — bugs get debugged on user machines
  });
  fs.chmodSync(outfile, 0o755);
}

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
  outputs: targets.map(({ entry, outfile }) => ({
    entry: path.relative(repoRoot, entry),
    outfile: path.relative(repoRoot, outfile),
  })),
};
fs.writeFileSync(path.join(pluginRoot, "bin/PROVENANCE.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");

for (const { outfile } of targets) {
  console.log(`Built ${path.relative(repoRoot, outfile)} (esbuild ${esbuildVersion}, source ${sourceSha.slice(0, 8)})`);
}
