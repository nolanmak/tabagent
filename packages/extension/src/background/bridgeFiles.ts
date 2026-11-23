// #11 / D31: ask the bridge to validate upload paths (files.resolve -> files.resolved).
import { TabAgentError } from "@tabagent/protocol";

type Sender = (msg: unknown) => boolean;
let sender: Sender | null = null;
const waiting = new Map<string, { resolve: (p: string[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** index.ts wires the bridge socket here. */
export function setFilesSender(fn: Sender) {
  sender = fn;
}

export function resolveFiles(commandId: string, paths: string[], timeoutMs = 15_000): Promise<string[]> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!sender || !sender({ type: "files.resolve", id, commandId, paths })) {
      reject(new TabAgentError("NO_EXTENSION", "The bridge is not connected, so upload paths cannot be checked"));
      return;
    }
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new TabAgentError("TIMEOUT", "The bridge did not validate the upload paths in time"));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
  });
}

/** Called by index.ts for every {type:"files.resolved"} message. */
export function onFilesResolved(msg: { id: string; ok: boolean; paths?: string[]; error?: { code: string; message: string; hint?: string } }) {
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  clearTimeout(w.timer);
  if (msg.ok && msg.paths) w.resolve(msg.paths);
  else w.reject(new TabAgentError((msg.error?.code ?? "BAD_REQUEST") as any, msg.error?.message ?? "Upload paths were refused", msg.error?.hint));
}

/** Kill switch: pending resolutions fail. */
export function rejectAllFiles(e: Error) {
  for (const [id, w] of waiting) {
    clearTimeout(w.timer);
    w.reject(e);
    waiting.delete(id);
  }
}
