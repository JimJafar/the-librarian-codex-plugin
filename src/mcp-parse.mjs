// src/mcp-parse.mjs
// Tiny parsers for the prose responses the Librarian server sends back.
// All Librarian MCP tools return text content (not structured JSON), so we
// grep canonical lines out of it. Match shape is from the server's actual
// output: `ID: ses_…`, `Status: active`, etc.

const ID_RE = /^ID:\s*(ses_[A-Za-z0-9_-]+)/m;
const STATUS_RE = /^Status:\s*(\w+)/m;

export function extractSessionId(text) {
  const m = (text ?? "").match(ID_RE);
  return m ? m[1] : null;
}

export function extractStatus(text) {
  const m = (text ?? "").match(STATUS_RE);
  return m ? m[1] : null;
}

// Parse a `list_sessions` rendered list. Each entry begins with
// `N. [status] title …` and is followed by an `id: ses_…` line. Returns the
// list in order, including ended sessions if present.
export function parseSessionList(text) {
  const lines = (text ?? "").split("\n");
  const sessions = [];
  let pending = null;
  for (const line of lines) {
    const head = line.match(/^\d+\.\s*\[([^\]]+)\]\s*(.*)$/);
    if (head) {
      pending = { status: head[1].trim(), title: head[2].trim() };
      continue;
    }
    const idLine = line.match(/^\s*id:\s*(ses_[A-Za-z0-9_-]+)/);
    if (idLine && pending) {
      sessions.push({ id: idLine[1], ...pending });
      pending = null;
    }
  }
  return sessions;
}
