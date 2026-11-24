// @vitest-environment happy-dom
// nolanmak/Jarvis#2524: page.find must hand back the rendered instance of a control
// first, and say why an instance without a box cannot be acted on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { submitInfo } from "../src/pagelib/forms";
import { findNodes, hiddenReason } from "../src/pagelib/index";

const FIX = join(__dirname, "../../../e2e/fixtures");
function load(html: string) {
  document.open();
  document.write(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  document.close();
}

/** happy-dom has no layout: a node in a hidden or display:none subtree (shadow-piercing) gets a 0x0 box. */
function boxless(el: Element): boolean {
  for (let a: Element | null = el; a; a = a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null)) {
    if (a.hasAttribute("hidden") || (a as HTMLElement).style?.display === "none") return true;
  }
  return false;
}
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return boxless(this) ? new DOMRect(0, 0, 0, 0) : new DOMRect(10, 10, 100, 20);
  };
});

type M = { el: number; role: string; name: string; hidden?: string };
const matches = (r: ReturnType<typeof findNodes>) => (r.value as { matches: M[] }).matches;

describe("page.find on a React streaming page before the reveal (live portal.anthropic.com/login)", () => {
  it("flags every login button as hidden inside the unrevealed Suspense boundary", () => {
    load(readFileSync(join(FIX, "streaming-login.html"), "utf8"));
    const m = matches(findNodes(null, { by: "role", value: "button", name: "Continue with" }));
    expect(m.map((x) => x.name)).toEqual(["Continue with Google", "Continue with email", "Continue with SSO"]);
    for (const x of m) expect(x.hidden).toMatch(/inside <div#S:0> which is display:none \(a React streaming Suspense boundary that has not been revealed yet\)/);
  });
});

describe("page.find prefers the rendered duplicate", () => {
  it("orders visible matches before boxless copies and only flags the copies", () => {
    load(readFileSync(join(FIX, "streaming-login.html"), "utf8"));
    const r = findNodes(null, { by: "text", value: "Open settings" });
    const m = matches(r);
    expect(m.length).toBe(2);
    expect(m[0].hidden).toBeUndefined();
    expect(r.elements[0]!.parentElement!.id).toBe("dup");
    expect(m[1].hidden).toBe("inside <div> which is display:none");
  });

  it("pierces open shadow roots and still prefers the rendered instance", () => {
    document.body.innerHTML = "<x-host></x-host>";
    const root = document.querySelector("x-host")!.attachShadow({ mode: "open" });
    root.innerHTML = '<div hidden><button>Go</button></div><button id="real">Go</button>';
    const r = findNodes(null, { by: "role", value: "button", name: "Go" });
    expect(r.elements.length).toBe(2);
    expect((r.elements[0] as Element).id).toBe("real");
    expect(matches(r)[1].hidden).toMatch(/display:none/);
  });
});

describe("a React form with a display:none mirror (live openai.com Request Daybreak Access)", () => {
  it("flags the mirror's fields and the hidden submit button", () => {
    load(readFileSync(join(FIX, "mirror-form.html"), "utf8"));
    const email = matches(findNodes(null, { by: "label", value: "Work email" }));
    expect(email.map((m) => m.hidden)).toEqual(["inside <form#mktoForm_1377.hidden.mktoForm> which is display:none"]);
    const go = matches(findNodes(null, { by: "role", value: "button", name: "Submit and start verification" }));
    expect(go[0].hidden).toBe("display:none (hidden attribute)");
  });

  it("submitInfo reports a submit control that exists but is disabled and hidden", () => {
    load(readFileSync(join(FIX, "mirror-form.html"), "utf8"));
    const v = submitInfo(null).value as any;
    expect(v.submit).toBeNull();
    expect(v.blocked).toEqual({ control: "Submit and start verification", why: "disabled and hidden (display:none (hidden attribute))" });
    // a form whose only submit is enabled and rendered is not blocked
    document.body.innerHTML = '<form><input name="q"><button>Go</button></form>';
    expect((submitInfo(null).value as any).blocked).toBeUndefined();
  });
});

describe("hiddenReason", () => {
  it("names the cause: own display:none, visibility, zero-size box", () => {
    document.body.innerHTML = '<button id="a" style="display:none">A</button><button id="b" style="visibility:hidden">B</button><button id="c">C</button>';
    expect(hiddenReason(document.getElementById("a")!)).toBe("display:none");
    expect(hiddenReason(document.getElementById("b")!)).toBe("visibility:hidden");
    expect(hiddenReason(document.getElementById("c")!)).toBeNull();
    const c = document.getElementById("c")!;
    c.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    expect(hiddenReason(c)).toBe("zero-size box (0x0)");
    const gone = document.createElement("button");
    expect(hiddenReason(gone)).toBe("detached");
  });
});
