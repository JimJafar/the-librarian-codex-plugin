#!/usr/bin/env node
// scripts/smoke.mjs
//
// End-to-end smoke: a mock Librarian HTTP server, the real bundled
// bin/librarian-codex-hook.js, and synthetic Codex hook payloads.
//
// sessions-rethink PR 3 — the session subsystem is retired, so the only
// scenarios left exercise conv-state injection (spec §4.9). On every
// UserPromptSubmit:
//   - hit  → the bundle calls `conv_state_get` exactly once and emits the
//            canonical <conversation-state> block via additionalContext.
//   - miss → returns `{}` (the prompt reaches the model unchanged).
//   - misconfig (no token) → returns `{}` without an MCP call.
//   - retired event (e.g. PostCompact) → returns `{}` without an MCP call.
//
// On failure: prints the call log + exits 1. On success: exits 0.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins/the-librarian");
const bin = path.join(pluginRoot, "bin/librarian-codex-hook.js");

if (!fs.existsSync(bin)) {
  console.error(`plugins/the-librarian/bin/librarian-codex-hook.js missing — run 'npm run build' first.`);
  process.exit(1);
}

// --- Mock Librarian -------------------------------------------------------

const allCalls = [];
let convStateRow = null; // staged row object for the next conv_state_get response (no primer)
let convStatePrimer = ""; // staged top-level awareness primer (A2 returns it every call)

// A2 made conv_state_get ALWAYS return a JSON object: with a row →
// `{ ...rowFields, primer }`; with no row → `{ primer }`. The old
// "No conversation state…" prose is gone.
function mockResponse(toolName) {
  allCalls.push({ tool: toolName });
  if (toolName !== "conv_state_get") {
    return `(mock has no response for ${toolName})`;
  }
  const response = convStateRow
    ? { ...convStateRow, primer: convStatePrimer }
    : { primer: convStatePrimer };
  return JSON.stringify(response);
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
        const text = mockResponse(rpc.params.name);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text }] },
          }),
        );
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

async function runHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-smoke-"));
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

(async () => {
  const { server, url } = await startMock();
  const baseEnv = {
    LIBRARIAN_MCP_URL: url,
    LIBRARIAN_AGENT_TOKEN: "smoke-token",
    CODEX_RUN_ID: "smoke-run",
  };

  console.log(`Mock Librarian on ${url}`);

  try {
    console.log("\nScenario 1: UserPromptSubmit with a conv_state hit injects the canonical block");
    {
      const dir = freshTmp();
      convStateRow = {
        conv_id: "codex:run:smoke-run:cwd:/proj",
        harness: "codex",
        domain: "coding",
        session_id: "ses_attached",
        off_record: false,
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
      };
      convStatePrimer = ""; // no primer this scenario — conv-state block only
      const from = snapshotCalls();
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      const parsed = JSON.parse(stdout);
      assert(
        parsed.hookSpecificOutput?.additionalContext?.includes("<conversation-state>"),
        "additionalContext carries the canonical block",
      );
      const block = parsed.hookSpecificOutput.additionalContext;
      assert(block.includes("conv_id: codex:run:smoke-run:cwd:/proj"), "block has conv_id");
      assert(block.includes("off_record: false"), "block has off_record");
      // The retired domain/session_id lines are dropped from the rendered
      // block even when present on the server row.
      assert(!block.includes("domain"), "block omits domain");
      assert(!block.includes("session_id"), "block omits session_id");
      const calls = callsSince(from);
      assert(
        calls.length === 1 && calls[0].tool === "conv_state_get",
        "exactly one MCP call (conv_state_get)",
      );
    }

    console.log("\nScenario 2: UserPromptSubmit with a conv_state miss (no row, no primer) returns {}");
    {
      const dir = freshTmp();
      convStateRow = null;
      convStatePrimer = "";
      const from = snapshotCalls();
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      assert(stdout.trim() === "{}", `stdout is '{}' (got ${JSON.stringify(stdout)})`);
      const calls = callsSince(from);
      assert(
        calls.length === 1 && calls[0].tool === "conv_state_get",
        "still queries conv_state_get once",
      );
    }

    console.log("\nScenario 3: missing token makes UserPromptSubmit a silent no-op");
    {
      const dir = freshTmp();
      const from = snapshotCalls();
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, LIBRARIAN_AGENT_TOKEN: "", PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      assert(stdout.trim() === "{}", `stdout is '{}' (got ${JSON.stringify(stdout)})`);
      const calls = callsSince(from);
      assert(calls.length === 0, "no MCP call attempted without a token");
    }

    console.log("\nScenario 4: a retired hook event returns {} without an MCP call");
    {
      const dir = freshTmp();
      const from = snapshotCalls();
      for (const name of ["SessionStart", "PostCompact", "Stop"]) {
        const { code, stdout } = await runHook(
          { hook_event_name: name, cwd: "/proj" },
          { ...baseEnv, PLUGIN_DATA: dir },
        );
        assert(code === 0, `hook exits 0 on ${name}`);
        assert(stdout.trim() === "{}", `stdout is '{}' on ${name}`);
      }
      const calls = callsSince(from);
      assert(calls.length === 0, "no MCP calls for retired events");
    }

    // --- spec 041 A4 — awareness primer ---------------------------------

    const PRIMER = "You have The Librarian: durable, cross-session memory.";
    const LIBRARIAN_BLOCK = `<librarian>\n${PRIMER}\n</librarian>`;
    const CONV_STATE_BLOCK = [
      "<conversation-state>",
      "  conv_id: codex:run:smoke-run:cwd:/proj",
      "  off_record: false",
      "</conversation-state>",
    ].join("\n");

    console.log("\nScenario 5: row + primer → conv-state block THEN the byte-identical <librarian> block");
    {
      const dir = freshTmp();
      convStateRow = { conv_id: "codex:run:smoke-run:cwd:/proj", off_record: false };
      convStatePrimer = PRIMER;
      const from = snapshotCalls();
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      const block = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert(block === `${CONV_STATE_BLOCK}\n${LIBRARIAN_BLOCK}`, "both blocks, conv-state first");
      const calls = callsSince(from);
      assert(
        calls.length === 1 && calls[0].tool === "conv_state_get",
        "still exactly one MCP call (no second fetch for the primer)",
      );
    }

    console.log("\nScenario 6: NO row + primer → the bare <librarian> block (survives a null row)");
    {
      const dir = freshTmp();
      convStateRow = null;
      convStatePrimer = PRIMER;
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      const block = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert(block === LIBRARIAN_BLOCK, `additionalContext is exactly the <librarian> block (got ${JSON.stringify(block)})`);
      assert(!block.includes("<conversation-state>"), "no conv-state block when there's no row");
    }

    console.log("\nScenario 7: row + empty primer → conv-state block only, no <librarian>");
    {
      const dir = freshTmp();
      convStateRow = { conv_id: "codex:run:smoke-run:cwd:/proj", off_record: false };
      convStatePrimer = "";
      const { code, stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/proj" },
        { ...baseEnv, PLUGIN_DATA: dir },
      );
      assert(code === 0, "hook exits 0");
      const block = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert(block === CONV_STATE_BLOCK, "conv-state block only");
      assert(!block.includes("<librarian>"), "no <librarian> block when the primer is empty");
    }

    console.log("\nsmoke passed.");
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
