// M6 auth wiring (#33-#35): thin adapters from the pure flows to chrome.*, the CDP driver and the
// bridge socket. Holds no decisions. Hooked in with one import line in background/index.ts.
import { pollCode, TabAgentError, type SessionMeta } from "@tabagent/protocol";
import { authTaint } from "../authTaint";
import { authTaintReady } from "../authTaintStore";
import { detachTab, peekCdpTab } from "../cdp";
import * as driverMod from "../driver";
import { disposeDrivers, driverFor, type Driver } from "../driver";
import { onKilled, registerHandlers } from "../handlerRegistry";
import { requireSensitive } from "../permissions";
import { AUTH_DENY_HOSTS, isDenylisted, isHardDenied, isVaultDenied } from "../policy";
import { endHandoff, inHandoff, listHandoffs, markPrivateTab, startHandoff, unmarkPrivateTab } from "../sessions";
import { getSettings } from "../settings";
import { withTabLock } from "../tabctx";
import { clearAuthMasks, isAuthMaskedNode, markAuthMaskedNode } from "./mask";
import { createAuthChannel, type Sender } from "./pure/channel";
import { findIk, GMAIL_APP_URL, gmailMessageId, originalUrl, parseRawMessage, pollMessages, readOriginalPage } from "./pure/confirm-link";
import { authCode, authConfirmLink, authLogin, authSignup, authStatus, newMemory, type AuthEnv, type AuthPage, type ConfirmMailReader, type EmailReader, type PageField } from "./pure/flows";
import { GMAIL_FEED_URL, readFeed } from "./pure/gmail";
import { runHandoff } from "./pure/handoff";
import { createRemoteHandoffs } from "./pure/remote";
import { checkAuthSite } from "./pure/site";

// ---------------------------------------------------------------------------
// Bridge wire (index.ts: setAuthSender + onAuthBridgeMessage)
// ---------------------------------------------------------------------------
let sender: Sender | null = null;
export function setAuthSender(fn: Sender) {
  sender = fn;
}
const channel = createAuthChannel({ send: (m) => (sender ? sender(m) : false) });
/** Returns true when the message was an auth message (auth.accounts.result / secret). */
export function onAuthBridgeMessage(msg: unknown): boolean {
  return channel.onMessage(msg);
}
export function rejectAllAuth(e: Error) {
  channel.rejectAll(e);
}
// Kill switch (D12): pending secret requests fail with KILLED; handoffs end via their own hook below.
onKilled(() => {
  channel.rejectAll(new TabAgentError("KILLED", "The user stopped all agents with the TabAgent kill switch"));
});
// Snapshot/diff masking (DA2): the driver renders these nodes' values as "••••" (agent/driver addMaskHook).
(driverMod as any).addMaskHook?.((tabId: number, backendNodeId: number) => isAuthMaskedNode(tabId, backendNodeId));
function event(name: string, data: Record<string, unknown>) {
  sender?.({ type: "event", event: name, data });
}

const mem = newMemory();

// ---------------------------------------------------------------------------
// Page adapter over the Driver (main frame)
// ---------------------------------------------------------------------------
async function tabUrl(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return t.pendingUrl || t.url || "";
}

function realPage(tabId: number): AuthPage {
  let drv: Driver | null = null;
  let epoch = 0;
  const d = async () => (drv ??= await driverFor(tabId, await tabUrl(tabId)));
  return {
    url: () => tabUrl(tabId),
    async closed() {
      return chrome.tabs.get(tabId).then(
        () => false,
        () => true,
      );
    },
    async fields() {
      const v = (await (await d()).call("authFields", [])) as (PageField & { ref: string | null })[];
      return v.filter((f) => !!f.ref) as PageField[];
    },
    async signals() {
      return (await (await d()).call("authSignals", [])) as { webauthn: boolean; captcha: boolean };
    },
    async chromeAutofill() {
      return (await (await d()).call("authAutofill", [])) as { usernameMasked?: string } | null;
    },
    async type(ref, value) {
      await (await d()).fill(ref, value);
    },
    async markFilled(ref) {
      const dr = await d();
      await dr.call("authMark", [], { ref });
      try {
        markAuthMaskedNode(tabId, (await Promise.resolve(dr.resolveRef(ref))).backendNodeId);
      } catch {
        /* ref gone: nothing to mask */
      }
    },
    async submit(ref) {
      const dr = await d();
      epoch = dr.navEpoch();
      await dr.focus(ref);
      await dr.press("Enter");
    },
    async settle() {
      const dr = await d();
      await dr.settle(epoch).catch(() => {});
      await dr.waitLoad(5000).catch(() => false);
    },
    async goto(url) {
      // The same hard lines nav.goto has: never the vault / mailbox hosts, the hard list or the user's denylist.
      const s = await getSettings();
      if (isVaultDenied(url) || isHardDenied(url) || isDenylisted(url, s.denylist)) throw new TabAgentError("PERMISSION_DENIED", "The link points to a host TabAgent does not open");
      const dr = await d();
      epoch = dr.navEpoch();
      await dr.navigate(url, "load", 20_000);
    },
  };
}

// ---------------------------------------------------------------------------
// Gmail reader (#34, DA7): private collapsed "TabAgent auth" tab, Atom feed, one code out
// ---------------------------------------------------------------------------
let mailUrl = GMAIL_FEED_URL;
const usedMessages = new Set<string>();

function waitComplete(tabId: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(on);
      reject(new TabAgentError("TIMEOUT", "Gmail did not load in time"));
    }, timeout);
    const on = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(on);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && tab.url && tab.url !== "about:blank") on(tabId, { status: "complete" });
    }, () => {});
  });
}

/**
 * Open the private, collapsed "TabAgent auth" tab on the Gmail feed next to the agent's tab. Agent tools
 * never reach it (markPrivateTab; mail.google.com is in VAULT_DENY_HOSTS). NOT_FOUND when Gmail isn't
 * signed in. `close()` removes it.
 */
async function openMailTab(agentTabId: number, notSignedInHint: string): Promise<{ id: number; close(): Promise<void> }> {
  const agentTab = await chrome.tabs.get(agentTabId);
  const tab = await chrome.tabs.create({ windowId: agentTab.windowId, url: "about:blank", active: false });
  const id = tab.id!;
  await markPrivateTab(id);
  const close = async () => {
    await chrome.tabs.remove(id).catch(() => {});
    unmarkPrivateTab(id);
  };
  try {
    try {
      const gid = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: agentTab.windowId } });
      await chrome.tabGroups.update(gid, { title: "TabAgent auth", collapsed: true, color: "grey" });
    } catch {
      /* no tab groups in this window type */
    }
    await chrome.tabs.update(id, { url: mailUrl });
    await waitComplete(id, 20_000);
    const first = readFeed((await chrome.tabs.get(id)).url ?? "", "<feed><fullcount>0</fullcount></feed>");
    if (!first.ok && first.code === "NOT_FOUND") throw new TabAgentError("NOT_FOUND", first.reason, notSignedInHint);
    return { id, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Same-origin fetch with the browser's Gmail session, run inside the private mail tab. */
async function mailFetch(tabId: number, url: string, max: number): Promise<{ url: string; text: string }> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (u: string, n: number) => {
      const resp = await fetch(u, { credentials: "include", cache: "no-store" });
      return { url: resp.url, text: (await resp.text()).slice(0, n) };
    },
    args: [url, max],
  });
  const out = res?.result as { url: string; text: string } | undefined;
  return { url: out?.url ?? "", text: out?.text ?? "" };
}

async function readInbox(tabId: number, unsupportedHint: string) {
  const out = await mailFetch(tabId, mailUrl, 500_000);
  const feed = readFeed(out.url, out.text);
  if (!feed.ok) throw new TabAgentError(feed.code, feed.reason, feed.code === "UNSUPPORTED" ? unsupportedHint : "Sign in to Gmail in this browser yourself.");
  return feed.messages;
}

function emailReader(agentTabId: number): EmailReader {
  return {
    async fetch({ since, from, timeout }) {
      const tab = await openMailTab(agentTabId, "Sign in to Gmail in this browser yourself, or use source=totp / sms. TabAgent never signs in to Gmail.");
      const ac = new AbortController();
      const stopKill = onKilled(() => ac.abort());
      try {
        const r = await pollCode(() => readInbox(tab.id, "Gmail changed its feed; use auth.handoff, or source=totp / sms."), { since, from, timeout, used: usedMessages, signal: ac.signal });
        if (r.messageId) usedMessages.add(r.messageId);
        return r.code;
      } finally {
        stopKill();
        await tab.close();
      }
    },
  };
}

// #113 confirmation links: the same private tab; the message body comes from Gmail's "show original"
// view (see pure/confirm-link.ts, O1). Only the links leave this reader, and only to the pure flow.
let mailIk: string | null = null;

function confirmReader(agentTabId: number): ConfirmMailReader {
  let tab: { id: number; close(): Promise<void> } | null = null;
  const open = async () => (tab ??= await openMailTab(agentTabId, "Sign in to Gmail in this browser yourself, or use auth.handoff. TabAgent never signs in to Gmail."));
  const unsupported = "Gmail changed; use auth.handoff and let the user open the confirmation email.";
  return {
    async messages({ since, from, timeout, skip }) {
      const t = await open();
      const ac = new AbortController();
      const stopKill = onKilled(() => ac.abort());
      try {
        return await pollMessages(() => readInbox(t.id, unsupported), { since, from, skip, timeout, signal: ac.signal });
      } finally {
        stopKill();
      }
    },
    async links(id) {
      const t = await open();
      const mid = gmailMessageId(id);
      if (!mid) throw new TabAgentError("UNSUPPORTED", "The Gmail feed entry had no message id", unsupported);
      let page = await mailFetch(t.id, originalUrl(mid, mailIk ?? undefined), 2_000_000);
      let r = readOriginalPage(page.url, page.text);
      if (!r.ok && r.code === "UNSUPPORTED") {
        // Gmail may want the account key (`ik`) on the message view: read it from the app page once.
        const app = await mailFetch(t.id, GMAIL_APP_URL, 3_000_000);
        const ik = findIk(app.text);
        if (ik && ik !== mailIk) {
          mailIk = ik;
          page = await mailFetch(t.id, originalUrl(mid, ik), 2_000_000);
          r = readOriginalPage(page.url, page.text);
        }
      }
      if (!r.ok) throw new TabAgentError(r.code, r.reason, r.code === "UNSUPPORTED" ? unsupported : "Sign in to Gmail in this browser yourself.");
      return parseRawMessage(r.raw);
    },
    async close() {
      await tab?.close();
      tab = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Env per command
// ---------------------------------------------------------------------------
interface Ctx {
  s: any;
  meta: SessionMeta;
  p: any;
  tool: any;
  tabId?: number;
  url?: string;
  cmdId: string;
  /** Router hook: mark this command's audit record (#131 authAuto). */
  auditNote?: (n: { authAuto?: true }) => void;
}

function envFor(c: Ctx, tabId: number): AuthEnv {
  return {
    cmdId: c.cmdId,
    tabId,
    async siteCheck(url) {
      const s = await getSettings();
      checkAuthSite({ sites: s.sites as any, denylist: s.denylist, authDenyHosts: AUTH_DENY_HOSTS, yolo: !!s.yolo }, url);
    },
    async consent(url, who, summary) {
      const via = await requireSensitive(c.meta, url, "g", c.tool.name, summary, [who.signup ? "Bitwarden generates and saves a new password; the agent never sees it" : "Sign-in uses a saved credential; the agent never sees it"], { auth: who, tabId });
      if (via === "authAuto") c.auditNote?.({ authAuto: true });
      return via;
    },
    channel,
    email: emailReader(tabId),
    confirmMail: confirmReader(tabId),
    // DA1 (review H1): taint the tab before the first keystroke; refuse documents agent JS touched.
    filled: (kind, secret) => authTaint.filled(tabId, kind, secret),
    scriptDirty: () => authTaint.scriptDirty(tabId),
    restartLockedUntil: () => authTaint.restartLockedUntil(),
    event,
    now: () => Date.now(),
  };
}

function needTab(c: Ctx): number {
  if (c.tabId == null) throw new TabAgentError("NOT_FOUND", "This session has no tabs yet", "Call nav.goto with the sign-in page first.");
  return c.tabId;
}

// ---------------------------------------------------------------------------
// Handoff (#35)
// ---------------------------------------------------------------------------

// #61 remote handoff: a bare debugger session for the phone's frames and input (see pure/remote.ts).
// It is deliberately not a CdpTab: no pagelib, no capture, no refs, and agent commands stay TAB_BUSY.
const remote = createRemoteHandoffs({
  send: (m) => (sender ? sender(m) : false),
  async attach(tabId) {
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (e) {
      if (!/already attached/i.test(String((e as Error).message ?? e))) throw e;
      // A stale session from an earlier service-worker life (cdp.ts does the same).
      await chrome.debugger.detach(target).catch(() => {});
      await chrome.debugger.attach(target, "1.3");
    }
  },
  async detach(tabId) {
    // If the agent's own session already took the tab back (it detaches/re-attaches on "already
    // attached"), ours is gone: do not detach theirs.
    if (peekCdpTab(tabId)?.attached) return;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  },
  cdp: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  end: (tabId, r) => endHandoff(tabId, r),
});
/** Bridge → extension handoff.* messages. Returns true when the message was one. */
export function onHandoffBridgeMessage(msg: unknown): boolean {
  return remote.onMessage(msg);
}

const BANNER = "tabagent-handoff-banner";
function banner(tabId: number, label: string | null, isRemote = false) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (id: string, text: string | null) => {
        document.getElementById(id)?.remove();
        if (!text) return;
        const d = document.createElement("div");
        d.id = id;
        d.setAttribute("data-tabagent-overlay", "");
        d.textContent = text;
        d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;background:#7c3aed;color:#fff;font:13px system-ui;padding:6px 10px;text-align:center";
        document.documentElement.appendChild(d);
      },
      args: [
        BANNER,
        label
          ? isRemote
            ? `TabAgent: ${label} is asking you to finish a step in this tab, here or from the remote handoff link. Press Done when finished.`
            : `TabAgent: ${label} is asking you to finish a step in this tab. Click Done in the TabAgent side panel when finished.`
          : null,
      ],
    })
    .catch(() => {});
}

chrome.notifications?.onClicked?.addListener((nid) => {
  const m = /^tabagent-handoff-(\d+)$/.exec(nid);
  if (!m) return;
  // A notification click is a user gesture: focusing here is allowed (D10).
  const tabId = Number(m[1]);
  chrome.tabs.get(tabId).then((t) => {
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    if (t.windowId != null) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }, () => {});
});

async function handoff(c: Ctx) {
  const tabId = needTab(c);
  const url = await tabUrl(tabId);
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    /* */
  }
  return runHandoff(
    {
      async detach(id) {
        disposeDrivers(id);
        await detachTab(id);
      },
      start: (info) => startHandoff(info),
      end: (id, r) => endHandoff(id, r),
      busy: (id) => inHandoff(id),
      notify(info, isRemote) {
        chrome.notifications
          ?.create(`tabagent-handoff-${info.tabId}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: `${info.sessionLabel} needs you in a tab`, message: `Finish the step on ${new URL(info.origin || "https://x").host}, then click Done in the TabAgent side panel.`, priority: 2 })
          .catch?.(() => {});
        chrome.action.setBadgeText({ text: "!" }).catch(() => {});
        banner(info.tabId, info.sessionLabel, isRemote);
      },
      clearNotice(id) {
        chrome.notifications?.clear(`tabagent-handoff-${id}`).catch?.(() => {});
        banner(id, null);
      },
      onTabClosed(id, cb) {
        const on = (closed: number) => closed === id && cb();
        chrome.tabs.onRemoved.addListener(on);
        return () => chrome.tabs.onRemoved.removeListener(on);
      },
      onKilled(cb) {
        return onKilled(cb);
      },
      event: (name, data) => event(name, data),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      timeoutMs: testHandoffTimeout ?? undefined,
      remote: {
        open: (req) => remote.open(c.cmdId, req.tabId, { origin: req.origin, reason: req.reason, sessionLabel: req.sessionLabel }),
        close: (id, outcome) => remote.close(id, outcome),
      },
    },
    { tabId, sessionId: c.meta.id, sessionLabel: c.meta.label, origin, reason: String(c.p.reason ?? "").slice(0, 500) },
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearAuthMasks(tabId);
  authTaint.closed(tabId);
  mem.lastLogin.delete(tabId);
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
registerHandlers({
  "auth.status": async (c) => {
    const tabId = needTab(c as Ctx);
    return authStatus(envFor(c as Ctx, tabId), realPage(tabId));
  },
  // Under the tab lock (review H1): a js.eval already running on the tab finishes before any
  // credential is typed, and the ones after it meet the taint.
  "auth.login": async (c) => {
    const tabId = needTab(c as Ctx);
    await authTaintReady;
    return withTabLock(tabId, () => authLogin(envFor(c as Ctx, tabId), realPage(tabId), c.p ?? {}, mem));
  },
  "auth.code": async (c) => {
    const tabId = needTab(c as Ctx);
    await authTaintReady;
    return withTabLock(tabId, () => authCode(envFor(c as Ctx, tabId), realPage(tabId), c.p ?? {}, mem));
  },
  "auth.signup": async (c) => {
    const tabId = needTab(c as Ctx);
    await authTaintReady;
    return withTabLock(tabId, () => authSignup(envFor(c as Ctx, tabId), realPage(tabId), c.p ?? {}));
  },
  "auth.confirm_link": async (c) => {
    const tabId = needTab(c as Ctx);
    return withTabLock(tabId, () => authConfirmLink(envFor(c as Ctx, tabId), realPage(tabId), c.p ?? {}, mem));
  },
  "auth.handoff": (c) => handoff(c as Ctx),
});

// e2e-only knobs (reachable only through serviceWorker.evaluate, never from a page or the UI).
let testHandoffTimeout: number | null = null;
(globalThis as any).__tabagentAuth = {
  setMailUrl(u: string) {
    mailUrl = u || GMAIL_FEED_URL;
  },
  setHandoffTimeout(ms: number | null) {
    testHandoffTimeout = ms;
  },
  pendingSecrets: () => channel.pendingCount(),
  handoffs: () => listHandoffs(),
  remoteHandoffs: () => remote.active(),
};
