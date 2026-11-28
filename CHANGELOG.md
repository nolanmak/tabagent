# Changelog

All notable changes to the `@nolmak/tabagent` npm package and the TabAgent extension. Both ship with
the same version (see [docs/release.md](docs/release.md)).

## Unreleased

### Sign-in

- A site can sign in without asking (`authAuto`): sign-ins and codes on that exact origin skip the
  prompt, and the audit log marks each one. Choosing `full` in the side panel turns it on. It is
  never available on password-manager, vault or denylisted hosts, and `policy.site_change` can
  request it with a visible approval. The side panel's new Sign-in column shows and revokes Always
  grants and has an "always allow texted/emailed codes" toggle
  ([#131](https://github.com/nolanmak/tabagent/issues/131)).

### Agents

- Chat page and panel polish: on narrow windows the header title opens a session picker; ↑ in an
  empty message box edits the last message sent from the page; keyboard focus stays on the same
  session when the list refreshes; Quick send for a connected session only offers Send; and
  **Working…** clears as soon as the agent's final reply arrives
  ([#159](https://github.com/nolanmak/tabagent/issues/159)).
- Live view: while a connected session drives a tab, its chat page shows the tab live (a read-only
  screencast above the message box, with a tab picker and a larger view). Side panel rows and the chat
  rail show a pulsing **Working in browser** badge with the tab's title, or the tab count when idle.
  Frames stay inside the extension; password-manager, mail and browser pages are never shown
  ([#164](https://github.com/nolanmak/tabagent/issues/164)).

## 0.2.0 (2026-11-27)

`PROTOCOL_VERSION` is unchanged (1): every wire change since 0.1.0 is additive, so a 0.1.0 extension
still pairs with a 0.2.0 bridge and the reverse. Update both anyway to get the new features, and
restart running agent sessions so their `tabagent mcp` picks up 0.2.0.

### Send to agent

- Send a message, the current tab or a selection from the side panel to a local Claude Code or Codex
  agent ([#115](https://github.com/nolanmak/tabagent/pull/115),
  [#121](https://github.com/nolanmak/tabagent/pull/121),
  [#128](https://github.com/nolanmak/tabagent/pull/128),
  [#132](https://github.com/nolanmak/tabagent/pull/132)).
- Claude Code sessions link back to the bridge through `/v1/inbox` and get messages on their next
  tool call ([#130](https://github.com/nolanmak/tabagent/pull/130)). Instant delivery through
  channels is available as an experiment ([#138](https://github.com/nolanmak/tabagent/pull/138)).
  See [docs/send-to-agent.md](docs/send-to-agent.md).
- Sending a tab grants the linked agent that tab ([#143](https://github.com/nolanmak/tabagent/pull/143)).
- `tabagent setup claude` and `tabagent setup codex` point an agent's MCP entry at
  `npx -y @nolmak/tabagent@latest mcp` so sessions always link
  ([#154](https://github.com/nolanmak/tabagent/pull/154)).
- Readable session titles, and the panel never spawns a new agent by surprise
  ([#149](https://github.com/nolanmak/tabagent/pull/149)).

### Sign-in

- Agents complete Sign in with Google: codes, challenge pages, account choice
  ([#86](https://github.com/nolanmak/tabagent/pull/86), [#87](https://github.com/nolanmak/tabagent/pull/87),
  [#102](https://github.com/nolanmak/tabagent/pull/102)).
- `auth.signup` creates accounts with a Bitwarden-generated password and `auth.confirm_link` follows
  confirmation emails ([#126](https://github.com/nolanmak/tabagent/pull/126),
  [#120](https://github.com/nolanmak/tabagent/pull/120), [#127](https://github.com/nolanmak/tabagent/pull/127)).
- `auth.code` reports the next step ([#136](https://github.com/nolanmak/tabagent/pull/136)); sign-in can
  be unlocked on bank hosts ([#101](https://github.com/nolanmak/tabagent/pull/101)).
- Bitwarden can stay unlocked across restarts, unlocks safely at any time and pulls from the server
  ([#77](https://github.com/nolanmak/tabagent/pull/77), [#99](https://github.com/nolanmak/tabagent/pull/99),
  [#122](https://github.com/nolanmak/tabagent/pull/122), [#129](https://github.com/nolanmak/tabagent/pull/129),
  [#144](https://github.com/nolanmak/tabagent/pull/144)).
- CAPTCHA solving with `captcha.solve` and per-token `autoCaptcha`
  ([#63](https://github.com/nolanmak/tabagent/pull/63)); remote handoff page over Tailscale
  ([#62](https://github.com/nolanmak/tabagent/pull/62)).

### Policy and settings tools

- `policy.site_change` and `policy.mode_change`: agents ask for per-site changes, YOLO mode or
  `devAllowSensitive`, and the user approves them ([#124](https://github.com/nolanmak/tabagent/pull/124),
  [#145](https://github.com/nolanmak/tabagent/pull/145), [#71](https://github.com/nolanmak/tabagent/pull/71)).
- `settings.get`, `settings.change` and `session.kill_all` ([#135](https://github.com/nolanmak/tabagent/pull/135)).
- `workflow.edit_draft` edits draft recipes from the CLI ([#148](https://github.com/nolanmak/tabagent/pull/148));
  recordings capture more step kinds ([#72](https://github.com/nolanmak/tabagent/pull/72),
  [#73](https://github.com/nolanmak/tabagent/pull/73)).
- YOLO mode allows every site and turns sign-in on everywhere
  ([#52](https://github.com/nolanmak/tabagent/pull/52), [#116](https://github.com/nolanmak/tabagent/pull/116)).
- `form.blockers` explains why a form can't submit ([#65](https://github.com/nolanmak/tabagent/pull/65)).

### Approvals

- Approve prompts with Touch ID or a phone page when no side panel is open
  ([#150](https://github.com/nolanmak/tabagent/pull/150)); the approval window pops up when no panel is
  open ([#51](https://github.com/nolanmak/tabagent/pull/51)).
- The restart lock explains itself and can be ended by the user
  ([#141](https://github.com/nolanmak/tabagent/pull/141)).

### Side panel

- Agents section with composer and feed ([#128](https://github.com/nolanmak/tabagent/pull/128)), click a
  session to view its tab ([#134](https://github.com/nolanmak/tabagent/pull/134)), search the Sites list
  ([#119](https://github.com/nolanmak/tabagent/pull/119)), "full" also enables sign-in and pre-approvals
  ([#125](https://github.com/nolanmak/tabagent/pull/125)).
- No more horizontal scrolling and clearer wait labels
  ([#98](https://github.com/nolanmak/tabagent/pull/98), [#75](https://github.com/nolanmak/tabagent/pull/75)).

### Fixes and hardening

- Closed credential readback and submit-gate bypasses ([#54](https://github.com/nolanmak/tabagent/pull/54)).
- Pairing codes last 30 minutes; one live extension socket across a reload
  ([#53](https://github.com/nolanmak/tabagent/pull/53), [#56](https://github.com/nolanmak/tabagent/pull/56)).
- Custom hidden-input checkboxes and radios toggle, found controls resolve to their rendered instance,
  and unreadable checkbox state is reported as unverified
  ([#55](https://github.com/nolanmak/tabagent/pull/55), [#58](https://github.com/nolanmak/tabagent/pull/58),
  [#60](https://github.com/nolanmak/tabagent/pull/60)).

## 0.1.0 (2026-11-23)

First release, published as `@nolmak/tabagent`.
