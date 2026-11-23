// js.eval over CDP (#18, D18c). Pure: the CDP `send` is injected.
import { TabAgentError, TIMEOUTS } from "@tabagent/protocol";

export const EVAL_MAX_BYTES = 100 * 1024;

type Send = (method: string, params: Record<string, unknown>) => Promise<any>;

let worldSeq = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TabAgentError("TIMEOUT", `js.eval did not finish within ${ms}ms`, "Make the expression faster, or pass a larger timeout (max 120000).")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * Evaluate `expression`. world=main is the page's own context; world=isolated is a
 * fresh world from Page.createIsolatedWorld on every call (not TabAgent's pagelib world).
 */
export async function runEval(send: Send, o: { expression: string; world: "main" | "isolated"; frameId: string; timeout?: number }): Promise<{ value: unknown; type?: string }> {
  const timeout = o.timeout ?? TIMEOUTS.action;
  const run = async () => {
    let contextId: number | undefined;
    if (o.world === "isolated") {
      const w = await send("Page.createIsolatedWorld", { frameId: o.frameId, worldName: `tabagent-eval-${++worldSeq}`, grantUniveralAccess: false });
      contextId = w.executionContextId;
    }
    let r: any;
    try {
      r = await send("Runtime.evaluate", {
        expression: o.expression,
        ...(contextId != null ? { contextId } : {}),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        replMode: true,
        timeout,
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/terminated|timed? ?out/i.test(msg)) throw new TabAgentError("TIMEOUT", `js.eval did not finish within ${timeout}ms`);
      throw e;
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const first = String(d.exception?.description ?? d.exception?.value ?? d.text ?? "Uncaught exception").split("\n")[0];
      throw new TabAgentError("BAD_REQUEST", `The expression threw: ${first.slice(0, 1000)}`, undefined, { pageText: true });
    }
    const res = r.result ?? {};
    if (res.type === "undefined") return { value: null, type: "undefined" };
    let value: unknown;
    if ("value" in res) value = res.value;
    else if (res.unserializableValue !== undefined) value = res.unserializableValue;
    else value = res.description ?? null;
    const size = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
    if (size > EVAL_MAX_BYTES) throw new TabAgentError("TOO_LARGE", `Result is ${size} bytes; the limit is ${EVAL_MAX_BYTES}`, "Return a smaller value, e.g. slice or summarise it in the expression.");
    return "value" in res ? { value } : { value, type: res.type };
  };
  return withTimeout(run(), timeout + 250);
}
