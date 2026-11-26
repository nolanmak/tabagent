import { listWorkflows, runWorkflow, scheduleWorkflow, startCapture, stopCapture, unscheduleWorkflow } from "../workflows";

export const workflowHandlers = {
  "workflow.capture_start": async ({ tabId, p }: any) => {
    if (tabId == null) throw new Error("Workflow capture needs a tab");
    await startCapture(tabId, p.source, p.name);
    return { started: true, tabId, source: p.source };
  },
  "workflow.capture_stop": async ({ tabId }: any) => {
    if (tabId == null) throw new Error("Workflow capture needs a tab");
    return { recipe: await stopCapture(tabId) };
  },
  "workflow.list": async () => ({ workflows: await listWorkflows() }),
  "workflow.run": async ({ tabId, p, meta }: any) => {
    if (tabId == null) throw new Error("Workflow replay needs an owned tab");
    return { run: await runWorkflow(p.id, tabId, meta) };
  },
  "workflow.schedule": async ({ tabId, p, meta }: any) => ({ schedule: await scheduleWorkflow(p.id, tabId, meta, p.cron, p.timeZone) }),
  "workflow.unschedule": async ({ p }: any) => { await unscheduleWorkflow(p.id); return { ok: true }; },
};
