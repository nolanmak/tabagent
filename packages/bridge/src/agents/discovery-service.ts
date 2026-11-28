// Discovery I/O (spec §5): `claude agents --json` and the Codex app-server. Decisions live in discovery.ts.
import { execFile } from "node:child_process";
import type { Agent, AgentSources } from "@tabagent/protocol";
import { CodexRpc, defaultCodexSocket, loadedThreadIds, readThread } from "./codex";
import { codexThreadToAgent, mergeAgents, parseAgentId, parseClaudeAgents, toAgent, type AgentBase, type LinkOf } from "./discovery";
import { RemoteControlReader } from "./remote";
import { pickTitle, TitleReader, transcriptPath } from "./titles";

export interface DiscoveryOpts {
  /** `claude` executable; default $TABAGENT_CLAUDE_BIN, else `claude` on PATH. */
  claudeBin?: string;
  /** Codex control socket; default $TABAGENT_CODEX_SOCKET, else ~/.codex/app-server-control/app-server-control.sock. */
  codexSocket?: string;
  claudeTimeoutMs?: number;
  codexTimeoutMs?: number;
  /** Display cache (§5). */
  cacheMs?: number;
  now?: () => number;
  /** AD4: live inbox link for an agent, applied on every list and resolve (never cached). */
  linkOf?: LinkOf;
  /** #137: Claude transcripts, for session titles; default $TABAGENT_CLAUDE_PROJECTS_DIR, else ~/.claude/projects. */
  claudeProjectsDir?: string;
  /** #151: Claude session records, for Remote Control URLs; default $TABAGENT_CLAUDE_SESSIONS_DIR, else ~/.claude/sessions. */
  claudeSessionsDir?: string;
}

export interface AgentList {
  agents: Agent[];
  sources: AgentSources;
}

interface SourceLists {
  lists: AgentBase[][];
  sources: AgentSources;
}

export const CLAUDE_MAX_BUFFER = 4 * 1024 * 1024;

export function defaultClaudeBin(): string {
  return process.env.TABAGENT_CLAUDE_BIN || "claude";
}

export class AgentDiscovery {
  readonly claudeBin: string;
  readonly codexSocket: string;
  private claudeTimeoutMs: number;
  readonly codexTimeoutMs: number;
  private cacheMs: number;
  private now: () => number;
  /** The vendor sources only; links are applied on read, so a link or unlink shows at once. */
  private cache: { at: number; value: SourceLists } | null = null;
  private inflight: Promise<SourceLists> | null = null;
  linkOf: LinkOf;
  private titles: TitleReader;
  private remote: RemoteControlReader;

  constructor(o: DiscoveryOpts = {}) {
    this.claudeBin = o.claudeBin ?? defaultClaudeBin();
    this.codexSocket = o.codexSocket ?? defaultCodexSocket();
    this.claudeTimeoutMs = o.claudeTimeoutMs ?? 5_000;
    this.codexTimeoutMs = o.codexTimeoutMs ?? 5_000;
    this.cacheMs = o.cacheMs ?? 5_000;
    this.now = o.now ?? Date.now;
    this.linkOf = o.linkOf ?? (() => null);
    this.titles = new TitleReader({ projectsDir: o.claudeProjectsDir });
    this.remote = new RemoteControlReader({ sessionsDir: o.claudeSessionsDir });
  }

  /**
   * #151: the transcript of a Claude session in the current (cached) list. Only listed sessions are ever
   * read, so a page can never name an arbitrary path. null when the agent is not listed or has no transcript.
   */
  async transcriptOf(id: string): Promise<{ listed: boolean; path: string | null }> {
    const l = await this.sources();
    const hit = l.lists.flat().find((a) => a.id === id);
    if (!hit) return { listed: false, path: null };
    if (hit.vendor !== "claude" || !hit.sessionId) return { listed: true, path: null };
    return { listed: true, path: transcriptPath(this.titles.projectsDir, hit.cwd, hit.sessionId) };
  }

  /** Cached for display only; concurrent callers share one run. A send never uses this (AD3). */
  async list(): Promise<AgentList> {
    return this.linked(await this.sources());
  }

  private sources(): Promise<SourceLists> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return Promise.resolve(this.cache.value);
    if (this.inflight) return this.inflight;
    const p: Promise<SourceLists> = this.sourcesFresh()
      .then((value) => {
        this.cache = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  clearCache() {
    this.cache = null;
  }

  async listFresh(): Promise<AgentList> {
    return this.linked(await this.sourcesFresh());
  }

  private linked(l: SourceLists): AgentList {
    return { agents: mergeAgents(l.lists, this.linkOf), sources: l.sources };
  }

  private async sourcesFresh(): Promise<SourceLists> {
    const [cl, cx] = await Promise.all([this.claudeAgents().then(ok, unavailable), this.codexAgents().then(ok, unavailable)]);
    return { lists: [cl.agents, cx.agents], sources: { claude: cl.state, codex: cx.state } };
  }

  /** AD3: re-resolve one id with no cache. null when it is gone (or its source is down). */
  async resolve(id: string): Promise<Agent | null> {
    const p = parseAgentId(id);
    if (!p) return null;
    if (p.vendor === "claude") {
      const all = await this.claudeAgents().catch(() => [] as AgentBase[]);
      const hit = all.find((a) => a.id === id);
      return hit ? toAgent(hit, this.linkOf(hit)) : null;
    }
    const rpc = await CodexRpc.connect(this.codexSocket, this.codexTimeoutMs).catch(() => null);
    if (!rpc) return null;
    try {
      const a = codexThreadToAgent(await readThread(rpc, p.threadId));
      return a ? toAgent(a, this.linkOf(a)) : null;
    } catch {
      return null;
    } finally {
      rpc.close();
    }
  }

  /** `claude agents --json`: 5 s timeout, 4 MB buffer, never `--all` (§5). */
  claudeAgents(): Promise<AgentBase[]> {
    return new Promise((resolve, reject) => {
      execFile(this.claudeBin, ["agents", "--json"], { timeout: this.claudeTimeoutMs, maxBuffer: CLAUDE_MAX_BUFFER, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(parseClaudeAgents(String(stdout)).map((a) => this.withRemote(this.withTitle(a))));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** #137: the transcript title (custom, else ai), else the vendor name. A read failure only drops the title. */
  private withTitle(a: AgentBase): AgentBase {
    const title = pickTitle(this.titles.titles(a.cwd, a.sessionId), a.name);
    return title ? { ...a, title } : a;
  }

  /** #151: the Remote Control URL from the session record, when the session runs with --remote-control. */
  private withRemote(a: AgentBase): AgentBase {
    const url = this.remote.urlFor(a.pid, a.startedAt);
    return url ? { ...a, remoteControlUrl: url } : a;
  }

  /** thread/loaded/list, then thread/read per thread. A failing read drops only that thread. */
  async codexAgents(): Promise<AgentBase[]> {
    const rpc = await CodexRpc.connect(this.codexSocket, this.codexTimeoutMs);
    try {
      const ids = await loadedThreadIds(rpc);
      const threads = await Promise.all(ids.map((id) => readThread(rpc, id).catch(() => null)));
      return threads.map(codexThreadToAgent).filter((a): a is AgentBase => !!a);
    } finally {
      rpc.close();
    }
  }
}

const ok = (agents: AgentBase[]) => ({ agents, state: "ok" as const });
const unavailable = () => ({ agents: [] as AgentBase[], state: "unavailable" as const });
