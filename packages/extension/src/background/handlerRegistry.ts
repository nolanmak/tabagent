// Extra handler table so feature modules (M6 auth: background/auth/**) plug into the
// router with one import line: `registerHandlers({ "auth.login": ... })`.
// Every registered handler still runs behind the router's authorize() chokepoint.
export type ExtraHandler = (ctx: { s: any; meta: any; p: any; tool: any; tabId?: number; url?: string; cmdId: string }) => Promise<unknown>;

export const extraHandlers: Record<string, ExtraHandler> = {};

export function registerHandlers(map: Record<string, ExtraHandler>) {
  Object.assign(extraHandlers, map);
}

// Kill-switch hook (D12): feature modules end their own pending work when the user kills.
const killHooks = new Set<() => void>();
export function onKilled(fn: () => void): () => void {
  killHooks.add(fn);
  return () => killHooks.delete(fn);
}
export function fireKilled() {
  for (const fn of killHooks) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
}
