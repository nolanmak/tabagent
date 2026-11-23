// act.upload and downloads.* (#11, D31, D18e).
import { TabAgentError, TIMEOUTS } from "@tabagent/protocol";
import { wireDownload } from "../../pure/dlattr";
import { splitKey } from "../cdp";
import { tracker } from "../downloads";
import { act, cdp, type Ctx } from "./ctx";
import { canonicalUploadPaths, staticGate } from "./gates";

type Handler = (c: Ctx) => Promise<unknown>;

/** Per session: ids already handed out by downloads.wait (so a later wait returns the next one). */
const waited = new Map<string, Set<number>>();

export const fileHandlers: Record<string, Handler> = {
  async "act.upload"(c) {
    const paths = c.p.paths as string[];
    return act(
      c,
      "act",
      async (t) => {
        const tab = cdp(t.drv).tab;
        const ref = c.p.ref as string;
        const timeout = c.p.timeout ?? TIMEOUTS.action;
        // 1) extension gate (category e) before anything touches the disk
        await staticGate(c, t.url, "e", `upload ${paths.length} file(s): ${paths.map((p) => p.split(/[\\/]/).pop()).join(", ")}`, ["Sends local files to the site"]);
        // 2) the target: the file input itself, its label, a wrapper, or a control that opens a chooser
        const direct = (await t.drv.call("resolveFileInput", [], { ref })) as { ref: string } | null;
        let backendNodeId: number;
        let sessionId: string | undefined;
        if (direct?.ref) {
          const ri = await t.drv.resolveRef(direct.ref);
          backendNodeId = ri.backendNodeId;
          [sessionId] = splitKey(ri.frameKey);
        } else {
          await tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
          try {
            const opened = tab.waitEvent((m) => m === "Page.fileChooserOpened", Math.min(timeout, 3000));
            await t.drv.click(ref, { timeout });
            const ev = await opened;
            if (!ev?.params?.backendNodeId) throw new TabAgentError("NOT_ACTIONABLE", `${ref} is not a file input and clicking it did not open a file chooser`, "Pass the ref of an <input type=file> or the button that opens the file picker.");
            backendNodeId = ev.params.backendNodeId;
            sessionId = ev.sessionId;
          } finally {
            await tab.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          }
        }
        // 3) bridge path check (realpath inside uploadDirs), then 4) set the files
        const canonical = await canonicalUploadPaths(c, paths);
        await tab.send("DOM.setFileInputFiles", { files: canonical, backendNodeId }, sessionId);
      },
      () => ({ files: paths.map((p) => ({ name: p.split(/[\\/]/).pop() })) }),
    );
  },

  async "downloads.list"(c) {
    const list = tracker.list(c.meta.id);
    tracker.markReported(c.meta.id, list.map((d) => d.id));
    return { downloads: list.map(wireDownload) };
  },

  async "downloads.wait"(c) {
    const sid = c.meta.id;
    const seen = waited.get(sid) ?? new Set<number>();
    waited.set(sid, seen);
    const timeout = c.p.timeout ?? TIMEOUTS.navigation;
    let d = c.p.id == null ? tracker.list(sid).find((x) => x.state === "complete" && !seen.has(x.id) && Date.now() - x.createdAt < 60_000) : undefined;
    d ??= (await tracker.waitNext(sid, timeout, c.p.id)) ?? undefined;
    if (!d) throw new TabAgentError("TIMEOUT", `No download of this session completed within ${timeout}ms`, "Start the download with act.click first; downloads.list shows what this session has.");
    seen.add(d.id);
    tracker.markReported(sid, [d.id]);
    return wireDownload(d);
  },

  async "downloads.read"(c) {
    const d = tracker.readable(c.meta.id, c.p.id);
    await staticGate(c, d.finalUrl || d.url, "e", `read downloaded file ${d.filename.split(/[\\/]/).pop()}`, ["Gives the agent the file's contents"]);
    return { __bridgeRead: { id: d.id, path: d.filename, mime: d.mime }, id: d.id, filename: d.filename };
  },
};
