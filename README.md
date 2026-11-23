# TabAgent

**Let any AI agent drive your real Chrome.** TabAgent is an open-source Chrome extension plus a
small local bridge that exposes your browser to Claude Code, Codex, Cursor, and any MCP or HTTP
client. Agents can navigate, read pages, pull structured data, fill forms, and upload and download
files, using your existing sign-ins.

> Status: **pre-alpha**, not published. This snapshot ends milestone M2 (data and forms). Until the
> permission engine and prompts land (M3), the extension uses the interim policy from
> [docs/DESIGN.md](docs/DESIGN.md) (D17): agents act only on their own tabs, browser pages and the
> Web Store are off-limits, and sensitive actions (password or card submits, risky clicks, page
> scripts, file transfers, taking over a tab) are refused unless the developer setting
> `devAllowSensitive` is on. See [docs/SECURITY.md](docs/SECURITY.md).

## Try it from a checkout

```bash
npm install
npm run build
node packages/bridge/dist/cli.js serve      # prints a pairing code
```

Load `packages/extension/dist` unpacked (`chrome://extensions` → Developer mode → Load unpacked),
open the TabAgent side panel and enter the pairing code (`tabagent status` shows it again). Then
connect an agent:

```bash
claude mcp add tabagent -- node /path/to/tabagent/packages/bridge/dist/cli.js mcp
node packages/bridge/dist/cli.js skill install --claude --codex     # optional usage skill
```

The default `core` profile keeps the tool list small (13 tools). Add more with
`tabagent mcp --profile forms,data` (`forms`, `data`, `dev`, `full`). Shell-only agents can use
`tabagent <tool> --json '{…}'`.

## Layout

```
packages/protocol   tool registry, envelopes, error codes (zod)
packages/extension  MV3 extension: service worker, page library, pairing screen
packages/bridge     Node daemon: MCP server, REST API, CLI
e2e/                Playwright tests with the real extension and bridge
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
