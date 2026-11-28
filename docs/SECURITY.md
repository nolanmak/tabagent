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
| f | Taking over one of your tabs | `tabs attach` (always asks, cannot be pre-approved) |

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
banking and password-manager hosts where TabAgent never signs in, on the never-reachable hosts below,
or on denylisted hosts: the panel and `policy.site_change` refuse to set it there, settings drop it
for the built-in lists, and the gate re-checks the host every time, so adding a site to the denylist
later stops it at once. A code consent that `authAuto` allowed is not cached, so turning it off also
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

### Settings agents can read and change (#105, #106)

`settings.get` lets any caller read the denylist, each saved site's policy, sign-in and lite mode,
YOLO, `devAllowSensitive`, the preferences below and the built-in hard lists. It is built field by
field from an allowlist: it never returns the pairing secret, bridge tokens or saved-account ids
(only how many accounts are set to "always").

`settings.change` sets only preferences that do not widen what an agent can do: `showOverlay`,
`beforeUnload`, `onSessionEnd`, `forceLite` and `liteSites`. It needs no approval but an `act`-capable
token, and each call is in the audit log. Anything else is refused with a pointer: YOLO and
`devAllowSensitive` stay panel-only (#109), and the denylist and sites go through the approval-gated
policy tools above.

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
