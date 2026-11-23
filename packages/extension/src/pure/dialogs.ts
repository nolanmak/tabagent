// JavaScript dialog state machine (D28, #27). One per tab. Pure: the CDP call
// that answers a dialog is injected.
import { TabAgentError } from "@tabagent/protocol";

export type BeforeUnloadPolicy = "accept" | "dismiss" | "ask-agent";

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
  sessionId?: string;
}

/** What a dialog looks like on the wire (D14 `dialogs`). Messages are page text. */
export interface WireDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

export function toWire(d: DialogInfo): WireDialog {
  return { type: d.type, message: d.message, ...(d.defaultPrompt !== undefined && d.type === "prompt" ? { defaultPrompt: d.defaultPrompt } : {}) };
}

export class DialogState {
  private open: DialogInfo | null = null;

  constructor(
    private o: {
      beforeUnload: () => BeforeUnloadPolicy;
      send: (accept: boolean, promptText: string | undefined, sessionId: string | undefined) => Promise<void>;
    },
  ) {}

  current(): DialogInfo | null {
    return this.open;
  }

  /** Page.javascriptDialogOpening. "auto" = answered per the beforeunload setting, agent not involved. */
  onOpening(p: { type: string; message?: string; defaultPrompt?: string; url?: string }, sessionId?: string): "held" | "auto" {
    const d: DialogInfo = { type: p.type, message: String(p.message ?? ""), ...(p.defaultPrompt !== undefined ? { defaultPrompt: p.defaultPrompt } : {}), ...(p.url ? { url: p.url } : {}), ...(sessionId ? { sessionId } : {}) };
    if (d.type === "beforeunload") {
      const pol = this.o.beforeUnload();
      if (pol !== "ask-agent") {
        this.o.send(pol === "accept", undefined, sessionId).catch(() => {});
        return "auto";
      }
    }
    this.open = d;
    return "held";
  }

  /** Page.javascriptDialogClosed (answered by us, the page, or the user). */
  onClosed() {
    this.open = null;
  }

  /** While a dialog is open, everything but dialog.handle gets DIALOG_OPEN (D28). */
  assertNone(tool: string) {
    if (!this.open || tool === "dialog.handle") return;
    const d = this.open;
    throw new TabAgentError("DIALOG_OPEN", `A ${d.type} dialog is open: "${d.message.slice(0, 300)}"`, "Call dialog.handle with action accept or dismiss first.", { pageText: true });
  }

  async handle(action: "accept" | "dismiss", promptText?: string): Promise<WireDialog> {
    const d = this.open;
    if (!d) throw new TabAgentError("NOT_FOUND", "No dialog is open on this tab");
    if (promptText !== undefined && d.type !== "prompt") throw new TabAgentError("BAD_REQUEST", `promptText only applies to a prompt dialog; this one is ${d.type}`);
    await this.o.send(action === "accept", action === "accept" ? promptText : undefined, d.sessionId);
    this.open = null;
    return toWire(d);
  }
}

/** After an action: if it opened a dialog, report it and skip the diff (D28). */
export function actionDialogOutcome(s: DialogState): { dialogs?: WireDialog[]; skipDiff: boolean } {
  const d = s.current();
  return d ? { dialogs: [toWire(d)], skipDiff: true } : { skipDiff: false };
}
