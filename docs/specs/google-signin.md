# Spec: agents complete "Sign in with Google"

Status: ready for epic (audited: fresh-eyes pass, 30-seam check). Owner: maintainer.
Depends on: #76 (agents told to use the `auth` profile). Helpful, not required: #77 (Bitwarden stays
unlocked across restarts).

Files this touches:

| Area | Files |
|---|---|
| Policy | `packages/extension/src/background/policy.ts` (`AUTH_DENY_HOSTS`), `.../auth/pure/site.ts` |
| Denylist defaults | `packages/protocol/src/index.ts` (`DEFAULT_DENYLIST`), `packages/extension/src/background/settingsModel.ts` (`SEEDED_DENYLIST`) |
| Account masking | `packages/protocol/src/auth.ts` (`maskAccount`) |
| Code extraction | `packages/protocol/src/auth-code.ts` (`DIGIT_CODE`, `extractCode`), `packages/protocol/test/auth-code.test.ts` |
| Login and next step | `.../auth/pure/flows.ts` (`authLogin`, `authCode`), `.../auth/pure/next.ts` (`classifyNext`, `PageSignals`) |
| Agent guidance | `packages/bridge/skill/SKILL.md`, `packages/bridge/test/skill.test.ts` (`TOOL_RE`) |
| Docs | `docs/SECURITY.md`, `docs/DESIGN.md`, `docs/tools.md` (generated) |

## 1. Problem

Many sites only offer "Sign in with Google" for an existing account. Today an agent cannot finish
that flow:

- `accounts.google.com` is in `AUTH_DENY_HOSTS`, so `auth.login` and `auth.code` refuse it with
  "TabAgent never signs in on accounts.google.com", whatever the user configures.
- It is also in the seeded denylist, so every tool refuses the page until the user edits the list.
- Google's 2-factor pages are classified wrongly: `classifyNext` returns `done` on any page where the
  login form is gone and the URL changed, which includes Google's "Check your phone" page.
- Google's SMS format (`G-123456 is your Google verification code`) yields no code: `DIGIT_CODE`
  deliberately rejects digits after `-` (test case in `auth-code.test.ts` asserts `null`).
- `maskAccount` shows only the first character and the domain, so several Gmail logins in one vault
  look identical (`n•••@gmail.com`).

Goal: after the user setup in §2, an agent clicks "Sign in with Google" on a third-party site, picks
the account, fills the password, enters an SMS or authenticator code, and lands back on the site
signed in. Anything that only a human can do goes to `auth.handoff`.

Observed in the field (2026-11-27, a grocery site): the site's Google link sends `prompt=login`, so
Google always asks for the password even when a Google session exists.

## 2. User setup (prerequisites, done by the user)

1. A password provider holds the Google login: Bitwarden (`tabagent bitwarden enable|login|unlock`)
   or 1Password CLI. The item has a URI that matches `https://accounts.google.com`. Items marked
   passkey-only or "master password re-prompt" are refused.
2. Remove `accounts.google.com` from the denylist (side panel, or approve a `policy.denylist_change`).
3. In the side panel Sites table, add `https://accounts.google.com`, set its policy to `act` or higher,
   and turn on its sign-in chip.
4. For SMS codes: macOS, `tabagent config auth.sms on`, Full Disk Access for the app that starts the
   bridge, iPhone Text Message Forwarding to this Mac. For authenticator codes: the Bitwarden item has a
   TOTP seed and the account has Bitwarden Premium.
5. The agent runs with `--profile core,auth` (#76).

`auth.status` reports provider, SMS and denylist state with hints; agents read it before acting.

## 3. Decisions

- **D1. `accounts.google.com` leaves `AUTH_DENY_HOSTS`.** This makes Google sign-in *unlockable by the
  user*; it does not turn it on by default (D2, D3 still apply). Why: maintainer decision to unblock
  Google for every user instead of adding a dedicated setting. The other `AUTH_DENY_HOSTS` entries
  (banks, password managers) are unchanged. Revert path if abused: re-add the host to `AUTH_DENY_HOSTS`
  (a code change; no migration needed).
- **D2. `accounts.google.com` stays in `SEEDED_DENYLIST`.** New installs start with Google blocked.
  Existing installs keep their stored denylist; nothing is migrated. Accepted consequence: users who
  already removed Google from their denylist get Google sign-in as soon as they also do §2 step 3.
  "No dedicated setting" means no new Google-specific toggle; the denylist entry plus §2 step 3 are
  the opt-in.
- **D3. Google follows the normal per-origin rules.** Auth tools need `sites["https://accounts.google.com"].auth`
  (checked by `checkAuthSite`); every other tool needs the site policy (checked by `resolve`). No
  inheritance from the site that started the flow. Note: `sensitiveStep` does not read the denylist;
  the denylist is enforced by `resolve` (all tools) and `checkAuthSite` (auth tools). Tests go through
  those two.
- **D4. `VAULT_DENY_HOSTS` is unchanged.** It keeps `passwords.google.com`, `myaccount.google.com`,
  `mail.google.com` and the password-manager vault hosts refused for every tool. It does **not** cover
  account-recovery or security pages served from `accounts.google.com`; D7 rule (c) covers those.
- **D5. Delete the unused `DEFAULT_DENYLIST` export.** It has no importers and has drifted from
  `SEEDED_DENYLIST`. `SEEDED_DENYLIST` (extension) remains the only seeded list, contents unchanged.
  The Web Store hard deny (`HARD_DENY_HOSTS`, `isHardDenied`) is unchanged.
- **D6. Account choice.**
  (a) The agent navigates to Google's sign-in page first, then calls `auth.status`; accounts match the
  tab's current origin, so calling it on the third-party site lists the wrong accounts.
  (b) The agent passes the account's `id` from `auth.status` (format `<provider>:<id>`), never the mask.
  (c) If the task names an account, the agent picks the id whose mask fits it. If several remain and
  the task does not say, the agent asks the user, showing the masks. If masks still collide, it hands off.
  (d) On Google's account chooser, the agent may click the tile for the chosen account (`act.click`, no
  secret). If the tile has no matching vault item, it hands off.
  (e) Two-step login: the second `auth.login` call on the same tab and origin within 2 minutes reuses
  the first call's account when `account` is omitted, and does not ask for consent again (the first
  prompt covered this sign-in). A different `account` on the second call is a new sign-in and prompts.
- **D7. What the agent does on each Google page.**
  (a) Automated: identifier and password pages (`auth.login`), SMS code (`auth.code {source:"sms"}`),
  authenticator code (`auth.code {source:"totp"}`, which needs a prior `auth.login` with that account on
  this tab and origin).
  (b) On `accounts.google.com` the agent passes `source` explicitly. `source:"email"` and the email step
  of `auto` are refused on `accounts.google.com` (Gmail may be signed in as another account).
  (c) Always `auth.handoff`: phone prompts ("Tap Yes"), number matching, passkeys, security keys, ID
  checks, Google's own CAPTCHA (`captcha.solve` does not support it), "This browser or app may not be
  secure", and any post-sign-in interstitial (recovery info, passkey enrollment, "Verify it's you").
  (d) The agent may click "Try another way" once to reach an SMS or authenticator option; otherwise hand
  off. It never changes account settings.
  (e) After one failed `auth.code` (timeout or wrong code), the agent tries (d) once, then hands off.
  If `auth.code` returns BAD_REQUEST for several codes in the window, it hands off.
  (f) After a handoff returns, refs are stale: re-snapshot. On `PROMPT_TIMEOUT` the agent reports and
  stops; it does not retry in a loop.
- **D8. Google page classification (`next.ts`).** Add a `PageSignals` input for the page host. Rule: on
  `accounts.google.com`, a page with no login field and no code field is `handoff_required`, never
  `done`; `done` needs the tab to have left `accounts.google.com` (or closed, D11). Google-specific by
  design. The CAPTCHA signal on `accounts.google.com` also means `handoff_required` (no solve attempt).
- **D9. Google SMS format.** Change `DIGIT_CODE` so a single uppercase letter followed by `-` directly
  before the digits is allowed (`G-123456` gives `123456`). Invert the existing `G-582113 … null` test.
  Still `null`: a multi-letter prefix (`ref-123456`, `AB-123456`), a bare leading `-` (`-123456`), digits
  after a digit and dash (`555-123456`). The change is shared with the Gmail reader; that is accepted.
  No sender filter: an unrelated code from another sender in the same window makes the result ambiguous
  (BAD_REQUEST), handled by D7(e).
  Window (existing, unchanged): from the last `auth.login` on the tab if it was within 10 minutes, else
  from the call; minus 30 seconds of slack; never older than 10 minutes. Google sends the SMS when the
  password is submitted, before `auth.code` runs, which is why the window starts at the login.
- **D10. Longer account masks.** `maskAccount` keeps the first 3 and last 2 characters of the local part
  when it is 7 characters or longer (`nol•••k7@gmail.com`), first 1 otherwise (unchanged). Applies
  everywhere masks appear (`auth.status`, consent prompt, results). Why: maintainer choice for telling
  several Gmail logins apart; it shows agents more of each address.
- **D11. Popup flows.** `sessions.ts` `adoptOpened` already adds a popup opened by a session tab to
  the session (not active). The agent calls `tabs {action:"select"}` on the popup before `auth.*`. If the
  popup closes during or after a submit, `auth.login`/`auth.code` return `next:"done"` instead of
  throwing, and the agent re-snapshots the opener.
- **D12. Taint (existing DA1, unchanged).** A tab is tainted until it has navigated *and* 10 minutes have
  passed since the last fill; each fill resets the clock. While tainted, sensitive categories c
  (arbitrary JavaScript: `js.eval`, `nav.wait` fn) and d (credential reads: `cookies.get`, `storage.get`,
  `network.get`) are refused on that tab; `act.*`, `nav.*` and snapshots are not. `network.get` never returns a
  request that started during the taint. Same-tab flows carry the taint back to the third-party site.
  Popup flows taint only the popup; the opener is not tainted (accepted, D11).

## 4. Non-goals

- No dedicated Google opt-in setting (D1, D2).
- No inheritance of sign-in permission from the site that started the flow (D3).
- No new Chrome password reading. The existing `chrome-autofill` provider (submits a form Chrome
  already filled) is unchanged and may act on Google pages.
- No automation of anything in D7(c).
- No change to other `AUTH_DENY_HOSTS` entries, to `VAULT_DENY_HOSTS`, or to the Web Store hard deny.
- No sender allowlist for SMS codes (D9).

## 5. Accepted risks

- **R1. A Google account opens password resets elsewhere.** A prompt-injected agent signed in to Google
  could be steered toward other sites' recovery flows. Controls: per-sign-in consent prompt (skipped if
  the user ticked "always" for that account, in which case only the other controls apply), D2/D3 opt-in,
  D4, D7(c) handoff on Google security pages, D12 taint. The kill switch is a user-triggered stop, not a
  preventive control. Ends when: a reported abuse, then revert per D1.
- **R2. Google may refuse automated sign-in.** It may show "This browser or app may not be secure" in a
  debugger-attached browser. Control: D7(c) handoff; local handoff detaches the debugger, and the user
  may need to reload. Ends when: 3 consecutive live runs (S5 procedure) complete without the block.
- **R3. OAuth consent and account-chooser clicks are not gated.** `act.click` on Google's account chooser
  or on an OAuth consent screen ("Allow") needs only the site policy, not the consent prompt. A
  prompt-injected agent could grant an app access to the user's Google data without typing a secret.
  Maintainer accepted this. Controls: site policy prompt for `accounts.google.com` unless set to `act`,
  D2/D3 opt-in, kill switch. Ends when: a reported abuse, then add a sensitive category for consent screens.
- **R4. Code collisions.** No sender filter (D9): another code arriving in the window fails the call as
  ambiguous. Control: D7(e).

## 6. Open threads

| # | Question | Blocks | Owner / trigger |
|---|---|---|---|
| O1 (load-bearing) | Does Google show the automation block for TabAgent in the real profile, and does local handoff + reload clear it? | Go/no-go after S0 | S0 |
| O2 | Does `fields.ts` detect Google's identifier and password pages, and is the transition in-page (no load) with the password field present when `settle` returns? | S2 fixture shape | S0 |
| O3 | On a popup-based site, does the popup appear in `tabs list`, and does D11 hold? | S3 popup test | S0 |
| O4 | Which origins does the flow visit and where does it land (for example a redirect to `myaccount.google.com`, which D4 refuses)? | S2/S3 expectations | S0 |
| O5 | Do the user's saved Google items match the current sign-in URLs (`itemMatches`)? | S5 | S0 |

## 7. Build order (TDD: each stage starts with failing tests)

- **S0. Spike (local, unmerged).** Run a local build with only D1 applied. Do §2. Walk two flows by
  hand-driven tool calls: one same-tab redirect site, one popup site. Record, per page: `FieldDesc[]`
  dump with values stripped, `classifyNext` result, URL path (no query values), whether it is an
  in-page transition; plus O1–O5. Report as a comment on the epic issue using the template there. No
  secrets, emails, names or account identifiers. **Go/no-go:** if the block (O1) appears on every
  attempt and handoff + reload does not clear it, stop after S1 and S4, and park S2/S3.
- **S1. Policy (D1, D2, D3, D4, D5).** Tests first: through `checkAuthSite` and `resolve`, Google is
  allowed when not denylisted, sign-in enabled and policy `act`; refused when denylisted, when sign-in is
  off, and when policy is too low; every remaining `AUTH_DENY_HOSTS` host still refused; existing DA12
  test still green; `SEEDED_DENYLIST` still contains `accounts.google.com`; `DEFAULT_DENYLIST` gone.
  Docs: `SECURITY.md` gains a "Google sign-in" paragraph (off by default via the denylist, needs §2
  steps 2–3 and per-sign-in consent, D4 pages stay refused, R3); the `AUTH_DENY_HOSTS` comment in
  `policy.ts` drops Google; `DESIGN.md` denylist bullet mentions Google. Exit: unit tests, typecheck.
- **S2. Login (D6, D10, O2, O4).** Tests first: `maskAccount` D10 cases and collisions; `auth.status`
  on a Google-origin fixture lists ids and masks; two-step reuse and single consent (D6e); step-1 result
  is `next:"unknown"` with the password page coming (the agent's cue to call again). New e2e fixture
  `e2e/fixtures/auth/google-two-step.html` built from S0's dumps (structure only), served on the fixture
  host; real Google policy is covered by S1 unit tests and S5. Exit: unit + e2e.
- **S3. Second factor and classification (D7, D8, D9, D11).** Tests first: D9 extraction cases; D8
  classification (Google page with no form gives `handoff_required`, leaving Google gives `done`,
  CAPTCHA on Google gives `handoff_required`); `source:"email"` refused on `accounts.google.com`; TOTP
  without a prior login gives the existing BAD_REQUEST; popup closing after submit gives `done` (D11).
  Exit: unit + e2e.
- **S4. Agent guidance.** Add a short "Sign in with Google" part to `SKILL.md`'s sign-in section
  (≤ 200 tokens; skill soft cap 1500): §2 prerequisites in one line, D6 order, D7 rules, D11, D12. Extend
  `TOOL_RE` in `skill.test.ts` to `auth|captcha|policy` so the lint checks these spans. MCP instructions
  unchanged (#76 covers them). Exit: skill lint, tool budget.
- **S5. Live verification.** Repeat S0's two flows on the merged build after §2. Pass: signed in on the
  third-party site; any handoff is only for a D7(c) page and is logged. Record pass/fail per flow on the
  epic. Three consecutive passes end R2.

## 8. Glossary

- **Denylist**: the user-editable host list in extension settings, seeded from `SEEDED_DENYLIST`. Every
  tool refuses a denylisted host (`resolve`, `checkAuthSite`).
- **`AUTH_DENY_HOSTS`**: hard-coded hosts where the auth tools never sign in. Independent of the denylist.
- **`VAULT_DENY_HOSTS`**: built-in hosts refused for every tool (DA12); Google account pages and vault apps.
- **`HARD_DENY_HOSTS` / `isHardDenied`**: Web Store and browser-internal pages, never reachable.
- Overlap between these lists is intended; they are separate layers. Do not merge them.
- **Taint**: DA1 per-tab state after a fill (D12). Unrelated to the lists above.
- **`handoff_required`**: the existing `classifyNext` value meaning "call `auth.handoff`".
