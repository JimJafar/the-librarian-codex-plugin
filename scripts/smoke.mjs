#!/usr/bin/env node
// scripts/smoke.mjs
// End-to-end smoke: a mock Librarian HTTP server, the real bundled
// bin/librarian-codex-hook.js, and synthetic Codex hook payloads.
//
// Each scenario gets a fresh PLUGIN_DATA tmpdir and a fresh mock state, so
// they're independent. Scenarios are sequential — they share the mock
// server, but state is per-PLUGIN_DATA.
//
// On failure: prints a summary + the call log from the mock and exits 1.
// On success: exits 0. This is the CI-equivalent of "did the plugin
// install in Codex and do the right thing on the four events". It does
// NOT verify Codex itself loads the manifest — that's the manual install
// step logged in AUTONOMOUS-BUILD-NOTES.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin/librarian-codex-hook.js");

if (!fs.existsSync(bin)) {
  console.error(`bin/librarian-codex-hook.js missing — run 'npm run build' first.`);
  process.exit(1);
}

// --- Mock Librarian -------------------------------------------------------
// Records every callTool invocation and lets the scenario stage responses.

let nextSessionId = 0;
let staleActive = []; // sessions the mock pretends are 'active' for the next list_sessions
const allCalls = [];

function mockResponse(toolName, args) {
  allCalls.push({ tool: toolName, args });
  switch (toolName) {
    case "start_session": {
      nextSessionId += 1;
      return `Session started.\nID: ses_smoke${nextSessionId}\nStatus: active\nVisibility: ${args.visibility}\n`;
    }
    case "list_sessions": {
      if (staleActive.length === 0) return "No sessions found.\n";
      let body = "Sessions:\n\n";
      staleActive.forEach((id, i) => {
        body += `${i + 1}. [active] stale — proj — codex — cwd:/p — 2026-05-26 — n\n   id: ${id}\n`;
      });
      return body;
    }
    case "pause_session":
      return `Session paused.`;
    case "end_session":
      return `Session ended.`;
    case "checkpoint_session":
      return `Session checkpointed.`;
    case "record_session_event":
      return `Event recorded.`;
    default:
      return `(mock has no response for ${toolName})`;
  }
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ")) {
        res.statusCode = 401;
        res.end();
        return;
      }
      try {
        const rpc = JSON.parse(body);
        const text = mockResponse(rpc.params.name, rpc.params.arguments || {});
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text }] } }));
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

// --- Scenario runner ------------------------------------------------------

async function runHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-smoke-"));
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    console.error("  calls so far:", JSON.stringify(allCalls.slice(-8), null, 2));
    process.exit(1);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function snapshotCalls() {
  return allCalls.length;
}

function callsSince(from) {
  return allCalls.slice(from);
}

// --- Run ------------------------------------------------------------------

(async () => {
  const { server, url } = await startMock();
  const baseEnv = {
    LIBRARIAN_MCP_URL: url,
    LIBRARIAN_AGENT_TOKEN: "smoke-token",
    CODEX_RUN_ID: "smoke-run",
  };

  console.log(`Mock Librarian on ${url}`);

  try {
    // ─────────────────────────────────────────────────────────────────────
    console.log("\nScenario 1: SessionStart(startup) bootstraps a session");
    {
      const dir = freshTmp();
      const from = snapshotCalls();
      const { code, stdout } = await runHook(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      assert(stdout.trim() === "{}", `stdout is '{}' (got ${JSON.stringify(stdout)})`);
      const calls = callsSince(from);
      assert(calls.length === 1 && calls[0].tool === "start_session", "exactly one start_session call");
      const state = readState(dir);
      assert(state.session_id?.startsWith("ses_smoke"), "state.session_id attached");
      assert(state.source_ref === "codex:run:smoke-run:cwd:/proj", "source_ref computed");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\nScenario 2: UserPromptSubmit on existing session makes exactly one MCP call (conv_state_get for §4.9 injection)",
    );
    {
      const dir = freshTmp();
      // Pre-seed state with an attached session.
      fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({
          session_id: "ses_preset",
          source_ref: "cwd:/proj",
          private: false,
          last_checkpoint_at: 1000,
          turns_since_checkpoint: 0,
        }),
      );
      const from = snapshotCalls();
      await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "what's next", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      const calls = callsSince(from);
      // Section §4.9 conv-state injection makes one read-only MCP
      // call per turn (`conv_state_get`); no session/memory writes.
      const writeCalls = calls.filter((c) => c.tool !== "conv_state_get");
      assert(writeCalls.length === 0, "no MCP write calls when already attached + non-marker prompt");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\nScenario 3: 'off the record' ends session and goes private");
    {
      const dir = freshTmp();
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
        session_id: "ses_to_end",
        source_ref: "cwd:/proj",
        private: false,
        last_checkpoint_at: 0,
        turns_since_checkpoint: 0,
      }));
      const from = snapshotCalls();
      await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "off the record", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      const calls = callsSince(from);
      assert(calls.length === 1 && calls[0].tool === "end_session", "end_session called");
      assert(calls[0].args.session_id === "ses_to_end", "ended the attached session");
      const state = readState(dir);
      assert(state.private === true, "state.private flipped");
      assert(state.session_id === null, "state.session_id cleared");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\nScenario 4: Stop on attached session records a per-turn message event");
    {
      const dir = freshTmp();
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
        session_id: "ses_active",
        source_ref: "cwd:/proj",
        private: false,
        last_checkpoint_at: Date.now(),
        turns_since_checkpoint: 0,
      }));
      const from = snapshotCalls();
      await runHook(
        { hook_event_name: "Stop", last_assistant_message: "Refactored the auth module.", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      const calls = callsSince(from);
      assert(calls.length === 1, "exactly one MCP call (no checkpoint yet — debounce)");
      assert(calls[0].tool === "record_session_event", "tool is record_session_event");
      assert(calls[0].args.type === "message", "type=message");
      assert(calls[0].args.summary === "Refactored the auth module.", "summary derived from last_assistant_message");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\nScenario 5: PostCompact triggers checkpoint_session");
    {
      const dir = freshTmp();
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
        session_id: "ses_to_checkpoint",
        source_ref: "cwd:/proj",
        private: false,
        last_checkpoint_at: 100,
        turns_since_checkpoint: 5,
      }));
      const from = snapshotCalls();
      await runHook(
        { hook_event_name: "PostCompact", trigger: "manual", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      const calls = callsSince(from);
      assert(calls.length === 1 && calls[0].tool === "checkpoint_session", "checkpoint_session called");
      const state = readState(dir);
      assert(state.turns_since_checkpoint === 0, "debounce counter reset");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\nScenario 6: SessionStart(resume) bootstraps first then pauses stale-active");
    {
      const dir = freshTmp();
      staleActive = ["ses_oldsmoke-active"];
      const from = snapshotCalls();
      await runHook(
        { hook_event_name: "SessionStart", source: "resume", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      const calls = callsSince(from);
      const seq = calls.map((c) => c.tool);
      assert(JSON.stringify(seq) === JSON.stringify(["start_session", "list_sessions", "pause_session"]),
        `expected start_session → list_sessions → pause_session, got ${JSON.stringify(seq)}`);
      assert(calls[2].args.session_id === "ses_oldsmoke-active", "paused the stale active");
      staleActive = []; // reset
    }

    console.log("\nAll scenarios passed.");
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
