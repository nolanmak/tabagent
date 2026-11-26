// Extension-owned capture state and local recipe store. Recipes are drafts until the user reviews
// them; no credentials, cookies, raw DOM, or sensitive input values are persisted.
import { buildRecipe, type CaptureEvent, type WorkflowRecipe } from "../pure/workflow";
import { driverFor } from "./driver";

type CaptureSource = "agent" | "manual";
type ActiveCapture = { source: CaptureSource; name: string; events: CaptureEvent[]; startedAt: number };
const active = new Map<number, ActiveCapture>();
let recipes: WorkflowRecipe[] | null = null;

async function load() {
  if (!recipes) recipes = ((await chrome.storage.local.get("workflows")).workflows as WorkflowRecipe[] | undefined) ?? [];
  return recipes;
}
async function save() {
  await chrome.storage.local.set({ workflows: recipes ?? [] });
}

function sourceFor(c: ActiveCapture): WorkflowRecipe["source"] {
  return c.source;
}

export async function startCapture(tabId: number, source: CaptureSource, name: string) {
  if (active.has(tabId)) throw new Error("A workflow capture is already active for this tab");
  active.set(tabId, { source, name, events: [], startedAt: Date.now() });
  if (source === "manual") await installManualListener(tabId);
}

export async function stopCapture(tabId: number): Promise<WorkflowRecipe> {
  const capture = active.get(tabId);
  if (!capture) throw new Error("No workflow capture is active for this tab");
  active.delete(tabId);
  if (capture.source === "manual") await removeManualListener(tabId);
  const recipe = buildRecipe(crypto.randomUUID(), capture.name, sourceFor(capture), capture.events, Date.now());
  const all = await load();
  recipes = [...all, recipe];
  await save();
  return recipe;
}

export function recordManual(tabId: number, event: CaptureEvent) {
  const capture = active.get(tabId);
  if (capture?.source === "manual") capture.events.push(event);
}

export async function recordAgent(tabId: number | undefined, tool: string, params: Record<string, unknown>, url: string) {
  if (tabId == null || tool.startsWith("workflow.")) return;
  const capture = active.get(tabId);
  if (!capture || capture.source !== "agent") return;
  if (tool === "nav.goto" && typeof params.url === "string") capture.events.push({ kind: "navigate", url: params.url });
  else if ((tool === "act.click" || tool === "act.type") && typeof params.ref === "string") {
    const ref = params.ref;
    const info = (await driverFor(tabId, url).then((d) => d.call("info", [], { ref })).catch(() => null)) as { role?: string; name?: string; label?: string; selector?: string } | null;
    const target = info ? { role: info.role, name: info.name, label: info.label, selector: info.selector } : { name: "captured target" };
    if (tool === "act.click") capture.events.push({ kind: "click", url, target });
    else if (typeof params.text === "string") capture.events.push({ kind: "input", url, target: { ...target, value: params.text } });
  }
  else if (tool === "act.press" && typeof params.key === "string") capture.events.push({ kind: "press", url, key: params.key });
}

export async function listWorkflows() {
  return (await load()).map((r) => ({ ...r, steps: [...r.steps] }));
}

export async function reviewWorkflow(id: string, approve: boolean) {
  const all = await load();
  const recipe = all.find((r) => r.id === id);
  if (!recipe) throw new Error(`No workflow recipe "${id}"`);
  if (approve) recipe.status = "reviewed";
  await save();
  return recipe;
}

async function installManualListener(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const key = "__tabagentWorkflowCapture";
      if ((window as any)[key]) return;
      const target = (el: Element) => {
        const html = el as HTMLElement;
        const control = el as HTMLInputElement;
        const label = control.labels?.[0]?.textContent?.trim();
        const name = el.getAttribute("aria-label") || label || el.getAttribute("name") || html.innerText?.trim().slice(0, 120) || undefined;
        const role = el.getAttribute("role") || (el.matches("button") ? "button" : el.matches("a") ? "link" : el.matches("input,textarea") ? "textbox" : undefined);
        const id = el.id ? `#${CSS.escape(el.id)}` : el.getAttribute("data-testid") ? `[data-testid=${JSON.stringify(el.getAttribute("data-testid"))}]` : undefined;
        return { role, name, label, selector: id, value: control.value };
      };
      const send = (event: unknown) => chrome.runtime.sendMessage({ type: "workflow.manual_event", event });
      const click = (e: Event) => e.target instanceof Element && send({ kind: "click", url: location.href, target: target(e.target) });
      const change = (e: Event) => e.target instanceof Element && send({ kind: "input", url: location.href, target: target(e.target) });
      const keydown = (e: KeyboardEvent) => ["Enter", "Escape", "Tab"].includes(e.key) && send({ kind: "press", url: location.href, key: e.key });
      document.addEventListener("click", click, true);
      document.addEventListener("change", change, true);
      document.addEventListener("keydown", keydown, true);
      (window as any)[key] = { click, change, keydown };
    },
  });
}

async function removeManualListener(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const saved = (window as any).__tabagentWorkflowCapture;
      if (!saved) return;
      document.removeEventListener("click", saved.click, true);
      document.removeEventListener("change", saved.change, true);
      document.removeEventListener("keydown", saved.keydown, true);
      delete (window as any).__tabagentWorkflowCapture;
    },
  });
}
