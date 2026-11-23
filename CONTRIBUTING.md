# Contributing

1. `pnpm install`
2. `pnpm -r build`
3. Load `packages/extension/dist` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
4. `pnpm --filter tabagent dev` to run the bridge, then pair from the extension side panel.

Before you open a PR, read [docs/DESIGN.md](docs/DESIGN.md). New tools need a protocol schema, an extension handler, an MCP registration, and an e2e test against a fixture page.
