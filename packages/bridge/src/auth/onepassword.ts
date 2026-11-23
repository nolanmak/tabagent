// 1Password provider through the `op` CLI (#33). `op item list` returns metadata only (no secrets);
// secrets are fetched per field with `op item get` only after consent. With the 1Password app's CLI
// integration on, the app asks for Touch ID; TabAgent never sees or asks for the account password.
import { accountId, itemUrlMatches, LOCAL_ID_RE, maskAccount, TabAgentError, type AuthAccount, type ProviderStatus } from "@tabagent/protocol";
import { CliMissing, CLI_TIMEOUT_MS, nodeRunner, SerialQueue, versionAtLeast, type Runner } from "./exec";
import type { BridgeProvider, SecretRequestField } from "./provider";

/** First release with `--reveal` (required to print concealed fields). */
export const MIN_OP_VERSION = "2.24.0";

export const OP_LOCKED_HINT =
  "1Password is locked or not signed in: ask the user to unlock the 1Password app (Settings > Developer > Integrate with 1Password CLI) or run `op signin` in the shell that starts the bridge.";
const OP_MISSING_HINT = "Install the 1Password CLI (`brew install 1password-cli`) and turn on Settings > Developer > Integrate with 1Password CLI in the 1Password app.";

interface OpListItem {
  id?: unknown;
  category?: unknown;
  additional_information?: unknown;
  urls?: { href?: unknown }[];
}

export interface OnePasswordOpts {
  bin?: string;
  runner?: Runner;
}

export class OnePasswordProvider implements BridgeProvider {
  readonly name = "1password" as const;
  private bin: string;
  private runner: Runner;
  private queue = new SerialQueue();

  constructor(o: OnePasswordOpts = {}) {
    this.bin = o.bin ?? "op";
    this.runner = o.runner ?? nodeRunner();
  }

  private op(args: string[]) {
    return this.queue.run(() => this.runner.run(this.bin, args, { timeoutMs: CLI_TIMEOUT_MS }));
  }

  async status(): Promise<ProviderStatus> {
    let v;
    try {
      v = await this.op(["--version"]);
    } catch (e) {
      if (e instanceof CliMissing) return { name: this.name, state: "missing", hint: OP_MISSING_HINT };
      throw e;
    }
    if (v.code !== 0) return { name: this.name, state: "missing", hint: OP_MISSING_HINT };
    if (!versionAtLeast(v.stdout, MIN_OP_VERSION)) return { name: this.name, state: "old-version", hint: `Update the 1Password CLI to ${MIN_OP_VERSION} or later.` };
    const acc = await this.op(["account", "list", "--format", "json"]);
    let accounts: unknown[] = [];
    try {
      accounts = acc.code === 0 && acc.stdout.trim() ? JSON.parse(acc.stdout) : [];
    } catch {
      accounts = [];
    }
    if (!Array.isArray(accounts) || accounts.length === 0) return { name: this.name, state: "logged-out", hint: OP_LOCKED_HINT };
    return { name: this.name, state: "unlocked", totp: "unknown" };
  }

  async find(origin: string): Promise<AuthAccount[]> {
    let r;
    try {
      r = await this.op(["item", "list", "--categories", "Login", "--format", "json"]);
    } catch (e) {
      if (e instanceof CliMissing) throw new TabAgentError("NOT_FOUND", "The 1Password CLI is not installed", OP_MISSING_HINT);
      throw e;
    }
    if (r.code !== 0) throw new TabAgentError("NOT_FOUND", "1Password is not available", OP_LOCKED_HINT);
    let items: OpListItem[];
    try {
      items = JSON.parse(r.stdout || "[]");
      if (!Array.isArray(items)) throw new Error();
    } catch {
      throw new TabAgentError("INTERNAL", "Unreadable output from the 1Password CLI");
    }
    const out: AuthAccount[] = [];
    for (const it of items) {
      if (typeof it.id !== "string" || !LOCAL_ID_RE.test(it.id)) continue;
      if (it.category !== undefined && it.category !== "LOGIN") continue;
      const uris = (Array.isArray(it.urls) ? it.urls : []).map((u) => (typeof u?.href === "string" ? u.href : "")).filter(Boolean).slice(0, 50).map((uri) => ({ uri, match: "domain" as const }));
      if (!uris.some((u) => itemUrlMatches(u.uri, origin))) continue; // DA3: registrable domain, https only
      out.push({
        id: accountId(this.name, it.id),
        provider: this.name,
        accountMasked: maskAccount(typeof it.additional_information === "string" ? it.additional_information : ""),
        uris,
      });
    }
    return out;
  }

  async secret(localId: string, field: SecretRequestField): Promise<string> {
    if (!LOCAL_ID_RE.test(localId)) throw new TabAgentError("BAD_REQUEST", "Bad 1Password item id");
    if (field === "totp") {
      const r = await this.op(["item", "get", localId, "--otp"]);
      const code = r.stdout.trim();
      if (r.code !== 0 || !/^\d{6,8}$/.test(code)) throw new TabAgentError("NOT_FOUND", "This 1Password item has no one-time password", OP_LOCKED_HINT);
      return code;
    }
    const r = await this.op(["item", "get", localId, "--fields", `label=${field}`, "--reveal", "--format", "json"]);
    if (r.code !== 0) throw new TabAgentError("NOT_FOUND", `Could not read the ${field} from 1Password`, OP_LOCKED_HINT);
    let value: unknown;
    try {
      const j = JSON.parse(r.stdout);
      value = Array.isArray(j) ? j[0]?.value : j?.value;
    } catch {
      throw new TabAgentError("INTERNAL", "Unreadable output from the 1Password CLI");
    }
    if (typeof value !== "string" || !value) throw new TabAgentError("NOT_FOUND", `The 1Password item has no ${field}`);
    return value;
  }
}
