// Side panel collapsible sections (#156): Sessions, Activity, Workflows and Settings start closed unless they
// need attention, and show a count and a short summary while closed. Plain data in, plain data out.

export type SectionId = "sessions" | "activity" | "workflows" | "settings";

export interface SectionFacts {
  sessions: { tabs: number }[];
  feed: { status: string }[];
  workflows: { status: string }[];
  /** A manual capture is recording. */
  capturing: boolean;
}

export interface SectionSummary {
  /** The count badge; empty hides it. */
  count: string;
  /** Short words next to the count, e.g. "3 tabs" or "1 to review". */
  meta: string;
  /** Open the section on its own (until the user opens or closes it). */
  attention: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function sectionSummaries(f: SectionFacts): Record<Exclude<SectionId, "settings">, SectionSummary> {
  const tabs = f.sessions.reduce((n, s) => n + (Number(s.tabs) || 0), 0);
  const failed = f.feed.filter((e) => e.status === "error" || e.status === "denied").length;
  const running = f.feed.filter((e) => e.status === "running").length;
  const drafts = f.workflows.filter((w) => w.status === "draft").length;
  return {
    // Live sessions are agents driving tabs right now: that is worth seeing without a click.
    sessions: { count: f.sessions.length ? String(f.sessions.length) : "", meta: f.sessions.length ? plural(tabs, "tab") : "", attention: f.sessions.length > 0 },
    activity: { count: f.feed.length ? String(f.feed.length) : "", meta: running ? `${running} running` : failed ? `${failed} failed` : "", attention: false },
    workflows: { count: f.workflows.length ? String(f.workflows.length) : "", meta: f.capturing ? "Recording" : drafts ? `${drafts} to review` : "", attention: f.capturing || drafts > 0 },
  };
}

/**
 * Whether a section is open after a render. A section the user opened or closed keeps that choice; otherwise it
 * opens when it needs attention and never closes on its own (nothing jumps shut under the pointer).
 */
export function nextOpen(open: boolean, attention: boolean, touched: boolean): boolean {
  return touched ? open : open || attention;
}
