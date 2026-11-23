// D24 diff core (pure): snapshot-format lines prefixed `+`, `-` or `~`, plus
// the per-session, per-tab baseline store.
//
// `~` marks a line that changed in place: a removed and an added line that
// carry the same ref (or, without refs, the same role and name).

export interface DiffResult {
  text: string;
  added: number;
  removed: number;
  changed: number;
}

const REF = /\[ref=(e\d+)\]/;

function identity(line: string): string | null {
  const t = line.trim();
  const r = t.match(REF);
  if (r) return "ref:" + r[1];
  const m = t.match(/^- (\S+)(?: ("(?:[^"\\]|\\.)*"))?/);
  if (!m || !m[2]) return null;
  return `rn:${m[1]} ${m[2]}`;
}

/** LCS edit script over lines. Falls back to set difference on huge inputs. */
function editScript(a: string[], b: string[]): { op: " " | "+" | "-"; line: string }[] {
  const n = a.length;
  const m = b.length;
  // trim common prefix / suffix first: actions usually change a small region
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
  const A = a.slice(p, n - s);
  const B = b.slice(p, m - s);
  const out: { op: " " | "+" | "-"; line: string }[] = a.slice(0, p).map((line) => ({ op: " " as const, line }));
  if (A.length * B.length > 4_000_000) {
    const sb = new Set(B);
    const sa = new Set(A);
    for (const l of A) if (!sb.has(l)) out.push({ op: "-", line: l });
    for (const l of B) out.push(sa.has(l) ? { op: " ", line: l } : { op: "+", line: l });
  } else {
    const N = A.length;
    const M = B.length;
    const dp: Uint32Array[] = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < N || j < M) {
      if (i < N && j < M && A[i] === B[j]) {
        out.push({ op: " ", line: A[i] });
        i++;
        j++;
      } else if (i < N && (j >= M || dp[i + 1][j] >= dp[i][j + 1])) out.push({ op: "-", line: A[i++] });
      else out.push({ op: "+", line: B[j++] });
    }
  }
  for (const line of a.slice(n - s)) out.push({ op: " ", line });
  return out;
}

export function diff(prevLines: string[], nextLines: string[], opts: { maxChars?: number } = {}): DiffResult {
  const script = editScript(prevLines, nextLines);
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  // Process change hunks: pair removed/added lines with the same identity as `~`.
  let k = 0;
  while (k < script.length) {
    if (script[k].op === " ") {
      k++;
      continue;
    }
    const minus: string[] = [];
    const plus: string[] = [];
    while (k < script.length && script[k].op !== " ") {
      (script[k].op === "-" ? minus : plus).push(script[k].line);
      k++;
    }
    const plusIds = new Map<string, number[]>();
    plus.forEach((l, i) => {
      const id = identity(l);
      if (id) plusIds.set(id, [...(plusIds.get(id) ?? []), i]);
    });
    const pairedPlus = new Set<number>();
    const removedOut: string[] = [];
    for (const l of minus) {
      const id = identity(l);
      const cand = id ? plusIds.get(id)?.find((i) => !pairedPlus.has(i)) : undefined;
      if (cand !== undefined) pairedPlus.add(cand);
      else removedOut.push(l);
    }
    for (const l of removedOut) {
      lines.push("- " + l.trim());
      removed++;
    }
    plus.forEach((l, i) => {
      if (pairedPlus.has(i)) {
        lines.push("~ " + l.trim());
        changed++;
      } else {
        lines.push("+ " + l.trim());
        added++;
      }
    });
  }
  let text = lines.join("\n");
  const max = opts.maxChars;
  if (max && text.length > max) {
    let cut = text.slice(0, max);
    cut = cut.slice(0, Math.max(0, cut.lastIndexOf("\n")));
    const shown = cut ? cut.split("\n").length : 0;
    text = `${cut}${cut ? "\n" : ""}… ${lines.length - shown} more changed lines; take a page.snapshot`;
  }
  return { text, added, removed, changed };
}

/**
 * Baselines: last snapshot or diff delivered to a session for a tab (D24).
 * Every delivery advances it; a navigation clears it; no baseline, no diff.
 */
export class Baselines {
  private m = new Map<string, string[]>();
  private k(session: string, tabId: number) {
    return `${session}|${tabId}`;
  }
  get(session: string, tabId: number): string[] | undefined {
    return this.m.get(this.k(session, tabId));
  }
  set(session: string, tabId: number, lines: string[]) {
    this.m.set(this.k(session, tabId), lines);
  }
  clear(session: string, tabId: number) {
    this.m.delete(this.k(session, tabId));
  }
  /** Navigation or detach: clear every session's baseline for the tab. */
  clearTab(tabId: number) {
    for (const k of [...this.m.keys()]) if (k.endsWith(`|${tabId}`)) this.m.delete(k);
  }
  clearSession(session: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(`${session}|`)) this.m.delete(k);
  }
  /**
   * Deliver a new snapshot: returns the diff against the baseline (or null when
   * there is none) and advances the baseline.
   */
  deliver(session: string, tabId: number, lines: string[], opts: { maxChars?: number } = {}): DiffResult | null {
    const prev = this.get(session, tabId);
    this.set(session, tabId, lines);
    return prev ? diff(prev, lines, opts) : null;
  }
}
