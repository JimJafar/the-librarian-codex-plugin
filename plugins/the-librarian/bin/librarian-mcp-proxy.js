#!/usr/bin/env node

// plugins/the-librarian/src/mcp-client.mjs
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var McpClientError = class extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "McpClientError";
    this.kind = kind;
    this.status = extra.status;
  }
};
function createRpcSender(config, transport) {
  const url = parseEndpoint(config.endpoint);
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);
  return {
    safeEndpoint,
    // Sends a single, already-serialised JSON-RPC request body and returns
    // the raw `{ status, body }`. Never embeds the token anywhere but the
    // Authorization header.
    async send(body) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`
      };
      try {
        return await send({ url: config.endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError) throw err;
        if (isTimeout(err)) {
          throw new McpClientError("timeout", `request timed out after ${timeoutMs}ms`);
        }
        throw new McpClientError("network", `could not reach the Librarian at ${safeEndpoint}`);
      }
    }
  };
}
function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpClientError("config", "Librarian endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientError(
      "config",
      `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`
    );
  }
  if (url.username || url.password) {
    throw new McpClientError("config", "Librarian endpoint must not embed credentials");
  }
  if (url.search) {
    throw new McpClientError("config", "Librarian endpoint must not include a query string");
  }
  return url;
}
function isTimeout(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ETIMEDOUT";
}
function defaultTransport(maxResponseBytes) {
  return async ({ url, body, headers, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        // Never follow a 3xx — fetch would carry the bearer header to the
        // redirect target and leak the token cross-origin.
        redirect: "error",
        signal: controller.signal
      });
      return { status: response.status, body: await readCapped(response, maxResponseBytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}
async function readCapped(response, cap) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > cap) {
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    return buffer.toString("utf8");
  }
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// plugins/the-librarian/src/mcp-stdio-proxy.mjs
import { pathToFileURL } from "node:url";
var JSONRPC_INTERNAL_ERROR = -32603;
var JSONRPC_INVALID_REQUEST = -32600;
function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}
function extractId(req) {
  if (req && (typeof req.id === "string" || typeof req.id === "number")) return req.id;
  return null;
}
function isNotification(req) {
  return req != null && typeof req === "object" && !("id" in req);
}
async function handleLine(rawLine, sender, logOnce) {
  const line = rawLine.trim();
  if (line === "") return null;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Parse error: request was not valid JSON");
  }
  const id = extractId(req);
  if (sender === null) {
    logOnce(
      "the-librarian MCP proxy: LIBRARIAN_MCP_URL and/or LIBRARIAN_AGENT_TOKEN are not set; every request will return a configuration error. Set both in the shell that launches Codex."
    );
    if (isNotification(req)) return null;
    return jsonRpcError(
      id,
      JSONRPC_INTERNAL_ERROR,
      "the-librarian MCP proxy is not configured: LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN must both be set"
    );
  }
  let response;
  try {
    response = await sender.send(line);
  } catch (err) {
    const detail = err instanceof McpClientError ? err.message : "request to the Librarian failed";
    if (isNotification(req)) return null;
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, `the-librarian MCP proxy: ${detail}`);
  }
  if (response.status !== 200) {
    if (isNotification(req)) return null;
    return jsonRpcError(
      id,
      JSONRPC_INTERNAL_ERROR,
      `the-librarian MCP proxy: the Librarian returned HTTP ${response.status}`
    );
  }
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    if (isNotification(req)) return null;
    return jsonRpcError(id, JSONRPC_INTERNAL_ERROR, "the-librarian MCP proxy: non-JSON response from the Librarian");
  }
  if (isNotification(req)) return null;
  return payload;
}
function makeLogOnce(write) {
  let logged = false;
  return (msg) => {
    if (logged) return;
    logged = true;
    write(`${msg}
`);
  };
}
function senderFromEnv(env) {
  const endpoint = env.LIBRARIAN_MCP_URL;
  const token = env.LIBRARIAN_AGENT_TOKEN;
  if (!endpoint || !token) return null;
  try {
    return createRpcSender({ endpoint, token });
  } catch {
    return null;
  }
}
async function runProxy({ input, output, errOut, env }) {
  const sender = senderFromEnv(env);
  const logOnce = makeLogOnce((s) => errOut.write(s));
  if (sender === null) {
    logOnce(
      "the-librarian MCP proxy: LIBRARIAN_MCP_URL and/or LIBRARIAN_AGENT_TOKEN are not set; every request will return a configuration error. Set both in the shell that launches Codex."
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
  if (buffer.trim() !== "") {
    const response = await handleLine(buffer, sender, logOnce);
    if (response !== null) output.write(JSON.stringify(response) + "\n");
  }
}
var isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runProxy({
    input: process.stdin,
    output: process.stdout,
    errOut: process.stderr,
    env: process.env
  }).catch((err) => {
    try {
      process.stderr.write(`the-librarian MCP proxy: fatal ${String(err?.message ?? err)}
`);
    } catch {
    }
    process.exit(1);
  });
}
export {
  handleLine,
  jsonRpcError,
  makeLogOnce,
  runProxy,
  senderFromEnv
};
