# TabAgent privacy policy

_Last updated: 2026-11-23_

TabAgent is an open-source Chrome extension and local bridge that lets AI agents you run on your
own computer operate your browser tabs under permissions you control.

## What TabAgent collects

Nothing is sent to TabAgent's authors or to any server operated by them. TabAgent has no
analytics, telemetry, advertising or remote logging.

## Where data goes

The extension communicates only with the TabAgent bridge running on your own computer at
`127.0.0.1`. When an agent you have connected asks for it, page content (accessibility snapshots,
text, extracted tables and links, screenshots, form fields, dialog messages, and, for tools you
approve, cookies, storage, network activity and downloaded files) is passed from the extension to
the bridge and from there to that agent. What the agent then does with it, including sending it to
a model provider, is governed by that agent's own terms and privacy policy, not by TabAgent.

## What is stored, and where

- In the extension (`chrome.storage.local`): the pairing secret, per-site policies, the denylist,
  pre-approvals and settings. In `chrome.storage.session`: which tabs each agent session owns,
  allow-once grants and the paused state. These never leave the browser except the secret, which
  is used only to authenticate to your local bridge.
- On your computer, in `~/.tabagent/` (readable only by your user): the bridge configuration and an
  audit log of agent actions. Audit records contain the tool name, the site's origin, redacted
  parameters, the outcome and a size and hash of each result, not page contents or screenshots.

You can delete all of it by removing the extension and the `~/.tabagent` directory.

## Sensitive data

Password and card field values are masked in snapshots, form descriptions, the live feed and the
audit log. Screenshots are not masked. Reading cookies or storage, uploading files, reading
downloads, running page JavaScript and submitting forms with password or payment fields require
your confirmation unless you pre-approve them for a site.

## Permissions

Why each Chrome permission is needed: [permissions.md](permissions.md).

## Changes and contact

Changes to this policy are made in the public repository and dated above. Questions: open an issue
on the TabAgent GitHub repository.
