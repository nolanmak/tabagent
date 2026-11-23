// Live environment for real runs: the e2e harness (#22) provides Chromium with
// the unpacked extension, a bridge on a temp port/home and real pairing; this
// module serves bench/fixtures on two local origins, pre-grants them and turns
// on devAllowSensitive (the same seeding as the e2e suite, #24), then reads
// each task's end state from the browser.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
export const CLI = join(ROOT, "packages/bridge/dist/cli.js");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".csv": "text/csv" };

function fixtureServer(host) {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const file = join(HERE, "fixtures", u.pathname === "/" ? "links.html" : u.pathname.replace(/\.\./g, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({ server, origin: `http://${host}:${server.address().port}` })));
}

async function loadHarness() {
  // Inside the repo so the bundle resolves @playwright/test and the MCP SDK from node_modules.
  const outfile = join(ROOT, "node_modules/.cache/tabagent-bench", `harness-${process.pid}.mjs`);
  await build({ entryPoints: [join(ROOT, "e2e/harness.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile, logLevel: "error",
    // keep the harness resolving its paths (CLI, extension dist, fixtures) relative to e2e/
    define: { "import.meta.url": JSON.stringify(pathToFileURL(join(ROOT, "e2e/harness.ts")).href) },
  });
  return (await import(pathToFileURL(outfile).href)).Harness;
}

export async function liveEnv() {
  const Harness = await loadHarness();
  const h = new Harness();
  await h.start();
  const a = await fixtureServer("localhost");
  const b = await fixtureServer("127.0.0.1");
  // trustFixtures() grants h.A and h.B; point them at the bench fixture origins.
  h.A = a.origin;
  h.B = b.origin;
  await h.trustFixtures({ devAllowSensitive: true });

  const pagesOnOrigin = () => h.ctx.pages().filter((p) => p.url().startsWith(a.origin));
  return {
    home: h.home,
    async prepare(task) {
      for (const p of pagesOnOrigin()) await p.close().catch(() => {});
      const p = await h.ctx.newPage();
      await p.goto(`${a.origin}/links.html`);
      await p.evaluate(() => localStorage.clear());
      await p.close();
      return { startUrl: `${a.origin}/${task.page}` };
    },
    async state(_task, final) {
      const pages = pagesOnOrigin();
      let page = pages[pages.length - 1];
      let own = false;
      if (!page) {
        page = await h.ctx.newPage();
        await page.goto(`${a.origin}/links.html`);
        own = true;
      }
      const s = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText ?? "",
        bench: JSON.parse(localStorage.getItem("bench") || "{}"),
      }));
      if (own) {
        s.url = null;
        s.title = null;
        s.text = "";
        await page.close();
      }
      return { ...s, answer: final };
    },
    async close() {
      await h.stop();
      a.server.close();
      b.server.close();
    },
  };
}
