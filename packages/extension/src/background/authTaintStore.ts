// Wires the auth taint (DA1, review H1) to chrome.storage so it survives worker restarts (D11).
// Everything that consults the taint awaits `authTaintReady` first, so no command runs on a
// freshly started worker before its tainted tabs are back.
import { authTaint, persistAuthTaint } from "./authTaint";

type Area = Parameters<typeof persistAuthTaint>[1]["session"];

export const authTaintReady: Promise<unknown> = persistAuthTaint(authTaint, {
  session: chrome.storage.session as unknown as Area,
  local: chrome.storage.local as unknown as Area,
}).catch(() => authTaint.failClosed());
