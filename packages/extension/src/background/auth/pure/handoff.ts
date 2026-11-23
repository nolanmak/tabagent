// #35 auth.handoff state machine. The agent hands a tab to the user for a human-only step and gets it
// back. While it waits: the debugger is detached (no automation bar, nothing observed), agent commands
// on the tab get TAB_BUSY (sessions.ts refuses handed-off tabs), the tab stays in the session's group.
// Ends: Done → completed:true, Cancel → completed:false, 5 min → PROMPT_TIMEOUT, kill → KILLED,
// tab closed → NOT_FOUND. Refs for the tab are stale afterwards (the driver is disposed on detach).
// Audit: exactly one start and one end event, no page content.
import { AUTH_HANDOFF_TIMEOUT, TabAgentError } from "@tabagent/protocol";

export interface HandoffRequest {
  tabId: number;
  sessionId: string;
  sessionLabel: string;
  origin: string;
  reason: string;
}

export interface HandoffDeps {
  /** Detach chrome.debugger from the tab and drop its driver/ref table (refs → REF_STALE). */
  detach(tabId: number): Promise<void>;
  /** Side-panel Done/Cancel (sessions.ts startHandoff / endHandoff / inHandoff). */
  start(info: HandoffRequest): Promise<"done" | "cancel">;
  end(tabId: number, result: "done" | "cancel"): void;
  busy(tabId: number): boolean;
  /** D19: badge, notification, informational in-tab banner. Never focuses the tab (D10). */
  notify(info: HandoffRequest): void;
  clearNotice(tabId: number): void;
  onTabClosed(tabId: number, cb: () => void): () => void;
  onKilled(cb: () => void): () => void;
  event(name: "auth.handoff.start" | "auth.handoff.end", data: Record<string, unknown>): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  timeoutMs?: number;
}

type End = { kind: "ui"; result: "done" | "cancel" } | { kind: "timeout" } | { kind: "killed" } | { kind: "closed" };

export async function runHandoff(deps: HandoffDeps, req: HandoffRequest): Promise<{ completed: boolean }> {
  if (deps.busy(req.tabId)) throw new TabAgentError("TAB_BUSY", `Tab ${req.tabId} is already handed to the user`, "Wait for the open handoff to finish.");
  const started = Date.now();
  deps.event("auth.handoff.start", { origin: req.origin, tabId: req.tabId });
  let end: End | null = null;
  const cleanups: (() => void)[] = [];
  try {
    await deps.detach(req.tabId);
    end = await new Promise<End>((resolve) => {
      deps.start(req).then((result) => resolve({ kind: "ui", result }));
      const t = deps.setTimeout(() => resolve({ kind: "timeout" }), deps.timeoutMs ?? AUTH_HANDOFF_TIMEOUT);
      cleanups.push(() => deps.clearTimeout(t));
      cleanups.push(deps.onKilled(() => resolve({ kind: "killed" })));
      cleanups.push(deps.onTabClosed(req.tabId, () => resolve({ kind: "closed" })));
      deps.notify(req);
    });
  } finally {
    for (const c of cleanups) c();
    if (!end || end.kind !== "ui") deps.end(req.tabId, "cancel");
    deps.clearNotice(req.tabId);
    const outcome = !end ? "error" : end.kind === "ui" ? end.result : end.kind;
    deps.event("auth.handoff.end", { origin: req.origin, tabId: req.tabId, outcome, ms: Date.now() - started });
  }
  const fin = end as End;
  switch (fin.kind) {
    case "ui":
      return { completed: fin.result === "done" };
    case "timeout":
      throw new TabAgentError("PROMPT_TIMEOUT", "The user did not finish the handoff within 5 minutes", "Ask the user, then call auth.handoff again.");
    case "killed":
      throw new TabAgentError("KILLED", "The user stopped all agents with the TabAgent kill switch");
    case "closed":
      throw new TabAgentError("NOT_FOUND", `Tab ${req.tabId} was closed during the handoff`);
  }
}
