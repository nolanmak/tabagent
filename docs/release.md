# Release checklist

The npm package (`tabagent`) and the Chrome Web Store build ship together and must carry the
**same version and the same `PROTOCOL_VERSION`** (#23). `npm run check-versions -- --tag vX.Y.Z`
enforces it, and the release workflow runs it first.

Do not release before every M3 (Safety) issue is closed (D17). OT2 (`debugger` required or
optional) must be decided before the first Web Store submission.

## 1. Decide the protocol version

`PROTOCOL_VERSION` lives in `packages/protocol/src/messages.ts` and is bundled into both the
bridge and the extension. Bump it (an integer) when the hello/welcome handshake, the Command or
Result envelope, an error code, or any tool's params/result change in a way an older peer would
misread. Both sides refuse a mismatched peer with `VERSION_MISMATCH` and a hint saying which side
to update (D5), so a bump means users must update **both** the npm package and the extension.

## 2. Bump versions (all must match)

- [ ] `packages/bridge/package.json` `version`
- [ ] `packages/bridge/src/version.ts` `BRIDGE_VERSION` (if it holds a literal)
- [ ] `packages/extension/package.json` `version`
- [ ] `packages/extension/manifest.json` `version`
- [ ] `packages/protocol/package.json` `version`
- [ ] `PROTOCOL_VERSION` if step 1 says so
- [ ] `npm install` to refresh `package-lock.json`
- [ ] `npm run check-versions -- --tag vX.Y.Z` passes

## 3. Check everything locally

- [ ] `npm run lint && npm run typecheck && npm run test:coverage`
- [ ] `npm run build && npm run test:release` (packaging, examples, manifest permissions)
- [ ] `npm run e2e`
- [ ] `npm run tool-budget`
- [ ] `npm run docs:gen` leaves no diff (`docs/tools.md`, `docs/lite-mode.md`)
- [ ] New permissions are justified in [store/permissions.md](store/permissions.md) (the release
      test fails otherwise) and the [privacy policy](store/privacy-policy.md) is still accurate

## 4. Run the release workflow

Actions → **Release** → Run workflow with `tag = vX.Y.Z`. Leave `dry_run` on for a first pass; it
builds, checks versions, runs the tests, zips the Web Store build
(`tabagent-extension-vX.Y.Z.zip`, built with `TABAGENT_STORE_BUILD=1` so the dev `key` is dropped)
and runs `npm publish --dry-run`. Re-run with `dry_run` off to publish. Publishing needs the
`NPM_TOKEN` secret on the `release` environment.

### Publishing by hand (security key)

The npm account uses a security key for 2FA, so a local publish goes through a browser
confirmation. From a clean checkout of the release commit on `main`:

```bash
git checkout main && git pull
npm ci
npm run check-versions -- --tag vX.Y.Z
npm run build && npm run test:release
npm publish -w @nolmak/tabagent --access public --dry-run   # check the file list
npm publish -w @nolmak/tabagent --access public --auth-type=web
```

The last command prints an `https://www.npmjs.com/auth/cli/...` URL: open it and tap the key. In a
non-interactive shell, wrap it so npm still sees a terminal:
`script -q /tmp/npm-publish.log npm publish -w @nolmak/tabagent --access public --auth-type=web`.
The tarball can 404 for a few minutes after `+ @nolmak/tabagent@X.Y.Z` while npm stages it.

Running agent sessions keep the `tabagent mcp` they started with. After publishing, restart them; if
`npx` keeps serving a cached older copy, use `npx -y @nolmak/tabagent@latest mcp` in the MCP config
(or clear `~/.npm/_npx`). Restart a running `tabagent serve` from the old version too.

## 5. Web Store

- [ ] Download the zip artifact from the workflow run
- [ ] Upload it in the Chrome Web Store developer dashboard
- [ ] Paste the single-purpose statement and per-permission justifications from
      [store/permissions.md](store/permissions.md)
- [ ] Link the privacy policy ([store/privacy-policy.md](store/privacy-policy.md), published at a
      public URL)
- [ ] Screenshots and the demo GIF from the README

## 6. After publishing

- [ ] Tag the commit `vX.Y.Z` and push the tag
- [ ] GitHub release notes; call out a `PROTOCOL_VERSION` bump ("update both the extension and
      `npm i -g @nolmak/tabagent`")
- [ ] Smoke test: `npx @nolmak/tabagent@X.Y.Z --version`, `tabagent serve`, pair the store extension
