// Shared handler plumbing. Integration point: agent C1 moves onTab/act/afterAction
// into ../tabctx.ts; then this file becomes `export * from "../tabctx";`.
export { act, onTab, withTabLock, cdp, titleOf, type Ctx, type TabCtx } from "../tools";
