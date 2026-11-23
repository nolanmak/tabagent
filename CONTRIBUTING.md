# Contributing

TabAgent uses **npm workspaces and esbuild** (OT3). Node 20+ (CI uses 22).

```bash
npm install
npm run build          # packages/extension/dist, then packages/bridge/dist
```

Load `packages/extension/dist` as an unpacked extension (`chrome://extensions` → Developer mode →
Load unpacked), run `node packages/bridge/dist/cli.js serve`, and pair from the side panel. The dev
build has a fixed extension ID; the Web Store build (`TABAGENT_STORE_BUILD=1`) drops the key.

## Scripts

| Script | What it does | CI job |
|---|---|---|
| `npm run lint` | ESLint, and checks `docs/tools.md` / `docs/lite-mode.md` are current | lint |
| `npm run typecheck` | `tsc --noEmit` over packages, tests and e2e | typecheck |
| `npm test` | Vitest unit tests (`packages/*/test`, `bench/test`, `scripts/test`) | |
| `npm run test:coverage` | unit tests with coverage floors | unit |
| `npm run build` | extension then bridge | build |
| `npm run test:release` | tests against the build: `--version`, MV3 manifest, permission justifications, example configs, `npm pack` install | build |
| `npm run e2e` | Playwright with the real extension, bridge and an MCP client | e2e |
| `npm run tool-budget` | MCP `tools/list` size per profile (core ≤ 2000, full ≤ 8000 tokens) | tool-budget |
| `npm run docs:gen` | regenerate the tool reference and lite-mode matrix from the registry | |
| `npm run check-versions` | npm and extension versions agree | build |
| `npm run bench -- --dry-run` | benchmark with a scripted fake agent | (in `npm test`) |

CI order: lint → typecheck → unit → build → e2e and tool-budget. Branch protection on `main`
requires all of them.

## How we build: test-first

Read the roadmap (#28) and [docs/DESIGN.md](docs/DESIGN.md) first. The rules:

1. **Red, green, refactor.** A PR's first commit adds the failing tests from the issue's test plan;
   link the red run in the PR.
2. **Logic lives in pure modules**, unit-tested in Vitest with no `chrome.*` and no CDP. Tests go
   in `packages/<pkg>/test/*.test.ts`; use `// @vitest-environment happy-dom` for DOM tests.
3. **Chrome and CDP sit behind thin adapters** with no decisions in them; e2e covers them.
4. **Every tool has an e2e test** against a fixture page through a real MCP client; add the
   fixture in the same PR.
5. **Every error code has a test that produces it**, and every decision table row is a
   table-driven test.
6. **A bug fix starts with a failing regression test.**
7. **Coverage floors:** protocol 90% lines, bridge 80%, extension pure modules 80%. The extension
   pure-module list is in `vitest.config.ts` (`EXTENSION_PURE`); put a new pure module under
   `packages/extension/src/pure/` or add it to the list. Adapters are not counted.
8. **Security properties are tests, not prose**: each D18 gate has a test for the gated path and
   each bypass path.

## Adding a tool

A new tool needs a registry entry in `packages/protocol` (params, result, level, sensitive
category, `pageContent`, profiles, `lite`, `handledBy`), an extension handler, an e2e test against
a fixture page, and `npm run docs:gen`. The registry drives the MCP list, REST routes and CLI. If it
pushes the `core` or `full` profile over budget, `npm run tool-budget` fails. A new Chrome
permission must be justified in [docs/store/permissions.md](docs/store/permissions.md).
