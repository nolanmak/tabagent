/** Pure validation and application for the extension-owned denylist (#67). */
export type DenylistChange = { op: "add" | "remove"; glob: string };

/** Deliberately narrow hostname glob grammar: `example.com` or `*.example.com`. */
const HOST_GLOB = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validateDenylistChanges(input: readonly DenylistChange[]): DenylistChange[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new Error("changes must contain 1 to 50 denylist changes");
  const seen = new Set<string>();
  return input.flatMap((change) => {
    const glob = typeof change?.glob === "string" ? change.glob.trim().toLowerCase() : "";
    if ((change?.op !== "add" && change?.op !== "remove") || !HOST_GLOB.test(glob)) throw new Error(`Invalid denylist hostname glob: ${String(change?.glob ?? "")}`);
    const canonical: DenylistChange = { op: change.op, glob };
    const key = `${canonical.op}:${canonical.glob}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [canonical];
  });
}

export function applyDenylistChanges(current: readonly string[], changes: readonly DenylistChange[]): { denylist: string[]; applied: DenylistChange[] } {
  const next = new Set(current.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const applied: DenylistChange[] = [];
  for (const change of changes) {
    if (change.op === "add" && !next.has(change.glob)) {
      next.add(change.glob);
      applied.push(change);
    }
    if (change.op === "remove" && next.delete(change.glob)) applied.push(change);
  }
  return { denylist: [...next].sort(), applied };
}
