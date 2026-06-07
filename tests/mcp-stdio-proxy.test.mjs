// tests/mcp-stdio-proxy.test.mjs
//
// The stdio↔HTTP proxy is the bundled Codex MCP server. The security-critical
// guarantees mirror the HTTP client:
//   1. The bearer token reaches the Librarian in the Authorization header.
//   2. The token NEVER appears on the proxy's stdout or stderr.
//   3. A transport / HTTP / parse failure becomes a JSON-RPC error response
//      (id-correlated) — the process never crashes, never hangs.
//   4. Missing env → a clear one-time stderr diagnostic + JSON-RPC errors.
//
// Two layers of test:
//   - Unit: handleLine / senderFromEnv / makeLogOnce in-process (fast, exact).
//   - Subprocess round-trip: the *real* src/mcp-stdio-proxy.mjs spawned as a
//     child against a stub HTTP MCP server — the genuine stdin→HTTP→stdout
//     path Codex will drive.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  handleLine,
  jsonRpcError,
  makeLogOnce,
  senderFromEnv,
} from "../plugins/the-librarian/src/mcp-stdio-proxy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proxyPath = path.join(repoRoot, "plugins/the-librarian/src/mcp-stdio-proxy.mjs");

const DUMMY_TOKEN = "dummy-proxy-token";

// --- Stub Librarian HTTP MCP server --------------------------------------

// Stands up an HTTP server that records each request and answers per the
// supplied handler. `handler({ rpc, auth })` returns { status, body } or, by
// default, echoes a JSON-RPC result.
function startStub(handler) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const auth = req.headers.authorization || "";
      let rpc = null;
      try {
        rpc = JSON.parse(raw);
      } catch {
        /* leave null */
      }
      requests.push({ auth, rpc, raw });
      const out = handler ? handler({ rpc, auth }) : null;
      if (out === "drop") {
        // Simulate a connection reset.
        req.socket.destroy();
        return;
      }
      const status = out?.status ?? 200;
      const body =
        out?.body ??
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc?.id ?? null,
          result: { ok: true, method: rpc?.method },
        });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

// Run the real proxy as a subprocess, feed `lines` to stdin, collect stdout +
// stderr until it exits.
function runProxySubprocess(lines, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [proxyPath], {
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    for (const line of lines) child.stdin.write(line + "\n");
    child.stdin.end();
  });
}

function parseLines(stdout) {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// --- Unit: handleLine -----------------------------------------------------

test("handleLine relays a JSON-RPC response verbatim on the happy path", async () => {
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send() {
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }) };
    },
  };
  const out = await handleLine('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', sender, () => {});
  assert.deepEqual(out, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
});

test("handleLine forwards the request body verbatim to the sender", async () => {
  let seen = null;
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send(body) {
      seen = body;
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) };
    },
  };
  const line = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"x":1}}';
  await handleLine(line, sender, () => {});
  assert.equal(seen, line, "the exact request line is POSTed (no re-serialisation drift)");
});

test("handleLine preserves the request id on a transport error", async () => {
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send() {
      throw new Error("boom");
    },
  };
  const out = await handleLine('{"jsonrpc":"2.0","id":42,"method":"recall"}', sender, () => {});
  assert.equal(out.jsonrpc, "2.0");
  assert.equal(out.id, 42);
  assert.equal(out.error.code, -32603);
  assert.match(out.error.message, /the-librarian MCP proxy/);
});

test("handleLine turns a non-200 into an id-correlated JSON-RPC error", async () => {
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send() {
      return { status: 500, body: "" };
    },
  };
  const out = await handleLine('{"jsonrpc":"2.0","id":"abc","method":"recall"}', sender, () => {});
  assert.equal(out.id, "abc");
  assert.match(out.error.message, /HTTP 500/);
});

test("handleLine turns a non-JSON server body into a JSON-RPC error", async () => {
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send() {
      return { status: 200, body: "<html>not json</html>" };
    },
  };
  const out = await handleLine('{"jsonrpc":"2.0","id":1,"method":"recall"}', sender, () => {});
  assert.match(out.error.message, /non-JSON/);
});

test("handleLine answers a parse error with id null and an invalid-request code", async () => {
  const out = await handleLine("{not valid json", { send: async () => {} }, () => {});
  assert.equal(out.id, null);
  assert.equal(out.error.code, -32600);
});

test("handleLine returns null for a notification (no id) — no reply is written", async () => {
  let called = false;
  const sender = {
    safeEndpoint: "https://example.com/mcp",
    async send() {
      called = true;
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", result: {} }) };
    },
  };
  const out = await handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', sender, () => {});
  assert.equal(out, null, "a notification gets no JSON-RPC reply");
  assert.equal(called, true, "but it is still forwarded to the server");
});

test("handleLine returns null for an empty / whitespace line", async () => {
  assert.equal(await handleLine("   ", { send: async () => {} }, () => {}), null);
});

test("handleLine with no sender (misconfigured) returns a config error per request", async () => {
  let logged = "";
  const logOnce = (m) => (logged += m);
  const out = await handleLine('{"jsonrpc":"2.0","id":1,"method":"recall"}', null, logOnce);
  assert.equal(out.id, 1);
  assert.match(out.error.message, /not configured/);
  assert.match(logged, /LIBRARIAN_MCP_URL/);
});

// --- Unit: senderFromEnv / makeLogOnce ------------------------------------

test("senderFromEnv returns null when either env var is missing", () => {
  assert.equal(senderFromEnv({ LIBRARIAN_MCP_URL: "https://x/mcp" }), null);
  assert.equal(senderFromEnv({ LIBRARIAN_AGENT_TOKEN: "t" }), null);
  assert.equal(senderFromEnv({}), null);
});

test("senderFromEnv returns null for an invalid endpoint (no throw)", () => {
  assert.equal(
    senderFromEnv({ LIBRARIAN_MCP_URL: "ftp://x/mcp", LIBRARIAN_AGENT_TOKEN: "t" }),
    null,
  );
  assert.equal(
    senderFromEnv({ LIBRARIAN_MCP_URL: "https://user:pw@x/mcp", LIBRARIAN_AGENT_TOKEN: "t" }),
    null,
  );
});

test("senderFromEnv builds a sender when both vars are valid", () => {
  const s = senderFromEnv({ LIBRARIAN_MCP_URL: "https://x/mcp", LIBRARIAN_AGENT_TOKEN: "t" });
  assert.equal(typeof s.send, "function");
});

test("makeLogOnce writes only the first time", () => {
  const seen = [];
  const logOnce = makeLogOnce((s) => seen.push(s));
  logOnce("a");
  logOnce("b");
  assert.deepEqual(seen, ["a\n"]);
});

test("jsonRpcError coerces an absent id to null", () => {
  assert.equal(jsonRpcError(undefined, -32603, "x").id, null);
  assert.equal(jsonRpcError(0, -32603, "x").id, 0);
});

// --- Subprocess round-trip ------------------------------------------------

test("round-trip: proxy relays initialize + tools/list, id-correlated", async () => {
  const { server, requests, url } = await startStub(({ rpc }) => ({
    status: 200,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: rpc.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "recall" }] },
    }),
  }));
  try {
    const { code, stdout } = await runProxySubprocess(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      ],
      { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: DUMMY_TOKEN },
    );
    assert.equal(code, 0, "proxy exits 0 after stdin closes");
    const responses = parseLines(stdout);
    assert.equal(responses.length, 2, "one response per request");
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, "2025-06-18");
    assert.equal(responses[1].id, 2);
    assert.deepEqual(responses[1].result.tools, [{ name: "recall" }]);
    assert.equal(requests.length, 2, "stub saw both requests");
  } finally {
    server.close();
  }
});

test("auth: the stub receives Bearer <token>; the token never leaks to stdout/stderr", async () => {
  const { server, requests, url } = await startStub();
  try {
    const { stdout, stderr } = await runProxySubprocess(
      ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
      { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: DUMMY_TOKEN },
    );
    assert.equal(requests[0].auth, `Bearer ${DUMMY_TOKEN}`, "bearer arrives in the Authorization header");
    assert.ok(!stdout.includes(DUMMY_TOKEN), "token never appears on stdout");
    assert.ok(!stderr.includes(DUMMY_TOKEN), "token never appears on stderr");
  } finally {
    server.close();
  }
});

test("fail-soft: a 500 from the Librarian becomes a JSON-RPC error, not a crash", async () => {
  const { server, url } = await startStub(() => ({ status: 500, body: "boom" }));
  try {
    const { code, stdout, stderr } = await runProxySubprocess(
      ['{"jsonrpc":"2.0","id":9,"method":"recall"}'],
      { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: DUMMY_TOKEN },
    );
    assert.equal(code, 0, "proxy exits cleanly even on a 500");
    const [resp] = parseLines(stdout);
    assert.equal(resp.id, 9);
    assert.match(resp.error.message, /HTTP 500/);
    assert.ok(!stderr.includes(DUMMY_TOKEN), "token not leaked on the error path");
  } finally {
    server.close();
  }
});

test("fail-soft: connection refused becomes a JSON-RPC error, not a crash", async () => {
  // Point at a port nothing is listening on. (Bind one, capture the port,
  // close it, then use that dead port.)
  const { server, url } = await startStub();
  await new Promise((r) => server.close(r));
  const { code, stdout } = await runProxySubprocess(
    ['{"jsonrpc":"2.0","id":3,"method":"recall"}'],
    { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: DUMMY_TOKEN },
  );
  assert.equal(code, 0, "proxy survives a refused connection");
  const [resp] = parseLines(stdout);
  assert.equal(resp.id, 3);
  assert.equal(resp.error.code, -32603);
});

test("missing env: proxy emits a one-time stderr diagnostic + JSON-RPC errors, no hang", async () => {
  const { code, stdout, stderr } = await runProxySubprocess(
    [
      '{"jsonrpc":"2.0","id":1,"method":"recall"}',
      '{"jsonrpc":"2.0","id":2,"method":"recall"}',
    ],
    {}, // no LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN
  );
  assert.equal(code, 0, "proxy exits 0 (no hang) even unconfigured");
  const responses = parseLines(stdout);
  assert.equal(responses.length, 2, "every request still gets an error response");
  assert.match(responses[0].error.message, /not configured/);
  assert.match(stderr, /LIBRARIAN_MCP_URL/, "a clear stderr diagnostic");
  // The diagnostic is one-time: the env-var hint should appear exactly once
  // even across two requests + the eager startup log.
  const occurrences = stderr.split("LIBRARIAN_MCP_URL").length - 1;
  assert.equal(occurrences, 1, "the diagnostic is logged once, not per request");
});

test("a notification sent over stdio produces no stdout line", async () => {
  const { server, url } = await startStub();
  try {
    const { stdout } = await runProxySubprocess(
      [
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":5,"method":"tools/list"}',
      ],
      { LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: DUMMY_TOKEN },
    );
    const responses = parseLines(stdout);
    assert.equal(responses.length, 1, "only the request with an id gets a reply");
    assert.equal(responses[0].id, 5);
  } finally {
    server.close();
  }
});
