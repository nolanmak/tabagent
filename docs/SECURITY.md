# Security model

TabAgent lets a local AI agent drive your real browser, with your sign-ins. This page says what
it protects against, what it does not, and where the real backstops are. Decision numbers refer to
roadmap #28 and [DESIGN.md](DESIGN.md).

To report a vulnerability, open a private security advisory on the GitHub repository rather than
a public issue.

## Trust boundary (D1)

```
 agents ──▶ bridge (127.0.0.1) ──▶ extension ──▶ your tabs
           trusted for "who"      the only enforcement point
           enforces file I/O      for site policy and sensitive gates
```

- The **bridge** decides *who is calling*: it authenticates every request (bearer secret or token,
  `Origin` and `Host` checks, D2) and labels each session. It is also the enforcement point for
  local file access (upload directories and download reads, D31).
- The **extension** sees one socket from the bridge and cannot verify which agent is behind a
  command. It is the only place that enforces site policy, the denylist, sensitive-action gates
  and the kill switch, because it is the only side that knows a tab's origin and page contents.
- Anything that can talk to the bridge with a valid credential is treated as the user's agent.

## Local credentials are an accepted risk (D3)

stdio MCP and the CLI authenticate with the bridge secret in `~/.tabagent/config.json` (mode
0600) and get full capability. Per-client tokens (`tabagent token create --caps act --sites
'*.github.com'`) narrow a client that *chooses* to use one; they are least-privilege, **not a
sandbox**. A local process that can read `config.json` can do anything a paired agent can. If
tokens ever need to be a real boundary, the plan is OS-keychain storage and per-agent credentials.

Tokens are stored hashed and can be listed and revoked. Their scope travels with each command and
is enforced in the extension: effective level = min(token cap, site policy).

## Network exposure

The bridge binds to `127.0.0.1` only. HTTP requests need `Authorization: Bearer …`; requests with
a browser `Origin` other than the paired extension are rejected, and the `Host` header must be
`127.0.0.1` or `localhost` with the bridge port, which defeats DNS rebinding. The WebSocket accepts
only the paired extension ID with the secret (D4). The extension keeps the secret in
`chrome.storage.local` with access restricted to trusted extension contexts, so content scripts
cannot read it (D7). No data leaves your machine, except through the opt-in remote handoff below.

### Remote handoff (opt-in, #61)

`tabagent config handoff.remote on` lets you finish an `auth.handoff` step (ID and selfie checks,
passkeys, payment entry) from your phone over Tailscale. It is off by default. When it is on:

- **Where it listens.** A second HTTP listener binds only this machine's Tailscale IPv4 address
  (100.64.0.0/10), found with `tailscale ip -4` or, failing that, an interface named `tailscale*`.
  100.64.0.0/10 is also carrier-grade NAT space, so a 100.x address on any other interface is
  ignored. The listener refuses any address outside that range and never binds a wildcard. It is
  opened when the first remote handoff starts and closed when the last one ends, so the port is
  closed the rest of the time. If no Tailscale address is found, the handoff stays local-only.
- **What it serves.** Only `GET /handoff/<id>`, `POST /handoff/<id>/claim`, `GET /handoff/<id>/frame`,
  `POST /handoff/<id>/input` and `POST /handoff/<id>/end`. Everything else returns 404, including
  `/v1`, `/mcp` and the extension WebSocket. Bearer tokens and the bridge secret are not accepted
  there. The `Host` header must be exactly `<tailnet ip>:<port>`, which blocks DNS rebinding.
- **Who can use it.** Each handoff gets a random 128-bit id and a 256-bit token in the link. Only
  their SHA-256 hashes are kept. A GET of the link does not use up the token, so link previews do no
  harm. The page script claims the token once (`POST …/claim`). That browser gets an `HttpOnly;
  SameSite=Strict` cookie scoped to `/handoff/<id>`, and the link stops working for anyone else.
  API calls need that cookie and an `x-tabagent-handoff: 1` header, which a cross-site page cannot
  send without a CORS preflight that is never answered. The link and the cookie are revoked when the
  handoff ends by Done or Cancel (on the phone or in the side panel), by timeout, by the tab closing,
  when the `auth.handoff` command ends for any reason, by the kill switch, when the extension
  disconnects, and when the bridge stops. Both also expire at the handoff timeout.
- **What it can do.** It can show a JPEG of the one handed-off tab and send that tab taps (as 0..1
  coordinates the extension scales to the tab's viewport), up to 500 characters of text, ten named
  keys with no modifiers, and scrolls. It has no navigation, no address bar, no script evaluation
  and no way to name another tab. The bridge knows the handoff only by its opaque id. The extension
  maps that id to the tab it handed off and ignores any tab id in a message.
- **Input-only debugger session (design decision).** A local handoff detaches the debugger so your
  own hands are not observed. A remote handoff has no local hands, so the phone's input has to reach
  the tab through CDP. Only after the phone first asks for a frame or sends input, the extension
  attaches a bare `chrome.debugger` session to that one tab. It is outside the agent's driver: no
  page library, no refs, no network or console capture. It is limited to `Page.captureScreenshot`,
  `Page.getLayoutMetrics`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`
  and `Emulation.setFocusEmulationEnabled` (so a background tab renders and takes input). Agent
  commands on the tab still get `TAB_BUSY` for the whole handoff. The session is detached when the
  handoff ends, so the agent's next command attaches fresh with stale refs, as after a local handoff.
- **Transport.** The page is plain HTTP. Tailscale encrypts it end to end with WireGuard, and only
  devices on your tailnet can reach the address. Anyone who can reach your tailnet and also has a
  live, unclaimed link can take over that one tab until the handoff ends. Treat the link like a
  password: post it only to a private channel.
- **Webhook.** `tabagent config handoff.webhook <url>` POSTs
  `{event, origin, reason, url, expiresAt, session}` when a handoff starts. It never sends page
  content. `url` is the live one-time link, or `null` when remote handoff is off. The webhook must be
  `https`, or `http` to loopback or a tailnet address. The bridge never logs the URL or the body.
- **Timeout.** `handoff.timeoutMin` (1 to 120). The default is 30 minutes with remote handoff on and
  5 minutes without.
- **Audit.** `handoff.open`, `handoff.remote.claim`, `handoff.remote.end`, `handoff.remote.revoke`
  and `handoff.webhook` events record the origin and the first 8 hex digits of the handoff id. They
  never record the token, the cookie or the link.

### Answering prompts outside the side panel (opt-in, #108)

By default a permission prompt can be answered only in the side panel (or the prompt window), which an
agent cannot drive. The side-panel setting **Answer prompts outside this panel** adds two more ways:
`tabagent approve` with Touch ID or your login password (macOS), and a one-time phone page on your
tailnet. The rule is that **the bridge never relays an answer without proof that you are there.** There
is no flag, environment variable, config key or token that skips it.

- **Off by default, panel-only.** Only the side panel can turn it on or off. `settings.change` refuses it
  and no tool or REST route sets it. Each change is written to the audit log. While it is off, the
  extension tells the bridge nothing about prompts and refuses every `prompt.answer`.
- **One decision point.** With it on, the extension mirrors its pending prompts to the bridge with the
  exact strings the panel shows. The extension stays the only place that decides: the bridge sends
  `prompt.answer`, and the extension applies it through the same queue as a panel click. The first
  answer wins. A second answer from any channel gets "already answered" and changes nothing. An answer
  at or after the 120 s expiry never executes, even if the timeout has not fired yet. An answer the
  prompt does not offer (for example "Always" on a policy change) is refused. The `decision` audit
  event records the channel: `panel`, `cli-presence` or `phone`.
- **`tabagent approve` (macOS).** The bridge runs the presence check itself, not the CLI. For each
  answer it issues a single-use challenge bound to that prompt id and answer, valid for 90 s, with a
  fresh random 256-bit key. A small Swift helper, compiled once with `swiftc` into `~/.tabagent/bin`,
  evaluates LocalAuthentication's `deviceOwnerAuthentication` policy (Touch ID, or the login password)
  with a reason that names the answer and the prompt title. Only on success does it return an HMAC of
  the challenge under that key. The key exists only in bridge memory and on the helper's stdin pipe.
  The bridge accepts the MAC once and then relays the answer. The CLI sends only `{promptId, answer}`,
  and the bridge ignores anything else in the request. Only one check runs at a time, and a cancelled
  check blocks new ones for 10 s, so an agent cannot stack dialogs. On Linux and Windows,
  `tabagent approve` refuses and points to the side panel or the phone page. These routes accept only
  the bridge secret, not per-client tokens.
- **Phone page.** It needs `handoff.remote on` and uses the remote handoff listener and its rules: the
  tailnet address only, the exact `Host`, a one-time link (128-bit id, 256-bit token, hashed), a token
  claimed once for an `HttpOnly; SameSite=Strict` cookie scoped to `/approve/<id>`, and the
  `x-tabagent-handoff: 1` header. The bridge hands out a link only after a presence check
  (`tabagent approve --phone`) or a click on **Phone link for approvals** in the side panel. It is
  **never posted to the handoff webhook**, because an agent can point the webhook at itself with
  `tabagent config`. A link lasts 60 minutes by default (1 to 120). It ends when you press End link,
  on the kill switch, when outside approvals are turned off, when the bridge stops, or when it expires.
  It survives an extension reconnect, but nothing can be answered while the extension is away. The
  listener is open only while a handoff or an approval link is live. The page fetches prompts as JSON
  and renders them with `textContent`, so prompt text cannot become markup.
- **Audit.** `approval.presence` (purpose and outcome), `approval.answer` (channel, prompt, answer,
  outcome) and `approval.phone.link` / `.claim` / `.end` / `.revoke`, which record the first 8 hex
  digits of the link id. None of them records a key, a MAC, a token, a cookie or a link.

**What this protects against.** An agent that uses TabAgent's own interfaces cannot answer a prompt.
That covers MCP tools, the REST API with a token or the bridge secret, and the CLI, including running
`tabagent approve` and `tabagent config` itself. Calling the approve route only shows a Touch ID or
password dialog that names the prompt and the answer, and only you can satisfy it. Getting a phone link
needs the same dialog or a click in the side panel.

**What it does not protect against.** The value of the proof comes from the LocalAuthentication
evaluation needing a person. It does not come from a secret that an agent running as you cannot read.
The key and MAC only bind a successful evaluation to one challenge inside the bridge.

- *A local process that tampers with TabAgent* (D3). Such a process can replace the compiled helper or
  the bridge's installed files. It can stop the bridge and serve its own on the port, and the extension
  would then accept `prompt.answer` from it. It can also connect to the extension socket with the
  secret from `config.json` and ask for a phone link. Any of these can answer prompts. Without this
  setting, the same process cannot answer prompts through TabAgent, which is why the setting is off by
  default. Turn it on only if you accept that risk for your agents.
- *A dialog you did not start.* If an agent runs `tabagent approve 1 always`, the dialog still shows
  what is being approved. Read it before you touch the sensor.
- *A leaked phone link.* Anyone on your tailnet with an unclaimed link can answer prompts until it ends.

## Untrusted page content: wrapping is a label, not a guarantee (D21)

Pages can contain text written to manipulate an AI agent ("ignore previous instructions…").
TabAgent has no model and interprets nothing; **resisting injected instructions is the agent's
job.** What TabAgent does is label page-derived output: snapshot and diff text, page text and
markdown, extraction results, dialog messages, console and network output, tab titles and URLs,
download filenames and error messages that quote the page are wrapped as

```
<<<PAGE_DATA 7f3a…
…page text…
PAGE_DATA 7f3a…>>>
```

with a fresh random nonce per response, so a page cannot forge the closing marker (the nonce is
regenerated if the page text happens to contain it). TabAgent's own hints stay outside the block.
The label tells a well-behaved agent what is data; an agent is free to ignore it. Do not rely on
wrapping for safety.

## The backstop: gates by effect (D17, D18)

Every command passes one chokepoint in the extension's router, in this order: paused (kill switch)
→ denylist → token scope → site policy or prompt → sensitive gate. The sensitive gates are defined
by *effect*, so there is no side door through a different tool:

| | Effect | Paths gated |
|---|---|---|
| a | Submitting a form that has password, card or SSN-like fields | `form.submit`, `act.press` of any key that resolves to Enter (Enter, Return, with modifiers) inside the form, `act.type` text containing a newline, `act.click` on its submit control; in any frame |
| b | Clicks that look like purchase, delete, send or transfer | `act.click` on a matching accessible name |
| c | Arbitrary JavaScript | `js.eval`, `nav.wait` with `for: fn` (both need `full` on the site) |
| d | Credential reads | `cookies.get`, `storage.get`, `network.get` (`network.list` never returns header values) |
| e | Local file transfer | `act.upload`, `downloads.read` |
| f | Taking over one of your tabs | `tabs attach` (always asks, cannot be pre-approved; see "Send to agent" below for the one user-initiated exception) |

**Send to agent shares a tab without the f prompt.** When *you* send a message from the side panel
with "Share this tab" ticked, to a linked Claude Code agent whose TabAgent tools can drive tabs (the
label then reads "Share this tab (agent can use it)"), that click is the attach consent: the tab
moves into the agent's tab group with no further prompt. Only the side panel can start a send: there
is no REST, CLI or page route, and the worker has a single
caller for the grant. The tab is not shared when another agent owns it or it is handed to you
(`TAB_BUSY`), when it is a private sign-in tab or outside a token's allowed sites
(`PERMISSION_DENIED`), when it is closed (`NOT_FOUND`) or while TabAgent is paused; the agent then
gets only the title and link, and the panel shows "tab not shared: <code>". If the message expires
before the agent picks it up, the tab is ungrouped and left open. The grant is the attach only: the
site policy prompt, token scope and every gate above still apply on the agent's first action.

Categories a–e can be pre-approved per origin; f always asks. Choosing `full` for a site in the side
panel (adding it or changing its row) also turns on sign-in, sign-in without asking (below) and
pre-approves a–e for it in one step (#118, #131), so full means no further prompts on that site; the
user can untick any of them after, and lowering the level later leaves them as they are.
Sign-in is still never turned on for hosts on the banking/password-manager list, the password,
account and mail hosts, or the denylist; the panel says why instead. Prompts are answered in the side
panel (reached from the toolbar badge or a notification), never by buttons inside the page, which
the agent could click (D19). A prompt that is not answered in 120s returns `PROMPT_TIMEOUT`, and a
late answer never executes anything (D15). Until the full permission engine lands, these effects
are refused outright unless the developer setting `devAllowSensitive` is on (D17).

Each gate has a test for the gated path and for every bypass path listed above.

### After TabAgent signs in (DA1)

Once `auth.login` or `auth.code` has typed a credential into a tab, that tab is tainted until it
has moved to a new page *and* 10 minutes (Chrome's back/forward cache lifetime) have passed. While
it is tainted, every c and d tool is refused on it, whatever the site policy, pre-approvals or
YOLO say. `network.get` never returns a request that started while the tab was tainted. For 10
minutes, any result or error that contains a typed password or code is withheld. Auth also refuses
to type into a page where agent JavaScript (`js.eval`, `nav.wait` fn) has run.

If the extension reloads while a tab is tainted or dirty, the per-tab state is lost, so TabAgent fails
closed: every tab counts as tainted and dirty for 10 minutes. Auth errors in that window say TabAgent
restarted and when typing resumes (#140). The side panel shows the lock with an "End lock now" button
for the user, typically after reloading TabAgent themselves. Agents can't reach it (panel-only
`ui.endRestartLock`), and taint recorded after the restart still applies.

### Sign in without asking (#131)

Sign-in (category g: `auth.login`, `auth.code`, `auth.confirm_link`) asks before every sign-in or
code by default, even on a site with sign-in allowed and policy `full`. There are two ways to skip
the prompt, both set only by the user:

- **Always grants** (per account): "Always for this account" on a prompt, or the side panel's
  "codes always" toggle, which adds the texted and emailed code sources (`code-source:sms`,
  `code-source:email`). The side panel's Sign-in column lists every Always grant for a site (account
  ids masked) with a ✕ that revokes it.
- **Sign in without asking** (`authAuto`, per site): every g request on that exact origin is allowed
  with no prompt, for every saved account and every code source. It is off by default. The user turns
  it on in the side panel (choosing `full` turns it on too), or approves a `policy.site_change` that
  asks for it. It needs sign-in explicitly on (`auth: true`: the Google default and YOLO are not
  enough), and turning sign-in off clears it. Each command it lets through is marked `authAuto: true`
  in the audit log, and turning it on or off for a site is written to the audit log too.

**The risk.** With `authAuto` on, an agent can sign in with any saved account for that site and type
any texted, emailed or TOTP code that arrives, without the user seeing anything. Codes often confirm
more than sign-ins: a bank, broker or payment site may text the same kind of code to approve a payment
or a transfer, and an agent entering it without asking approves that. The side panel shows this
warning when `authAuto` is turned on and next to every site that has it. It is never available on the
password-manager hosts where TabAgent never signs in, on the never-reachable hosts below, or on
denylisted hosts: the panel and `policy.site_change` refuse to set it there, settings drop it for the
built-in lists, and the gate re-checks the host every time, so adding a site to the denylist later
stops it at once. Banks are on the seeded denylist, so they cannot have it until the user removes the
bank from the denylist (#100); after that a bank can have it like any other site, and that is where the
payment warning matters most. A code consent that `authAuto` allowed is not cached, so turning it off also
applies at once. Sign-ups (`auth.signup`) still ask every time. YOLO does not turn it on.

### Google sign-in (#79)

TabAgent never signs in on password-manager hosts, whatever the settings. Google sign-in
(`accounts.google.com`) and banking sign-in (#100, the banks on the seeded denylist) are different: they are
off by default because the hosts are on the seeded denylist, and the user turns them on by removing the host
from the denylist. Sign-in for `https://accounts.google.com` (and every origin under YOLO, #110) is then on by
default; for a bank outside YOLO the user must also enable sign-in for that origin. Every `auth.login` there still asks for consent unless
the user ticked "always" for that account. Google account, password and mail pages stay never reachable
(below). Accepted risk: clicks on Google's account chooser or an OAuth consent screen ("Allow") need only
the site policy, not the sign-in consent, so an agent with `act` on `accounts.google.com` can grant an app
access without typing a secret.

### Agent-requested policy changes (#67, #104)

Agents cannot write extension settings. Two `full`-level tools let a caller *request* a change, and
the extension applies it only after the user approves a visible prompt in the side panel:

- `policy.denylist_change`: an exact add/remove list of host globs.
- `policy.site_change`: one exact origin and the sign-in (`auth`), sign-in without asking
  (`authAuto`), site policy and lite-mode values to set. The prompt shows the origin, each change
  (with the payment warning for `authAuto`) and the agent's reason.

These prompts (category p) offer only "Allow once" and "Deny". They cannot be pre-approved, and YOLO,
saved site permissions and `devAllowSensitive` do not skip them. A denied or timed-out prompt changes
nothing. The state the prompt was shown against is snapshotted before it is displayed; if the
denylist or that site's settings change before the user answers, the approval is refused and the
agent has to ask again. Turning things off (`auth: false`, `policy: "deny"`) goes through the same
prompt.

A site change is refused before any prompt for: browser and Web Store pages, the never-reachable
hosts below, the banking and password-manager hosts where TabAgent never signs in, and any host on the
denylist (the agent is told to request a denylist change first). Removing a bank from the denylist
never lets TabAgent sign in there.

### YOLO and developer mode (#109)

`policy.mode_change {yolo?, devAllowSensitive?, durationMin?, reason}` (also `full`-level) is the
only way an agent can touch YOLO or `devAllowSensitive`:

- **Turning either off** applies at once with no prompt, since it only narrows what agents may do.
  It is in the audit log with the agent's reason, like every call.
- **Turning either on** is a category p prompt like the tools above: "Allow once" or "Deny" only, not
  skipped by YOLO, `devAllowSensitive` or saved permissions, and snapshotted so a change to either mode
  (or YOLO's expiry) while the prompt is open refuses the approval. Whether a prompt is needed depends
  only on the request (any `true`), never on the current state. The prompt lists each change, the
  duration (or "no time limit"), the reason, and what the mode allows: YOLO means every site without
  asking, sign-in on every site and no sensitive-action confirmations; developer mode means no
  confirmations for form submits with secrets, risky clicks, JavaScript, credential reads and file
  transfers. A request that turns one mode on and the other off is one approval; a denial applies
  neither.
- **`durationMin`** (1 to 1440, only with `yolo: true`) stores an expiry timestamp. A `chrome.alarms`
  alarm switches YOLO off at that time, and every settings read also treats an expired YOLO as off, so
  the limit holds across service-worker and browser restarts even if the alarm is late. The expiry is
  audited (`yolo.expired`) and the side panel shows the time left. Without `durationMin` YOLO stays on
  until the user turns it off, as from the panel; turning YOLO off by any route clears the expiry.

A request that changes nothing is refused with `BAD_REQUEST`.

### Settings agents can read and change (#105, #106)

`settings.get` lets any caller read the denylist, each saved site's policy, sign-in and lite mode,
YOLO, `devAllowSensitive`, the preferences below and the built-in hard lists. It is built field by
field from an allowlist: it never returns the pairing secret, bridge tokens or saved-account ids
(only how many accounts are set to "always").

`settings.change` sets only preferences that do not widen what an agent can do: `showOverlay`,
`beforeUnload`, `onSessionEnd`, `forceLite` and `liteSites`. It needs no approval but an `act`-capable
token, and each call is in the audit log. Anything else is refused with a pointer: YOLO and
`devAllowSensitive` go through `policy.mode_change` (#109), and the denylist and sites through the
other approval-gated policy tools above.

### Never reachable

`passwords.google.com`, `myaccount.google.com`, `mail.google.com` and the password-manager vault
apps are refused for every agent tool. This list is built in and cannot be edited; YOLO does not
apply to it (DA12). YOLO mode shows a YOLO badge and a banner in the side panel while it is on,
and turning it (or `devAllowSensitive`) on or off is written to the audit log.

## Best-effort heuristics (D18b)

Gate (b) is an English keyword match on the accessible name of the clicked element. It will miss
buttons labelled in other languages, with icons only, or with unusual wording, and it will
sometimes ask about harmless clicks. Gate (a) detects password, card and SSN-like fields from
input types, autocomplete attributes and labels; a sufficiently unusual form can evade it. Use site
policy (`read` or `deny`) for sites where a missed prompt would be costly.

## Masking, and what is not masked

Password and card field values are shown as `••••` in snapshots, diffs, `form.describe`, the live
feed and the audit record. **Screenshots are neither wrapped nor masked**: an image shows whatever
is on screen, including sensitive values and any text a page uses to address the agent. Audit
records never contain screenshots (D20).

## Audit log (D20)

The extension builds each audit record with sensitive params redacted; the bridge adds the caller
and time and appends it to `~/.tabagent/audit.jsonl` (0600, rotated at 10 MB, 5 files kept). The
bridge never logs raw params or results, only a size and SHA-256 of each result. Prompts, decisions,
kill and resume are logged as events.

## Kill switch (D12)

`Alt+Shift+K`, the toolbar or the side panel pauses everything: in-flight commands fail with
`KILLED`, pending prompts are dropped, the debugger detaches from every tab and allow-once grants
are cleared. Every later command returns `KILLED` until you click Resume, so a looping agent cannot
get around it by opening a new session.

Agents and scripts can also press it: `session.kill_all` and `tabagent kill` need no session, token
level or approval, because stopping can only make things safer (#106). Resume cannot be reached from
the bridge: there is no tool or REST route for it, and the extension accepts it only from its own
side panel.

## What TabAgent does not protect against

- Malware or another local process with access to your user account (see D3).
- An agent you have paired that is itself malicious or compromised, beyond the prompts and gates
  above.
- Actions on sites you have granted `act` or `full` that are not in a sensitive category.
- Content visible in screenshots.
