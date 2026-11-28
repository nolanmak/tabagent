import type { Agent } from "@tabagent/protocol";
import { agentFeedLineHtml, agentRowHtml, agentRowView } from "../packages/extension/src/pure/agents";
import { test, expect } from "./fixture";

// Regression: long origins, URLs, labels and tab titles used to widen the side panel and give it a
// horizontal scrollbar (flex rows that could not shrink, and a <select> sized to its longest option).
const LONG = "https://www.example-really-long-subdomain-name.co.uk/path/to/a/very/long/resource/with/no/breaks?query=abcdefghijklmnopqrstuvwxyz0123456789";

test("side panel never scrolls horizontally with long content", async ({ h }) => {
  // #131: the Sign-in column with every control, Always grants and the payment warning showing.
  const longSite = "https://accounts.supercalifragilisticexpialidocious-example.com";
  await h.setPolicies({ [longSite]: "act" }, { sites: { [longSite]: { auth: true, authAuto: true, authAlways: ["1password:abcdefghijklmnopqrstuvwxyz0123456789", "code-source:sms", "code-source:email", "confirm-link:email"] } } });
  const panel = await h.openPanel();
  await panel.setViewportSize({ width: 320, height: 900 });
  await panel.waitForSelector("#sites tr", { state: "attached" });
  // Agents rows and send-feed lines (#90) from the panel's own pure renderers, with long names and cwds.
  const now = Date.now();
  const longAgent = (over: Partial<Agent> = {}): Agent => ({
    id: "claude:1:1",
    vendor: "claude",
    name: `an-agent-with-a-very-long-name-${"x".repeat(80)}`,
    cwd: `/Users/someone/${"deeply-nested-folder/".repeat(6)}${"y".repeat(90)}`,
    startedAt: now,
    pid: 123456,
    status: "busy",
    statusLabel: "waitingOnUserInput",
    linked: true,
    canDriveTab: true,
    delivery: "spawn",
    ...over,
  });
  const rows =
    agentRowHtml(agentRowView(longAgent({ title: `A readable session title that goes on and on ${"z".repeat(90)}`, delivery: "channel" }), now), true) +
    agentRowHtml(agentRowView(longAgent({ id: "claude:2:2", linked: false, canDriveTab: false, delivery: "none", remoteControlUrl: "https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv" }), now), false) +
    agentRowHtml(agentRowView(longAgent({ id: "codex:t", vendor: "codex", name: null, delivery: "none", status: "error" }), now), false);
  const spawnLabel = agentRowView(longAgent({ linked: false, delivery: "none" }), now).spawnLabel!;
  const feed = agentFeedLineHtml({ requestId: "r", ts: now, agentName: longAgent().name!, vendor: "claude", route: "spawn", state: "failed", code: "WORKSPACE_UNTRUSTED", detail: `Workspace not trusted. Run claude in ${longAgent().cwd} once and accept the trust prompt.` });
  // The renderers' own markup for a handoff row and a capture-tab option, filled with long text.
  await panel.evaluate(
    ({ long, rows, feed, spawnLabel }) => {
      document.getElementById("handoffBox")!.hidden = false;
      document.getElementById("handoffs")!.innerHTML = `<li><span><b>claude-code-with-a-very-long-client-name</b> · ${long}<br><span class="muted small">${long}</span></span><span><button>Cancel</button> <button class="primary">Done</button></span></li>`;
      document.getElementById("manualCaptureTab")!.innerHTML = `<option>A very long tab title ${long}</option>`;
      document.getElementById("agentsBox")!.hidden = false;
      document.getElementById("agents")!.innerHTML = rows;
      // #151: the Quick send composer opens under the selected row.
      const slot = document.createElement("li");
      slot.className = "quick-send";
      slot.append(document.getElementById("agentComposer")!);
      document.querySelector("#agents li.agent")!.after(slot);
      document.getElementById("agentFeed")!.innerHTML = feed;
      // #137: the secondary Start a new session button, labelled with a long folder name.
      const spawn = document.getElementById("agentSpawn")!;
      spawn.hidden = false;
      spawn.textContent = spawnLabel;
      document.getElementById("agentTabTitle")!.textContent = `A very long tab title ${long}`;
      // The selection preview (#92) is truncated in display, but must also wrap an unbroken run.
      document.getElementById("agentSelectionPreview")!.textContent = `“${long.slice(0, 79)}…”`;
      document.getElementById("agentComposerNote")!.textContent = "The tab URL is 2,001 characters; the limit is 2,000. Untick Share this tab to send without it.";
      document.querySelectorAll("details").forEach((d) => ((d as HTMLDetailsElement).open = true));
    },
    { long: LONG, rows, feed, spawnLabel },
  );
  await expect(panel.locator(`#sites tr[data-site="${longSite}"] .signin-warn`)).toBeVisible();
  const withRows = await panel.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(withRows.scrollWidth).toBeLessThanOrEqual(withRows.clientWidth);
  // The Sites search toolbar (#117), with a long query, a count and the clear button showing.
  await panel.getByLabel("Search sites").fill(LONG);
  await expect(panel.locator("#siteCount")).toHaveText("0 of 1 site");
  await expect(panel.getByRole("button", { name: "Clear site search" })).toBeVisible();
  const { scrollWidth, clientWidth } = await panel.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await panel.close();
});
