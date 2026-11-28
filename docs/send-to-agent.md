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
  working the header says **Working…** and a typing indicator shows at the bottom; it clears as soon as
  the agent's final reply for the turn arrives.
- **Switching sessions.** Wide windows list every session in a rail on the left. On narrow windows the
  session title in the header is a button that opens the same list (arrow keys, **Enter** to switch,
  **Esc** to close).
- **Sending.** Type in the box at the bottom. **Enter** sends, **Shift+Enter** starts a new line.
  **Share a tab** optionally includes one of your open tabs (its title and link; a session that can use
  the browser also gets the tab itself). Your message shows at once as *Sending…*, then *Sent · waiting
  for the agent* (instant) or *Waiting for its next browser action*, and it settles into the
  conversation once the agent has received it. A message that could not be sent stays, with **Edit and
  resend**. With the box empty, **↑** puts the last message you sent from this page back in the box to
  edit; sending it sends a new message (the earlier one stays as it was), and **Esc** cancels.
- **Not connected.** The message box is replaced by a card. If the session runs with Remote Control,
  **Open in Claude** is the main button. The card also explains how to connect the session to TabAgent,
  and offers **Start a new session in \<folder\>**.
- **Codex.** History isn't available for Codex threads yet; sending still queues the message.
- **Live view.** When a connected session has tabs, a **Live view** strip sits above the message box and
  shows the tab it is using, live. With several tabs, pick one; click the picture (or **Larger**) for a
  bigger view; collapse the strip to stop it. It is view-only: nothing you do on it reaches the page.
  Side panel rows and the rail show **Working in browser** (with the tab's title) while the session runs
  a browser command or ran one in the last 10 seconds, and the number of its tabs otherwise.

The conversation is read from Claude Code's own transcript (`~/.claude/projects/…/<session>.jsonl`) by
your local TabAgent bridge, only for sessions it lists, and only shown in TabAgent's own extension pages.
It is never sent over the bridge's HTTP API, logged or written to the audit log.

The live view is a Chrome DevTools screencast of the session's own tab, made by the extension and shown
only in its chat page. Frames never go to the bridge, to disk, to logs or to the audit log. Only tabs the
session owns are shown, never your other tabs, and never password-manager, Google account, mail or
browser pages (it stops as soon as the tab goes to one). Sites in Lite mode are not shown, since Lite
mode does not use the debugger.

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
   shows a **linked** badge and says **Connected**.

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

For a Claude Code session that is not connected, the chat page's card has a separate **Start a new
session in \<folder\>** button (connected sessions only offer **Send**, and Send never starts one). It
starts a new background session (`claude --bg`) in that session's folder with your message as its first
prompt. The feed line says where it started and how to
attach to it, for example `claude attach 1a2b3c4d`. Claude Code refuses to start a background session in
a folder whose trust prompt you have never accepted; run `claude` there once first.
