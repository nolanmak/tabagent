// #61 opt-in e2e: captcha.solve against the real vendor widgets on the fixture pages, which use each
// vendor's published test site keys. Needs network access to the vendors, so it only runs with
// TABAGENT_CAPTCHA_E2E=1. For the solver path set CAPSOLVER_API_KEY (the bridge the harness spawns
// inherits it); without it only the free trusted-click path is exercised.
//
//   TABAGENT_CAPTCHA_E2E=1 [CAPSOLVER_API_KEY=…] npx playwright test e2e/captcha.spec.ts
import { test, expect } from "./fixture";
import { view } from "./view";

test.skip(process.env.TABAGENT_CAPTCHA_E2E !== "1", "opt-in: TABAGENT_CAPTCHA_E2E=1 (needs the vendors' servers)");
test.describe.configure({ mode: "serial" });

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

for (const [page, vendor] of [
  ["captcha-hcaptcha.html", "hcaptcha"],
  ["captcha-recaptcha.html", "recaptcha"],
  ["captcha-turnstile.html", "turnstile"],
] as const) {
  test(`${vendor}: captcha.solve solves the widget and the page callback fires`, async ({ h }) => {
    test.setTimeout(180_000);
    await h.trustFixtures();
    const c = await h.mcp({ profile: "auth,data" });
    await h.ok(c, "nav.goto", { url: `${h.A}/${page}` });
    await h.ok(c, "nav.wait", { for: "networkidle" });
    await settle();
    const r = await h.call(c, "captcha.solve", {});
    test.info().annotations.push({ type: "captcha.solve", description: r.text.slice(0, 300) });
    if (process.env.TABAGENT_E2E_VERBOSE) console.log(`${vendor}: ${r.text.slice(0, 300)}`);
    if (r.isError) {
      // Without a provider key the only acceptable failure is the solver path being unavailable.
      expect(process.env.CAPSOLVER_API_KEY).toBeUndefined();
      expect(r.text).toMatch(/CAPTCHA_UNSOLVED[\s\S]*no_provider/);
      return;
    }
    expect(view(r).json).toMatchObject({ vendor, solved: true });
    const text = view(await h.ok(c, "page.text", {})).json.text as string;
    expect(text).toMatch(/captcha ok/);
  });
}
