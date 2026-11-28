# Chrome Web Store: permission justifications

Every permission the extension requests is justified here. `test/release/store-permissions.test.ts`
reads the `###` headings below and fails unless they equal the built manifest's permissions
exactly (required plus optional, API plus host). Adding a permission to the manifest without a
justification here fails CI, and so does leaving a justification for a permission that was removed.

**Single purpose.** TabAgent lets AI agents that the user runs on their own computer (Claude Code,
Codex, Cursor, or any MCP/HTTP client) operate the user's Chrome tabs through a local bridge on
`127.0.0.1`, under per-site permissions and confirmation prompts that the user controls.

No data leaves the user's machine. The extension talks only to the TabAgent bridge on loopback
(see [privacy-policy.md](privacy-policy.md)).

## API permissions

### `debugger`

The Chrome DevTools Protocol is how TabAgent reads the accessibility tree that agents use to
understand a page, dispatches trusted mouse and keyboard input (so clicks and typing behave like a
person's, including on React and Vue controlled inputs), takes screenshots of background tabs
without focusing them, handles JavaScript dialogs, and reports network and console activity when a
developer asks for it. The debugger attaches only to tabs inside an agent's own tab group, lazily on
the first command that needs it, and detaches when the session ends, the tab leaves the session, or
the user presses the kill switch. Chrome's "started debugging this browser" bar stays visible while
it is attached. Users who do not want this can switch a site to lite mode, which uses content
scripts only. (Whether `debugger` becomes an optional permission is open thread OT2; if it moves to
`optional_permissions`, this justification still applies and the test still matches it.)

### `tabs`

Agents open, list, select and close tabs, and TabAgent needs each tab's URL to enforce the user's
per-site policy before every command (the tab's origin is re-checked each time).

### `tabGroups`

Each agent session gets its own labelled, coloured tab group, so the user can see at a glance which
tabs an agent is driving and which agent owns them. On session end the group is collapsed or
ungrouped; user tabs that were attached are never closed.

### `sidePanel`

The side panel is TabAgent's control surface: pairing with the local bridge, the live action feed,
approving or denying permission and sensitive-action prompts, per-site policies, and the kill
switch / resume button.

### `storage`

`chrome.storage.local` keeps the pairing secret (restricted to trusted extension contexts, so content
scripts cannot read it), site policies, the denylist, pre-approvals and settings.
`chrome.storage.session` keeps session state that must survive a service-worker restart: which tabs
each session owns, allow-once grants and the paused flag.

### `downloads`

Agents can wait for and list downloads started by their own tabs (`downloads.list`,
`downloads.wait`), and read a downloaded file after the user approves it (`downloads.read`). Only
downloads started by the session's own tabs are visible to that session.

### `cookies`

`cookies.get` lets a developer's agent read cookies for the current site while debugging. It is a
credential read, so it always asks the user first unless the user pre-approved it for that site, and
the call is recorded in the local audit log.

### `alarms`

When the bridge is not running, the service worker can be evicted. A 30-second alarm wakes it to
retry the connection to the local bridge, so the user does not have to reload the extension after
starting the bridge.

### `contextMenus`

Adds one right-click item, "Send to agent", on pages and text selections. Its submenu lists up to
five agents the user recently messaged from the side panel, plus "Choose…". Clicking an entry sends
nothing: it remembers which agent, tab and selected text the user picked (in session storage, for at
most two minutes) and opens the side panel, where the user writes the message and presses Send.

### `notifications`

When an agent needs approval (for example to act on a new site or to submit a form with a password
field), TabAgent raises a notification so the user notices the prompt even when the side panel is
closed. Chrome only opens the side panel on a user gesture, so clicking the notification is how the
prompt is reached.

### `scripting`

Content scripts provide page text and markdown extraction, table and link extraction, the "agent is
driving" border and element highlights, and the lite-mode driver that works without `debugger`.
They are injected only into tabs the agent's session owns.

### `webNavigation`

TabAgent tracks navigations and frame loads in session tabs to report what an action did (for
example "this click navigated to …"), to wait for page loads, to invalidate element references when
a document is replaced, and to keep popups opened by a session tab inside that session.

## Host permissions

### `<all_urls>`

The user decides which sites an agent may use, at run time, per origin; TabAgent cannot know that
list in advance. Host access is needed to attach the debugger, inject content scripts and read cookies
on the sites the user approves. Unknown sites are not acted on until the user answers a prompt; a
built-in, user-editable denylist (Chrome internal pages, the Web Store, password managers, banking)
is refused outright; and every command is checked against the user's policy for the tab's current
origin.
