// Auth fixture server (http or https with a throwaway self-signed cert).
// Records every credential / code it receives so tests can assert the page got
// the right secret while the agent's transcript did not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Received {
  path: string;
  host: string;
  fields: Record<string, string>;
  cookie: string;
}

export interface AuthServer {
  server: Server;
  port: number;
  /** PEM of the self-signed cert when https. */
  cert?: Buffer;
  received: Received[];
  /** Messages the fake mailbox serves (stand-in for Gmail). */
  mailbox: { from: string; subject: string; body: string; ts: number }[];
  /** Make /auth/login answer with a one-time-code step that expects this code ("" = no 2FA). */
  setCode(code: string): void;
  close(): Promise<void>;
}

/** Make a self-signed cert valid for `names` (DNS SANs). */
export function selfSignedCert(names: string[]): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "tabagent-cert-"));
  const san = names.map((n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${san}`], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => resolve(b));
  });
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export async function authServer(opts: { https?: { names: string[] }; password?: string; code?: string } = {}): Promise<AuthServer> {
  const received: Received[] = [];
  const mailbox: AuthServer["mailbox"] = [];
  const state = { password: opts.password ?? "", code: opts.code ?? "" };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    const host = req.headers.host ?? "";
    const cookie = req.headers.cookie ?? "";
    const html = (s: string, code = 200, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(s);
    };
    if (req.method === "POST") {
      const raw = await readBody(req);
      const fields = Object.fromEntries(new URLSearchParams(raw));
      received.push({ path: u.pathname, host, fields, cookie });
      if (u.pathname === "/auth/login") {
        if (fields.password && state.code) return html(page("Verify", `<h1>Enter your code</h1><form method="post" action="/auth/code"><label for="otp">Verification code</label><input id="otp" name="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`));
        return html(page("Welcome", `<h1>Signed in as ${fields.username ?? ""}</h1>`), 200, { "set-cookie": "session=1; Path=/" });
      }
      if (u.pathname === "/auth/step1") {
        return html(page("Password", `<h1>Hi ${fields.username ?? ""}</h1><form method="post" action="/auth/login"><input type="hidden" name="username" value="${fields.username ?? ""}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`));
      }
      if (u.pathname === "/auth/code") return html(page("Welcome", `<h1>Verified</h1>`), 200, { "set-cookie": "session=1; Path=/" });
      if (u.pathname === "/auth/signup") return html(page("Check your email", `<h1>Account created. Check your email to confirm it.</h1>`));
      return html(page("ok", "ok"));
    }
    if (u.pathname === "/auth/human") {
      // Handoff fixture: a "human check" whose button sets a cookie.
      const signed = /human=1/.test(cookie);
      return html(page("Human check", signed ? `<h1>Signed in</h1>` : `<h1>Prove you are human</h1><button id="human" onclick="document.cookie='human=1; path=/'; location.reload()">I am human</button>`));
    }
    if (u.pathname === "/mail/feed/atom" || u.pathname === "/mail/inbox") {
      // Fake mailbox standing in for Gmail (the reader URL is injectable in tests).
      res.writeHead(200, { "content-type": u.pathname.endsWith("atom") ? "application/atom+xml; charset=utf-8" : "text/html; charset=utf-8" });
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const entries = mailbox
        .map((m) => `<entry><title>${esc(m.subject)}</title><summary>${esc(m.body)}</summary><issued>${new Date(m.ts).toISOString()}</issued><modified>${new Date(m.ts).toISOString()}</modified><author><name>${esc(m.from)}</name><email>${esc(m.from)}</email></author></entry>`)
        .join("");
      res.end(`<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for fixture@example.com</title><fullcount>${mailbox.length}</fullcount>${entries}</feed>`);
      return;
    }
    if (u.pathname === "/favicon.ico") {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = join(HERE, u.pathname === "/" ? "login.html" : u.pathname.replace(/\.\./g, ""));
    try {
      html(readFileSync(file, "utf8"));
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  };
  const tls = opts.https ? selfSignedCert(opts.https.names) : null;
  const server = tls ? createHttps(tls, handler) : createHttp(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port as number;
  return {
    server,
    port,
    cert: tls?.cert,
    received,
    mailbox,
    setCode: (c: string) => {
      state.code = c;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
