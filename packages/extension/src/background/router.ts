// Command router (#3). Every command goes:
//   validate -> paused check -> resolve tab -> authorize (D17 chokepoint) -> handler -> envelope + audit.
// Chrome-free: all effects are injected so the router is unit-testable.
import { buildAudit, liftSide, outcomeFor, type AuditRecord, type RedactOpts } from "./audit";
import { normalizeNavUrl, requirementsFor, type Requirements, type ToolLike } from "./authorize";
import { originOf, type Level, type SensitiveCategory } from "./policy";

export interface SessionMetaLike {
  id: string;
  label: string;
  cap: Level;
  sites: string[];
}

export interface CommandLike {
  type: "command";
  id: string;
  session: SessionMetaLike;
  tool: string;
  params: unknown;
}

export interface ErrorJson {
  code: string;
  message: string;
  hint?: string;
  untrusted?: boolean;
}

export interface Envelope {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ErrorJson;
  snapshotDiff?: string;
  navigation?: { url: string; title: string; kind: string };
  dialogs?: { type: string; message: string; defaultPrompt?: string }[];
  downloads?: { id: number; filename: string; state: string }[];
  audit: AuditRecord;
}

export interface AuthorizeRequest {
  meta: SessionMetaLike;
  tool: string;
  action?: string;
  url: string;
  level: Level | null;
  sensitive?: SensitiveCategory;
  tabId?: number;
  summary: string;
  reasons: string[];
}

export interface FeedEvent {
  id: number;
  ts: number;
  sessionId: string;
  label: string;
  tool: string;
  action?: string;
  origin: string | null;
  params: unknown;
  status: "running" | "ok" | "error" | "denied";
  errorCode?: string;
  ms?: number;
  resultSummary?: { bytes: number; sha256: string };
}

export interface RouterDeps<S = unknown> {
  getTool(name: string): (ToolLike & { params?: unknown }) | undefined;
  /** Throws a BAD_REQUEST error on invalid params; returns parsed params. */
  validate(tool: ToolLike, params: unknown): Record<string, unknown>;
  isPaused(): boolean | Promise<boolean>;
  getSession(meta: SessionMetaLike): Promise<S>;
  /** Session tab for this command; throws NOT_FOUND / TAB_BUSY. */
  resolveTab(session: S, tabId: number | undefined): Promise<number>;
  tabUrl(tabId: number): Promise<string>;
  /** tabs attach target (no tabId = active tab of last-focused window). Throws TAB_BUSY if owned by someone else. */
  attachTarget(meta: SessionMetaLike, tabId: number | undefined): Promise<{ tabId: number; url: string; title: string }>;
  downloadUrl(id: number, sessionId: string): string | undefined;
  authorize(req: AuthorizeRequest): Promise<void>;
  /** Mark a static sensitive approval as valid for the duration of this command. */
  holdApproval?(sessionId: string, origin: string, category: SensitiveCategory): () => void;
  handler(name: string): ((ctx: { s: S; meta: SessionMetaLike; p: any; tool: any; tabId?: number; url?: string; cmdId: string }) => Promise<unknown>) | undefined;
  /** Param paths whose values are password/card fields (masked in feed + audit). */
  sensitivePaths?(tool: string, params: Record<string, unknown>, tabId: number | undefined, url: string): Promise<string[]>;
  feed?(e: FeedEvent): void;
  onInflight?(n: number): void;
  now?(): number;
}

/** Error helper that works with any TabAgentError shape. */
export class RouterError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
  toJSON(): ErrorJson {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

function toErrorJson(e: unknown, tool: string): ErrorJson {
  const any = e as { code?: unknown; message?: unknown; toJSON?: () => ErrorJson };
  if (any && typeof any === "object" && typeof any.code === "string" && typeof any.toJSON === "function") {
    const j = any.toJSON();
    return { ...j };
  }
  const msg = String((any as Error)?.message ?? e ?? "")
    .split("\n")[0]
    .slice(0, 300);
  return { code: "INTERNAL", message: `Internal error in ${tool}${msg ? `: ${msg}` : ""}` };
}

function summaryFor(tool: string, p: Record<string, unknown>, attach?: { title: string }): string {
  switch (tool) {
    case "nav.goto":
      return `open ${p.url}`;
    case "js.eval":
      return `run JavaScript: ${String(p.expression ?? "").slice(0, 120)}`;
    case "nav.wait":
      return `wait for a JavaScript condition: ${String(p.value ?? "").slice(0, 120)}`;
    case "cookies.get":
      return "read cookies";
    case "storage.get":
      return `read ${p.kind ?? "web"}Storage`;
    case "network.get":
      return "read a network request body and headers";
    case "act.upload":
      return `upload ${Array.isArray(p.paths) ? p.paths.length : 0} local file(s)`;
    case "downloads.read":
      return "read a downloaded file";
    case "tabs":
      if (p.action === "attach") return `take over your tab "${(attach?.title ?? "").slice(0, 60)}"`;
      return `tabs ${p.action}`;
    default:
      return tool;
  }
}

const REASONS: Record<string, string> = {
  c: "Runs code in the page with access to its data",
  d: "Can include session credentials",
  e: "Moves a local file between your computer and the page",
  f: "Adopting a tab you opened gives the agent your page and its sign-ins",
};

export function createRouter<S>(deps: RouterDeps<S>) {
  let seq = 0;
  const inflight = new Map<string, (e: RouterError) => void>();
  const now = deps.now ?? Date.now;

  function setInflight() {
    deps.onInflight?.(inflight.size);
  }

  async function handle(cmd: CommandLike): Promise<Envelope> {
    const started = now();
    const feedId = ++seq;
    let toolName = cmd.tool;
    let action: string | undefined;
    let origin: string | null = null;
    let params: Record<string, unknown> = (cmd.params ?? {}) as Record<string, unknown>;
    let redact: RedactOpts = {};
    const feedBase = () => ({ id: feedId, ts: started, sessionId: cmd.session.id, label: cmd.session.label, tool: toolName, action, origin });
    let release: (() => void) | undefined;
    let abortReject: ((e: RouterError) => void) | undefined;
    const aborted = new Promise<never>((_, rej) => (abortReject = rej));
    aborted.catch(() => {});
    inflight.set(cmd.id, (e) => abortReject!(e));
    setInflight();

    const finish = async (ok: boolean, result: unknown, err?: ErrorJson): Promise<Envelope> => {
      const { result: clean, side } = ok ? liftSide(result) : { result: undefined, side: {} };
      const audit = await buildAudit({ tool: toolName, action, origin, params, outcome: ok ? "ok" : outcomeFor(err?.code), errorCode: err?.code, result: clean, redact });
      deps.feed?.({ ...feedBase(), params: audit.params, status: ok ? "ok" : audit.outcome === "denied" ? "denied" : "error", errorCode: err?.code, ms: now() - started, resultSummary: audit.resultSummary });
      const env: Envelope = { type: "result", id: cmd.id, ok, ...(ok ? { result: clean } : { error: err }), ...side, audit };
      return env;
    };

    try {
      const tool = deps.getTool(cmd.tool);
      if (!tool) throw new RouterError("BAD_REQUEST", `Unknown tool "${cmd.tool}"`, "tools/list shows the available tools.");
      toolName = tool.name;
      params = deps.validate(tool, cmd.params);
      if (tool.name === "tabs") action = String(params.action);
      if (await deps.isPaused()) throw new RouterError("KILLED", "The user stopped all agents with the TabAgent kill switch", "Ask the user to press Resume in the TabAgent side panel.");

      const req: Requirements = requirementsFor(tool, params);
      const session = await deps.getSession(cmd.session);
      const run = async () => {
        let tabId: number | undefined;
        let url = "";
        let attach: { tabId: number; url: string; title: string } | undefined;
        if (req.needsTab || (req.tabOptional && params.tabId != null)) {
          tabId = await deps.resolveTab(session, params.tabId as number | undefined);
          if ("tabId" in ((tool as any).params?.shape ?? { tabId: 1 })) params.tabId = tabId;
          url = await deps.tabUrl(tabId);
        }
        switch (req.urlSource) {
          case "param":
            url = tool.name === "nav.goto" ? normalizeNavUrl(String(params.url ?? "")) : String(params.url ?? "");
            break;
          case "tab-or-param":
            if (params.url) url = String(params.url);
            break;
          case "download":
            url = deps.downloadUrl(Number(params.id), cmd.session.id) ?? "";
            break;
          case "attach-target":
            attach = await deps.attachTarget(cmd.session, params.tabId as number | undefined);
            tabId = attach.tabId;
            params.tabId = attach.tabId;
            url = attach.url;
            break;
        }
        origin = url ? originOf(url) : null;
        // The D17 chokepoint: exactly one authorize() per command, before any handler.
        // authorize() asks about the site first and the sensitive category second.
        await deps.authorize({ meta: cmd.session, tool: tool.name, action, url, level: req.level, sensitive: req.sensitive, tabId, summary: summaryFor(tool.name, params, attach), reasons: req.sensitive && REASONS[req.sensitive] ? [REASONS[req.sensitive]] : [] });
        if (req.sensitive && deps.holdApproval && origin) release = deps.holdApproval(cmd.session.id, origin, req.sensitive);
        if (deps.sensitivePaths) {
          try {
            redact = { sensitivePaths: await deps.sensitivePaths(tool.name, params, tabId, url) };
          } catch {
            redact = {};
          }
        }
        deps.feed?.({ ...feedBase(), params: (await buildAudit({ tool: tool.name, action, origin, params, outcome: "ok", redact })).params, status: "running" });
        const h = deps.handler(tool.name);
        if (!h) throw new RouterError("UNSUPPORTED", `No handler for ${tool.name} in this extension version`);
        return h({ s: session, meta: cmd.session, p: params, tool, tabId, url, cmdId: cmd.id });
      };
      const result = await Promise.race([run(), aborted]);
      return await finish(true, result);
    } catch (e) {
      return await finish(false, undefined, toErrorJson(e, toolName));
    } finally {
      release?.();
      inflight.delete(cmd.id);
      setInflight();
    }
  }

  /** Kill switch: every in-flight command resolves KILLED now. */
  function abortAll(message = "The user stopped all agents with the TabAgent kill switch") {
    for (const rej of inflight.values()) rej(new RouterError("KILLED", message, "Ask the user to press Resume in the TabAgent side panel."));
  }

  return { handle, abortAll, inflightCount: () => inflight.size };
}
