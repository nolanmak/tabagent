// Permission engine. Enforced here (in the extension), never in the bridge.
import { hostMatches, hostOf, isRestrictedUrl, LEVEL_RANK, originOf, TabAgentError, type Level, type SessionMeta, type SitePolicy } from "@tabagent/protocol";
import { broadcast } from "./feed";
import { getSettings, updateSettings } from "./settings";

export type PromptKind = "site" | "sensitive" | "attach";
export type Answer = "once" | "always" | "deny";

export interface PromptInfo {
  id: string;
  kind: PromptKind;
  label: string;
  sessionId: string;
  origin: string;
  level?: Level;
  tool: string;
  summary: string;
  reasons: string[];
  created: number;
}

const PROMPT_TIMEOUT_MS = 120_000;
const pending = new Map<string, { info: PromptInfo; resolve: (a: Answer) => void; windowId?: number; timer: ReturnType<typeof setTimeout> }>();
/** session -> origin -> granted level ("Allow once" = for this session). */
const grants = new Map<string, Map<string, Level>>();

export function pendingPrompts(): PromptInfo[] {
  return [...pending.values()].map((p) => p.info);
}

export function answerPrompt(id: string, answer: Answer) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(answer);
  if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
  broadcast({ type: "prompts", prompts: pendingPrompts() });
  return true;
}

export function denyAllPrompts() {
  for (const id of [...pending.keys()]) answerPrompt(id, "deny");
}

export function clearGrants(sessionId?: string) {
  if (sessionId) grants.delete(sessionId);
  else grants.clear();
}

chrome.windows.onRemoved.addListener((wid) => {
  for (const [id, p] of pending) if (p.windowId === wid) answerPrompt(id, "deny");
});

async function ask(info: Omit<PromptInfo, "id" | "created">): Promise<Answer> {
  const id = crypto.randomUUID();
  const full: PromptInfo = { ...info, id, created: Date.now() };
  return new Promise<Answer>((resolve) => {
    const timer = setTimeout(() => answerPrompt(id, "deny"), PROMPT_TIMEOUT_MS);
    pending.set(id, { info: full, resolve, timer });
    broadcast({ type: "prompts", prompts: pendingPrompts() });
    chrome.windows
      .create({ url: chrome.runtime.getURL(`prompt.html?id=${id}`), type: "popup", width: 460, height: 420, focused: true })
      .then((w) => {
        const p = pending.get(id);
        if (p && w?.id != null) p.windowId = w.id;
      })
      .catch(() => {
        /* side panel can still answer */
      });
  });
}

export function isDenylisted(host: string, denylist: string[]) {
  return denylist.some((g) => hostMatches(g, host));
}

/** Effective stored policy for an origin (before session grants). */
export async function effectivePolicy(url: string): Promise<{ origin: string | null; policy: SitePolicy; source: string }> {
  if (!url || /^about:blank/i.test(url) || /^data:/i.test(url)) return { origin: null, policy: "full", source: "blank page" };
  if (isRestrictedUrl(url)) return { origin: null, policy: "deny", source: "restricted browser page" };
  const origin = originOf(url);
  if (!origin) return { origin: null, policy: "deny", source: "unsupported URL scheme" };
  const s = await getSettings();
  const explicit = s.policies[origin];
  if (explicit) return { origin, policy: explicit, source: "site policy" };
  if (isDenylisted(hostOf(url), s.denylist)) return { origin, policy: "deny", source: "built-in denylist (unlock in side panel)" };
  return { origin, policy: s.defaultPolicy, source: "default policy" };
}

function tokenLimits(meta: SessionMeta, url: string, level: Level) {
  if (LEVEL_RANK[level] > LEVEL_RANK[meta.cap]) {
    throw new TabAgentError("PERMISSION_DENIED", `This client's token is limited to "${meta.cap}" but ${level} access is needed`, "Create a token with a higher --cap.");
  }
  if (meta.sites.length) {
    const host = hostOf(url);
    if (host && !meta.sites.some((g) => hostMatches(g, host))) {
      throw new TabAgentError("PERMISSION_DENIED", `This client's token is not allowed on ${host}`, `Allowed sites: ${meta.sites.join(", ")}`);
    }
  }
}

/** Ensure the session may use `level` on `url`. May prompt the user. */
export async function requireSite(meta: SessionMeta, url: string, level: Level, tool: string, summary: string) {
  const { origin, policy, source } = await effectivePolicy(url);
  if (!origin) {
    if (policy === "deny") throw new TabAgentError("PERMISSION_DENIED", `TabAgent cannot act on ${url.slice(0, 80)} (${source})`);
    return;
  }
  tokenLimits(meta, url, level);
  const g = grants.get(meta.id)?.get(origin);
  if (g && LEVEL_RANK[g] >= LEVEL_RANK[level]) return;
  if (policy === "deny") throw new TabAgentError("PERMISSION_DENIED", `${origin} is denied (${source})`, "The user can change this in the TabAgent side panel.");
  if (policy !== "ask" && LEVEL_RANK[policy] >= LEVEL_RANK[level]) return;
  const answer = await ask({ kind: "site", label: meta.label, sessionId: meta.id, origin, level, tool, summary, reasons: policy !== "ask" ? [`Site is set to "${policy}"; ${level} needs more access`] : [] });
  if (answer === "deny") throw new TabAgentError("PERMISSION_DENIED", `The user denied ${level} access to ${origin}`);
  if (answer === "always") {
    const s = await getSettings();
    await updateSettings({ policies: { ...s.policies, [origin]: level } });
  } else {
    if (!grants.has(meta.id)) grants.set(meta.id, new Map());
    grants.get(meta.id)!.set(origin, level);
  }
}

/** Ask before a sensitive action unless pre-approved for this site. */
export async function requireSensitive(meta: SessionMeta, url: string, tool: string, summary: string, reasons: string[], kind: PromptKind = "sensitive") {
  const origin = originOf(url) ?? url;
  const s = await getSettings();
  if (kind === "sensitive" && s.sensitiveAllowed[origin]) return;
  const answer = await ask({ kind, label: meta.label, sessionId: meta.id, origin, tool, summary, reasons });
  if (answer === "deny") throw new TabAgentError("PERMISSION_DENIED", `The user declined: ${summary}`);
  if (answer === "always" && kind === "sensitive") {
    await updateSettings({ sensitiveAllowed: { ...s.sensitiveAllowed, [origin]: true } });
  }
}
