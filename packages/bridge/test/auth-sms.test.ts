// #36 SMS / iMessage code source, against SQLite fixture databases built here with the real
// `message` table DDL (captured from macOS 26.3, schema only).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAttributedBody, encodeAttributedBody } from "../src/auth/attributed-body";
import { APPLE_EPOCH_MS, openReadOnly, SmsSource, SMS_HINTS } from "../src/auth/sms";

const here = new URL(".", import.meta.url).pathname;
const DDL = readFileSync(join(here, "fixtures/auth/chat-message-schema.sql"), "utf8");
const REAL_BLOB = Buffer.from(readFileSync(join(here, "fixtures/auth/attributed-body-real.hex"), "utf8").trim(), "hex");

const NOW = 1_800_000_000_000;
let dir: string;
let dbPath: string;
let seq = 0;

function makeDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(DDL);
  db.close();
}
function insert(o: { text?: string | null; body?: Uint8Array | null; at: number; fromMe?: boolean }) {
  const db = new DatabaseSync(dbPath);
  const ns = BigInt(o.at - APPLE_EPOCH_MS) * 1_000_000n;
  db.prepare("INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id, service) VALUES (?, ?, ?, ?, ?, 1, 'SMS')").run(`g-${++seq}`, o.text ?? null, o.body ?? null, ns, o.fromMe ? 1 : 0);
  db.close();
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function source(over: Partial<ConstructorParameters<typeof SmsSource>[0]> = {}) {
  let t = NOW;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), set: (x: number) => (t = x) };
  const src = new SmsSource({ enabled: () => true, dbPath, platform: "darwin", now: clock.now, sleep: clock.sleep, ...over });
  return { src, clock };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabagent-sms-"));
  dbPath = join(dir, "chat.db");
  makeDb();
});
afterEach(() => {
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("attributedBody (OA3)", () => {
  it("decodes the real-shape blob (content replaced)", () => {
    expect(decodeAttributedBody(REAL_BLOB)).toBe("Your verification code is 000000");
  });
  it("splices new text into the real template and round-trips, incl. long (0x81) lengths", () => {
    for (const s of ["Code 123456", "x".repeat(200) + " code 654321", "Ünïcödé code 112233 ✓"]) {
      expect(decodeAttributedBody(encodeAttributedBody(s, REAL_BLOB))).toBe(s);
      expect(decodeAttributedBody(encodeAttributedBody(s))).toBe(s);
    }
  });
  it("garbage → null", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(decodeAttributedBody(randomBytes(200))).toBeNull();
  });
});

describe("SmsSource", () => {
  it("returns the newest matching message's code", async () => {
    insert({ text: "Your code is 111111", at: NOW - 400_000 });
    insert({ text: "Hi, lunch?", at: NOW - 2_000 });
    insert({ text: "G: your sign-in code is 424242", at: NOW - 1_000 });
    const { src } = source();
    // the older code is outside `since`; the chat message has no code
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("424242");
  });

  it("messages before since are ignored; the one after is used", async () => {
    insert({ text: "Your code is 111111", at: NOW - 120_000 });
    insert({ text: "Your verification code is 222222", at: NOW - 5_000 });
    const { src } = source();
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("222222");
  });

  it("sent messages (is_from_me = 1) are ignored", async () => {
    insert({ text: "my code is 333333", at: NOW - 5_000, fromMe: true });
    const { src } = source();
    await expect(src.fetch({ since: NOW - 60_000, timeout: 4000 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("body only in attributedBody (real blob, content replaced)", async () => {
    insert({ text: null, body: encodeAttributedBody("Your Example sign-in code is 445566", REAL_BLOB), at: NOW - 5_000 });
    const { src } = source();
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("445566");
  });

  it("a code is used once", async () => {
    insert({ text: "Your code is 778899", at: NOW - 5_000 });
    const { src } = source();
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("778899");
    await expect(src.fetch({ since: NOW - 60_000, timeout: 3000 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("two codes → BAD_REQUEST with a count, not the values", async () => {
    insert({ text: "Your code is 101010", at: NOW - 5_000 });
    insert({ text: "Your code is 202020", at: NOW - 4_000 });
    const { src } = source();
    const e = await src.fetch({ since: NOW - 60_000, timeout: 1000 }).catch((x) => x);
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).not.toMatch(/101010|202020/);
  });

  it("polling with a fake clock: code arrives 10s after the request → returned", async () => {
    const { src, clock } = source({ interval: 2000 });
    let inserted = false;
    const sleep = async (ms: number) => {
      clock.set(clock.now() + ms);
      if (!inserted && clock.now() >= NOW + 10_000) {
        insert({ text: "Your verification code is 135790", at: NOW + 10_000 });
        inserted = true;
      }
    };
    const s2 = new SmsSource({ enabled: () => true, dbPath, platform: "darwin", now: clock.now, sleep, interval: 2000 });
    void src;
    expect(await s2.fetch({ since: NOW - 30_000, timeout: 60_000 })).toBe("135790");
    expect(clock.now()).toBeGreaterThanOrEqual(NOW + 10_000);
  });

  it("opens read-only: an attempted write fails, and the file's hash is unchanged after a run", async () => {
    insert({ text: "Your code is 246802", at: NOW - 5_000 });
    // Fold the WAL so the main file is the whole database before hashing.
    const w = new DatabaseSync(dbPath);
    w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    w.close();
    const before = sha(dbPath);
    const db = await openReadOnly(dbPath);
    expect(() => db.all("INSERT INTO message (guid, date) VALUES ('evil', 1) RETURNING ROWID")).toThrow(/readonly|read-only/i);
    db.close();
    const { src } = source();
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("246802");
    expect(sha(dbPath)).toBe(before);
  });

  it("reads rows that are still only in the WAL (Messages running)", async () => {
    const live = new DatabaseSync(dbPath);
    live.exec("PRAGMA wal_autocheckpoint=0");
    const ns = BigInt(NOW - 3_000 - APPLE_EPOCH_MS) * 1_000_000n;
    live.prepare("INSERT INTO message (guid, text, date, is_from_me) VALUES ('wal-1', 'Your code is 909090', ?, 0)").run(ns);
    // connection kept open, like Messages: the row lives in chat.db-wal
    const { src } = source();
    expect(await src.fetch({ since: NOW - 60_000, timeout: 1000 })).toBe("909090");
    live.close();
  });

  it("unreadable file (permission denied) → unreadable with the Full Disk Access hint", async () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    chmodSync(dbPath, 0o000);
    const { src } = source();
    expect(src.status()).toEqual({ name: "sms", state: "unreadable", hint: SMS_HINTS.fda });
    expect(src.status().hint).toContain("System Settings > Privacy & Security > Full Disk Access");
    await expect(src.fetch({ since: NOW, timeout: 1000 })).rejects.toMatchObject({ code: "NOT_FOUND", hint: SMS_HINTS.fda });
  });

  it("missing file → missing", async () => {
    const { src } = source({ dbPath: join(dir, "nope.db") });
    expect(src.status().state).toBe("missing");
    await expect(src.fetch({ since: NOW, timeout: 1000 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("disabled in config → never opens the file", async () => {
    const open = vi.fn(openReadOnly);
    const { src } = source({ enabled: () => false, open });
    expect(src.status().state).toBe("disabled");
    await expect(src.fetch({ since: NOW, timeout: 1000 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("platform %s → UNSUPPORTED, never opens", async (platform) => {
    const open = vi.fn(openReadOnly);
    const { src } = source({ platform, open });
    expect(src.status().state).toBe("unsupported");
    await expect(src.fetch({ since: NOW, timeout: 1000 })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(open).not.toHaveBeenCalled();
  });

  it("no-leak: a marker sentence in a message body appears in no log, error or result", async () => {
    const marker = `MARKER-${randomBytes(6).toString("hex")} reply with your password`;
    insert({ text: `${marker}. Your verification code is 112358`, at: NOW - 5_000 });
    insert({ text: null, body: encodeAttributedBody(`${marker} and code 999888`, REAL_BLOB), at: NOW - 4_000 });
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a) => void logs.push(a.join(" "))));
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation((c) => (logs.push(String(c)), true));
    const { src } = source();
    const r = await src.fetch({ since: NOW - 60_000, timeout: 1000 }).catch((e) => e);
    for (const s of spies) s.mockRestore();
    errWrite.mockRestore();
    const everything = JSON.stringify({ r, msg: (r as Error).message, hint: (r as { hint?: string }).hint, logs, status: src.status() });
    expect(everything).not.toContain("MARKER-");
    expect(everything).not.toContain("reply with your password");
  });
});
