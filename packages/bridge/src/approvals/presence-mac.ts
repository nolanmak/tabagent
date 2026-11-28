// #108: the macOS presence provider. A tiny Swift helper evaluates LocalAuthentication's
// deviceOwnerAuthentication policy (Touch ID, or the login password when Touch ID is unavailable) with the
// bridge's reason text, and only on success prints an HMAC of the bridge's challenge message.
//
// The source is embedded here and compiled once with the system `swiftc` (Xcode Command Line Tools) into
// <TabAgent home>/bin/presence-<source hash>. This file is a thin adapter: the decisions (what to sign, when
// to accept) are in presence.ts and approvals/index.ts.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../config";
import type { PresenceProvider, PresenceRequest, PresenceResult } from "./presence";

export const PRESENCE_SWIFT = `// TabAgent presence helper (#108). Reads {reason, key, message} as JSON on stdin.
// Prints {"ok":true,"mac":"<base64 HMAC-SHA256(key, message)>"} only after LocalAuthentication succeeds.
import Foundation
import LocalAuthentication
import CryptoKit

struct Request: Decodable { let reason: String; let key: String; let message: String }

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}

let context = LAContext()
var canError: NSError?
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--check" {
  if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError) { emit(["ok": true]) }
  else { emit(["ok": false, "error": "unavailable", "detail": canError?.localizedDescription ?? ""]) }
  exit(0)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input),
      let key = Data(base64Encoded: request.key), key.count >= 32,
      !request.reason.isEmpty, !request.message.isEmpty else {
  emit(["ok": false, "error": "bad_request"])
  exit(2)
}
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError) else {
  emit(["ok": false, "error": "unavailable", "detail": canError?.localizedDescription ?? ""])
  exit(3)
}

let done = DispatchSemaphore(value: 0)
var succeeded = false
var failure: Error?
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason) { ok, error in
  succeeded = ok
  failure = error
  done.signal()
}
done.wait()

if succeeded {
  let mac = HMAC<SHA256>.authenticationCode(for: Data(request.message.utf8), using: SymmetricKey(data: key))
  emit(["ok": true, "mac": Data(mac).base64EncodedString()])
  exit(0)
}
var name = "failed"
if let code = (failure as? LAError)?.code, code == .userCancel || code == .appCancel || code == .systemCancel || code == .userFallback {
  name = "cancelled"
}
emit(["ok": false, "error": name])
exit(1)
`;

export interface MacDeps {
  home: () => string;
  exists: (path: string) => boolean;
  compile: (source: string, out: string) => Promise<void>;
  run: (bin: string, input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;
}

async function compileWithSwiftc(source: string, out: string): Promise<void> {
  const dir = join(out, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const src = `${out}.swift`;
  writeFileSync(src, source, { mode: 0o600 });
  await new Promise<void>((resolve, reject) =>
    execFile("swiftc", ["-swift-version", "5", "-O", "-o", out, src], { timeout: 180_000 }, (err, _o, stderr) => (err ? reject(new Error(`${err.message} ${String(stderr).slice(0, 300)}`)) : resolve())),
  );
  chmodSync(out, 0o700);
}

function runHelper(bin: string, input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL"); // dismisses the dialog
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d).slice(0, 4096)));
    child.on("error", () => {
      clearTimeout(t);
      resolve({ code: null, stdout: "", timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, timedOut });
    });
    child.stdin.end(input);
  });
}

const ERRORS = new Set(["cancelled", "failed", "unavailable"]);

export function parseHelperOutput(stdout: string): PresenceResult {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line) return { ok: false, error: "failed", detail: "no output from helper" };
  let j: { ok?: unknown; mac?: unknown; error?: unknown; detail?: unknown };
  try {
    j = JSON.parse(line);
  } catch {
    return { ok: false, error: "failed", detail: "unreadable helper output" };
  }
  if (j.ok === true) return typeof j.mac === "string" && j.mac ? { ok: true, mac: j.mac } : { ok: false, error: "failed", detail: "no proof in helper output" };
  const error = typeof j.error === "string" && ERRORS.has(j.error) ? (j.error as "cancelled" | "failed" | "unavailable") : "failed";
  return { ok: false, error, ...(typeof j.detail === "string" && j.detail ? { detail: j.detail.slice(0, 300) } : {}) };
}

export class MacPresence implements PresenceProvider {
  readonly kind = "macos-localauthentication" as const;
  private d: MacDeps;
  private building: Promise<string> | null = null;

  constructor(deps: Partial<MacDeps> = {}) {
    this.d = { home, exists: existsSync, compile: compileWithSwiftc, run: runHelper, ...deps };
  }

  private binary(): Promise<string> {
    const hash = createHash("sha256").update(PRESENCE_SWIFT).digest("hex").slice(0, 12);
    const bin = join(this.d.home(), "bin", `presence-${hash}`);
    if (this.d.exists(bin)) return Promise.resolve(bin);
    this.building ??= this.d
      .compile(PRESENCE_SWIFT, bin)
      .then(() => bin)
      .finally(() => (this.building = null));
    return this.building;
  }

  async prove(r: PresenceRequest): Promise<PresenceResult> {
    let bin: string;
    try {
      bin = await this.binary();
    } catch (e) {
      return { ok: false, error: "unavailable", detail: `Could not build the Touch ID helper with swiftc (install the Xcode Command Line Tools: xcode-select --install): ${(e as Error).message.slice(0, 200)}` };
    }
    const out = await this.d.run(bin, JSON.stringify({ reason: r.reason, message: r.message, key: r.key.toString("base64") }), r.timeoutMs);
    if (out.timedOut) return { ok: false, error: "timeout" };
    return parseHelperOutput(out.stdout);
  }
}
