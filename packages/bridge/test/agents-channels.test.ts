// P3 channel route (spec AD9, spike §2): detecting that the agent process loaded TabAgent as a channel,
// from its argv (`ps -o args=`), and the channel-permission method filter. Pure, over an injected reader.
import { describe, expect, it } from "vitest";
import { channelEntries, channelName, channelsFlag, isChannelPermissionMethod, loadsChannel, parseArgsLine, splitArgs, CHANNEL_MIN_CLAUDE_VERSION, DEFAULT_CHANNEL_NAME } from "../src/agents/channels";

describe("splitArgs", () => {
  it.each([
    ["claude --channels server:tabagent", ["claude", "--channels", "server:tabagent"]],
    ['claude --channels "server:a, server:tabagent"', ["claude", "--channels", "server:a, server:tabagent"]],
    ["claude --channels 'server:tabagent'", ["claude", "--channels", "server:tabagent"]],
    ['claude --x ""  y', ["claude", "--x", "", "y"]],
    ["  claude\t--a\n", ["claude", "--a"]],
    ["", []],
  ])("%j", (line, argv) => {
    expect(splitArgs(line)).toEqual(argv);
  });
});

describe("channel entries in argv (AD9)", () => {
  const T: [string, string, boolean][] = [
    ["flag absent", "claude --profile full", false],
    ["flag absent, server named elsewhere", "claude --mcp-config server:tabagent", false],
    ["other servers only", "claude --dangerously-load-development-channels server:other", false],
    ["server:tabagent (dev flag)", "claude --dangerously-load-development-channels server:tabagent", true],
    ["server:tabagent (--channels)", "claude --channels server:tabagent", true],
    ["plugin:tabagent@market", "claude --channels plugin:tabagent@market", true],
    ["plugin without a marketplace", "claude --channels plugin:tabagent", false],
    ["plugin with an empty marketplace", "claude --channels plugin:tabagent@", false],
    ["prefix is not a match", "claude --channels server:tabagent2", false],
    ["= form", "claude --dangerously-load-development-channels=server:tabagent", true],
    ["= form, other server", "claude --channels=server:other", false],
    ["comma list", "claude --channels server:a,server:tabagent", true],
    ["space list", "claude --channels server:a server:tabagent --resume", true],
    ["quoted list", 'claude --channels "server:a, server:tabagent"', true],
    ["single-quoted list", "claude --channels 'plugin:x@y,plugin:tabagent@official'", true],
    ["the list stops at the next flag", "claude --channels server:a --other server:tabagent", false],
    ["the list stops at a prompt word", "claude --channels server:a fix server:tabagent", false],
    ["two flags, the second names us", "claude --channels server:a --dangerously-load-development-channels server:tabagent", true],
    ["after a bare --, nothing counts", "claude -- --channels server:tabagent", false],
    ["flag with no value", "claude --channels", false],
    ["full path to claude and a node wrapper", "/usr/local/bin/node /opt/claude/cli.js --dangerously-load-development-channels server:tabagent", true],
  ];
  it.each(T)("%s", (_name, line, want) => {
    expect(loadsChannel(line)).toBe(want);
  });
  it("lists every entry, in order", () => {
    expect(channelEntries("claude --channels server:a,server:b plugin:c@d --x --channels=server:e")).toEqual(["server:a", "server:b", "plugin:c@d", "server:e"]);
  });
  it("matches a configured server name instead of tabagent", () => {
    expect(loadsChannel("claude --channels server:browser", "browser")).toBe(true);
    expect(loadsChannel("claude --channels plugin:browser@m", "browser")).toBe(true);
    expect(loadsChannel("claude --channels server:tabagent", "browser")).toBe(false);
  });
});

describe("channelName (TABAGENT_CHANNEL_NAME)", () => {
  it("defaults to tabagent", () => {
    expect(DEFAULT_CHANNEL_NAME).toBe("tabagent");
    expect(channelName({})).toBe("tabagent");
  });
  it("uses a valid configured name", () => {
    expect(channelName({ TABAGENT_CHANNEL_NAME: "browser" })).toBe("browser");
    expect(channelName({ TABAGENT_CHANNEL_NAME: " my-tab_agent.2 " })).toBe("my-tab_agent.2");
  });
  it("ignores an empty or malformed name", () => {
    for (const v of ["", "a,b", "a b", "server:x", "x".repeat(65)]) expect(channelName({ TABAGENT_CHANNEL_NAME: v })).toBe("tabagent");
  });
});

describe("channelsFlag (AD9: the proxy's x-tabagent-channels)", () => {
  const reader = (rows: Record<number, string | null>) => {
    const asked: number[] = [];
    return {
      asked,
      read: async (pid: number) => {
        asked.push(pid);
        return rows[pid] ?? null;
      },
    };
  };
  it('"1" when the agent process argv loads this server as a channel', async () => {
    const r = reader({ 42: "claude --dangerously-load-development-channels server:tabagent" });
    expect(await channelsFlag(42, r.read)).toBe("1");
    expect(r.asked).toEqual([42]);
  });
  it('"0" without the flag, for another name, or with a configured name that does not match', async () => {
    const r = reader({ 42: "claude --channels server:other", 43: "claude", 44: "claude --channels server:tabagent" });
    expect(await channelsFlag(42, r.read)).toBe("0");
    expect(await channelsFlag(43, r.read)).toBe("0");
    expect(await channelsFlag(44, r.read, "browser")).toBe("0");
  });
  it('"0" with no agent pid (never asks ps), a vanished pid, or a failing ps', async () => {
    const r = reader({});
    expect(await channelsFlag(undefined, r.read)).toBe("0");
    expect(r.asked).toEqual([]);
    expect(await channelsFlag(9, r.read)).toBe("0");
    expect(await channelsFlag(9, async () => Promise.reject(new Error("no ps")))).toBe("0");
  });
});

describe("parseArgsLine (ps -o args=)", () => {
  it("first line, trimmed; empty output is null", () => {
    expect(parseArgsLine("  claude --channels server:tabagent  \n")).toBe("claude --channels server:tabagent");
    expect(parseArgsLine("\n")).toBeNull();
    expect(parseArgsLine("")).toBeNull();
  });
});

describe("channel permission methods (AD9: never relayed)", () => {
  it.each([
    ["notifications/claude/channel/permission_request", true],
    ["notifications/claude/channel/permission", true],
    ["claude/channel/permission_request", true],
    ["notifications/claude/channel", false],
    ["notifications/initialized", false],
    ["tools/call", false],
  ])("%s -> %s", (m, want) => {
    expect(isChannelPermissionMethod(m)).toBe(want);
  });
});

it("records the minimum Claude Code version that delivered channel pushes in the P0 spike", () => {
  expect(CHANNEL_MIN_CLAUDE_VERSION).toBe("2.1.332");
});
