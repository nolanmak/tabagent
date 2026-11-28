import { test, expect, Harness } from "./fixture";

// #117: search/filter the Settings -> Sites list.
const settings = (h: Harness) => h.sw.evaluate(async () => (globalThis as any).__tabagent.getSettings());

test("Sites search filters rows, survives a settings re-render, and clears", async ({ h }) => {
  const policies: Record<string, string> = {
    "https://app.mercury.com": "read",
    "https://mercury.com": "act",
    "https://accounts.google.com": "full",
    "https://zeta.example": "read",
  };
  for (let i = 0; i < 20; i++) policies[`https://site${String(i).padStart(2, "0")}.example`] = "read";
  await h.setPolicies(policies);
  const total = Object.keys(policies).length;

  const panel = await h.openPanel();
  await panel.click("#settingsBox summary");
  const rows = panel.locator("#sites tr[data-site]");
  await expect(rows).toHaveCount(total);
  await expect(panel.locator("#siteCount")).toHaveText(`${total} sites`);
  // Sorted by host.
  await expect(rows.first().locator(".origin")).toHaveText("https://accounts.google.com");

  const search = panel.getByLabel("Search sites");
  await search.fill("MERCURY");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".origin")).toHaveText(["https://app.mercury.com", "https://mercury.com"]);
  await expect(panel.locator("#siteCount")).toHaveText(`2 of ${total} sites`);

  // Editing a filtered row re-renders the panel; the filter must still be applied.
  await panel.selectOption('select[data-policy][data-origin="https://mercury.com"]', "full");
  await expect.poll(async () => (await settings(h)).sites["https://mercury.com"].policy).toBe("full");
  await panel.locator('input[data-lite][data-origin="https://app.mercury.com"]').check();
  await expect.poll(async () => (await settings(h)).sites["https://app.mercury.com"].lite).toBe(true);
  await expect(rows).toHaveCount(2);
  await expect(search).toHaveValue("MERCURY");
  await expect(panel.locator("#siteCount")).toHaveText(`2 of ${total} sites`);

  // No match.
  await search.fill("nothing-here");
  await expect(rows).toHaveCount(0);
  await expect(panel.locator("#sites")).toContainText("No sites match");
  await expect(panel.locator("#siteCount")).toHaveText(`0 of ${total} sites`);

  // Clear button restores every row.
  await panel.getByRole("button", { name: "Clear site search" }).click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(total);
  await expect(search).toBeFocused();

  // Escape clears too.
  await search.fill("zeta");
  await expect(rows).toHaveCount(1);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(total);
  await panel.close();
});
