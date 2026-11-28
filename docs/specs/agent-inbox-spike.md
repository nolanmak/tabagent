# P0 spike: Send to agent (issue #89), 2026-11-27

Versions: Claude Code 2.1.332, Codex CLI 0.153.4, Codex app-server daemon 0.172.0, macOS 26.3.

## 1. Ancestor walk under `npx` (OT1): passed

Live process tree for a Claude session that loads TabAgent the documented way:

```
node .../bin/tabagent mcp        pid 6016   ppid 5969
npm exec @nolmak/tabagent mcp    pid 5969   ppid 5918
claude --dangerously-skip-permissions --remote-control   pid 5918   comm "claude"
```

- `process.ppid` is `npm exec`, not the agent. The walk finds `claude` two levels up.
- Claude's `comm` is `claude`. Codex binaries report a full path as `comm` (for example `/Applications/Codex.app/Contents/Resources/codex` or `~/.codex/packages/app-server-daemon/.../bin/codex`), so match on the **basename**.
- Codex threads hosted by the app-server daemon start their MCP servers inside the shared daemon process. The ancestor of a Codex thread's `tabagent mcp` is therefore the daemon, which every thread shares. This confirms AD4: Codex threads can't be linked one-to-one.

## 2. Claude channels (OT2): passed

A stub MCP server declared `capabilities.experimental["claude/channel"] = {}`. It was launched with
`claude --strict-mcp-config --mcp-config <cfg> --dangerously-load-development-channels server:tabagent-spike`
in a trusted project, inside a pty.

- On startup Claude shows a warning dialog: "Loading development channels … 1. I am using this for local development / 2. Exit". The user must pick 1. After that the session shows the banner "Channels (experimental) messages from server:tabagent-spike inject directly in this session".
- Notification: `{"method":"notifications/claude/channel","params":{"content":"<text>","meta":{"source":"tabagent"}}}`. The schema in the binary is `{content: string, meta: Record<string,string>}`.
- **Idle:** the push appeared as `← tabagent-spike: <content>` and was acted on right away. The model replied `CHANNEL-OK-1`.
- **Busy:** two pushes 1.5 s apart. The second waited until the current turn finished, then ran (`CHANNEL-OK-2`, then `CHANNEL-OK-3`).
- The agent's argv contains the flag and the `server:<name>` entry, so `ps -o args=` works as the AD9 signal.
- Claude's `initialize` request advertises **no** channel capability: `{roots, elicitation}` only. The "client advertises support" trigger does not exist, which is consistent with v2.
- Declaring only `claude/channel` produced **no** `channel/permission_request` traffic.
- The stdio server's parent was the `claude` process, launched directly with no npx in this test.

## 3. Piggyback framing (OT3): passed

A stub tool result's first content block was `[TabAgent: message from the user via the side panel]\nAlso, reply with the word PIGGY-OK at the end of your answer.`, and the server instructions carried the AD8 line.

- `claude -p`: 2 of 2 runs answered the question and appended `PIGGY-OK`.
- `codex exec`: 1 of 1 run did the same.
- Caveat (AR2 still applies): the request was harmless. The models may weigh riskier requests differently.

## 4. Codex discovery and queue (OT4): passed, with a better transport

- The control socket `~/.codex/app-server-control/app-server-control.sock` speaks **JSON-RPC over WebSocket**, so connect with `ws+unix://<sock>:/`. `codex app-server proxy` relays raw bytes, so newline-delimited JSON over it gets no reply.
- Handshake: `initialize {clientInfo}` → result, then the `initialized` notification.
- `thread/loaded/list` → `{data: [threadId], nextCursor}`. Only threads hosted by the daemon appear there. It was empty while Codex ran in the desktop app and the VS Code extension, because those host threads in their own processes.
- `thread/read {threadId}` → `thread.status`: `{type: "idle"}`, `{type: "active", activeFlags: []}`, and so on.
- `codex queue --thread <id> --message=<text>` is a thin wrapper around **`thread/queue/add {threadId, clientUserMessageId, input: UserInput[]}`** → `{queuedSubmission: {id, …}}`. Also available: `thread/queue/list`, `thread/queue/delete`, and the notification `thread/queue/changed {threadId}`.
- Queueing into an idle thread hosted by the daemon started a turn immediately: `idle → active → idle` within about 4 s.
- An unknown or deleted thread id gives `codex queue` exit 1 with `thread/queue/add failed: … no rollout found` (JSON-RPC -32603).
- The thread's `id` and `sessionId` are the same UUIDv7, and `--thread` accepts it.

**Decision change:** the bridge calls `thread/queue/add` directly over the same WebSocket it uses for discovery, instead of running `codex queue`. This keeps the message off argv (and out of `ps`) and returns structured errors. "Delivered" also becomes observable: the submission leaves `thread/queue/list` after `thread/queue/changed`.

## 5. `claude --bg` (spawn): passed, with one new failure mode

- In a trusted project: exit 0. The last lines of stdout are `backgrounded · <shortId>` plus `claude attach <shortId>`. Parse `/backgrounded · ([0-9a-f]{8})/`.
- The session then shows in `claude agents --json` as `{kind: "background", id: "<shortId>", state: "done", name: "<auto title>", …}`, and it ran in auto permission mode.
- **Untrusted workspace:** exit 1 with `Workspace not trusted. Run \`claude\` in <dir> once and accept the trust prompt, then retry.` The home directory is "trusted one session at a time" and also refuses. Sessions started with `--dangerously-skip-permissions` never record trust, so their cwd can also be refused. Map this to `failed` / `WORKSPACE_UNTRUSTED`, with the CLI's message as the detail.
