// Shared handler plumbing. Integration point: agent C1 moves onTab/act/afterAction
// into ../tabctx.ts; then the re-export below points there.
import type { Ctx as BaseCtx } from "../tools";
export { act, onTab, withTabLock, cdp, titleOf, type TabCtx } from "../tools";

/** The router adds the command id and the authorized tab to every handler call. */
export type Ctx = BaseCtx & { cmdId?: string; tabId?: number; url?: string };
