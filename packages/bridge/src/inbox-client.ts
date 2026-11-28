// The stdio proxy's side of the agent inbox (AD4, AD5): keep one `GET /v1/inbox` SSE stream open to the
// bridge, re-register after the daemon comes back, and ack each push. SSE parsing and backoff are pure.
import { INBOX_ACK_PATH, INBOX_PATH, InboxPushSchema, type InboxPush } from "@tabagent/protocol";

/** AD5: reconnect delays. */
export const INBOX_BACKOFF = { minMs: 1000, maxMs: 30_000 } as const;

export function nextBackoff(prev: number | undefined, o: { minMs: number; maxMs: number } = INBOX_BACKOFF): number {
  return prev === undefined ? o.minMs : Math.min(prev * 2, o.maxMs);
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental `text/event-stream` parser: feed it chunks, it calls `onEvent` per complete event. */
export function createSseParser(onEvent: (e: SseEvent) => void): (chunk: string) => void {
  let buf = "";
  let event = "";
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line === "") {
        if (data.length) onEvent({ event: event || "message", data: data.join("\n") });
        event = "";
        data = [];
      } else if (line.startsWith(":")) continue;
      else {
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
  };
}

export interface InboxClientOpts {
  port: number;
  token: string;
  /** Registration headers (AD4); called on every (re)connect. */
  headers: () => Record<string, string>;
  /** D6: bring a daemon back before reconnecting, so the stream re-registers with the new one (AD5). */
  ensureDaemon: () => Promise<unknown>;
  /** A push from the bridge. It is acked after this returns. P3 (#93) writes channel pushes to the agent here. */
  onPush?: (m: InboxPush) => void | Promise<void>;
  log?: (m: string) => void;
  /** Tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class InboxClient {
  private stopped = false;
  private ac: AbortController | null = null;
  private running = false;
  connected = false;

  constructor(private o: InboxClientOpts) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.ac?.abort();
    this.connected = false;
  }

  private get base() {
    return `http://127.0.0.1:${this.o.port}`;
  }

  private async loop() {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    const now = this.o.now ?? Date.now;
    let delay: number | undefined;
    let warned = false;
    while (!this.stopped) {
      const started = now();
      try {
        const status = await this.once();
        if (status !== 200 && !warned) {
          warned = true;
          this.o.log?.(`agent inbox: the bridge answered HTTP ${status}; retrying`);
        }
      } catch {
        /* unreachable or dropped: retry below */
      }
      this.connected = false;
      if (this.stopped) break;
      // A stream that lived a while was healthy: start again from 1 s. Short ones keep backing off.
      delay = now() - started >= INBOX_BACKOFF.maxMs ? INBOX_BACKOFF.minMs : nextBackoff(delay);
      await sleep(delay);
      if (this.stopped) break;
      await this.o.ensureDaemon().catch(() => {});
    }
    this.running = false;
  }

  /** One stream: resolves when it ends. Returns the HTTP status. */
  private async once(): Promise<number> {
    const ac = (this.ac = new AbortController());
    const res = await fetch(this.base + INBOX_PATH, {
      headers: { ...this.o.headers(), authorization: `Bearer ${this.o.token}`, accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return res.status;
    }
    this.connected = true;
    const pushes: InboxPush[] = [];
    const feed = createSseParser((e) => {
      if (e.event !== "message") return;
      try {
        const p = InboxPushSchema.safeParse(JSON.parse(e.data));
        if (p.success) pushes.push(p.data);
      } catch {
        /* not JSON: ignore */
      }
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
        while (pushes.length) await this.deliver(pushes.shift()!);
      }
    } catch {
      /* aborted or dropped */
    }
    return 200;
  }

  private async deliver(m: InboxPush) {
    try {
      await this.o.onPush?.(m);
    } catch (e) {
      this.o.log?.(`agent inbox: push ${m.msgId} failed: ${(e as Error).message}`);
      return;
    }
    await fetch(this.base + INBOX_ACK_PATH, {
      method: "POST",
      headers: { ...this.o.headers(), authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
      body: JSON.stringify({ msgId: m.msgId }),
    }).catch(() => {});
  }
}
