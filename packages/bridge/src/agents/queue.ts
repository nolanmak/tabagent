// Queue route (AD7, AD10, spike §4): `thread/queue/add` over the Codex app-server WebSocket, then watch
// until the submission leaves `thread/queue/list`. Pure helpers first; the adapter and watcher below.
import { CodexRpc } from "./codex";

export const QUEUE_ADD_TIMEOUT_MS = 10_000;
export const QUEUE_POLL_MS = 10_000;
export const QUEUE_WATCH_MS = 30 * 60_000;

export function submissionIdOf(result: unknown): string | null {
  const id = (result as { queuedSubmission?: { id?: unknown } } | null)?.queuedSubmission?.id;
  return typeof id === "string" && id ? id : null;
}

/** Is the submission still in the thread's queue? Accepts the shapes thread/queue/list may use. */
export function submissionPending(list: unknown, submissionId: string): boolean {
  const l = list as Record<string, unknown> | unknown[] | null;
  const items = Array.isArray(l) ? l : l && typeof l === "object" ? [l.data, l.queuedSubmissions, l.submissions].find(Array.isArray) : undefined;
  return Array.isArray(items) && items.some((x) => (x as { id?: unknown } | null)?.id === submissionId);
}

export type QueueAdd = { ok: true; submissionId: string; rpc: CodexRpc } | { ok: false; detail: string };

/** Add the text to the thread's queue. On success the connection stays open for the watcher. */
export async function queueAdd(socket: string, threadId: string, requestId: string, text: string, timeoutMs = QUEUE_ADD_TIMEOUT_MS): Promise<QueueAdd> {
  let rpc: CodexRpc;
  try {
    rpc = await CodexRpc.connect(socket, timeoutMs);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  try {
    const r = await rpc.request("thread/queue/add", { threadId, clientUserMessageId: requestId, input: [{ type: "text", text }] }, timeoutMs);
    const submissionId = submissionIdOf(r);
    if (!submissionId) throw new Error("thread/queue/add returned no submission id");
    return { ok: true, submissionId, rpc };
  } catch (e) {
    rpc.close();
    return { ok: false, detail: (e as Error).message };
  }
}

export interface WatchOpts {
  socket: string;
  threadId: string;
  submissionId: string;
  pollMs?: number;
  watchMs?: number;
  connectTimeoutMs?: number;
  onDelivered: () => void;
}

/**
 * Checks on `thread/queue/changed` for the thread and every pollMs. Reports delivered once, then stops.
 * After watchMs it stops quietly and the send stays `queued`. Reconnects on the next poll if the socket drops.
 */
export class QueueWatcher {
  private poll: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout>;
  private stopped = false;
  private checking = false;
  private off: (() => void) | null = null;

  constructor(
    private rpc: CodexRpc | null,
    private o: WatchOpts,
    private onStop: () => void = () => {},
  ) {
    this.listen();
    this.poll = setInterval(() => void this.check(), o.pollMs ?? QUEUE_POLL_MS);
    this.deadline = setTimeout(() => this.stop(), o.watchMs ?? QUEUE_WATCH_MS);
    this.poll.unref?.();
    this.deadline.unref?.();
  }

  private listen() {
    this.off = this.rpc?.onNotification((method, params) => {
      if (method === "thread/queue/changed" && (params as { threadId?: unknown } | null)?.threadId === this.o.threadId) void this.check();
    }) ?? null;
  }

  async check() {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      if (!this.rpc?.open) {
        this.off?.();
        this.rpc?.close();
        this.rpc = await CodexRpc.connect(this.o.socket, this.o.connectTimeoutMs).catch(() => null);
        if (this.stopped) return this.rpc?.close();
        this.listen();
        if (!this.rpc) return;
      }
      const list = await this.rpc.request("thread/queue/list", { threadId: this.o.threadId });
      if (!this.stopped && !submissionPending(list, this.o.submissionId)) {
        this.o.onDelivered();
        this.stop();
      }
    } catch {
      /* try again on the next change or poll */
    } finally {
      this.checking = false;
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.deadline);
    this.off?.();
    this.rpc?.close();
    this.onStop();
  }
}
