// src/log.mjs
// Append-only structured log to ${PLUGIN_DATA}/log.jsonl. Hooks must never
// throw on a log failure — best-effort write, swallow errors. This is for
// post-hoc debugging from the user's machine, not for telemetry.

import fs from "node:fs";
import path from "node:path";

const LOG_FILENAME = "log.jsonl";

export async function log(dataDir, entry) {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(path.join(dataDir, LOG_FILENAME), line, "utf8");
  } catch {
    // Best-effort. Never block a hook on log failure.
  }
}
