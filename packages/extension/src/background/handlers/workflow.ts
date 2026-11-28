import { editDraftWorkflow, listWorkflowRuns, listWorkflows, reviewRepair, runWorkflow, scheduleWorkflow, startCapture, stopCapture, unscheduleWorkflow } from "../workflows";

export const workflowHandlers = {
  "workflow.capture_start": async ({ tabId, p, meta }: any) => {
    if (tabId == null) throw new Error("Workflow capture needs a tab");
    await startCapture(tabId, p.source, p.name, meta.id);
    return { started: true, tabId, source: p.source };
  },
  "workflow.capture_stop": async ({ tabId }: any) => {
    if (tabId == null) throw new Error("Workflow capture needs a tab");
    return { recipe: await stopCapture(tabId) };
  },
  "workflow.list": async () => ({ workflows: await listWorkflows() }),
  "workflow.run": async ({ tabId, p, meta }: any) => {
    if (tabId == null) throw new Error("Workflow replay needs an owned tab");
    return { run: await runWorkflow(p.id, tabId, meta, p.inputs ?? {}) };
  },
  "workflow.schedule": async ({ tabId, p, meta }: any) => ({ schedule: await scheduleWorkflow(p.id, tabId, meta, p.cron, p.timeZone, p.inputs ?? {}) }),
  "workflow.unschedule": async ({ p }: any) => { await unscheduleWorkflow(p.id); return { ok: true }; },
  "workflow.runs": async ({ p }: any) => ({ runs: await listWorkflowRuns(p.id) }),
  "workflow.review_repair": async ({ p }: any) => reviewRepair(p.recipeId, p.repairId, p.decision),
  // No prompt: a draft cannot run or be scheduled until the user reviews it in the side panel.
  "workflow.edit_draft": async ({ p, meta }: any) => editDraftWorkflow(p.id, p.ops, meta?.id),
};
