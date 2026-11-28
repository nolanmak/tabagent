// Test doubles for Send to agent (spec §11): a stub `claude` executable on a temp PATH and a fake
// Codex app-server speaking JSON-RPC over WebSocket on a temp unix socket. The real CLIs never run.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const STUB = `#!/bin/sh
d="$(dirname "$0")"
printf '%s\\n' "$1 $2" >> "$d/calls.log"
if [ "$1" = "agents" ]; then
  [ -f "$d/agents.sleep" ] && sleep "$(cat "$d/agents.sleep")"
  [ -f "$d/agents.json" ] && cat "$d/agents.json"
  [ -f "$d/agents.err" ] && cat "$d/agents.err" >&2
  exit "$(cat "$d/agents.exit" 2>/dev/null || echo 0)"
fi
if [ "$1" = "--bg" ]; then
  printf '%s' "$2" > "$d/bg.text"
  pwd > "$d/bg.cwd"
  [ -f "$d/bg.sleep" ] && sleep "$(cat "$d/bg.sleep")"
  [ -f "$d/bg.out" ] && cat "$d/bg.out"
  [ -f "$d/bg.err" ] && cat "$d/bg.err" >&2
  exit "$(cat "$d/bg.exit" 2>/dev/null || echo 0)"
fi
echo "unexpected args: $*" >&2
exit 2
`;

/** A `claude` stub in its own directory. Behaviour is read from files next to it on each run. */
export class StubClaude {
  readonly dir: string;
  readonly bin: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "ta-claude-"));
    this.bin = join(this.dir, "claude");
    writeFileSync(this.bin, STUB);
    chmodSync(this.bin, 0o755);
  }
  set(name: string, content: string | number | object | null) {
    const p = join(this.dir, name);
    if (content === null) rmSync(p, { force: true });
    else writeFileSync(p, typeof content === "object" ? JSON.stringify(content) : String(content));
  }
  agents(records: object[]) {
    this.set("agents.json", records);
  }
  /** A stand-in for ~/.claude/projects (point TABAGENT_CLAUDE_PROJECTS_DIR or claudeProjectsDir here). */
  get projectsDir(): string {
    return join(this.dir, "projects");
  }
  /** Write `<projects>/<cwd slug>/<sessionId>.jsonl` with these entries, as Claude Code does (#137). */
  transcript(cwd: string, sessionId: string, entries: object[]) {
    const d = join(this.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  /** Append entries to an existing transcript (a live session writing more). */
  appendTranscript(cwd: string, sessionId: string, entries: object[]) {
    const d = join(this.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(d, { recursive: true });
    appendFileSync(join(d, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  /** A stand-in for ~/.claude/sessions (point TABAGENT_CLAUDE_SESSIONS_DIR or claudeSessionsDir here). */
  get sessionsDir(): string {
    return join(this.dir, "sessions");
  }
  /** Write `<sessions>/<pid>.json` as Claude Code does (#151: bridgeSessionId for Remote Control). */
  session(pid: number, rec: Record<string, unknown>) {
    mkdirSync(this.sessionsDir, { recursive: true });
    writeFileSync(join(this.sessionsDir, `${pid}.json`), JSON.stringify({ pid, ...rec }));
  }
  read(name: string): string | null {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  calls(): string[] {
    return (this.read("calls.log") ?? "").split("\n").filter(Boolean);
  }
  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

type Handler = (params: any, ws: WebSocket) => unknown;

export interface RpcError {
  code: number;
  message: string;
}

/** Fake Codex app-server control socket: JSON-RPC 2.0 over WebSocket on a unix socket (spike §4). */
export class FakeCodex {
  readonly dir: string;
  readonly socket: string;
  readonly requests: { method: string; params: any }[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly clients = new Set<WebSocket>();
  initializedSeen = 0;
  private server: Server;
  private wss: WebSocketServer;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "ta-cx-"));
    this.socket = join(this.dir, "c.sock");
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      let initialized = false;
      ws.on("message", async (data) => {
        const m = JSON.parse(String(data));
        if (m.id === undefined) {
          if (m.method === "initialized") this.initializedSeen++;
          return;
        }
        this.requests.push({ method: m.method, params: m.params });
        if (m.method === "initialize") {
          initialized = true;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { userAgent: "fake/0", platformOs: "macos" } }));
          return;
        }
        if (!initialized) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "Not initialized" } }));
          return;
        }
        const h = this.handlers.get(m.method);
        if (!h) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } }));
          return;
        }
        try {
          const result = await h(m.params, ws);
          if (result === NO_REPLY) return;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        } catch (e) {
          const err = e as RpcError;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32603, message: err.message } }));
        }
      });
    });
  }

  listen(): Promise<this> {
    return new Promise((r) => this.server.listen(this.socket, () => r(this)));
  }

  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }

  /** Serve these threads through thread/loaded/list + thread/read. */
  threads(threads: Record<string, unknown>[]): this {
    this.on("thread/loaded/list", () => ({ data: threads.map((t) => t.id), nextCursor: null }));
    this.on("thread/read", ({ threadId }) => {
      const t = threads.find((x) => x.id === threadId);
      if (!t) throw { code: -32603, message: `no rollout found for thread id ${threadId}` };
      return { thread: t };
    });
    return this;
  }

  notify(method: string, params: unknown) {
    for (const ws of this.clients) ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  calls(method: string) {
    return this.requests.filter((r) => r.method === method);
  }

  async close() {
    for (const c of this.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Return from a handler to leave the request unanswered (timeout tests). */
export const NO_REPLY = Symbol("no-reply");

export function codexThread(id: string, status: Record<string, unknown> = { type: "idle" }, extra: Record<string, unknown> = {}) {
  return { id, sessionId: id, name: null, cwd: "/work/cx", createdAt: 1_795_000_000, status, preview: "p", ...extra };
}

export function claudeRecord(pid: number, startedAt: number, extra: Record<string, unknown> = {}) {
  return { pid, cwd: "/work/cl", kind: "interactive", startedAt, sessionId: "11111111-2222-3333-4444-555555555555", name: `agent-${pid}`, status: "idle", ...extra };
}

// ---------------------------------------------------------------------------
// #151: synthetic Claude Code transcript lines (shapes from real transcripts, invented content)
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (p: string) => `${p}${(++seq).toString(16).padStart(7, "0")}-0000-4000-8000-000000000000`;
const at = (s: number) => new Date(Date.UTC(2026, 10, 27, 12, 0, s)).toISOString();

export const tx = {
  user: (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", uuid: uid("u"), timestamp: at(1), isSidechain: false, userType: "external", message: { role: "user", content: text }, ...extra }),
  assistant: (blocks: object[] | string, extra: Record<string, unknown> = {}) => ({ type: "assistant", uuid: uid("a"), timestamp: at(2), isSidechain: false, message: { role: "assistant", model: "claude-test", content: blocks }, ...extra }),
  text: (text: string) => ({ type: "text", text }),
  toolUse: (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input }),
  thinking: (t: string) => ({ type: "thinking", thinking: t, signature: "sig" }),
  toolResult: (id: string, content: unknown, isError = false) => ({ type: "user", uuid: uid("r"), timestamp: at(3), isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }),
  /** A channel push as Claude Code records it: a meta user line with origin.kind "channel" (AD9). */
  channel: (prompt: string, server = "tabagent") => ({
    type: "user",
    uuid: uid("c"),
    timestamp: at(4),
    isMeta: true,
    origin: { kind: "channel", server },
    message: { role: "user", content: `<channel source="${server}">\n[TabAgent: message from the user via the side panel]\n${prompt}\n</channel>` },
  }),
  system: () => ({ type: "system", uuid: uid("s"), subtype: "turn_duration", durationMs: 10, timestamp: at(5) }),
  title: (t: string) => ({ type: "ai-title", aiTitle: t, sessionId: "s" }),
};
