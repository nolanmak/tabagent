// Re-record the AX-tree fixtures used by the snapshot golden tests:
//   node packages/extension/test/record-ax.mjs
// Serves e2e/fixtures, loads each page in Playwright's Chromium and stores
// Accessibility.getFullAXTree plus the backendNodeIds of sensitive inputs.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../e2e/fixtures");
const out = join(here, "fixtures/ax");
mkdirSync(out, { recursive: true });

export const PAGES = ["index", "form", "table", "article", "modal", "checkout", "custom-select", "drag", "masked", "delay", "shadow"];

const server = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(fixtures, p)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const cdp = await page.context().newCDPSession(page);
for (const name of PAGES) {
  await page.goto(`${origin}/${name}.html`);
  if (name === "delay") await page.waitForSelector("text=Late button");
  await page.waitForTimeout(100);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type=password], input[autocomplete^="cc-"], input[name*="card" i]' });
  const sensitive = [];
  for (const id of nodeIds) sensitive.push((await cdp.send("DOM.describeNode", { nodeId: id })).node.backendNodeId);
  // Strip volatile/noisy fields to keep fixtures small and stable.
  const slim = nodes.map((n) => ({
    nodeId: n.nodeId,
    ...(n.ignored ? { ignored: true } : {}),
    ...(n.role ? { role: { value: n.role.value } } : {}),
    ...(n.name?.value ? { name: { value: n.name.value } } : {}),
    ...(n.value && n.value.value !== undefined ? { value: { value: n.value.value } } : {}),
    ...(n.properties?.length ? { properties: n.properties.map((p) => ({ name: p.name, value: { value: p.value.value } })) } : {}),
    ...(n.childIds?.length ? { childIds: n.childIds } : {}),
    ...(n.parentId ? { parentId: n.parentId } : {}),
    ...(n.backendDOMNodeId != null ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
  }));
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ page: `${name}.html`, nodes: slim, sensitive }));
  console.log(name, slim.length, "nodes", sensitive.length, "sensitive");
}
await browser.close();
server.close();
