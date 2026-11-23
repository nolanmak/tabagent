# TabAgent — Design

TabAgent is an open-source Chrome extension plus a small local bridge that lets
any AI agent (Claude Code, Codex, Cursor, custom agents over MCP or HTTP) drive
the user's real Chrome: open tabs, read pages, pull structured data, fill and
submit forms, upload/download files, watch network and console, and run JS —
everything a browser agent needs, with the user's own sign-ins, under a
permission model the user controls.

## Goals

1. **Agent-agnostic.** One install serves every agent. Primary interface is MCP
   (stdio and Streamable HTTP); a plain JSON-over-HTTP API and a CLI cover
   agents without MCP.
2. **Real browser, real sessions.** Works in the user's everyday Chrome profile,
   so agents can act on sites the user is already logged into.
3. **Token-efficient page understanding.** Default observation is a compact,
   ref-annotated accessibility snapshot, not raw HTML or screenshots.
4. **Reliable actions.** Trusted input events via the Chrome DevTools Protocol,
   auto-waiting, stable element refs, and actionable error messages.
5. **Safe by default.** Per-site permissions, confirmation for sensitive
   actions, visible "agent is driving" indicators, isolated tab groups per
   agent, an audit log, and a kill switch.
6. **Multi-agent.** Several agents connected at once, each in its own session
   and tab group, without stepping on each other.

## Non-goals (v1)

- Headless/cloud browsers (use Playwright for that).
- Firefox/Safari (MV3 Firefox port is a later milestone).
- Built-in LLM. TabAgent is the hands and eyes; the agent is the brain.
- CAPTCHA solving or bot-detection evasion.

## Architecture

```
 ┌──────────────┐  MCP stdio   ┌───────────────────────────┐   WebSocket    ┌──────────────────────────┐
 │ Claude Code  │─────────────▶│                           │  (127.0.0.1,   │  Chrome extension (MV3)  │
 ├──────────────┤  MCP HTTP    │   tabagent bridge        │   paired token)│                          │
 │ Codex / etc. │─────────────▶│   (Node daemon)           │◀──────────────▶│  service worker          │
 ├──────────────┤  REST + CLI  │   - session manager       │                │   ├ command router       │
 │ scripts/curl │─────────────▶│   - auth / pairing        │                │   ├ CDP driver           │
 └──────────────┘              │   - audit log             │                │   │  (chrome.debugger)   │
                               └───────────────────────────┘                │   ├ permission engine    │
                                                                            │   └ tab-group sessions   │
                                                                            │  content scripts         │
                                                                            │   ├ a11y snapshot + refs │
                                                                            │   ├ extractors           │
                                                                            │   └ overlay / highlight  │
                                                                            │  side panel UI           │
                                                                            └──────────────────────────┘
```

### Why a bridge process?

An MV3 extension cannot listen on a port, and agents speak MCP over stdio or
HTTP. The bridge is the server; the extension is a client that dials out to
`ws://127.0.0.1:<port>`. Keeping the bridge thin (routing, auth, sessions, logs)
keeps all browser logic in the extension.

- `npx tabagent mcp` — stdio MCP server. If a daemon is already running it
  proxies to it; otherwise it starts one in-process. This means each agent
  config is a one-liner.
- `tabagent serve` — long-running daemon: WebSocket for the extension, MCP
  Streamable HTTP at `/mcp`, REST at `/v1`.
- `tabagent <tool> [args]` — CLI wrapper over REST, for shell-only agents.

Native Messaging was considered as the transport. It needs a per-OS host
manifest install and spawns one host per connection, which makes
multi-agent fan-in awkward. It stays as an optional fallback for locked-down
machines, and as a way for the extension to auto-start the daemon.

### MV3 service-worker lifetime

Chrome 116+ keeps a service worker alive while a WebSocket exchanges messages.
The extension sends a heartbeat every 20s and reconnects with backoff. An
offscreen document is the fallback if a Chrome release regresses this.

### Pairing and auth

1. `tabagent serve` prints a one-time pairing code and writes a random bridge
   secret to `~/.tabagent/config.json` (0600).
2. The user enters the code in the extension's side panel. The extension stores
   the bridge secret in `chrome.storage.local`.
3. The WebSocket handshake carries the secret. The bridge binds to 127.0.0.1
   only and rejects any `Origin` other than the extension's ID, so web pages
   cannot reach it.
4. Agents get **per-client tokens** (`tabagent token create --name codex`),
   scoped to a set of capabilities and sites. stdio MCP clients use the local
   config file automatically.

## Sessions and multi-agent isolation

- Each connected client gets a **session**. A session owns a Chrome **tab
  group** with a colour and label (`🤖 claude-code`). By default, tools act only
  on tabs inside the session's group.
- `tabs.attach` can adopt an existing user tab into the session; that always
  asks the user first (see permissions).
- Tab locks: one session at a time drives a given tab, and other sessions get a
  `TAB_BUSY` error.
- When a session ends, its group is collapsed and kept (configurable: close).

## Page understanding

### Snapshot (default observation)

`page.snapshot` returns a pruned accessibility tree as indented text, with a
stable ref on each interactive or landmark node:

```
- banner
  - link "Home" [ref=e1]
  - searchbox "Search" [ref=e2] value=""
- main
  - heading "Checkout" level=1
  - textbox "Email" [ref=e7] required
  - combobox "Country" [ref=e8] value="United States"
  - checkbox "Save card" [ref=e9] checked=false
  - button "Pay $42.00" [ref=e10]
```

- Built from CDP `Accessibility.getFullAXTree`, with a content-script DOM walk
  as fallback (closed shadow roots, odd ARIA).
- Covers iframes, including cross-origin ones through CDP target attach, and
  open shadow DOM.
- Refs map to `backendNodeId` and stay stable across snapshots while the node
  lives. A stale ref returns `REF_STALE` with a hint to re-snapshot.
- Options: `mode: interactive|full`, `root: ref`, `maxTokens`, `diff: true`
  (only what changed since the last snapshot).

### Other observations

- `page.screenshot` — viewport, full page, or element; optional ref labels
  drawn on the image ("set-of-marks") for vision models.
- `page.text` / `page.markdown` — readable content (Readability-style).
- `page.find` — locate by text, role, label, CSS, or XPath and get refs back.

## Tool surface (MCP + REST)

All tools take an optional `tabId`; the default is the session's active tab.

| Group | Tools |
|---|---|
| Tabs | `tabs.list`, `tabs.new`, `tabs.select`, `tabs.close`, `tabs.attach` |
| Navigation | `nav.goto`, `nav.back`, `nav.forward`, `nav.reload`, `nav.wait` (load / networkidle / selector / text / url / fn) |
| Observe | `page.snapshot`, `page.screenshot`, `page.text`, `page.markdown`, `page.find` |
| Act | `act.click`, `act.dblclick`, `act.hover`, `act.type`, `act.fill`, `act.press`, `act.select`, `act.check`, `act.scroll`, `act.drag`, `act.upload` |
| Forms | `form.describe` (fields, labels, types, required, current values), `form.fill` (map of label/ref → value, in one call), `form.submit` |
| Extract | `extract.table` (→ rows JSON/CSV), `extract.links`, `extract.schema` (a JSON Schema plus a hint; returns matching data with heuristics and selectors), `extract.paginate` (follow "next" up to N pages) |
| Script | `js.eval` (in page or isolated world; gated) |
| Dev | `console.list`, `network.list`, `network.get` (headers and body), `network.waitFor` |
| Files | `downloads.list`, `downloads.wait`, `downloads.read` (via the bridge) |
| Dialogs | `dialog.handle` (alert/confirm/prompt/beforeunload) |
| Storage | `cookies.get`, `storage.get` (local/session; gated) |
| Meta | `session.info`, `session.permissions`, `session.end` |

Every action returns `{ ok, result, snapshotDiff?, navigation?, dialogs?,
downloads? }`, so an agent rarely needs a second call to see what happened.

### Action reliability

- Input goes through CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` /
  `insertText`, which produces trusted events.
- Before each action, auto-wait: the element is attached, visible, stable (no
  animation), enabled, and not covered by another element (hit-test at click
  point). The default timeout is 5s; on failure the agent gets a reason such as
  `covered by <div.modal>`.
- Scroll into view and re-hit-test.
- `act.fill` clears and sets the value with native setter plus input/change
  events, which covers React/Vue controlled inputs.
- `act.upload` uses `DOM.setFileInputFiles`. The bridge stages files from paths
  the agent supplies, within allowed directories only.

### No-debugger mode

`chrome.debugger` shows the "TabAgent started debugging this browser" bar, and
some users or sites dislike it. **Lite mode** uses content scripts only:
synthetic events, DOM-based snapshot, no network bodies. It is selectable per
site and documented as less reliable.

## Permissions and safety

The permission engine runs in the extension, so the bridge can never bypass it.

- **Site policy** per origin: `deny | read | act | full`. The default for
  unknown origins is `ask`. A prompt appears in the side panel: "claude-code
  wants to *act* on github.com — Allow once / Always / Deny".
- **Sensitive actions** always ask unless the user pre-approves them per site:
  - submitting forms that contain password, payment-card, or SSN-like fields
  - clicks on elements matching purchase/delete/send/transfer heuristics
  - `js.eval`, `cookies.get`, `storage.get`, `downloads.read`
  - `tabs.attach` on a user tab
- **Built-in denylist**: `chrome://`, the Web Store, password managers, and
  banking domains (user-editable list) are `deny` until explicitly unlocked.
- **Prompt-injection hygiene**: page content goes back to the agent wrapped and
  labelled as untrusted page data. TabAgent never acts on instructions found in
  pages; that remains the agent's responsibility, and the docs say so.
- **Visibility**: a badge on the toolbar icon, a coloured tab group, an
  optional on-page border with highlighted target elements, and the side panel
  shows a live action feed.
- **Kill switch**: a toolbar button or `Alt+Shift+K` detaches all sessions
  immediately.
- **Audit log**: every command, its caller, and its result are recorded in
  `~/.tabagent/audit.jsonl`. Screenshots are optional, and form values are
  redacted for sensitive fields.

## Repo layout

```
tabagent/
  packages/
    protocol/    # zod schemas for commands/results, shared types, error codes
    extension/   # MV3: background SW, content scripts, side panel (Vite + TS)
    bridge/      # Node daemon + MCP server + REST + CLI (published as `tabagent` on npm)
  examples/      # agent configs (Claude Code, Codex, Cursor), sample tasks
  e2e/           # Playwright-launched Chrome with the unpacked extension + fixture sites
  docs/
```

TypeScript throughout, pnpm workspaces, Vitest for unit tests, Playwright for
e2e (launching Chromium with `--load-extension`).

## Agent setup (target UX)

```bash
npm i -g tabagent && tabagent serve      # once; prints the pairing code
claude mcp add tabagent -- npx tabagent mcp
codex mcp add tabagent -- npx tabagent mcp
```

## Milestones

- **M0 — Skeleton**: monorepo, protocol package, bridge↔extension WebSocket with
  pairing, `tabs.*` and `nav.goto` end to end via MCP.
- **M1 — Core agent loop**: snapshot with refs, click/type/fill/press/select,
  auto-wait, screenshot, sessions and tab groups.
- **M2 — Data and forms**: `form.*`, `extract.*`, markdown, downloads/uploads,
  dialogs.
- **M3 — Safety**: permission engine, prompts, sensitive-action detection,
  kill switch, audit log, side panel feed.
- **M4 — Dev and power tools**: network/console, `js.eval`, iframes and shadow
  DOM, snapshot diffs, set-of-marks screenshots, lite mode.
- **M5 — Ship**: npm publish, Chrome Web Store listing, docs site, examples,
  and a benchmark against WebArena-style tasks.

## Open questions

- Should snapshots include off-screen content by default (more tokens), or only
  the viewport plus a "N more below" hint?
- Should it support a second "agent profile" Chrome window as an alternative to
  the main profile, for users who want isolation over convenience?
- Should the Web Store build ship with `debugger` as an optional permission
  (`optional_permissions`) to ease review?
