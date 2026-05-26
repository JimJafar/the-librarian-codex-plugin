// src/state-store.mjs
// Local plugin state — attached session_id, off-record flag, checkpoint
// debounce counters. Persisted to ${PLUGIN_DATA}/state.json with an atomic
// write (write tmp → rename) so a hook crash mid-write can't leave the file
// half-rewritten, and so two concurrent hook invocations can serialise via
// withLock without corrupting each other.
//
// Schema is deliberately small + flat: nothing here is durable cross-machine
// — that's the Librarian server's job. This file just remembers what this
// Codex run has attached itself to.

import fs from "node:fs";
import path from "node:path";

const STATE_FILENAME = "state.json";
const LOCK_FILENAME = "state.json.lock";

// Defaults a handler can rely on before the first write.
export const DEFAULT_STATE = Object.freeze({
  session_id: null, // ses_… of the currently-attached Librarian session
  private: false, // off-record flag — UserPromptSubmit hook flips this
  last_checkpoint_at: 0, // epoch ms; used by the debounced-checkpoint policy
  turns_since_checkpoint: 0, // event count since the last checkpoint
  source_ref: null, // canonical source_ref the session was started against
});

function statePath(dataDir) {
  return path.join(dataDir, STATE_FILENAME);
}

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_FILENAME);
}

export async function loadState(dataDir) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.promises.readFile(statePath(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    // Always normalize against DEFAULT_STATE so a partial file from an older
    // plugin version still gives every handler the fields it expects.
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_STATE };
    // A malformed JSON file means somebody (or something) corrupted state on
    // disk. Loudly reset rather than crash every subsequent hook on parse.
    if (err instanceof SyntaxError) return { ...DEFAULT_STATE };
    throw err;
  }
}

export async function saveState(dataDir, state) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const final = statePath(dataDir);
  // process.pid + a high-entropy random suffix make concurrent writers' tmp
  // names disjoint, so rename() can never accidentally clobber another
  // writer's not-yet-renamed file.
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.promises.rename(tmp, final); // POSIX-atomic on the same filesystem
}

// withLock: serialise a load → mutate → save sequence across concurrent hook
// invocations. The race we care about is openai/codex#15266 — SessionStart and
// UserPromptSubmit firing simultaneously on the first prompt and both
// attempting to start a session. The lock makes the second one read the
// first's session_id and bail.
//
// Implementation: O_EXCL on the lockfile. On EEXIST, spin briefly (random
// backoff to avoid lock-step retries) up to `timeoutMs`, then steal the lock
// only if it is older than `staleMs` (a previous hook crashed after acquiring
// without releasing).
export async function withLock(dataDir, fn, { timeoutMs = 2000, staleMs = 5000 } = {}) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const lock = lockPath(dataDir);
  const start = Date.now();
  let handle = null;
  while (handle === null) {
    try {
      handle = await fs.promises.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Try to steal a stale lock.
      try {
        const stat = await fs.promises.stat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.promises.unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        // The other side released between our open() and stat(). Loop.
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`state-store: could not acquire lock within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    await fs.promises.unlink(lock).catch(() => {});
  }
}
