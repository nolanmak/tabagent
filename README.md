# TabAgent

**Let any AI agent drive your real Chrome.** TabAgent is an open-source Chrome extension plus a
small local bridge that exposes your browser to Claude Code, Codex, Cursor, and any MCP or HTTP
client. Agents can navigate, read pages, pull structured data, fill forms, upload and download
files, and inspect network and console activity. They do it with your existing sign-ins, under
permissions you control.

> Status: **pre-alpha**, not yet published. See [docs/DESIGN.md](docs/DESIGN.md) and the
> [roadmap](https://github.com/nolanmak/tabagent/issues).

## Why

- **Agent-agnostic**: one install, every agent. MCP (stdio + Streamable HTTP), REST, and a CLI.
- **Your real browser**: works in your everyday profile, where you are already logged in.
- **Token-efficient**: compact accessibility snapshots with stable element refs instead of HTML.
- **Reliable**: trusted CDP input, auto-waiting, and actionable errors.
- **Safe by default**: per-site permissions, prompts for sensitive actions, a tab group per agent,
  an audit log and a kill switch (`Alt+Shift+K`). Read [docs/SECURITY.md](docs/SECURITY.md) for what
  that does and does not protect against.

## Quick start

1. **Build and start the bridge** (Node 20+):

   ```bash
   npm install && npm run build
   node packages/bridge/dist/cli.js serve    # prints a pairing code
   ```

2. **Load the extension unpacked**: `chrome://extensions` → Developer mode → Load unpacked →
   `packages/extension/dist`.

3. **Pair**: open the TabAgent side panel (toolbar icon) and enter the code. `tabagent status`
   shows it again.

4. **Connect your agent**:

   ```bash
   claude mcp add tabagent -- npx -y tabagent mcp
   codex  mcp add tabagent -- npx -y tabagent mcp
   tabagent skill install --claude --codex     # optional usage skill
   ```

5. Ask your agent to do something in the browser. It works in its own tab group; the first time it
   touches a site, TabAgent asks you in the side panel.

The default `core` profile keeps the tool list small (13 tools). Add more with
`npx tabagent mcp --profile forms,data` (`forms`, `data`, `dev`, `full`). Shell-only agents can
use `tabagent <tool> --json '{…}'`.

## Docs

- [Security model](docs/SECURITY.md)
- [Design](docs/DESIGN.md)

## Layout

```
packages/protocol   tool registry, envelopes, error codes (zod)
packages/extension  MV3 extension: service worker, content scripts, side panel
packages/bridge     Node daemon: MCP server, REST API, CLI (npm: tabagent)
e2e/                Playwright tests with the real extension and bridge
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
