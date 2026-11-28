// #61 Part B: the remote handoff listener. A second HTTP server, bound ONLY to this machine's tailnet
// address, serving ONLY these routes for live handoffs:
//
//   GET  /handoff/<id>?t=<token>   the phone page (token or claimed cookie; a GET never uses the token up)
//   POST /handoff/<id>/claim       one-time: URL token -> HttpOnly SameSite=Strict cookie for this path
//   GET  /handoff/<id>/frame       JPEG of the handed-off tab
//   POST /handoff/<id>/input       {kind: tap|text|key|scroll}
//   POST /handoff/<id>/end         {result: done|cancel}
//
// and, for a live phone approval link (#108, approvals/index.ts):
//
//   GET  /approve/<id>?t=<token>   the approval page;  POST /approve/<id>/claim   token -> cookie (once)
//   GET  /approve/<id>/prompts     pending prompts (the side panel's text)
//   POST /approve/<id>/answer      {promptId, answer}; first answer wins in the extension
//   POST /approve/<id>/end         revoke the link
//
// Everything else is 404: no /v1, no /mcp, no /ext socket, no bearer tokens accepted. API routes need the
// cookie and an `x-tabagent-handoff: 1` header (a cross-site page cannot send it without a preflight we
// never answer). The Host header must be exactly <tailnet ip>:<port> (DNS rebinding).
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { HandoffInputSchema, HandoffResultSchema, toTabAgentError, type HandoffInput } from "@tabagent/protocol";
import { approvalsEndedPage, approvalsPage } from "../approvals/page";
import { handoffPage, endedPage } from "./page";
import type { HandoffEntry, HandoffRegistry } from "./registry";
import { isTailnetIPv4 } from "./tailnet";

export const COOKIE = "tabagent_handoff";
export const APPROVE_COOKIE = "tabagent_approve";
const ROUTE = /^\/handoff\/([0-9a-f]{32})(?:\/(claim|frame|input|end))?$/;
/** #108: the phone approval page, same rules (one-time link, claimed cookie, header, Host). */
const APPROVE_ROUTE = /^\/approve\/([0-9a-f]{32})(?:\/(claim|prompts|answer|end))?$/;
const MAX_BODY = 4096;

/** #108: phone approvals served on the same listener (see approvals/index.ts). */
export interface ApprovalsRemote {
  links: HandoffRegistry;
  remoteList(): unknown[];
  remoteAnswer(e: HandoffEntry, cookie: string, promptId: unknown, answer: unknown): Promise<{ ok: boolean; outcome: string; by?: string; error?: { code: string; message: string } }>;
  remoteEnd(e: HandoffEntry): void;
  auditLink(event: string, e: HandoffEntry, data?: Record<string, unknown>): void;
  status(r: { ok: boolean; outcome?: string }): number;
}

export interface RemoteBackend {
  registry: HandoffRegistry;
  frame(e: HandoffEntry): Promise<{ mime: string; data: Buffer }>;
  input(e: HandoffEntry, input: HandoffInput): Promise<void>;
  end(e: HandoffEntry, result: "done" | "cancel"): void;
  audit(event: string, e: HandoffEntry, data?: Record<string, unknown>): void;
}

export interface RemoteListener {
  ip: string;
  port: number;
  close(): Promise<void>;
}

function cookieOf(req: IncomingMessage, name = COOKIE): string {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    return null;
  }
}

export function createRemoteHandler(o: { expectedHost: () => string; backend: RemoteBackend; approvals?: () => ApprovalsRemote | undefined; log?: (m: string) => void }): RequestListener {
  const { backend } = o;
  const reg = () => backend.registry;

  function send(res: ServerResponse, status: number, body: string | Buffer = "", headers: Record<string, string> = {}) {
    if (res.headersSent) return;
    res.writeHead(status, {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...(typeof body === "string" && !headers["content-type"] ? { "content-type": "text/plain; charset=utf-8" } : {}),
      ...headers,
    });
    res.end(body);
  }

  function html(res: ServerResponse, status: number, render: (nonce: string) => string) {
    const nonce = randomBytes(16).toString("base64");
    send(res, status, render(nonce), {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
  }

  const notFound = (res: ServerResponse, page = false) => (page ? html(res, 404, endedPage) : send(res, 404, "Not found"));

  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), { "content-type": "application/json" });

  async function handleApprove(req: IncomingMessage, res: ServerResponse, url: URL, a: ApprovalsRemote, id: string, action: string | undefined) {
    const byCookie = () => {
      const c = cookieOf(req, APPROVE_COOKIE);
      const e = c ? a.links.checkCookie(id, c) : null;
      return e ? { e, c } : null;
    };
    if (!action) {
      if (req.method !== "GET") return notFound(res);
      const t = url.searchParams.get("t");
      const ok = (t ? a.links.checkToken(id, t) : null) ?? byCookie();
      if (!ok) return html(res, 404, approvalsEndedPage);
      return html(res, 200, approvalsPage);
    }
    if (req.headers["x-tabagent-handoff"] !== "1") return send(res, 403, "Forbidden");
    if (action === "claim") {
      if (req.method !== "POST") return notFound(res);
      const body = (await readJson(req)) as { t?: unknown } | null;
      const cookie = typeof body?.t === "string" ? a.links.claim(id, body.t) : null;
      if (!cookie) return byCookie() ? send(res, 204) : notFound(res);
      const e = a.links.get(id);
      if (e) a.auditLink("approval.phone.claim", e);
      return send(res, 204, "", { "set-cookie": `${APPROVE_COOKIE}=${cookie}; Path=/approve/${id}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(60, Math.ceil(((e?.expiresAt ?? 0) - Date.now()) / 1000))}` });
    }
    const s = byCookie();
    if (!s) return notFound(res);
    if (action === "prompts" && req.method === "GET") return json(res, 200, { prompts: a.remoteList() });
    if (action === "answer" && req.method === "POST") {
      const body = (await readJson(req)) as { promptId?: unknown; answer?: unknown } | null;
      const r = await a.remoteAnswer(s.e, s.c, body?.promptId, body?.answer);
      return json(res, a.status(r), r);
    }
    if (action === "end" && req.method === "POST") {
      a.remoteEnd(s.e);
      return send(res, 204);
    }
    return notFound(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== o.expectedHost()) return send(res, 403, "Forbidden");
    const url = new URL(req.url ?? "/", "http://handoff.invalid");
    const am = APPROVE_ROUTE.exec(url.pathname);
    const approvals = am ? o.approvals?.() : undefined;
    if (am && approvals) return handleApprove(req, res, url, approvals, am[1], am[2]);
    const m = ROUTE.exec(url.pathname);
    if (!m) return notFound(res);
    const [, id, action] = m;
    const byCookie = () => {
      const c = cookieOf(req);
      return c ? reg().checkCookie(id, c) : null;
    };

    if (!action) {
      if (req.method !== "GET") return notFound(res);
      const t = url.searchParams.get("t");
      const e = (t ? reg().checkToken(id, t) : null) ?? byCookie();
      if (!e) return notFound(res, true);
      return html(res, 200, (nonce) => handoffPage(e, nonce));
    }

    if (req.headers["x-tabagent-handoff"] !== "1") return send(res, 403, "Forbidden");

    if (action === "claim") {
      if (req.method !== "POST") return notFound(res);
      const body = (await readJson(req)) as { t?: unknown } | null;
      const cookie = typeof body?.t === "string" ? reg().claim(id, body.t) : null;
      if (!cookie) {
        // The browser that claimed it may reload with the token still in its URL.
        return byCookie() ? send(res, 204) : notFound(res);
      }
      const e = reg().get(id);
      if (e) backend.audit("handoff.remote.claim", e);
      return send(res, 204, "", { "set-cookie": `${COOKIE}=${cookie}; Path=/handoff/${id}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(60, Math.ceil(((e?.expiresAt ?? 0) - Date.now()) / 1000))}` });
    }

    const e = byCookie();
    if (!e) return notFound(res);

    if (action === "frame" && req.method === "GET") {
      try {
        const f = await backend.frame(e);
        return send(res, 200, f.data, { "content-type": f.mime });
      } catch (err) {
        return send(res, toTabAgentError(err).code === "TIMEOUT" ? 504 : 502, "The tab could not be captured");
      }
    }
    if (action === "input" && req.method === "POST") {
      const p = HandoffInputSchema.safeParse(await readJson(req));
      if (!p.success) return send(res, 400, "Bad input");
      try {
        await backend.input(e, p.data);
        return send(res, 204);
      } catch (err) {
        return send(res, toTabAgentError(err).code === "TIMEOUT" ? 504 : 502, "The input could not be delivered");
      }
    }
    if (action === "end" && req.method === "POST") {
      const body = (await readJson(req)) as { result?: unknown } | null;
      const r = HandoffResultSchema.safeParse(body?.result);
      if (!r.success) return send(res, 400, "Bad result");
      backend.end(e, r.data);
      return send(res, 204);
    }
    return notFound(res);
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      o.log?.(`handoff: remote request failed (${toTabAgentError(err).code})`);
      send(res, (err as Error)?.message === "too large" ? 413 : 500, "Error");
    });
  };
}

/** Bind `handler` on exactly `ip` (which must be a tailnet address). Never a wildcard, never loopback. */
export async function startRemoteListener(handler: RequestListener, ip: string, port: number): Promise<RemoteListener> {
  if (!isTailnetIPv4(ip)) throw new Error(`Refusing to serve the handoff page on ${ip}: not a tailnet address (100.64.0.0/10)`);
  const server = createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  // The remote listener never upgrades: the extension socket lives on loopback only.
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, ip, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    ip,
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}
