// src/mcp-stdio-proxy.mjs
//
// A stdio↔HTTP JSON-RPC proxy. Codex can bundle *stdio* MCP servers and
// forward named shell env vars into them via an `env_vars` allowlist, but it
// can't interpolate `${VAR}` into a *remote HTTP* server's `url` (openai/codex
// #7521). The Librarian is a remote HTTP MCP server whose URL + token are
// per-user. So we ship this tiny proxy as a bundled stdio server: Codex spawns
// it, forwards LIBRARIAN_MCP_URL + LIBRARIAN_AGENT_TOKEN, and the proxy relays
// each JSON-RPC message to the user's remote endpoint.
//
// Wire contract (the MCP stdio transport):
//   - stdin  : newline-delimited JSON-RPC request objects (one per line).
//   - stdout : newline-delimited JSON-RPC response objects (one per request
//              that has an `id`; notifications — no `id` — get no reply).
//   - stderr : diagnostics only. The bearer token NEVER appears here (or on
//              stdout). It is carried solely in the Authorization header by
//              the shared sender in mcp-client.mjs.
//
// Security + reuse: the outbound HTTP path is the shared `createRpcSender`
// from mcp-client.mjs — same endpoint validation (http(s) only, no embedded
// creds, no query string), same `redirect: "error"`, same timeout + size cap.
// There is exactly one credential path in this codebase; the proxy does not
// fork it.
//
// Fail-soft: a transport/HTTP/parse failure becomes a JSON-RPC error response
// correlated to the request `id` — the process never crashes and never blocks.
// Missing env vars emit a single stderr diagnostic and then answer every
// request with a config error (so the client sees a clean failure instead of
// a hang).

import { createRpcSender, McpClientError } from "./mcp-client.mjs";

// JSON-RPC reserved error codes we use. -32603 is "internal error"; -32600 is
// "invalid request". Transport/config failures map to internal error since the
// request itself was well-formed — the server side was unreachable.
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_INVALID_REQUEST = -32600;

// Build a JSON-RPC error response, preserving id correlation. A null/absent id
// (notification, or an unparseable line) yields id: null per the spec.
export function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

// Pull a usable id out of a (possibly malformed) parsed request. JSON-RPC ids
// are string | number | null; anything else (or absent) becomes null.
function extractId(req) {
  if (req && (typeof req.id === "string" || typeof req.id === "number")) return req.id;
  return null;
}

// A request with no `id` is a JSON-RPC *notification* — it must not get a
// reply. (`id: 0` is a real id, so check for the property, not truthiness.)
function isNotification(req) {
  return req != null && typeof req === "object" && !("id" in req);
}

// Handle one already-parsed-or-not line. Returns the response object to emit,
// or null when nothing should be written (a notification, or an
// empty/whitespace line). `sender` is null when the proxy is misconfigured —
// every request then gets a config error.
export async function handleLine(rawLine, sender, logOnce) {
  const line = rawLine.trim();
  if (line === "") return null;

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    // An unparseable line can't carry an id we trust — answer with id: null
    // so a strict client still sees a correlated-shaped error rather than
    // silence.
    return jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Parse error: request was not valid JSON");
  }

  const id = extractId(req);

  if (sender === null) {
    logOnce(
      "the-librarian MCP proxy: LIBRARIAN_MCP_URL and/or LIBRARIAN_AGENT_TOKEN are not set; " +
        "every request will return a configuration error. Set both in the shell that launches Codex.",
    );
    // Notifications still get no reply — there's no id to answer to.
    if (isNotification(req)) return null;
    return jsonRpcError(
      id,
      JSONRPC_INTERNAL_ERROR,
      "the-librarian MCP proxy is not configured: LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN must both be set",
    );
  }

  let response;
  try {
    response = await sender.send(line);
  } catch (err) {
    // Transport/timeout/network error → fail-soft JSON-RPC error. Never let
    // it throw out of the loop. The message is host+path only (the sender's
    // safeEndpoint), never the token.
    const detail = err instanceof McpClientError ? err.message : "request to the Librarian failed";
    if (isNotification(req)) return null;
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, `the-librarian MCP proxy: ${detail}`);
  }

  if (response.status !== 200) {
    if (isNotification(req)) return null;
    return jsonRpcError(
      id,
      JSONRPC_INTERNAL_ERROR,
      `the-librarian MCP proxy: the Librarian returned HTTP ${response.status}`,
    );
  }

  // Happy path: the Librarian already speaks JSON-RPC, so relay its response
  // body verbatim if it parses. We re-parse (rather than passing the raw
  // string through) so a non-JSON body becomes a clean JSON-RPC error instead
  // of corrupting the newline-delimited stdout stream.
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    if (isNotification(req)) return null;
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, "the-librarian MCP proxy: non-JSON response from the Librarian");
  }

  // A notification must produce no output even if the server echoed a body.
  if (isNotification(req)) return null;
  return payload;
}

// A one-shot stderr logger: the same diagnostic should not spam stderr once
// per request. Returns a function that logs `msg` only the first time.
export function makeLogOnce(write) {
  let logged = false;
  return (msg) => {
    if (logged) return;
    logged = true;
    write(`${msg}\n`);
  };
}

// Build the shared sender from the environment, or null if either var is
// missing / the endpoint is invalid. Never throws.
export function senderFromEnv(env) {
  const endpoint = env.LIBRARIAN_MCP_URL;
  const token = env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) return null;
  try {
    return createRpcSender({ endpoint, token });
  } catch {
    // An invalid endpoint (bad URL, embedded creds, query string) is a
    // misconfiguration we treat exactly like a missing var: log once, error
    // every request.
    return null;
  }
}

// The main loop: consume newline-delimited JSON-RPC from `input`, write
// newline-delimited responses to `output`, diagnostics to `errOut`. Resolves
// when `input` ends. Processes lines sequentially to keep id-correlation
// simple and stdout writes ordered.
export async function runProxy({ input, output, errOut, env }) {
  const sender = senderFromEnv(env);
  const logOnce = makeLogOnce((s) => errOut.write(s));

  // If we're already misconfigured, surface the diagnostic immediately rather
  // than waiting for the first request — but still answer requests with
  // errors (don't exit, or Codex would just see the server die).
  if (sender === null) {
    logOnce(
      "the-librarian MCP proxy: LIBRARIAN_MCP_URL and/or LIBRARIAN_AGENT_TOKEN are not set; " +
        "every request will return a configuration error. Set both in the shell that launches Codex.",
    );
  }

  let buffer = "";
  input.setEncoding("utf8");

  for await (const chunk of input) {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const response = await handleLine(line, sender, logOnce);
      if (response !== null) output.write(JSON.stringify(response) + "\n");
    }
  }

  // Flush a trailing line with no terminating newline (e.g. a single request
  // piped without one).
  if (buffer.trim() !== "") {
    const response = await handleLine(buffer, sender, logOnce);
    if (response !== null) output.write(JSON.stringify(response) + "\n");
  }
}

// Entry-point guard: run only when invoked directly, never on test import.
import { pathToFileURL } from "node:url";

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  runProxy({
    input: process.stdin,
    output: process.stdout,
    errOut: process.stderr,
    env: process.env,
  }).catch((err) => {
    // Last-ditch: never crash with a stack trace that could include request
    // content. The token is never in scope here, but keep the message terse.
    try {
      process.stderr.write(`the-librarian MCP proxy: fatal ${String(err?.message ?? err)}\n`);
    } catch {
      /* swallow */
    }
    process.exit(1);
  });
}
