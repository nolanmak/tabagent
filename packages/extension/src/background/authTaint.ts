// DA1 made structural (#31, security review H1): once TabAgent has typed a credential into a
// tab, nothing on that tab may read it back, and no result anywhere may carry it.
// Pure: no chrome.*. The service worker feeds it fills, main-frame navigations and tab closes.
//
// Three layers, none of which YOLO, devAllowSensitive or a pre-approval can skip:
//  1. While a tab is tainted, every c/d tool (js.eval, nav.wait fn, network.get, storage.get,
//     cookies.get) is refused on it. A tab stays tainted while the filled document may still
//     be loaded: until it has navigated to a new document AND TAINT_MS has passed since the
//     last fill (Chrome keeps a page in the back/forward cache for up to 10 minutes).
//  2. network.get refuses every request that started while the tab was tainted, for good
//     (the login POST body carries the password long after the taint ends).
//  3. For TAINT_MS after a fill, any command result or error that contains a typed password
//     or code (raw, URL/form-encoded, JSON- or HTML-escaped) is withheld.
// Separately, auth refuses to type into a document where agent JavaScript has run, since
// that code could already be listening for keystrokes.
import { TabAgentError } from "@tabagent/protocol";

export const TAINT_MS = 10 * 60_000;
/** Shorter values match too much page text to screen; layers 1 and 2 still apply. */
const MIN_SCREEN_LEN = 4;

export type FillKind = "username" | "password" | "code" | "autofill";

interface Period {
  start: number;
  lastFill: number;
  /** First main-frame navigation to a new document after the last fill. */
  navAt?: number;
}

interface Screened {
  until: number;
  re: RegExp;
}

function escapeRe(s: string) {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

function htmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Every spelling of `s` that can show up inside a JSON-serialised result. */
function spellings(s: string): string[] {
  const enc = encodeURIComponent(s);
  const base = [s, enc, enc.replace(/%20/g, "+"), htmlEscape(s)];
  const out = new Set<string>();
  for (const b of base) {
    out.add(b);
    out.add(JSON.stringify(b).slice(1, -1));
  }
  return [...out];
}

/** What survives a worker restart (D11). Timestamps and tab ids only, never a secret. */
export interface TaintSnapshot {
  v: 1;
  tabs: [number, Period[]][];
  dirty: number[];
}

export class AuthTaint {
  private tabs = new Map<number, Period[]>();
  private dirty = new Set<number>();
  private secrets = new Map<string, Screened>();
  /** After a restart that lost the per-tab state: every tab is tainted and dirty until then. */
  private closedUntil = 0;
  /** Called after every change to tabs/dirty (persistAuthTaint hooks storage in here). */
  onChange?: (snap: TaintSnapshot) => void;

  constructor(
    private now: () => number = Date.now,
    private ttl = TAINT_MS,
  ) {}

  private changed() {
    this.onChange?.(this.snapshot());
  }

  snapshot(): TaintSnapshot {
    return { v: 1, tabs: [...this.tabs].map(([id, ps]) => [id, ps.map((p) => ({ ...p }))]), dirty: [...this.dirty] };
  }

  load(snap: TaintSnapshot) {
    this.tabs = new Map(snap.tabs.map(([id, ps]) => [id, ps.map((p) => ({ ...p }))]));
    this.dirty = new Set(snap.dirty);
  }

  /** Anything open at shutdown: a tab still tainted, or a document agent JS touched. */
  active(): boolean {
    return this.dirty.size > 0 || [...this.tabs.keys()].some((id) => this.tainted(id));
  }

  /** Fail closed: treat every tab as tainted and dirty for one window from now. */
  failClosed() {
    this.closedUntil = this.now() + this.ttl;
  }

  private blanket(): boolean {
    return this.now() < this.closedUntil;
  }

  private end(p: Period): number {
    return p.navAt === undefined ? Infinity : Math.max(p.navAt, p.lastFill + this.ttl);
  }

  private last(tabId: number): Period | undefined {
    const ps = this.tabs.get(tabId);
    return ps?.[ps.length - 1];
  }

  /** Call before a credential is typed (or, for autofill, before TabAgent submits Chrome's fill). */
  filled(tabId: number, kind: FillKind, secret?: string | null) {
    const t = this.now();
    const last = this.last(tabId);
    if (last && t < this.end(last)) {
      last.lastFill = t;
      delete last.navAt;
    } else {
      const ps = this.tabs.get(tabId) ?? [];
      ps.push({ start: t, lastFill: t });
      this.tabs.set(tabId, ps);
    }
    this.changed();
    if ((kind === "password" || kind === "code") && secret && secret.length >= MIN_SCREEN_LEN) {
      const alts = spellings(secret).map(escapeRe).join("|");
      // Codes are short digits: match whole tokens so ids and timestamps don't trip the screen.
      const re = kind === "code" ? new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`) : new RegExp(alts);
      this.secrets.set(secret, { until: t + this.ttl, re });
    }
  }

  /** Main frame committed a document. A back/forward-cache restore brings an old document back. */
  navigated(tabId: number, o: { bfcache?: boolean } = {}) {
    if (o.bfcache) return;
    const had = this.dirty.delete(tabId);
    const last = this.last(tabId);
    if (last && last.navAt === undefined) last.navAt = this.now();
    else if (!had) return;
    this.changed();
  }

  tainted(tabId: number): boolean {
    if (this.blanket()) return true;
    const last = this.last(tabId);
    return !!last && this.now() < this.end(last);
  }

  /** network.get: did this request start while the tab was tainted? */
  requestBlocked(tabId: number, start: number): boolean {
    return (this.tabs.get(tabId) ?? []).some((p) => start >= p.start && start < this.end(p));
  }

  /** Agent JavaScript ran in the tab's current document (js.eval, nav.wait fn). */
  ranScript(tabId: number) {
    if (this.dirty.has(tabId)) return;
    this.dirty.add(tabId);
    this.changed();
  }

  scriptDirty(tabId: number): boolean {
    return this.blanket() || this.dirty.has(tabId);
  }

  /** True when `text` carries a typed secret that is still within its window. */
  leaks(text: string): boolean {
    if (!this.secrets.size || !text) return false;
    const t = this.now();
    for (const [k, s] of this.secrets) {
      if (t >= s.until) {
        this.secrets.delete(k);
        continue;
      }
      if (s.re.test(text)) return true;
    }
    return false;
  }

  closed(tabId: number) {
    const a = this.tabs.delete(tabId);
    const b = this.dirty.delete(tabId);
    if (a || b) this.changed();
  }
}

/** The service worker's one instance. */
export const authTaint = new AuthTaint();

interface Area {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const SESSION_KEY = "authTaint";
const ACTIVE_KEY = "authTaintActive";

/**
 * D11 (PR #54 review): keep the taint across worker restarts. Tab periods and dirty documents go to
 * storage.session (cleared with the browser session, so tab ids never refer to someone else's tab).
 * storage.session is also wiped when the extension is reloaded or updated; for that case a single
 * boolean in storage.local says whether anything was open, and if so the new worker fails closed:
 * every tab is tainted and dirty for TAINT_MS. Typed secrets are never stored; after a restart the
 * output screen is gone, and layers 1 and 2 (refusing reads) carry the guarantee.
 * Resolves to how it started: "restored", "fail-closed" or "clean". Then hooks every change to storage.
 */
export async function persistAuthTaint(taint: AuthTaint, areas: { session: Area; local: Area }): Promise<"restored" | "fail-closed" | "clean"> {
  let outcome: "restored" | "fail-closed" | "clean" = "clean";
  const snap = ((await areas.session.get(SESSION_KEY).catch(() => ({}))) as { authTaint?: TaintSnapshot }).authTaint;
  if (snap && snap.v === 1 && Array.isArray(snap.tabs) && Array.isArray(snap.dirty)) {
    taint.load(snap);
    outcome = "restored";
  } else {
    const was = ((await areas.local.get(ACTIVE_KEY).catch(() => ({}))) as { authTaintActive?: boolean }).authTaintActive;
    if (was !== false && was !== undefined) {
      taint.failClosed();
      outcome = "fail-closed";
    }
  }
  let lastActive: boolean | undefined;
  const write = (s: TaintSnapshot) => {
    areas.session.set({ [SESSION_KEY]: s }).catch(() => {});
    const active = taint.active();
    if (active !== lastActive) {
      lastActive = active;
      areas.local.set({ [ACTIVE_KEY]: active }).catch(() => {});
    }
  };
  taint.onChange = write;
  if (outcome === "fail-closed") areas.local.set({ [ACTIVE_KEY]: true }).catch(() => {});
  else write(taint.snapshot());
  return outcome;
}

const CREDENTIAL_READ = new Set(["c", "d"]);

/** Router hook, before authorize: c/d tools are refused on a tainted tab, whatever the policy says. */
export function credentialGuard(taint: AuthTaint, req: { tool: string; sensitive?: string; tabId?: number }) {
  if (req.tabId == null || !req.sensitive || !CREDENTIAL_READ.has(req.sensitive)) return;
  if (!taint.tainted(req.tabId)) return;
  throw new TabAgentError(
    "PERMISSION_DENIED",
    `${req.tool} is blocked on this tab: TabAgent typed a credential into it, and the agent must never be able to read it back (DA1)`,
    "Use another tab. This tab is cleared once it has moved to a new page and 10 minutes have passed since the sign-in.",
  );
}
