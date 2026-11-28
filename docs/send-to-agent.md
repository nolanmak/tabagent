# Send to agent

The **Agents** section of the TabAgent side panel lists the Claude Code and Codex sessions running on
your machine. Pick one, type a message, and press **Send**. The design is in
[specs/agent-inbox.md](specs/agent-inbox.md).

Each row shows the session's title (the name you gave it with `/rename`, else the title Claude Code
generated), then its folder, how long it has been running and its process id.

| Row says | What Send does |
|---|---|
| on its next browser action | The message is attached to the session's next successful TabAgent tool result. |
| instant | The message is pushed to the session right away (channels, see below). |
| queued (Codex) | The message is queued on the Codex thread and starts a turn when the thread is free. |
| Not connected — can't message this session | Nothing. Send is disabled. See [Connect a session](#connect-a-session). |

Sessions that are not connected and have no title are collapsed under **N other sessions**.

## Connect a session

A Claude Code session can only get messages from the side panel when its own `tabagent mcp` server has
connected back to the TabAgent bridge. Until then the row says **Not connected — can't message this
session**. To connect it:

1. **Update TabAgent.** The session's `tabagent mcp` has to be a version that links to the bridge (0.2.0 or
   later). With the documented install, `npx -y @nolmak/tabagent mcp` fetches the
   latest version when the session starts. If you installed it globally, run
   `npm i -g @nolmak/tabagent@latest`. Restart `tabagent serve` too, so the bridge and the extension match.
2. **Restart the session.** A session started before the update keeps running the old `tabagent mcp`.
   Quit it and start it again (`claude --resume` keeps the conversation). Within a few seconds the row
   shows a **linked** badge and Send works.

Linked sessions get a message on their next browser action. For **instant** delivery, start Claude
Code with channels enabled:

```bash
claude --dangerously-load-development-channels server:tabagent
```

Channels are optional and experimental; see
[Instant delivery to Claude Code](../README.md#instant-delivery-to-claude-code-experimental) for the
details. Without them messages still arrive, just on the next tool call.

Codex threads hosted by the Codex app-server do not need linking; their messages are queued.

## Start a new session instead

For a Claude Code session, the composer also has a separate **Start a new session in \<folder\>**
button. It never runs when you press Send. It starts a new background session (`claude --bg`) in that
session's folder with your message as its first prompt. The feed line says where it started and how to
attach to it, for example `claude attach 1a2b3c4d`. Claude Code refuses to start a background session in
a folder whose trust prompt you have never accepted; run `claude` there once first.
