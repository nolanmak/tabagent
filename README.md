# Tabwright

**Let any AI agent drive your real Chrome.** Tabwright is an open-source Chrome extension plus a tiny local bridge that exposes your browser to Claude Code, Codex, Cursor, and any MCP or HTTP client. Agents can navigate, read pages, pull structured data, fill forms, upload/download files, and inspect network/console. They do it with your existing sign-ins, under permissions you control.

> Status: **design / pre-alpha.** See [docs/DESIGN.md](docs/DESIGN.md) and the [issues](https://github.com/nolanmak/tabwright/issues) for the roadmap.

## Why

- **Agent-agnostic**: one install, every agent. MCP (stdio + Streamable HTTP), REST, and a CLI.
- **Your real browser**: works in your everyday profile, so agents can act where you're already logged in.
- **Token-efficient**: compact accessibility snapshots with stable element refs instead of raw HTML.
- **Reliable**: trusted CDP input events, auto-waiting, and actionable errors.
- **Safe by default**: per-site permissions, confirmation for sensitive actions, an isolated tab group per agent, an audit log, and a kill switch.

## Planned usage

```bash
npm i -g tabwright
tabwright serve                          # prints a pairing code; enter it in the extension
claude mcp add tabwright -- npx tabwright mcp
codex  mcp add tabwright -- npx tabwright mcp
```

## Layout

```
packages/protocol   shared command/result schemas (zod)
packages/extension  MV3 extension: service worker, content scripts, side panel
packages/bridge     Node daemon: MCP server, REST API, CLI
```

## Contributing

Issues labelled `good first issue` are a good place to start. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
