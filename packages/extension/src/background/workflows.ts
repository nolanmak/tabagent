// Extension-owned capture state and local recipe store. Recipes are drafts until the user reviews
// them; no credentials, cookies, raw DOM, or sensitive input values are persisted.
import { assertionsPass, buildRecipe, chooseLocatorCandidate, replayBlockCode, replayBlockReason, shouldSkipDuplicate, type CaptureEvent, type Locator, type RunState, type WorkflowRecipe, type WorkflowRunReason } from "../pure/workflow";
import { driverFor } from "./driver";
import { requireSite } from "./permissions";
import { cronMatches, parseCron } from "../pure/cron";
import { getSession, resolveTab } from "./sessions";

type CaptureSource = "agent" | "manual";
type ActiveCapture = { source: CaptureSource; name: string; events: CaptureEvent[]; startedAt: number };
const active = new Map<number, ActiveCapture>();
let recipes: WorkflowRecipe[] | null = null;
export type WorkflowRun = { id: string; recipeId: string; startedAt: number; endedAt?: number; state: RunState; step?: number; reason?: string; reasonCode?: WorkflowRunReason; dedupeKey?: string; repairs: { id: string; step: number; from: Locator; to: Locator; decision?: "accept" | "reject" }[] };
let runs: WorkflowRun[] | null = null;
export type WorkflowSchedule = { id: string; recipeId: string; tabId: number; meta: any; cron: string; timeZone: string; enabled: boolean; lastMinute?: number };
let schedules: WorkflowSchedule[] | null = null;
// Chrome alarms and test/manual ticks may arrive together. Loading storage is async, so the
// lastMinute guard alone is not a mutex; serialize a tick to prevent duplicate cron runs.
let scheduleTick: Promise<WorkflowRun[]> | null = null;

async function load() {
  if (!recipes) recipes = ((await chrome.storage.local.get("workflows")).workflows as WorkflowRecipe[] | undefined) ?? [];
  return recipes;
}
async function save() {
  await chrome.storage.local.set({ workflows: recipes ?? [] });
}
async function loadSchedules() { if (!schedules) schedules = ((await chrome.storage.local.get("workflowSchedules")).workflowSchedules as WorkflowSchedule[] | undefined) ?? []; return schedules; }
async function saveSchedules() { await chrome.storage.local.set({ workflowSchedules: schedules ?? [] }); }
async function loadRuns() { if (!runs) runs = ((await chrome.storage.local.get("workflowRuns")).workflowRuns as WorkflowRun[] | undefined) ?? []; return runs; }
async function saveRuns() { await chrome.storage.local.set({ workflowRuns: runs ?? [] }); }

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

/** Navigation is part of manual capture even though the old document's listeners are gone. */
export function recordManualNavigation(tabId: number, url: string) {
  const capture = active.get(tabId);
  if (capture?.source === "manual" && /^https?:/i.test(url)) capture.events.push({ kind: "navigate", url });
}

/** Kill/tab close discards armed, unsaved capture material. */
export async function discardCapture(tabId: number) {
  const capture = active.get(tabId);
  if (!capture) return false;
  active.delete(tabId);
  if (capture.source === "manual") await removeManualListener(tabId).catch(() => {});
  return true;
}
export async function discardAllCaptures() { await Promise.all([...active.keys()].map(discardCapture)); }

/** Minimal capture state for the extension UI; events themselves stay private until stopped. */
export function listActiveCaptures() {
  return [...active.entries()].map(([tabId, capture]) => ({ tabId, source: capture.source, name: capture.name, startedAt: capture.startedAt }));
}

export async function captureAgentStep(tabId: number | undefined, tool: string, params: Record<string, unknown>, url: string): Promise<{ tabId: number; event: CaptureEvent } | undefined> {
  if (tabId == null || tool.startsWith("workflow.")) return;
  const capture = active.get(tabId);
  if (!capture || capture.source !== "agent") return;
  if (tool === "nav.goto" && typeof params.url === "string") return { tabId, event: { kind: "navigate", url: params.url } };
  else if ((tool === "act.click" || tool === "act.type") && typeof params.ref === "string") {
    const ref = params.ref;
    const info = (await driverFor(tabId, url).then((d) => d.call("info", [], { ref })).catch(() => null)) as { role?: string; name?: string; label?: string; selector?: string } | null;
    const target = info ? { role: info.role, name: info.name, label: info.label, selector: info.selector } : { name: "captured target" };
    if (tool === "act.click") return { tabId, event: { kind: "click", url, target } };
    if (typeof params.text === "string") return { tabId, event: { kind: "input", url, target: { ...target, value: params.text } } };
  }
  else if (tool === "act.press" && typeof params.key === "string") return { tabId, event: { kind: "press", url, key: params.key } };
}

export function recordAgent(captured: unknown) {
  const item = captured as { tabId?: number; event?: CaptureEvent } | undefined;
  if (item?.tabId != null && item.event && active.get(item.tabId)?.source === "agent") active.get(item.tabId)!.events.push(item.event);
}

export async function listWorkflows() {
  return (await load()).map((r) => ({ ...r, steps: [...r.steps] }));
}

export async function reviewWorkflow(id: string, approve: boolean, dedupeKey?: string, urlIncludes?: string) {
  const all = await load();
  const recipe = all.find((r) => r.id === id);
  if (!recipe) throw new Error(`No workflow recipe "${id}"`);
  if (approve) {
    recipe.status = "reviewed";
    const key = dedupeKey?.trim().slice(0, 200);
    if (key) recipe.dedupeKey = key;
    else delete recipe.dedupeKey;
    const expectedUrl = urlIncludes?.trim().slice(0, 500);
    recipe.assertions = expectedUrl ? [{ kind: "url_includes", value: expectedUrl }] : [];
  }
  await save();
  return recipe;
}

/** The user may trim a draft before review, but reviewed recipes are immutable except repairs. */
export async function removeWorkflowStep(id: string, index: number) {
  const recipe = (await load()).find((entry) => entry.id === id);
  if (!recipe) throw new Error(`No workflow recipe "${id}"`);
  if (recipe.status !== "draft") throw new Error("Only draft recipes can be edited");
  if (!Number.isInteger(index) || index < 0 || index >= recipe.steps.length) throw new Error("Workflow step was not found");
  recipe.steps.splice(index, 1);
  await save();
  return recipe;
}

export async function listWorkflowRuns(recipeId?: string) {
  return (await loadRuns()).filter((r) => !recipeId || r.recipeId === recipeId).map((r) => ({ ...r, repairs: [...r.repairs] }));
}
export async function reviewRepair(recipeId: string, repairId: string, decision: "accept" | "reject") {
  const run = (await loadRuns()).find((r) => r.recipeId === recipeId && r.repairs.some((x) => x.id === repairId));
  const repair = run?.repairs.find((x) => x.id === repairId);
  const recipe = (await load()).find((r) => r.id === recipeId);
  if (!run || !repair || !recipe) throw new Error("Repair proposal not found");
  repair.decision = decision;
  if (decision === "accept" && recipe.steps[repair.step]) recipe.steps[repair.step].locator = repair.to;
  await save();
  await saveRuns();
  return { repair, recipe };
}
export async function listWorkflowSchedules() { return (await loadSchedules()).map((s) => ({ ...s, meta: undefined })); }
export async function scheduleWorkflow(recipeId: string, tabId: number, meta: any, cron: string, timeZone: string) {
  const recipe = (await load()).find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`No workflow recipe "${recipeId}"`);
  if (recipe.status !== "reviewed") throw new Error("Only reviewed recipes can be scheduled");
  parseCron(cron); new Intl.DateTimeFormat("en-US", { timeZone }).format();
  const schedule: WorkflowSchedule = { id: crypto.randomUUID(), recipeId, tabId, meta: { id: meta.id, label: meta.label, cap: meta.cap, sites: meta.sites }, cron, timeZone, enabled: true };
  schedules = [...await loadSchedules(), schedule]; await saveSchedules();
  await chrome.alarms.create("tabagent-workflows", { periodInMinutes: 1 });
  return schedule;
}
export async function unscheduleWorkflow(id: string) { schedules = (await loadSchedules()).filter((s) => s.id !== id); await saveSchedules(); }
/** Invoked from the extension alarm. A missed minute is never replayed (no catch-up). */
async function recordScheduledBlock(recipeId: string, reasonCode: WorkflowRunReason, reason: string) {
  const run: WorkflowRun = { id: crypto.randomUUID(), recipeId, startedAt: Date.now(), endedAt: Date.now(), state: "blocked", reasonCode, reason, repairs: [] };
  runs = [...(await loadRuns()).slice(-99), run];
  await saveRuns();
  return run;
}

async function runDueSchedulesOnce(now: Date, extensionConnected: boolean) {
  const minute = Math.floor(now.getTime() / 60_000); const due: WorkflowRun[] = [];
  for (const s of await loadSchedules()) if (s.enabled && s.lastMinute !== minute && cronMatches(s.cron, now, s.timeZone)) {
    s.lastMinute = minute;
    due.push(extensionConnected ? await runWorkflow(s.recipeId, s.tabId, s.meta) : await recordScheduledBlock(s.recipeId, "NO_EXTENSION", "the paired extension bridge is offline"));
  }
  await saveSchedules(); return due;
}

export function runDueSchedules(now = new Date(), extensionConnected = true) {
  if (scheduleTick) return scheduleTick;
  scheduleTick = runDueSchedulesOnce(now, extensionConnected).finally(() => { scheduleTick = null; });
  return scheduleTick;
}

async function findRef(tabId: number, url: string, locator: Locator): Promise<{ ref: string; repair?: Locator } | null> {
  const drv = await driverFor(tabId, url);
  const by = locator.role ? "role" : locator.label ? "label" : locator.text ? "text" : locator.selector ? "css" : "text";
  const value = locator.role ?? locator.label ?? locator.text ?? locator.selector ?? locator.name ?? "";
  const matches = await drv.find({ by, value, ...(locator.role && locator.name ? { name: locator.name } : {}) } as any);
  if (matches.matches.length === 1) return { ref: matches.matches[0].ref };
  const candidates = matches.matches.map((m: any) => ({ role: m.role ?? locator.role ?? "", name: m.name ?? "", selector: m.selector ?? "" }));
  const repaired = chooseLocatorCandidate(locator, candidates);
  if (!repaired) return null;
  const hit = matches.matches.find((m: any) => m.name === repaired.name && (m.role ?? "") === repaired.role);
  return hit ? { ref: hit.ref, repair: repaired } : null;
}

/** Execute a reviewed, low-risk recipe in an already-owned tab. Every navigated origin is re-authorized. */
export async function runWorkflow(recipeId: string, tabId: number, meta: any): Promise<WorkflowRun> {
  const recipe = (await load()).find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`No workflow recipe "${recipeId}"`);
  const priorRuns = await loadRuns();
  const run: WorkflowRun = { id: crypto.randomUUID(), recipeId, startedAt: Date.now(), state: "queued", ...(recipe.dedupeKey ? { dedupeKey: recipe.dedupeKey } : {}), repairs: [] };
  runs = [...priorRuns.slice(-99), run];
  const finish = async <T extends Partial<WorkflowRun>>(patch: T) => { Object.assign(run, patch); await saveRuns(); return run; };
  if (recipe.status !== "reviewed") return finish({ state: "blocked" as const, endedAt: Date.now(), reason: "recipe has not been reviewed in the extension" });
  if (shouldSkipDuplicate(recipe.dedupeKey, priorRuns.filter((candidate) => candidate.recipeId === recipeId))) return finish({ state: "skipped" as const, endedAt: Date.now(), reason: "a completed run already has this recipe's dedupe key" });
  run.state = "running";
  try {
    // A scheduled recipe never gains access merely because it remembers a tab id.
    // The original session must still exist and still own that tab.
    await resolveTab(await getSession(meta), tabId);
    for (let i = 0; i < recipe.steps.length; i++) {
      run.step = i;
      const step = recipe.steps[i];
      const blocked = replayBlockReason(step);
      if (blocked) return finish({ state: "blocked" as const, endedAt: Date.now(), reason: `step ${i + 1}: ${blocked}`, reasonCode: replayBlockCode(step) ?? "SENSITIVE_ACTION" });
      const tab = await chrome.tabs.get(tabId);
      const url = tab.pendingUrl || tab.url || "";
      if (step.kind === "navigate") {
        await requireSite(meta, step.url!, "act", "workflow.run", `replay workflow navigation to ${step.url}`);
        await (await driverFor(tabId, step.url!)).navigate(step.url!, "load", 30_000);
        continue;
      }
      await requireSite(meta, url, "act", "workflow.run", `replay workflow step ${i + 1}`);
      const found = step.locator ? await findRef(tabId, url, step.locator) : null;
      if ((step.kind === "click" || step.kind === "input" || step.kind === "select") && !found) return finish({ state: "blocked" as const, endedAt: Date.now(), reason: `step ${i + 1}: target was missing or ambiguous`, reasonCode: "AMBIGUOUS_TARGET" });
      if (found?.repair && step.locator) run.repairs.push({ id: crypto.randomUUID(), step: i, from: step.locator, to: found.repair });
      const drv = await driverFor(tabId, url);
      if (step.kind === "click") await drv.click(found!.ref);
      else if (step.kind === "input") await drv.fill(found!.ref, (step.value as any).value);
      else if (step.kind === "press") await drv.press(step.key ?? "");
    }
    const finalTab = await chrome.tabs.get(tabId);
    const finalUrl = finalTab.pendingUrl || finalTab.url || "";
    if (!assertionsPass(recipe.assertions, finalUrl)) return finish({ state: "blocked" as const, endedAt: Date.now(), reason: "one or more reviewed postconditions did not pass", reasonCode: "ASSERTION_FAILED" });
    return finish({ state: "succeeded" as const, endedAt: Date.now() });
  } catch (e) {
    const reason = String((e as Error).message ?? e).slice(0, 300);
    const reasonCode: WorkflowRunReason | undefined = /sign.?in|auth|mfa|passkey/i.test(reason) ? "AUTH_REQUIRED" : /permission|deny|scope/i.test(reason) ? "POLICY_DENIED" : undefined;
    return finish({ state: reasonCode ? "blocked" as const : "failed" as const, endedAt: Date.now(), reason, ...(reasonCode ? { reasonCode } : {}) });
  }
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
