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

1. **Run `tabagent setup claude`.** It reads Claude Code's `tabagent` MCP server
   (`claude mcp get tabagent`), shows the command and the TabAgent version it runs, and rewrites it in
   user scope to `npx -y @nolmak/tabagent@latest mcp`, the first kind of entry that always links to the
   bridge. Your `--profile`, other arguments and environment are kept.

   ```bash
   npx -y @nolmak/tabagent@latest setup claude            # or: tabagent setup claude
   tabagent setup claude --profile core,auth              # change the profile while at it
   tabagent setup claude --dry-run                        # print the claude mcp commands, change nothing
   ```

   `--scope project|local` writes that Claude Code scope instead of `user`. `--local` points the entry at
   this git checkout's `packages/bridge/dist/cli.js` (for TabAgent development). `--channels` also checks
   your Claude Code version for instant delivery and prints a line that saves the alias below to your
   shell startup file. `tabagent setup codex` does the same for Codex. If you installed TabAgent
   globally, also run `npm i -g @nolmak/tabagent@latest` and restart `tabagent serve`, so the bridge and
   the extension match.
2. **Restart the session.** A session started before the update keeps running the old `tabagent mcp`.
   Quit it and start it again (`claude --resume` keeps the conversation). Within a few seconds the row
   shows a **linked** badge and Send works.

To set it up by hand instead: `claude mcp remove tabagent`, then
`claude mcp add tabagent -s user -- npx -y @nolmak/tabagent@latest mcp`.

Linked sessions get a message on their next browser action. For **instant** delivery, start Claude
Code with channels enabled (Claude Code asks once to allow a "local development" channel; accept it):

```bash
claude --dangerously-load-development-channels server:tabagent
alias claude-tab='claude --dangerously-load-development-channels server:tabagent'   # optional shortcut
```

Channels are optional and experimental; see
[Instant delivery to Claude Code](../README.md#instant-delivery-to-claude-code-experimental) for the
details. Without them messages still arrive, just on the next tool call. Sessions started with
`claude --remote-control` can also be opened from the panel via Remote Control.

Codex threads hosted by the Codex app-server do not need linking; their messages are queued.

## Start a new session instead

For a Claude Code session, the composer also has a separate **Start a new session in \<folder\>**
button. It never runs when you press Send. It starts a new background session (`claude --bg`) in that
session's folder with your message as its first prompt. The feed line says where it started and how to
attach to it, for example `claude attach 1a2b3c4d`. Claude Code refuses to start a background session in
a folder whose trust prompt you have never accepted; run `claude` there once first.
