import { test as base } from "@playwright/test";
import { Harness } from "./harness";

export const test = base.extend<{}, { h: Harness }>({
  h: [
    async ({}, use) => {
      const h = new Harness();
      await h.start();
      await use(h);
      await h.stop();
    },
    { scope: "worker", timeout: 60_000 },
  ],
});
export { expect } from "@playwright/test";
export { Harness };
