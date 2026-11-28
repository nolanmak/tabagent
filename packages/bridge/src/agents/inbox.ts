// Agent inbox streams (AD4, AD5): one SSE stream per restKey from each `tabagent mcp` proxy. The registry
// is pure over an injected connection; the HTTP side lives in daemon.ts.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { INBOX_HEADERS, toolsForProfiles, type ToolDef } from "@tabagent/protocol";

export interface InboxConn {
  write(event: string, data: unknown): void;
  close(): void;
}

/** What the proxy registered (AD4). */
export interface InboxInfo {
  /** The bridge session id (SessionMeta.id) the stream belongs to. */
  sessionId: string;
  agentPid?: number;
  client: string;
  channels: boolean;
  profile: string;
}

export interface InboxStream extends InboxInfo {
  key: string;
  conn: InboxConn;
  openedAt: number;
}

export interface InboxOpts {
  now?: () => number;
  newId?: () => string;
  /** The current stream for this key went away: the agent is unlinked (AD5). Not called on replacement. */
  onClosed?: (key: string, stream: InboxStream) => void;
}

export class InboxRegistry {
  private streams = new Map<string, InboxStream>();
  /** Unacked pushes per key (AD5). P3 turns an ack into the `sent` state. */
  private unacked = new Map<string, Set<string>>();
  private now: () => number;
  private newId: () => string;

  constructor(private o: InboxOpts = {}) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? randomUUID;
  }

  get size() {
    return this.streams.size;
  }

  /** Register a stream. A stream already open for the key is replaced and closed. */
  open(key: string, info: InboxInfo, conn: InboxConn): InboxStream {
    const old = this.streams.get(key);
    const s: InboxStream = { ...info, key, conn, openedAt: this.now() };
    this.streams.set(key, s);
    if (old) old.conn.close();
    return s;
  }

  /** A connection closed. Returns true when it was the key's current stream (now unlinked). */
  close(key: string, conn: InboxConn): boolean {
    const s = this.streams.get(key);
    if (!s || s.conn !== conn) return false;
    this.streams.delete(key);
    this.unacked.delete(key);
    this.o.onClosed?.(key, s);
    return true;
  }

  get(key: string): InboxStream | undefined {
    return this.streams.get(key);
  }

  /** AD4: the stream whose proxy runs under this agent pid. The newest wins if two proxies share one agent. */
  byAgentPid(pid: number): InboxStream | undefined {
    let best: InboxStream | undefined;
    for (const s of this.streams.values()) if (s.agentPid === pid && (!best || s.openedAt >= best.openedAt)) best = s;
    return best;
  }

  /** Push `{msgId, ...data}` to the key's live stream. null when there is none: nothing is buffered (AD5). */
  push(key: string, data: Record<string, unknown>): string | null {
    const s = this.streams.get(key);
    if (!s) return null;
    const msgId = this.newId();
    let set = this.unacked.get(key);
    if (!set) this.unacked.set(key, (set = new Set()));
    set.add(msgId);
    s.conn.write("message", { msgId, ...data });
    return msgId;
  }

  /** The proxy acked a push. Only the key that received it can ack it, and only once. */
  ack(key: string, msgId: string): boolean {
    return this.unacked.get(key)?.delete(msgId) ?? false;
  }

  closeAll() {
    const all = [...this.streams.values()];
    this.streams.clear();
    this.unacked.clear();
    for (const s of all) s.conn.close();
  }
}

const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** AD4 registration headers. Malformed values are dropped, never trusted. */
export function parseInboxHeaders(h: IncomingHttpHeaders): Omit<InboxInfo, "sessionId"> {
  const pidRaw = header(h, INBOX_HEADERS.agentPid);
  const pid = pidRaw && /^\d{1,10}$/.test(pidRaw) ? Number(pidRaw) : NaN;
  const prof = header(h, INBOX_HEADERS.profile);
  return {
    ...(Number.isInteger(pid) && pid > 0 ? { agentPid: pid } : {}),
    client: String(header(h, INBOX_HEADERS.client) ?? "").replace(/[^\w .-]/g, "").slice(0, 40),
    channels: header(h, INBOX_HEADERS.channels) === "1",
    profile: prof && /^[a-z]+(,[a-z]+)*$/.test(prof) && prof.length <= 100 ? prof : "core",
  };
}

/** Glossary canDriveTab: the linked session's profile has page_* or act_* tools. */
export function profileCanDriveTab(profile: string, tools?: readonly ToolDef[]): boolean {
  try {
    return toolsForProfiles(profile, tools).some((t) => t.name.startsWith("page.") || t.name.startsWith("act."));
  } catch {
    return false;
  }
}
