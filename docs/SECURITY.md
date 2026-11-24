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
cannot read it (D7). No data leaves your machine.

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

Categories a–e can be pre-approved per origin; f always asks. Prompts are answered in the side
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

## What TabAgent does not protect against

- Malware or another local process with access to your user account (see D3).
- An agent you have paired that is itself malicious or compromised, beyond the prompts and gates
  above.
- Actions on sites you have granted `act` or `full` that are not in a sensitive category.
- Content visible in screenshots.
