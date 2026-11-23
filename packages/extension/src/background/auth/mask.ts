// DA2 masking registry: DOM nodes TabAgent filled with a secret, per tab, by CDP backendNodeId.
// Snapshot/diff code (agent-driver) asks isAuthMaskedNode() and renders the value as "••••", the same
// as a password field. One-time-code fields are masked by attribute (isOneTimeCodeAutocomplete in
// pure/fields.ts, isAuthMasked in pagelib/auth.ts for form.describe).
const masked = new Map<number, Set<number>>();

export function markAuthMaskedNode(tabId: number, backendNodeId: number) {
  let s = masked.get(tabId);
  if (!s) masked.set(tabId, (s = new Set()));
  s.add(backendNodeId);
}

export function isAuthMaskedNode(tabId: number, backendNodeId: number | undefined): boolean {
  return backendNodeId !== undefined && !!masked.get(tabId)?.has(backendNodeId);
}

export function clearAuthMasks(tabId: number) {
  masked.delete(tabId);
}

export { isOneTimeCodeAutocomplete } from "./pure/fields";
