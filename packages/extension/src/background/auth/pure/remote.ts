// #61 Part B: the input-only channel for a tab handed to the user through the remote (phone) page.
//
// Decision: a local handoff detaches the debugger so the user's own hands are not observed. A remote
// handoff has no local hands: the phone's taps and keys must reach the tab through CDP. So, only while
// a remote handoff is live and only after the phone asks for something, the extension attaches a bare
// debugger session to that one tab, outside the agent's CdpTab/Driver machinery:
//   - no pagelib, no refs, no network/console capture, no snapshots;
//   - only the methods in REMOTE_CDP_METHODS (screenshot, layout size, mouse, keys, insertText, focus
//     emulation so a background tab renders and takes input) - never Runtime, Page.navigate or DOM;
//   - the tab comes from this module's own handoffId → tabId map, never from the bridge message;
//   - agent commands on the tab still get TAB_BUSY (sessions.ts), and the session is detached when the
//     handoff ends, so the agent's next command attaches fresh.
import { HandoffInputSchema, TabAgentError, type HandoffInput } from "@tabagent/protocol";
import { keyDef } from "../../keys";

export const REMOTE_CDP_METHODS: ReadonlySet<string> = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Emulation.setFocusEmulationEnabled",
]);

/** How long the extension waits for the bridge's handoff.opened before going local-only (older bridge). */
export const OPEN_WAIT_MS = 3000;

export interface Viewport {
  w: number;
  h: number;
}
export interface CdpCall {
  method: string;
  params: Record<string, any>;
}

const px = (v: number, size: number) => Math.min(Math.max(0, size - 1), Math.max(0, Math.round(v * size)));

/** Map one phone input to CDP calls. x/y are 0..1 of the screenshot; the viewport is in CSS px. */
export function inputToCdp(input: HandoffInput, vp: Viewport): CdpCall[] {
  switch (input.kind) {
    case "tap": {
      const x = px(input.x, vp.w);
      const y = px(input.y, vp.h);
      return [
        { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } },
        { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x, y, button: "left", clickCount: 1 } },
        { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x, y, button: "left", clickCount: 1 } },
      ];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: input.text } }];
    case "key": {
      const d = keyDef(input.key);
      const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: 0 };
      return [
        { method: "Input.dispatchKeyEvent", params: { type: d.text ? "keyDown" : "rawKeyDown", ...base, ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}) } },
        { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
      ];
    }
    case "scroll":
      return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: px(input.x, vp.w), y: px(input.y, vp.h), deltaX: 0, deltaY: input.dy } }];
  }
}

export interface RemoteDeps {
  send(m: unknown): boolean;
  /** Attach a bare chrome.debugger session to the tab (no CdpTab, no driver). */
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  cdp(tabId: number, method: string, params: Record<string, unknown>): Promise<any>;
  /** End the handoff on that tab as if Done/Cancel was pressed in the side panel. */
  end(tabId: number, result: "done" | "cancel"): boolean;
  newId?: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export interface OpenInfo {
  origin: string;
  reason: string;
  sessionLabel: string;
}
export interface OpenResult {
  handoffId: string | null;
  url: string | null;
  timeoutMs: number | null;
}

interface Entry {
  tabId: number;
  attached: boolean;
}

const NONE: OpenResult = { handoffId: null, url: null, timeoutMs: null };

export function createRemoteHandoffs(deps: RemoteDeps) {
  const byId = new Map<string, Entry>();
  const waits = new Map<string, { timer: unknown; done: (m: any) => void }>();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const st = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const call = (e: Entry, method: string, params: Record<string, unknown>) => {
    if (!REMOTE_CDP_METHODS.has(method)) throw new TabAgentError("PERMISSION_DENIED", `${method} is not allowed during a remote handoff`);
    return deps.cdp(e.tabId, method, params);
  };

  async function ensure(e: Entry) {
    if (e.attached) return;
    await deps.attach(e.tabId);
    e.attached = true;
    // A background tab neither paints nor takes input without focus emulation (driver.ts wake()).
    await call(e, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  const fail = (type: string, id: string, code: TabAgentError["code"], message: string) => deps.send({ type, id, ok: false, error: { code, message } });
  const codeOf = (err: unknown) => (err instanceof TabAgentError ? err.code : "INTERNAL");

  async function frame(msg: { id: string; handoffId: string }) {
    const e = byId.get(String(msg.handoffId));
    if (!e) return fail("handoff.frame.result", msg.id, "NOT_FOUND", "No remote handoff with that id");
    try {
      await ensure(e);
      const r = await call(e, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
      deps.send({ type: "handoff.frame.result", id: msg.id, ok: true, mime: "image/jpeg", dataBase64: String(r?.data ?? "") });
    } catch (err) {
      e.attached = false;
      fail("handoff.frame.result", msg.id, codeOf(err), "The tab could not be captured");
    }
  }

  async function input(msg: { id: string; handoffId: string; input: unknown }) {
    const e = byId.get(String(msg.handoffId));
    if (!e) return fail("handoff.input.result", msg.id, "NOT_FOUND", "No remote handoff with that id");
    const p = HandoffInputSchema.safeParse(msg.input);
    if (!p.success) return fail("handoff.input.result", msg.id, "BAD_REQUEST", "Unsupported input");
    try {
      await ensure(e);
      const m = await call(e, "Page.getLayoutMetrics", {});
      const v = m?.cssVisualViewport ?? m?.visualViewport ?? m?.cssLayoutViewport ?? m?.layoutViewport;
      const vp = { w: Number(v?.clientWidth) || 0, h: Number(v?.clientHeight) || 0 };
      if (!vp.w || !vp.h) throw new TabAgentError("INTERNAL", "No viewport size");
      for (const c of inputToCdp(p.data, vp)) await call(e, c.method, c.params);
      deps.send({ type: "handoff.input.result", id: msg.id, ok: true });
    } catch (err) {
      e.attached = false;
      fail("handoff.input.result", msg.id, codeOf(err), "The input could not be delivered");
    }
  }

  return {
    /** Ask the bridge for a remote link. Never rejects: anything but a link means a local-only handoff. */
    open(commandId: string, tabId: number, info: OpenInfo): Promise<OpenResult> {
      const id = newId();
      return new Promise<OpenResult>((resolve) => {
        if (!deps.send({ type: "handoff.open", id, commandId, origin: info.origin.slice(0, 300), reason: info.reason.slice(0, 500), sessionLabel: info.sessionLabel.slice(0, 100) })) return resolve(NONE);
        const timer = st(() => {
          waits.delete(id);
          resolve(NONE);
        }, OPEN_WAIT_MS);
        waits.set(id, {
          timer,
          done: (m) => {
            const timeoutMs = typeof m?.timeoutMs === "number" && m.timeoutMs > 0 ? m.timeoutMs : null;
            if (m?.ok === true && typeof m.handoffId === "string" && m.handoffId) {
              byId.set(m.handoffId, { tabId, attached: false });
              resolve({ handoffId: m.handoffId, url: typeof m.url === "string" ? m.url : null, timeoutMs });
            } else resolve({ handoffId: null, url: null, timeoutMs });
          },
        });
      });
    },

    /** The handoff ended (any way): drop the mapping, detach the input session, tell the bridge. */
    async close(handoffId: string, outcome: string): Promise<void> {
      const e = byId.get(handoffId);
      byId.delete(handoffId);
      if (e?.attached) {
        e.attached = false;
        await deps.detach(e.tabId).catch(() => {});
      }
      deps.send({ type: "handoff.closed", handoffId, outcome });
    },

    /** Bridge → extension handoff messages. Returns true when the message was ours. */
    onMessage(msg: any): boolean {
      switch (msg?.type) {
        case "handoff.opened": {
          const w = waits.get(msg.id);
          if (w) {
            waits.delete(msg.id);
            ct(w.timer);
            w.done(msg);
          }
          return true;
        }
        case "handoff.frame":
          void frame(msg);
          return true;
        case "handoff.input":
          void input(msg);
          return true;
        case "handoff.end": {
          const e = byId.get(String(msg.handoffId));
          if (e) deps.end(e.tabId, msg.result === "done" ? "done" : "cancel");
          return true;
        }
      }
      return false;
    },

    active: () => byId.size,
  };
}

export type RemoteHandoffs = ReturnType<typeof createRemoteHandoffs>;
