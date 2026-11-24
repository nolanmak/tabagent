# TabAgent — Design

TabAgent is an open-source Chrome extension plus a small local bridge that lets
any AI agent (Claude Code, Codex, Cursor, custom agents over MCP or HTTP) drive
the user's real Chrome: open tabs, read pages, pull structured data, fill and
submit forms, upload/download files, watch network and console, and run JS,
with the user's own sign-ins, under a permission model the user controls.

This document folds in the decisions from the 2026-11-22 spec audit (roadmap
#28, cited as **D1–D40**). Where an issue and this document disagree, the
decision in #28 wins. Open threads (**OT1–OT8**) are listed at the end with
their current state.

## Goals

1. **Agent-agnostic.** One install serves every agent. Primary interface is MCP
   (stdio and Streamable HTTP); a REST API and a CLI cover agents without MCP.
2. **Real browser, real sessions.** Works in the user's everyday Chrome profile.
3. **Token-efficient page understanding.** The default observation is a compact,
   ref-annotated accessibility snapshot, not raw HTML or screenshots.
4. **Reliable actions.** Trusted input via the Chrome DevTools Protocol,
   auto-waiting, stable element refs, actionable errors.
5. **Safe by default.** Per-site permissions, confirmation for sensitive
   effects, visible "agent is driving" indicators, a tab group per agent, an
   audit log and a kill switch.
6. **Multi-agent.** Several agents at once, each in its own session and tab
   group, without stepping on each other.

## Non-goals (v1)

- Headless/cloud browsers (use Playwright for that). Firefox/Safari.
- A built-in LLM. TabAgent has no model and interprets nothing (D21).
- CAPTCHA solving or bot-detection evasion.
- Native Messaging transport and an extension-started daemon. *Trigger: a user
  whose machine blocks loopback WebSocket.*
- Offscreen-document keepalive. *Trigger: the heartbeat e2e test goes red on a
  Chrome release.*
- More than one connected extension, a second "agent profile" window,
  incognito. *Trigger: demand for isolation over convenience.*
- Screenshots in the audit log; closed shadow roots in lite mode; non-English
  sensitive-click heuristics; `extract.schema` as a general-purpose extractor.

## Architecture

```
 ┌──────────────┐  MCP stdio   ┌───────────────────────────┐   WebSocket    ┌──────────────────────────┐
 │ Claude Code  │─────────────▶│                           │  127.0.0.1     │  Chrome extension (MV3)  │
 ├──────────────┤  MCP HTTP    │   tabagent bridge         │  hello/welcome │                          │
 │ Codex / etc. │─────────────▶│   (Node daemon)           │◀──────────────▶│  service worker          │
 ├──────────────┤  REST + CLI  │   - sessions, auth        │                │   ├ router + authorize() │
 │ scripts/curl │─────────────▶│   - untrusted wrapping    │                │   ├ Driver: CDP | lite   │
 └──────────────┘              │   - audit log, file I/O   │                │   ├ permission engine    │
                               └───────────────────────────┘                │   └ tab-group sessions   │
                                                                            │  content scripts         │
                                                                            │   ├ extractors, overlay  │
                                                                            │   └ lite-mode DOM walker │
                                                                            │  side panel UI           │
                                                                            └──────────────────────────┘
```

An MV3 extension cannot listen on a port and agents speak MCP over stdio or
HTTP, so the bridge is the server and the extension dials out. The bridge stays
thin: routing, auth, sessions, wrapping, audit and local file I/O. Browser logic
lives in the extension.

### Trust boundary (D1)

The bridge is trusted for *who is calling*; the extension sees a single socket
and cannot verify caller identity. The extension is the **only** enforcement
point for site policy and sensitive gates. The bridge is a second enforcement
point for local file I/O only (D31). Client tokens are least-privilege, not a
sandbox (D3). See [SECURITY.md](SECURITY.md).

### Processes

- `tabagent serve` — the daemon: WebSocket for the extension, MCP Streamable
  HTTP at `/mcp`, REST at `/v1`, health at `/v1/health`.
- `tabagent mcp` — stdio MCP server. It **never hosts the daemon in-process**
  (D6): if `/v1/health` does not answer it spawns a detached `tabagent serve`
  and proxies to it, so the first agent's exit does not kill other agents'
  sessions. Only MCP frames go to stdout; the pairing code goes to stderr and
  is shown by `tabagent status`. Unpaired calls return `NO_EXTENSION` with the
  pairing hint.
- `tabagent <tool> --json '{…}'` — CLI over REST; scalar flags (`--url x`) are
  generated sugar (D30).

### Ports, pairing and auth (D2, D4, D5, D7)

- Default port `47615`; override with `TABAGENT_PORT` or `config.json`; the
  extension's pairing screen has a port field.
- The extension opens the WebSocket and sends
  `hello {protocolVersion, extensionVersion, secret?, pairCode?}`.
  - **Unpaired:** a valid pair code (one-time, 30-minute TTL, invalidated after
    5 wrong attempts; `tabagent pair` mints a new one) is accepted; the bridge
    records the extension ID in `config.json.extensionIds` and replies
    `welcome {protocolVersion, bridgeVersion, secret}`.
  - **Paired:** hello must carry the secret and come from a recorded extension ID.
  - One extension connection: a reconnect from the same ID replaces the old
    socket; a different ID while one is connected is refused with a message
    naming the cause. Incognito is off.
- `protocolVersion` is in hello/welcome; a mismatch returns `VERSION_MISMATCH`
  with a hint saying which side to update (npm and the Web Store update on
  different schedules).
- The extension stores the secret in `chrome.storage.local` with
  `setAccessLevel('TRUSTED_CONTEXTS')`, so content scripts cannot read it.
- **HTTP auth from M0.** Every `/mcp` and `/v1` request needs
  `Authorization: Bearer <secret-or-token>`. A browser `Origin` other than the
  paired `chrome-extension://<id>` is rejected, and `Host` must be `127.0.0.1`
  or `localhost` with the bridge port (DNS-rebinding defence).
- stdio MCP and the CLI authenticate with the secret from `config.json` and get
  cap `full` with no site limit; the caller name is MCP `clientInfo.name`
  (fallback `local`). `tabagent token create --name codex --caps act --sites
  '*.github.com'` narrows a client that chooses to use a token. Tokens are
  stored hashed; `tabagent token list|revoke` exist (D3).

### Service-worker lifetime and state (D11)

- Heartbeat: the extension sends `ping` every 20s, the bridge answers `pong`,
  and closes a socket silent for 45s, failing its in-flight commands with
  `NO_EXTENSION`.
- With no socket open the worker can be evicted, so reconnect is driven by a
  `chrome.alarms` alarm every 30s, not only by `setTimeout` backoff.
- `chrome.storage.session`: sessions, tab ownership, allow-once grants, paused
  flag, per-tab ref counter. `chrome.storage.local`: secret, site policies,
  settings. Lost on restart: the ref table, diff baselines, network/console
  buffers; after a restart every old ref returns `REF_STALE`.

### Where settings live (D32)

- Bridge `config.json` (directory overridable with `TABAGENT_HOME`): port,
  secret, extensionIds, tokens, uploadDirs, maxReadBytes.
- Extension `chrome.storage.local`: per-origin site entries (policy, lite mode,
  pre-approvals), denylist edits, session-end behaviour (default collapse and
  keep), `beforeunload` policy (default accept), on-page border (default on),
  `devAllowSensitive` (default off).

## Sessions and tabs (D8–D10, D12)

- **Identity (D8).** The bridge allocates session id and label and sends them in
  every Command (`session: {id, label, cap, sites}`). One session per MCP
  connection; REST/CLI get one per credential name plus optional
  `--session <name>`, expiring after 30 minutes idle or on `session.end`.
  Label = token name, else `clientInfo.name`, else `local`. The tab group is
  created lazily on the session's first new tab.
- **Ownership (D9).** A tab belongs to at most one session (map in the
  extension, persisted in `chrome.storage.session`). Tools act only on tabs the
  session owns; there is no override, and another session's tab returns
  `TAB_BUSY`. Commands from one session to one tab run serially. `tabs list`
  shows only the session's tabs. `tabs attach` with no `tabId` adopts the user's
  active tab in the last-focused window; it always prompts and cannot be
  pre-approved. An attached tab joins the group and on session end is ungrouped
  and left open, never closed. Popups and `target=_blank` tabs opened by a
  session tab join that session; a tab the user drags out of the group leaves it.
- **Active tab and focus (D10).** The session's active tab is the one it last
  created or selected; with none, tab tools return `NOT_FOUND` with hint "call
  tabs new". `tabs select` changes the session's active tab only. TabAgent never
  brings a tab or window to the front.
- **Background tabs (OT1, answered).** CDP input, auto-wait and screenshots work
  on background tabs in headed Chrome without focusing them, so several agents
  can drive tabs in one window. Headless Chromium needed a fix for `act.type` on
  background tabs (in progress in the driver work, #7).
- **Kill switch (D12).** Toolbar, side panel or `Alt+Shift+K` enters a paused
  state: in-flight commands abort with `KILLED`, pending prompts drop, the
  debugger detaches from every tab and allow-once grants clear. Tab groups and
  stored policies stay. Every later command returns `KILLED` until the user
  clicks Resume. Kill and resume reach the bridge as audit events.

## Protocol (D13–D15, D30)

- **Registry.** `packages/protocol` holds one entry per exposed tool (D13):
  `name`, `group`, `description`, `params` (zod), `result` (zod), `level`,
  `sensitive` (D18 category), `actions` (per-action level/sensitivity, only for
  `tabs`), `pageContent` (page-derived result fields, D21), `profiles` (D29),
  `lite` (D26), `handledBy` (`extension|bridge|both`). The MCP tool list, REST
  routes, CLI commands, extension handler table and the
  [tool reference](tools.md) are generated from it.
- **Names.** MCP names must match `^[a-zA-Z0-9_-]{1,64}$`, so dots become
  underscores on the wire (`nav.goto` → `nav_goto`). REST, CLI and audit use the
  registry name plus `action`.
- **Command:** `{type:"command", id, session:{id,label,cap,sites}, tool, params}`.
- **Result envelope (D14):**
  `{type:"result", id, ok, result?, error?:{code,message,hint?}, snapshotDiff?,
  navigation?:{url,title,kind}, dialogs?:[{type,message,defaultPrompt?}],
  downloads?:[{id,filename,state}], audit}`. Side-effect fields are populated
  for the `act`, `nav`, `form` and `dialog` groups and `extract.paginate`; an
  absent field means nothing happened.
- **Error codes:** `REF_STALE, TAB_BUSY, PERMISSION_DENIED, PROMPT_TIMEOUT,
  TIMEOUT, NOT_ACTIONABLE, NOT_FOUND, BAD_REQUEST, UNAUTHORIZED, NO_EXTENSION,
  VERSION_MISMATCH, KILLED, UNSUPPORTED, DEBUGGER_DETACHED, DIALOG_OPEN,
  TOO_LARGE, INTERNAL`.
- **Timeouts (D15).** Every waiting tool takes `timeout` (ms). Defaults 5000 for
  actions and `page.find`, 30000 for `nav.goto` and `nav.wait`; max 120000.
  Compound tools (`form.fill`, `extract.paginate`) apply it per step with a 120s
  cap per call. A permission prompt waits 120s then returns `PROMPT_TIMEOUT`; a
  late answer is discarded and never executes anything.
- **Screenshots on the wire (D30):** `{mime, dataBase64, width, height}`. MCP
  turns it into an image block, REST returns the JSON, the CLI writes a file
  (`--out`, else a temp path) and prints the path.

## Page understanding (D22–D25)

### Snapshot

`page.snapshot` returns a pruned accessibility tree as indented text with a ref
on each interactive node:

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

- **Source (D25).** The CDP accessibility tree is the only source for the CDP
  driver (it sees through shadow roots; a plain content script does not). The
  content-script DOM walker belongs to lite mode only.
- **Defaults (D23).** `mode: interactive` (interactive nodes with refs, plus
  landmarks and headings as unreferenced structure), the whole page rather than
  the viewport, capped by `maxTokens` (default 6000). Over budget:
  `… truncated, N more nodes; narrow with root=<ref>`; #20 adds list collapsing.
  Truncated nodes get no refs until shown.
- **A token is `ceil(chars / 4)` everywhere** in this project: snapshot cap,
  golden budgets, the tool budget, the benchmark (which also reports
  model-reported usage).
- **Refs (D22).** Format `e<N>`, from a per-tab counter that only goes up and is
  never reused. The table lives in the service worker:
  `ref → {backendNodeId, CDP session/frame, loaderId}`. A replaced document, a
  detached node or a ref used with another `tabId` returns `REF_STALE`. Frame
  identity is in the table, not the text. `page.snapshot`, `page.find` and
  set-of-marks share the table, so one node has one ref.
- **Frames.** Cross-origin frames are governed by their own origin's policy
  (D16); a denied frame becomes a one-line placeholder. Same-origin frames and
  open shadow DOM are in M1; cross-origin frames come with #19.

### Diffs (D24)

After an action the extension waits for the DOM to be quiet (100ms, max 1s),
snapshots, and returns `snapshotDiff` in snapshot format with lines prefixed
`+`, `-` or `~`. The baseline is the last snapshot or diff delivered to this
session for this tab, and every delivery advances it. If the action navigated,
`snapshotDiff` is omitted, `navigation` is set and the baseline is cleared. No
baseline, no diff. #20 adds `diff: true` on `page.snapshot`.

### Other observations

- `page.screenshot` — viewport, full page or element; optional set-of-marks
  labels. Overlay elements are hidden while it is taken (D40).
- `page.text` / `page.markdown` — readable content.
- `page.find {by: text|role|label|css|xpath, value, name?, root?}` — up to 20
  `{ref, role, name}` in document order, minting refs from the shared table even
  for nodes a snapshot prunes; no match is an empty list (#26).

## Driver and actions (D26–D28)

- **Driver interface (D26).** Snapshot, input, screenshot and dialogs sit behind
  a `Driver`. The CDP driver is the M1 implementation; lite mode is a second
  driver, not a retrofit.
- **Input.** CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`
  produce trusted events. Before each action, auto-wait: attached, visible,
  stable, enabled, and not covered (hit-test at the click point). Failures name
  the reason, e.g. `covered by <div.modal>` (that message quotes the page and is
  wrapped, D21). `act.fill` uses the native setter plus input/change events.
- **Debugger lifecycle (D27).** Attach lazily per tab on the first command that
  needs CDP; stay attached until the session ends, the tab leaves the session,
  or kill. If the user cancels Chrome's debugging bar, in-flight commands on
  that tab fail with `DEBUGGER_DETACHED` and the tab stays stopped until resumed
  in the side panel.
- **Dialogs (D28, #27).** `dialog.handle {action: accept|dismiss, promptText?}`
  is in the core profile. An action that opens a dialog returns at once with
  `ok:true`, `dialogs` set and no diff. While a dialog is open every other
  command on that tab returns `DIALOG_OPEN` with the details; a dialog opened
  with nothing in flight is reported by the next command. `beforeunload`
  defaults to accept (setting: `accept|dismiss|ask-agent`).
- **Waiting (#26).** `nav.wait {for: load|networkidle|selector|text|url|fn}`.
  `networkidle` uses the driver's own in-flight counter (500ms quiet, D35);
  `url` is a substring or `/regex/`; `fn` is arbitrary page JS and goes through
  the same sensitive gate as `js.eval` (D18c).

### Lite mode (D26, #21)

Lite mode uses content scripts only (synthetic events, DOM-walker snapshot in
the same text format and ref rules). It is chosen per origin in settings and
never switches on its own; `session.info` reports each tab's mode. Unsupported
tools return `UNSUPPORTED` without touching the page. The per-tool matrix is
generated from the registry's `lite` field: [lite-mode.md](lite-mode.md).

## Tools (D29, D31, D33–D36)

The full, generated reference is [tools.md](tools.md). Groups: tabs (`tabs`
with `action: list|new|select|close|attach`), navigation, page, act, form,
extract, script (`js.eval`), dev (`console.list`, `network.*`), files
(`act.upload`, `downloads.*`), dialogs, storage (`cookies.get`,
`storage.get`), session (`session.info`, `session.permissions`,
`session.end`).

- **Profiles (D29).** `core` (13): `tabs`, `nav.goto`, `nav.wait`,
  `page.snapshot`, `page.screenshot`, `act.click`, `act.type`, `act.press`,
  `act.select`, `form.fill`, `extract.table`, `page.markdown`, `dialog.handle`.
  `forms` = core + `form.describe`, `form.submit`, `act.fill`, `act.check`,
  `act.upload`. `data` = core + `page.text`, `page.find`, `extract.links`,
  `extract.schema`, `extract.paginate`, `downloads.*`. `dev` = core +
  `js.eval`, `console.list`, `network.*`, `cookies.get`, `storage.get`.
  `full` = everything. Profiles combine (`--profile forms,data`); Streamable
  HTTP clients pass `?profile=`. REST and the CLI always expose every tool.
- **Tool budget (#30).** `core` ≤ 2000 tokens and `full` ≤ 8000 tokens of
  `tools/list` JSON; `scripts/tool-budget.mjs` gates both in CI. The skill has a
  reported (not gated) 1500-token soft cap.
- **`form.fill` (D34).** A key matching `^e\d+$` is a ref; anything else is a
  label matched exactly (case-insensitive, whitespace-normalised) against the
  accessible name. Zero matches → `NOT_FOUND`, several → `BAD_REQUEST` listing
  candidates. Best-effort, not atomic: `{filled:[…], failed:[{key, code,
  message}]}`; one diff at the end. `form.describe` returns a ref per field.
- **Extraction (D33).** `extract.schema` v1: JSON-LD and microdata first, then
  repeated-structure detection; returns `{data, selectors}` and accepts
  `selectors` later. `extract.paginate {extractor: table|links|schema, next?,
  maxPages=5}` routes every hop through the router (policy, gates, audit) and
  stops on no/disabled next control, unchanged URL or all-duplicate page,
  returning pages so far plus any error.
- **Files (D31).** `uploadDirs` in `config.json` defaults to
  `~/.tabagent/uploads` only. Paths are `realpath`-resolved before the check,
  so symlinks and `..` cannot escape; the canonical path is what
  `DOM.setFileInputFiles` receives. `downloads.*` cover only downloads started
  by the session's own tabs; `downloads.read` reads only a path matching a
  download id the extension reported for that session, limit 5 MB
  (`TOO_LARGE`), text as UTF-8, binary as base64.
- **Network capture (D35).** Starts when the debugger attaches: ring buffers of
  500 requests and 200 console messages per tab, kept across navigations,
  cleared on tab close. Bodies are fetched on demand and may be gone
  (`NOT_FOUND`). `network.list` never returns header values.
- **Owners (D36).** `tabs attach`, `session.permissions` → #5; `act.dblclick` →
  #7; `page.text` → #10; `cookies.get`, `storage.get` → #18.

## Permissions and safety (D16–D21, D40)

- **Levels (D16).** Ordered `deny < read < act < full`. `read` = observe; `act`
  = input and navigation; `full` = the Script, Storage and Dev groups. `ask` is
  not a stored level, it is the absence of a policy. Policy is keyed by origin
  (scheme + host + port) and is global across clients; token scope narrows per
  client; effective level = min(token cap, site policy).
- **Prompt answers.** *Allow once* = this session, this origin, the requested
  level, until the session ends. *Always* = store exactly the requested level.
  *Deny* = this session and origin. A later request for a higher level prompts
  again.
- **Evaluation order for every command:** paused (D12) → denylist → token
  scope → site policy or ask → sensitive gate. The tab's current origin is
  re-checked before every command; `nav.goto` checks the target origin first.
- **One chokepoint (D17).** The router calls
  `authorize(session, tool, action, origin)` before any handler, from M0 on.
  Until #12/#13 the policy is: session-owned tabs only, hard denylist
  (`chrome://`, extension pages, Web Store), and the D18 effects are refused
  with `PERMISSION_DENIED` unless `devAllowSensitive` is on (off by default; the
  e2e harness turns it on). #12/#13 replace the policy, not the hook. Nothing is
  published before M3 is done.
- **Gates by effect (D18),** enforced in the router: (a) submitting a form that
  has password, card or SSN-like fields, by any path (`form.submit`,
  `act.press` Enter in the form, `act.click` on its submit control); (b) clicks
  matching purchase/delete/send/transfer, a best-effort English keyword match on
  the accessible name; (c) arbitrary JS: `js.eval`, `nav.wait` with `fn`;
  (d) credential reads: `cookies.get`, `storage.get`, `network.get`;
  (e) local file transfer: `act.upload`, `downloads.read`; (f) `tabs attach`.
  Pre-approval is per origin per category a–e; f always asks. Password and card
  values are masked as `••••` in snapshots, diffs, `form.describe`, the live
  feed and the audit record. Screenshots are not masked.
- **Prompts (D19).** Chrome only opens the side panel on a user gesture, so a
  pending prompt sets the toolbar badge to `!`, raises a `chrome.notifications`
  notification and shows an informational banner in the agent's tab (no approve
  buttons in the page, which the agent could click). The user answers in the
  side panel. Prompts queue FIFO; identical pending requests share one prompt.
- **Audit (D20).** The extension builds the record, because only it knows what
  is sensitive: `{tool, action, origin, params (redacted), outcome, errorCode?,
  resultSummary:{bytes, sha256}}`. The bridge adds caller and timestamp and
  appends it; it never logs raw params or results. Prompts, decisions, kill and
  resume arrive as `event` messages. `~/.tabagent/audit.jsonl` is 0600, rotates
  at 10 MB and keeps 5 files.
- **Untrusted-content wrapping (D21, #16).** The wire stays typed JSON; the
  registry's `pageContent` marks page-derived fields, and the bridge wraps them
  at the MCP/REST/CLI output edge between `<<<PAGE_DATA {nonce}` and
  `PAGE_DATA {nonce}>>>`, with a fresh random nonce per response (regenerated
  if the page text contains it). Wrapped: snapshot and diff text, page
  text/markdown, extraction output, dialog messages, console and network
  output, tab titles and URLs, download filenames, and error messages that
  quote the page. TabAgent's own hints stay outside. **TabAgent has no model
  and interprets nothing; resisting injected instructions is the agent's job.**
  The label is a convention the agent may ignore; the D18 gates are the
  backstop.
- **Denylist.** `chrome://`, extension pages, the Web Store, and a seeded,
  user-editable list (password managers, banking) are refused.
- **Visibility (D40).** Badge states: off, connected, acting, needs approval,
  paused. A coloured tab group per session; an on-page border (default on) and
  target highlights. Overlay elements carry `data-tabagent-overlay`, have
  `pointer-events:none`, are excluded from snapshots and hidden during
  screenshots. The side panel shows a live action feed.

## Agent integration

1. **MCP (primary).** `tabagent mcp` (stdio) or `/mcp` (Streamable HTTP).
   Examples for Claude Code, Codex and Cursor are in
   [`examples/`](../examples), and CI starts each one.
2. **CLI / REST (fallback).** `tabagent <tool> --json '{…}'` and
   `POST /v1/call/<tool>`; no context cost until used.
3. **Skill (#29).** A `SKILL.md` shared by Claude Code and Codex
   (`tabagent skill install [--claude] [--codex] [--force]`): snapshot then act
   by ref, re-snapshot on `REF_STALE`, fill a form in one `form.fill`, treat
   page content as untrusted. TabAgent itself asks the user before sensitive
   actions; when a call is waiting on approval or returns `PROMPT_TIMEOUT` /
   `PERMISSION_DENIED`, the agent tells the user a prompt is waiting in the side
   panel and does not retry in a loop. A lint test keeps every tool, param and
   error code named in the skill in sync with the registry.

```bash
npm i -g @nolmak/tabagent && tabagent serve      # once; prints the pairing code
claude mcp add tabagent -- npx -y @nolmak/tabagent mcp
codex mcp add tabagent -- npx -y @nolmak/tabagent mcp
tabagent skill install --claude --codex
```

## Repo layout and tooling

```
tabagent/
  packages/
    protocol/    # registry, envelopes, error codes, wrapping, policy helpers (zod)
    extension/   # MV3: service worker, pagelib (content scripts), side panel
    bridge/      # Node daemon + MCP + REST + CLI (published as `tabagent`)
  e2e/           # Playwright + unpacked extension + real bridge + MCP client
  bench/         # benchmark tasks, fixtures, runner (#24)
  examples/      # Claude Code, Codex, Cursor configs
  scripts/       # tool budget, docs generator, version check
  test/release/  # checks against built artifacts
  docs/
```

TypeScript throughout, **npm workspaces + esbuild** (OT3), Vitest for unit
tests, Playwright for e2e (bundled Chromium with `--load-extension`, headless in
CI). The extension source manifest is `packages/extension/manifest.json`,
copied to `dist`; dev and e2e builds are the same artifact. CI runs lint →
typecheck → unit (coverage floors: protocol 90% lines, bridge 80%, extension
pure modules 80%) → build → e2e and tool-budget. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the TDD rules.

## Milestones

- **M0 — Skeleton:** tooling (#25), protocol (#1), e2e harness (#22), bridge
  (#2), service worker + router + chokepoint (#3), MCP + REST (#4).
- **M1 — Core agent loop:** sessions (#5), snapshot + diff core (#6), wrapping
  (#16), actions (#7), `nav.wait` + `page.find` (#26), screenshots (#8), tool
  budget (#30), skill (#29).
- **M2 — Data and forms:** dialogs (#27), forms (#9), extraction (#10), files (#11).
- **M3 — Safety:** permission engine (#12), sensitive gates (#13), side panel
  (#14), tokens + audit (#15).
- **M4 — Dev and power tools:** network/console (#17), `js.eval`/cookies/storage
  (#18), frames + shadow DOM (#19), diffs + budgeting (#20), lite mode (#21).
- **M5 — Ship:** release (#23), benchmark (#24).

## Open threads

| # | Question | State |
|---|---|---|
| OT1 | Do CDP input, auto-wait and screenshots work on background tabs without focusing? | **Answered: yes** in headed Chrome. Headless needed a fix for `act.type` on background tabs (driver work). |
| OT2 | Ship `debugger` as an optional permission for Web Store review? | Open (Nolan, before submission). Until then it is required; if optional, lite mode becomes the first-run state and needs a grant flow. |
| OT3 | Package manager and bundler. | **Answered: npm workspaces + esbuild.** |
| OT4 | Move Safety (M3) ahead of Data and forms (M2)? | Open; recommendation is to keep the order and rely on D17. |
| OT5 | How Claude Code, Codex and Cursor treat dotted MCP tool names. | Open; D13 already assumes they are rejected, so names use underscores. |
| OT6 | Codex skill directory and SKILL.md format. | Open (#29). |
| OT7 | Land the spike issue by issue or keep it as reference. | Open (Nolan). |
| OT8 | Benchmark task set and model. | v1 task set is the 20 fixture tasks in `bench/`; WebArena subset and model decided at M5 start. |

## Dropped claims

These appeared in earlier drafts and are no longer true:

- "The permission engine runs in the extension, so the bridge can never bypass
  it" — dropped (D1): the extension cannot verify who is calling.
- "TabAgent never acts on instructions found in pages" — reworded (D21).
- "`npx -y @nolmak/tabagent mcp` starts the daemon in-process" — replaced by D6.
- Snapshot "with a content-script DOM walk as fallback" — D25: lite mode only.
- "Screenshots are optional in the audit log" — cut from v1 (D20).
- pnpm + Vite — replaced by npm workspaces + esbuild (OT3).
- Separate `tabs.list`/`tabs.new`/… tools — one `tabs` tool with `action` (D13).
