// src/mcp-client.mjs
// Minimal HTTP MCP client for the Librarian endpoint. Ported from the Claude
// plugin's bundled bin/librarian-mcp-call.js — same wire shape, same security
// posture (redirect: error so a 3xx never carries the bearer cross-origin,
// response size capped), refactored to plain ESM and dependency-injected
// transport for testability.
//
// Tools called from hook handlers (currently just conv_state_get, for
// conv-state injection). All return prose text bodies; callers handle parsing.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

export class McpClientError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "McpClientError";
    this.kind = kind; // "config" | "timeout" | "network" | "http" | "malformed" | "rpc"
    this.status = extra.status;
  }
}

// Low-level JSON-RPC sender. Owns the single security-critical HTTP path the
// whole plugin shares: endpoint validation (http(s) only, no embedded creds,
// no query string), bearer-in-header-only, `redirect: "error"` so a 3xx can
// never carry the token cross-origin, and a response-size cap. Both the
// high-level `createMcpClient` (used by hook handlers) and the stdio↔HTTP
// proxy (`mcp-stdio-proxy.mjs`) route through this — there must be exactly
// one outbound credential path in the codebase.
//
// Returns the raw HTTP `{ status, body }`. Transport failures are normalised
// to a `timeout`/`network` McpClientError; an HTTP/JSON-RPC error is left for
// the caller to interpret (the proxy relays raw JSON-RPC error bodies; the
// client raises typed errors). The returned object exposes `safeEndpoint`
// (host+path, no credentials) for diagnostics.
export function createRpcSender(config, transport) {
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
        Authorization: `Bearer ${config.token}`,
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
    },
  };
}

export function createMcpClient(config, transport) {
  const sender = createRpcSender(config, transport);

  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });

      const response = await sender.send(body);

      if (response.status !== 200) {
        throw new McpClientError("http", `${name} returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new McpClientError("malformed", `${name} returned non-JSON`);
      }

      if (isRecord(payload) && payload.error != null) {
        const rpc = payload.error;
        const code = isRecord(rpc) ? rpc.code : undefined;
        const msg = isRecord(rpc) ? String(rpc.message ?? "").slice(0, 200) : "";
        throw new McpClientError("rpc", `${name} failed: ${msg} (code ${String(code)})`);
      }

      const text = extractText(payload);
      if (text === null) {
        throw new McpClientError("malformed", `${name} response had no text content`);
      }
      return text;
    },
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
      `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`,
    );
  }
  if (url.username || url.password) {
    throw new McpClientError("config", "Librarian endpoint must not embed credentials");
  }
  if (url.search) {
    // A `?token=…` style URL would leak credentials in any logs that capture
    // URLs (proxies, browser history if it ever ends up there). The bearer
    // header is the only acceptable carrier.
    throw new McpClientError("config", "Librarian endpoint must not include a query string");
  }
  return url;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isTimeout(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ETIMEDOUT";
}

function extractText(payload) {
  if (!isRecord(payload)) return null;
  const result = payload.result;
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
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
        signal: controller.signal,
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
  for (;;) {
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
