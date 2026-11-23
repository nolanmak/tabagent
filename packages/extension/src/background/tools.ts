// Tool handlers, one per registry entry in @tabagent/protocol. This file only
// aggregates: driver-backed handlers (page.snapshot/screenshot/find, nav.*,
// act.*) live in ./handlers/{page,nav,act}, form/extract/files/dialog in
// ./handlers/*, tabs + session.* in ./sessionTools. Shared tab plumbing
// (onTab, act, afterAction) lives in ./tabctx.
import { actHandlers } from "./handlers/act";
import { dialogHandlers } from "./handlers/dialog";
import { extractHandlers } from "./handlers/extract";
import { fileHandlers } from "./handlers/files";
import { formHandlers } from "./handlers/forms";
import { navHandlers } from "./handlers/nav";
import { pageHandlers } from "./handlers/page";
import type { Ctx } from "./tabctx";

export type { Ctx, TabCtx } from "./tabctx";
export { act, afterAction, cdp, onTab, titleOf, withTabLock } from "./tabctx";

type Handler = (c: Ctx) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  ...pageHandlers,
  ...navHandlers,
  ...actHandlers,
  ...formHandlers,
  ...extractHandlers,
  ...fileHandlers,
  ...dialogHandlers,
};
