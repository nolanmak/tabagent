// D22 ref table (pure; storage comes in through CounterStore).
//
// - Refs are `e<N>`. N comes from one counter shared by every tab, so a ref is
//   unique across tabs and a ref used with another tabId is always REF_STALE.
// - N only goes up and is never reused, including across service-worker
//   restarts: the counter is persisted in blocks (`reserve`) *before* numbers
//   from a block are handed out, so a restart continues above anything minted.
// - The table itself is in memory only: after a restart every old ref is
//   unknown and resolves to REF_STALE.
// - Each entry records the node's backendNodeId plus its CDP session + frame
//   (`frameKey`) and the document's loaderId. A different loaderId for that
//   frame (document replaced) or a frame that's gone makes the ref stale.
import { staleRef } from "./errors";

export interface RefTarget {
  tabId: number;
  /** `${cdpSessionId ?? ""}|${frameId}` for CDP; `lite|<frameId>` in lite mode. */
  frameKey: string;
  backendNodeId: number;
  /** Document identity: CDP loaderId, or the lite content script's document id. */
  loaderId: string;
}

export interface CounterStore {
  load(): Promise<number>;
  save(n: number): Promise<void>;
}

export const REF_RE = /^e(\d+)$/;

export function memoryStore(initial = 0): CounterStore & { value: number } {
  const s = {
    value: initial,
    async load() {
      return s.value;
    },
    async save(n: number) {
      s.value = n;
    },
  };
  return s;
}

function keyOf(t: RefTarget) {
  return `${t.tabId}|${t.frameKey}|${t.loaderId}|${t.backendNodeId}`;
}

export class RefTable {
  private next = 1;
  private reserved = 0;
  private byRef = new Map<string, RefTarget>();
  private byKey = new Map<string, string>();
  private initP: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private store: CounterStore,
    private block = 1000,
  ) {}

  /** Load the persisted counter. Every number below it may have been used before. */
  init(): Promise<void> {
    this.initP ??= (async () => {
      const n = await this.store.load();
      this.next = Math.max(1, (n | 0) + 1);
      this.reserved = this.next - 1;
      await this.reserve(1);
    })();
    return this.initP;
  }

  /** Make sure at least `count` more refs can be minted without reusing a number after a crash. */
  async reserve(count: number): Promise<void> {
    if (!this.initP) await this.init();
    if (this.next + count - 1 <= this.reserved) return;
    this.reserved = this.next + Math.max(count, this.block) - 1;
    const n = this.reserved;
    this.saving = this.saving.then(() => this.store.save(n));
    await this.saving;
  }

  /** Number the next new ref would get (for budget estimates). */
  peekNext(): number {
    return this.next;
  }

  /** Existing ref for a node, if any. */
  peek(t: RefTarget): string | undefined {
    return this.byKey.get(keyOf(t));
  }

  /** Ref for a node: the existing one or a new, never-used number. */
  mint(t: RefTarget): string {
    const k = keyOf(t);
    const have = this.byKey.get(k);
    if (have) return have;
    if (this.next > this.reserved) {
      // Caller forgot to reserve: extend (best effort) rather than fail.
      this.reserved = this.next + this.block - 1;
      const n = this.reserved;
      this.saving = this.saving.then(() => this.store.save(n)).catch(() => {});
    }
    const ref = `e${this.next++}`;
    this.byRef.set(ref, { ...t });
    this.byKey.set(k, ref);
    return ref;
  }

  /** Raw entry, without validity checks. */
  get(ref: string): RefTarget | undefined {
    return this.byRef.get(ref);
  }

  /**
   * Resolve a ref for a command on `tabId`. `loaderOf(frameKey)` returns the
   * frame's current document id, or undefined when the frame no longer exists.
   * Throws REF_STALE for unknown refs, refs from another tab, and refs whose
   * document was replaced.
   */
  resolve(ref: string, tabId: number, loaderOf?: (frameKey: string) => string | undefined): RefTarget {
    const t = this.byRef.get(ref);
    if (!t) {
      if (!REF_RE.test(ref)) throw staleRef(ref, "not a TabAgent ref (refs look like e12)");
      throw staleRef(ref, "unknown ref (the page changed or TabAgent restarted)");
    }
    if (t.tabId !== tabId) throw staleRef(ref, `it belongs to another tab (${t.tabId})`);
    if (loaderOf) {
      const cur = loaderOf(t.frameKey);
      if (cur === undefined) throw staleRef(ref, "its frame is gone");
      if (cur !== t.loaderId) throw staleRef(ref, "the page (or its frame) navigated");
    }
    return t;
  }

  /** Forget refs matching a predicate (they become REF_STALE). */
  drop(pred: (t: RefTarget, ref: string) => boolean): number {
    let n = 0;
    for (const [ref, t] of this.byRef) {
      if (pred(t, ref)) {
        this.byRef.delete(ref);
        this.byKey.delete(keyOf(t));
        n++;
      }
    }
    return n;
  }

  dropTab(tabId: number) {
    return this.drop((t) => t.tabId === tabId);
  }

  dropFrame(tabId: number, frameKey: string) {
    return this.drop((t) => t.tabId === tabId && t.frameKey === frameKey);
  }

  /** Drop refs for one node (e.g. it was detached). */
  dropNode(tabId: number, frameKey: string, backendNodeId: number) {
    return this.drop((t) => t.tabId === tabId && t.frameKey === frameKey && t.backendNodeId === backendNodeId);
  }

  size() {
    return this.byRef.size;
  }

  /** Refs of one tab (optionally one frame), in minting order. */
  entries(tabId: number, frameKey?: string): [string, RefTarget][] {
    return [...this.byRef].filter(([, t]) => t.tabId === tabId && (frameKey === undefined || t.frameKey === frameKey));
  }
}
