// Opt-in (TABAGENT_MANUAL=1): records docs/demo frames of an agent filling a form through TabAgent.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, Harness } from "../fixture";

test("record demo frames", async ({ h }) => {
  await h.trustFixtures();
  const out = join(process.cwd(), "docs", "demo-frames");
  mkdirSync(out, { recursive: true });
  const c = await h.mcp({ label: "claude-code" });
  let n = 0;
  const page = async () => h.ctx.pages().find((p) => p.url().includes("/form.html"));
  const shot = async () => {
    const p = await page();
    if (p) await p.screenshot({ path: join(out, `f${String(n++).padStart(2, "0")}.png`) });
  };
  await h.ok(c, "nav.goto", { url: `${h.A}/form.html` });
  await shot();
  const s = await h.ok(c, "page.snapshot");
  await shot();
  await h.ok(c, "form.fill", { fields: { "Email address": "neo@matrix.io", "Full name": "Thomas Anderson", Country: "Canada", "Subscribe to newsletter": true, Bio: "Knows kung fu" } });
  await shot();
  await h.ok(c, "act.click", { ref: Harness.ref(s.text, /button "Create account"/) });
  await new Promise((r) => setTimeout(r, 400));
  await shot();
  await shot();
});
