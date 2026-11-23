# TabAgent

**Let any AI agent drive your real Chrome.** TabAgent is an open-source Chrome extension plus a
small local bridge that exposes your browser to Claude Code, Codex, Cursor, and any MCP or HTTP
client.

> Status: **pre-alpha (M0 skeleton)**, not published. Agents can open, list, select and close their
> own tabs and navigate them. See [docs/DESIGN.md](docs/DESIGN.md) and the
> [roadmap](https://github.com/nolanmak/tabagent/issues).

## Quick start (from source)

```bash
npm install
npm run build
node packages/bridge/dist/cli.js serve      # prints a pairing code
```

Load `packages/extension/dist` unpacked (`chrome://extensions` → Developer mode → Load unpacked),
open the TabAgent side panel (toolbar icon) and enter the code. `tabagent status` shows it again.

Connect an agent over stdio MCP:

```bash
claude mcp add tabagent -- node /path/to/tabagent/packages/bridge/dist/cli.js mcp
```

Shell-only agents can use `tabagent <tool> --json '{…}'`.

Until the permission engine lands, agents act only on tabs they opened, never on browser pages,
extension pages or the Chrome Web Store, and every sensitive action is refused.

## Layout

```
packages/protocol   tool registry, envelopes, error codes (zod)
packages/extension  MV3 extension: service worker, pairing screen
packages/bridge     Node daemon: MCP server, REST API, CLI (npm: tabagent)
e2e/                Playwright tests with the real extension and bridge
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
