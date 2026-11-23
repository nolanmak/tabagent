// Root Vitest config (#25).
//
// Unit project: pure modules, no build needed. `npm test` / `npm run test:coverage`.
//
// Coverage floors are the TDD rules in roadmap #28: protocol 90% lines,
// bridge 80%, extension *pure modules* 80%. Adapters (chrome.*, CDP, sockets)
// are covered by e2e and are not counted.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "@tabagent/protocol": `${root}packages/protocol/src/index.ts` };

/**
 * Extension modules that take plain data in and return plain data. Anything
 * placed under a `pure/` directory is counted automatically.
 */
export const EXTENSION_PURE = [
  "packages/extension/src/**/pure/**/*.ts",
  // DOM extractors unit-tested under happy-dom
  "packages/extension/src/pagelib/{forms,extract}.ts",
  "packages/extension/src/background/{snapshot,keys,refs,autowait,router,diff,frames,screenshot-plan,policy,wait}.ts",
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts", "test/unit/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "json-summary"],
      include: ["packages/protocol/src/**/*.ts", "packages/bridge/src/**/*.ts", ...EXTENSION_PURE],
      // cli.ts is the process entry point; it is exercised by spawning the built
      // binary (e2e), which v8 coverage in this process cannot see.
      exclude: ["packages/bridge/src/cli.ts", "**/*.d.ts", "**/test/**"],
      thresholds: {
        "packages/protocol/src/**/*.ts": { lines: 90 },
        "packages/bridge/src/**/*.ts": { lines: 80 },
        ...Object.fromEntries(EXTENSION_PURE.map((g) => [g, { lines: 80 }])),
      },
    },
  },
});
