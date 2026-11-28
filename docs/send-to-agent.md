# Send to agent

The **Agents** section of the TabAgent side panel lists the Claude Code and Codex sessions running on
your machine. **Click a session to open it as a chat**: a page with the whole conversation, the
agent's replies as they happen, and a message box at the bottom. **Quick send** on a row opens a small
composer right under it, for a one-off message without leaving the panel. The design is in
[specs/agent-inbox.md](specs/agent-inbox.md).

Each row shows the session's title (the name you gave it with `/rename`, else the title Claude Code
generated), then its folder, how long it has been running and its process id, and how it can be reached:

| Row says | What sending does |
|---|---|
| Connected · instant | The message is pushed to the session right away (channels, see below). |
| Connected · on next browser action | The message is attached to the session's next successful TabAgent tool result. |
| Codex · queued | The message is queued on the Codex thread and starts a turn when the thread is free. |
| Remote Control only | TabAgent can't message it, but **Open in Claude ↗** opens the live session in Claude's own web UI. See [Remote Control](#remote-control). |
| Not connected | Nothing. See [Connect a session](#connect-a-session). |

Sessions that are not connected, have no Remote Control and have no title are collapsed under
**N other sessions**.

## The chat page

Clicking a session opens `chat.html` in a new tab (or switches to it if it is already open).

- **History.** Your messages and the agent's replies are chat bubbles; code blocks, lists and links are
  formatted. Each tool call is one line (for example `🔧 Bash: npm test`); click it to see what it ran
  and the result. Messages you sent from TabAgent are labelled **via TabAgent**. The newest 200 entries
  load first; **Load earlier messages** goes further back.
- **Live replies.** New entries appear within about a second of Claude Code writing them. If you have
  scrolled up, a **New messages ↓** button appears instead of the page jumping. While the agent is
  working the header says **Working…** and a typing indicator shows at the bottom.
- **Sending.** Type in the box at the bottom. **Enter** sends, **Shift+Enter** starts a new line.
  **Share a tab** optionally includes one of your open tabs (its title and link; a session that can use
  the browser also gets the tab itself). Your message shows at once as *Sending…*, then *Sent · waiting
  for the agent* (instant) or *Waiting for its next browser action*, and it settles into the
  conversation once the agent has received it. A message that could not be sent stays, with **Edit and
  resend**.
- **Not connected.** The message box is replaced by a card. If the session runs with Remote Control,
  **Open in Claude** is the main button. The card also explains how to connect the session to TabAgent,
  and offers **Start a new session in \<folder\>**.
- **Codex.** History isn't available for Codex threads yet; sending still queues the message.

The conversation is read from Claude Code's own transcript (`~/.claude/projects/…/<session>.jsonl`) by
your local TabAgent bridge, only for sessions it lists, and only shown in TabAgent's own extension pages.
It is never sent over the bridge's HTTP API, logged or written to the audit log.

## Remote Control

A Claude Code session started with `--remote-control` can be opened in Claude's web UI at
`https://claude.ai/code/<session>`, with the full history and live replies, and you can type into it.
TabAgent finds that link in `~/.claude/sessions/<pid>.json` and shows **Open in Claude ↗** on the row and
in the chat page header. It works for sessions that are not connected to TabAgent, with no restart, and
it opens in a normal tab under your own claude.ai login.

## Connect a session

A Claude Code session can only get messages from TabAgent when its own `tabagent mcp` server has
connected back to the TabAgent bridge. Until then the row says **Not connected** (or **Remote Control
only**). To connect it:

1. **Update TabAgent.** The session's `tabagent mcp` has to be a version that links to the bridge (the
   first release after 0.1.0). With the documented install, `npx -y @nolmak/tabagent mcp` fetches the
   latest version when the session starts. If you installed it globally, run
   `npm i -g @nolmak/tabagent@latest`. Restart `tabagent serve` too, so the bridge and the extension match.
2. **Restart the session.** A session started before the update keeps running the old `tabagent mcp`.
   Quit it and start it again (`claude --resume` keeps the conversation). Within a few seconds the row
   shows a **linked** badge and says **Connected**.

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

For a Claude Code session, Quick send and the chat page's not-connected card have a separate **Start a
new session in \<folder\>** button. It never runs when you press Send. It starts a new background session (`claude --bg`) in that
session's folder with your message as its first prompt. The feed line says where it started and how to
attach to it, for example `claude attach 1a2b3c4d`. Claude Code refuses to start a background session in
a folder whose trust prompt you have never accepted; run `claude` there once first.
