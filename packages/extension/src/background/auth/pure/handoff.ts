// #35 auth.handoff state machine. The agent hands a tab to the user for a human-only step and gets it
// back. While it waits: the debugger is detached (no automation bar, nothing observed), agent commands
// on the tab get TAB_BUSY (sessions.ts refuses handed-off tabs), the tab stays in the session's group.
// Ends: Done → completed:true, Cancel → completed:false, timeout → PROMPT_TIMEOUT, kill → KILLED,
// tab closed → NOT_FOUND. Refs for the tab are stale afterwards (the driver is disposed on detach).
// Audit: exactly one start and one end event, no page content.
//
// #61 remote handoff: after detaching, the extension asks the bridge for a one-time phone link
// (`remote.open`). The bridge answers with the handoff timeout it is configured for (default 5 min, 30
// with remote on) and, when remote handoff is on, a handoffId. Done/Cancel on the phone end the handoff
// exactly like the side panel. Every ending closes the link (`remote.close`), which revokes it.
import { AUTH_HANDOFF_TIMEOUT, TabAgentError } from "@tabagent/protocol";

export interface HandoffRequest {
  tabId: number;
  sessionId: string;
  sessionLabel: string;
  origin: string;
  reason: string;
}

export interface HandoffRemote {
  /** A rejection is treated as "no remote link". */
  open(req: HandoffRequest): Promise<{ handoffId: string | null; url: string | null; timeoutMs: number | null }>;
  close(handoffId: string, outcome: string): Promise<void> | void;
}

export interface HandoffDeps {
  /** Detach chrome.debugger from the tab and drop its driver/ref table (refs → REF_STALE). */
  detach(tabId: number): Promise<void>;
  /** Side-panel Done/Cancel (sessions.ts startHandoff / endHandoff / inHandoff). */
  start(info: HandoffRequest): Promise<"done" | "cancel">;
  end(tabId: number, result: "done" | "cancel"): void;
  busy(tabId: number): boolean;
  /** D19: badge, notification, informational in-tab banner. Never focuses the tab (D10). */
  notify(info: HandoffRequest, remote?: boolean): void;
  clearNotice(tabId: number): void;
  onTabClosed(tabId: number, cb: () => void): () => void;
  onKilled(cb: () => void): () => void;
  event(name: "auth.handoff.start" | "auth.handoff.end", data: Record<string, unknown>): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** Test override; wins over the bridge's timeout. */
  timeoutMs?: number;
  /** #61: the bridge's remote handoff page (absent → local only). */
  remote?: HandoffRemote;
}

type End = { kind: "ui"; result: "done" | "cancel" } | { kind: "timeout" } | { kind: "killed" } | { kind: "closed" };

export async function runHandoff(deps: HandoffDeps, req: HandoffRequest): Promise<{ completed: boolean }> {
  if (deps.busy(req.tabId)) throw new TabAgentError("TAB_BUSY", `Tab ${req.tabId} is already handed to the user`, "Wait for the open handoff to finish.");
  const started = Date.now();
  deps.event("auth.handoff.start", { origin: req.origin, tabId: req.tabId });
  let end: End | null = null;
  let handoffId: string | null = null;
  let timeoutMs = deps.timeoutMs ?? AUTH_HANDOFF_TIMEOUT;
  const cleanups: (() => void)[] = [];
  try {
    await deps.detach(req.tabId);
    if (deps.remote) {
      const r = await deps.remote.open(req).catch(() => null);
      handoffId = r?.handoffId ?? null;
      if (deps.timeoutMs == null && r?.timeoutMs) timeoutMs = r.timeoutMs;
    }
    end = await new Promise<End>((resolve) => {
      deps.start(req).then((result) => resolve({ kind: "ui", result }));
      const t = deps.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      cleanups.push(() => deps.clearTimeout(t));
      cleanups.push(deps.onKilled(() => resolve({ kind: "killed" })));
      cleanups.push(deps.onTabClosed(req.tabId, () => resolve({ kind: "closed" })));
      deps.notify(req, !!handoffId);
    });
  } finally {
    for (const c of cleanups) c();
    if (!end || end.kind !== "ui") deps.end(req.tabId, "cancel");
    deps.clearNotice(req.tabId);
    const outcome = !end ? "error" : end.kind === "ui" ? end.result : end.kind;
    if (handoffId) await Promise.resolve(deps.remote?.close(handoffId, outcome)).catch(() => {});
    deps.event("auth.handoff.end", { origin: req.origin, tabId: req.tabId, outcome, ms: Date.now() - started, ...(deps.remote ? { remote: !!handoffId } : {}) });
  }
  const fin = end as End;
  switch (fin.kind) {
    case "ui":
      return { completed: fin.result === "done" };
    case "timeout": {
      const min = Math.max(1, Math.round(timeoutMs / 60_000));
      throw new TabAgentError("PROMPT_TIMEOUT", `The user did not finish the handoff within ${min} minute${min === 1 ? "" : "s"}`, "Ask the user, then call auth.handoff again.");
    }
    case "killed":
      throw new TabAgentError("KILLED", "The user stopped all agents with the TabAgent kill switch");
    case "closed":
      throw new TabAgentError("NOT_FOUND", `Tab ${req.tabId} was closed during the handoff`);
  }
}
