// src/mcp-client.mjs
// Minimal HTTP MCP client for the Librarian endpoint. Ported from the Claude
// plugin's bundled bin/librarian-mcp-call.js — same wire shape, same security
// posture (redirect: error so a 3xx never carries the bearer cross-origin,
// response size capped), refactored to plain ESM and dependency-injected
// transport for testability.
//
// Tools called from hook handlers: start_session, list_sessions,
// continue_session, checkpoint_session, pause_session, end_session,
// record_session_event. All return prose text bodies; callers handle parsing.

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

export function createMcpClient(config, transport) {
  const url = parseEndpoint(config.endpoint);
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);

  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      };

      let response;
      try {
        response = await send({ url: config.endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError) throw err;
        if (isTimeout(err)) {
          throw new McpClientError("timeout", `${name} timed out after ${timeoutMs}ms`);
        }
        throw new McpClientError("network", `${name} could not reach the Librarian at ${safeEndpoint}`);
      }

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
