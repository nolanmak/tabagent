// Extra handler table so feature modules (M6 auth: background/auth/**) plug into the
// router with one import line: `registerHandlers({ "auth.login": ... })`.
// Every registered handler still runs behind the router's authorize() chokepoint.
export type ExtraHandler = (ctx: { s: any; meta: any; p: any; tool: any; tabId?: number; url?: string; cmdId: string }) => Promise<unknown>;

export const extraHandlers: Record<string, ExtraHandler> = {};

export function registerHandlers(map: Record<string, ExtraHandler>) {
  Object.assign(extraHandlers, map);
}
