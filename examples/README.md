# Agent examples

Each folder holds a ready-to-copy MCP config that starts `tabagent mcp` over stdio. The bridge
daemon is started for you on first use (it runs detached and is shared by every agent); pair the
extension once with the code from `tabagent status`.

| Agent | File | Where it goes | One-liner |
|---|---|---|---|
| Claude Code | [claude-code/.mcp.json](claude-code/.mcp.json) | project root (`.mcp.json`) | `claude mcp add tabagent -- npx -y tabagent mcp` |
| Codex | [codex/config.toml](codex/config.toml) | `~/.codex/config.toml` | `codex mcp add tabagent -- npx -y tabagent mcp` |
| Cursor | [cursor/mcp.json](cursor/mcp.json) | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` | — |

Options go after `mcp`: `--profile forms,data` widens the tool set (default `core`, see
[docs/tools.md](../docs/tools.md)); `TABAGENT_TOKEN` in `env` uses a narrowed token instead of the
local secret.

Install the usage skill too: `npx tabagent skill install --claude --codex`.

`test/release/examples.test.ts` runs the command in every file here against the locally built bridge,
initializes an MCP session and lists tools, so a config that stops working fails CI.

Claude Desktop is not listed because nobody has run it yet (#23).
