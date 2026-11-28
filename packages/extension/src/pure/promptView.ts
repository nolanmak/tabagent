// #108: the text of a permission prompt, in one place. The side panel, the prompt window, the CLI
// (`tabagent approve`) and the phone page all show exactly these strings, and offer exactly these answers.
import type { MirroredPrompt, PromptAnswer } from "@tabagent/protocol";

export interface PromptLike {
  promptId: string;
  kind: string;
  sessionLabel?: string;
  label?: string;
  level?: string;
  origin: string;
  summary?: string;
  reasons?: string[];
  tool: string;
  expires: number;
  sensitive?: { category: string; description: string };
  auth?: { accountId?: string; accountMasked: string; provider: string; signup?: boolean };
}

type TitleInput = Pick<PromptLike, "kind" | "sessionLabel" | "label" | "level" | "origin" | "summary"> & { sensitive?: { category: string }; auth?: PromptLike["auth"] };

export function promptTitle(p: TitleInput): string {
  const who = p.sessionLabel ?? p.label ?? "An agent";
  // #112: the sign-up summary is TabAgent's own text ("Create an account on <host> as <masked> and save it to Bitwarden?").
  if (p.sensitive?.category === "g" && p.auth?.signup) return p.summary ?? `Create an account on ${p.origin}?`;
  if (p.sensitive?.category === "g" && p.auth) return `Sign in to ${p.origin} as ${p.auth.accountMasked} with ${p.auth.provider}?`;
  if (p.kind === "site") return `${who} wants ${p.level === "read" ? "to read" : p.level === "act" ? "to act on" : "full access to"} ${p.origin}`;
  return `${who} wants to ${p.summary ?? "do something sensitive"}`;
}

export function promptDetail(p: PromptLike): string {
  if (p.kind === "site") {
    return p.level === "read" ? "It will be able to see page content." : p.level === "act" ? "It will be able to click, type and navigate on this site." : "It will be able to run scripts and read cookies and storage on this site.";
  }
  if (!p.sensitive) return `on ${p.origin}`;
  // Policy changes are not tied to the tab's page; the summary names the site.
  return p.sensitive.category === "p" ? p.sensitive.description : `${p.sensitive.description} · on ${p.origin}`;
}

/** No "Always": tab takeover, policy changes, workflow repairs and sign-ups are asked every time. */
function oneShot(p: PromptLike): boolean {
  const c = p.sensitive?.category;
  return p.kind === "attach" || c === "f" || c === "p" || c === "r" || !!p.auth?.signup;
}

export function alwaysLabel(p: PromptLike): string | undefined {
  if (oneShot(p)) return undefined;
  if (p.kind === "site") return `Always allow ${p.level}`;
  return p.sensitive?.category === "g" ? "Always for this account" : "Always allow on this site";
}

/** The answers the prompt offers, in the panel's button order. */
export function offeredAnswers(p: PromptLike): PromptAnswer[] {
  return oneShot(p) ? ["deny", "once"] : ["deny", "always", "once"];
}

export function promptView(p: PromptLike): MirroredPrompt {
  const always = alwaysLabel(p);
  return {
    promptId: p.promptId,
    title: promptTitle(p),
    detail: promptDetail(p),
    summary: p.summary ?? "",
    reasons: [...(p.reasons ?? [])],
    tool: p.tool,
    sessionLabel: p.sessionLabel ?? p.label ?? "",
    origin: p.origin,
    expires: p.expires,
    answers: offeredAnswers(p),
    ...(always ? { alwaysLabel: always } : {}),
  };
}
