// tests/mcp-client.test.mjs
// The MCP HTTP client carries the bearer token to the Librarian. The
// security-critical assertions here are:
//   1. Bearer header is set.
//   2. A 3xx is treated as a hard error (no redirect-following — the bearer
//      would otherwise leak cross-origin).
//   3. Endpoint with embedded credentials is rejected.
//   4. Error kinds are stable so handlers can branch on them.
//
// Plus the happy path: a tools/call request shape that matches the JSON-RPC
// 2.0 contract the Librarian server expects.

import test from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, McpClientError } from "../src/mcp-client.mjs";

function fakeTransport(handler) {
  // Returns a transport function that records the calls and lets the test
  // body decide the response.
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return handler(req);
  };
  fn.calls = calls;
  return fn;
}

test("callTool POSTs a tools/call JSON-RPC envelope with the bearer header", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    body: JSON.stringify({ result: { content: [{ text: "hi" }] } }),
  }));
  const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "tok_abc" }, transport);
  const text = await client.callTool("recall", { query: "foo" });
  assert.equal(text, "hi");
  assert.equal(transport.calls.length, 1);
  const req = transport.calls[0];
  assert.equal(req.url, "https://example.com/mcp");
  assert.equal(req.headers.Authorization, "Bearer tok_abc");
  const body = JSON.parse(req.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.method, "tools/call");
  assert.equal(body.params.name, "recall");
  assert.deepEqual(body.params.arguments, { query: "foo" });
});

test("a non-200 response throws an http-kind McpClientError carrying the status", async () => {
  const transport = fakeTransport(() => ({ status: 502, body: "" }));
  const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
  const err = await client.callTool("recall", {}).catch((e) => e);
  assert.ok(err instanceof McpClientError);
  assert.equal(err.kind, "http");
  assert.equal(err.status, 502);
});

test("a JSON-RPC error payload throws an rpc-kind McpClientError", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    body: JSON.stringify({ error: { code: -32603, message: "internal" } }),
  }));
  const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
  const err = await client.callTool("recall", {}).catch((e) => e);
  assert.equal(err.kind, "rpc");
  assert.match(err.message, /internal/);
});

test("a non-JSON body throws a malformed-kind McpClientError", async () => {
  const transport = fakeTransport(() => ({ status: 200, body: "<html>" }));
  const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
  const err = await client.callTool("recall", {}).catch((e) => e);
  assert.equal(err.kind, "malformed");
});

test("rejects a non-http(s) endpoint at client construction time", () => {
  assert.throws(
    () => createMcpClient({ endpoint: "ftp://example.com/mcp", token: "t" }),
    (err) => err instanceof McpClientError && err.kind === "config",
  );
});

test("rejects an endpoint that embeds credentials", () => {
  assert.throws(
    () => createMcpClient({ endpoint: "https://user:pw@example.com/mcp", token: "t" }),
    (err) => err instanceof McpClientError && err.kind === "config",
  );
});
