// src/log.mjs
// Append-only structured log to ${PLUGIN_DATA}/log.jsonl. Hooks must never
// throw on a log failure — best-effort write, swallow errors. This is for
// post-hoc debugging from the user's machine, not for telemetry.
//
// Rotation: at MAX_LOG_BYTES we rename the current file to log.jsonl.1
// (overwriting any prior .1) and start fresh. One generation is enough — the
// log is a debug sidecar, not an audit trail. Stat-before-append adds one
// syscall per hook event but it's sub-millisecond on local fs.

import fs from "node:fs";
import path from "node:path";

const LOG_FILENAME = "log.jsonl";
const ROTATED_FILENAME = "log.jsonl.1";
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function log(dataDir, entry) {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, LOG_FILENAME);
    await rotateIfNeeded(dataDir, file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(file, line, "utf8");
  } catch {
    // Best-effort. Never block a hook on log failure.
  }
}

async function rotateIfNeeded(dataDir, file) {
  let size;
  try {
    const stat = await fs.promises.stat(file);
    size = stat.size;
  } catch (err) {
    if (err.code === "ENOENT") return; // No file yet — nothing to rotate.
    return; // Any other stat error: skip rotation, proceed to append.
  }
  if (size < MAX_LOG_BYTES) return;
  const rotated = path.join(dataDir, ROTATED_FILENAME);
  try {
    // POSIX rename overwrites the destination atomically, so any previous .1
    // is replaced in one step. On the rare error (cross-device, permission)
    // we swallow and append to the over-cap file rather than dropping the
    // log line — bounded growth is the goal, not zero growth.
    await fs.promises.rename(file, rotated);
  } catch {
    /* swallow — best-effort */
  }
}
