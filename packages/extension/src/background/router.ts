// Command router (#3). Every command goes:
//   validate -> resolve tab -> authorize (D17 chokepoint) -> handler -> envelope + audit.
// Chrome-free: all effects are injected so the router is unit-testable.
import { buildAudit, liftSide, outcomeFor, type AuditRecord } from "./audit";
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
}

export interface RouterDeps<S = unknown> {
  getTool(name: string): (ToolLike & { params?: unknown }) | undefined;
  /** Throws a BAD_REQUEST error on invalid params; returns parsed params. */
  validate(tool: ToolLike, params: unknown): Record<string, unknown>;
  getSession(meta: SessionMetaLike): Promise<S>;
  /** Session tab for this command; throws NOT_FOUND / TAB_BUSY. */
  resolveTab(session: S, tabId: number | undefined): Promise<number>;
  tabUrl(tabId: number): Promise<string>;
  authorize(req: AuthorizeRequest): Promise<void>;
  handler(name: string): ((ctx: { s: S; meta: SessionMetaLike; p: any; tool: any; tabId?: number; url?: string; cmdId: string }) => Promise<unknown>) | undefined;
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

export function createRouter<S>(deps: RouterDeps<S>) {
  async function handle(cmd: CommandLike): Promise<Envelope> {
    let toolName = cmd.tool;
    let action: string | undefined;
    let origin: string | null = null;
    let params: Record<string, unknown> = (cmd.params ?? {}) as Record<string, unknown>;

    const finish = async (ok: boolean, result: unknown, err?: ErrorJson): Promise<Envelope> => {
      const { result: clean, side } = ok ? liftSide(result) : { result: undefined, side: {} };
      const audit = await buildAudit({ tool: toolName, action, origin, params, outcome: ok ? "ok" : outcomeFor(err?.code), errorCode: err?.code, result: clean });
      const env: Envelope = { type: "result", id: cmd.id, ok, ...(ok ? { result: clean } : { error: err }), ...side, audit };
      return env;
    };

    try {
      const tool = deps.getTool(cmd.tool);
      if (!tool) throw new RouterError("BAD_REQUEST", `Unknown tool "${cmd.tool}"`, "tools/list shows the available tools.");
      toolName = tool.name;
      params = deps.validate(tool, cmd.params);
      if (tool.name === "tabs") action = String(params.action);

      const req: Requirements = requirementsFor(tool, params);
      const session = await deps.getSession(cmd.session);
      let tabId: number | undefined;
      let url = "";
      if (req.needsTab || (req.tabOptional && params.tabId != null)) {
        tabId = await deps.resolveTab(session, params.tabId as number | undefined);
        if ("tabId" in ((tool as any).params?.shape ?? { tabId: 1 })) params.tabId = tabId;
        url = await deps.tabUrl(tabId);
      }
      if (req.urlSource === "param") url = tool.name === "nav.goto" ? normalizeNavUrl(String(params.url ?? "")) : String(params.url ?? "");
      origin = url ? originOf(url) : null;
      // The D17 chokepoint: exactly one authorize() per command, before any handler.
      await deps.authorize({ meta: cmd.session, tool: tool.name, action, url, level: req.level, sensitive: req.sensitive, tabId });
      const h = deps.handler(tool.name);
      if (!h) throw new RouterError("UNSUPPORTED", `No handler for ${tool.name} in this extension version`);
      const result = await h({ s: session, meta: cmd.session, p: params, tool, tabId, url, cmdId: cmd.id });
      return await finish(true, result);
    } catch (e) {
      return await finish(false, undefined, toErrorJson(e, toolName));
    }
  }

  return { handle };
}
