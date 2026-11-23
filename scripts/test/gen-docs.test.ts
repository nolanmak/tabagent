// #23 / #21: tool reference and lite-mode matrix are generated from the
// registry; this test fails when the committed docs are stale.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "@tabagent/protocol";
import { toJSONSchema, z } from "zod";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import * as lib from "../gen-docs-lib.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("generated docs are current", () => {
  it("docs/tools.md matches the registry (run `npm run docs:gen`)", () => {
    expect(readFileSync(join(ROOT, "docs/tools.md"), "utf8")).toBe(lib.renderToolsDoc(TOOLS, toJSONSchema));
  });

  it("docs/lite-mode.md matches the registry (run `npm run docs:gen`)", () => {
    expect(readFileSync(join(ROOT, "docs/lite-mode.md"), "utf8")).toBe(lib.renderLiteDoc(TOOLS));
  });

  it("every registry tool appears in both docs", () => {
    const tools = readFileSync(join(ROOT, "docs/tools.md"), "utf8");
    const lite = readFileSync(join(ROOT, "docs/lite-mode.md"), "utf8");
    for (const t of TOOLS) {
      expect(tools).toContain(`### ${t.name}`);
      expect(lite).toContain(`| \`${t.name}\` |`);
    }
  });
});

describe("renderers handle old and new registry shapes", () => {
  const oldShape = [
    { name: "js.eval", group: "dev", description: "Run JS", params: z.object({ code: z.string() }), level: "full", sensitive: true, pageContent: true, profiles: ["dev"] },
  ];
  const newShape = [
    {
      name: "tabs",
      group: "tabs",
      description: "Manage tabs | pipes escaped",
      params: z.object({ action: z.enum(["list", "attach"]), tabId: z.number().int().optional().describe("Tab id") }),
      level: "none",
      actions: { list: { level: "none" }, attach: { level: "act", sensitive: "f" } },
      pageContent: ["title", "url"],
      lite: "supported",
      handledBy: "extension",
      profiles: ["core"],
    },
    {
      name: "page.screenshot",
      group: "page",
      description: "Shot",
      params: z.object({}),
      level: "read",
      sensitive: undefined,
      pageContent: [],
      lite: "degraded",
      liteNote: "viewport only",
      handledBy: "extension",
      profiles: ["core"],
    },
  ];

  it("old shape: boolean sensitive/pageContent, lite unspecified", () => {
    const md = lib.renderToolsDoc(oldShape, toJSONSchema);
    expect(md).toContain("| [`js.eval`](#jseval) | `js_eval` | full | yes | dev | unspecified | — |");
    expect(md).toContain("page content yes");
    expect(md).toContain("| `code` | string | yes |  |");
    expect(lib.renderLiteDoc(oldShape)).toContain("1 not yet declared in the registry");
  });

  it("new shape: per-action levels and categories, pageContent fields, lite, handledBy", () => {
    const md = lib.renderToolsDoc(newShape, toJSONSchema);
    expect(md).toContain("list: none<br>attach: act");
    expect(md).toContain("attach: f");
    expect(md).toContain("page content `title`, `url`");
    expect(md).toContain("Manage tabs \\| pipes escaped");
    expect(md).toContain('| `action` | "list" \\| "attach" | yes |');
    expect(md).toContain("| `tabId` | integer |  | Tab id |");
    expect(md).toContain("No parameters.");
    const lite = lib.renderLiteDoc(newShape);
    expect(lite).toContain("Totals: 1 supported, 1 degraded, 0 unsupported.");
    expect(lite).toContain("| `page.screenshot` | degraded | viewport only |");
  });

  it("falls back to the zod shape when JSON Schema conversion fails", () => {
    const rows = lib.paramRows({ params: { shape: { a: { description: "x" } } } }, () => {
      throw new Error("nope");
    });
    expect(rows).toEqual([{ name: "a", type: "", required: false, description: "x" }]);
  });

  it("label helpers", () => {
    expect(lib.sensitiveLabel(false)).toBe("");
    expect(lib.sensitiveLabel("c")).toBe("c");
    expect(lib.sensitiveLabel(["a", "b"])).toBe("a, b");
    expect(lib.pageContentLabel([])).toBe("");
    expect(lib.pageContentLabel(false)).toBe("");
    expect(lib.typeLabel({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(lib.typeLabel({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(lib.typeLabel({ const: 1 })).toBe("1");
    expect(lib.typeLabel({})).toBe("any");
    expect(lib.liteOf({ lite: "bogus" })).toBe("unspecified");
    expect(lib.toolSensitiveLabel({ sensitive: "c", sensitiveWhen: { param: "for", values: ["fn"] } })).toBe("c (when for=fn)");
    expect(lib.toolSensitiveLabel({})).toBe("");
    expect(lib.profilesLabel({ profiles: [] })).toBe("full only");
    expect(lib.profilesLabel({ profiles: ["core", "full"] })).toBe("core");
  });
});
