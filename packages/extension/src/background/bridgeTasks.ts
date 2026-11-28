// #158 Timed tasks, worker side: tasks.list -> tasks.listed and tasks.label -> tasks.labeled over the bridge
// socket, and tasks.changed relayed to the side panel. Chrome-free; index.ts wires the sender, the panel
// broadcast and routes bridge messages here.
import { TabAgentError, TASKS_FEATURE, TasksLabeledSchema, TasksListedSchema, type TaskSummary } from "@tabagent/protocol";

type Sender = (msg: unknown) => boolean;
let sender: Sender | null = null;
let changed: (() => void) | null = null;

export function setTasksSender(fn: Sender) {
  sender = fn;
}
/** Called on every tasks.changed from the bridge (the worker broadcasts to the panel). */
export function setTasksChangedListener(fn: () => void) {
  changed = fn;
}

/** The panel shows the Tasks section only when both sides advertise the feature. */
export function tasksSupported(extFeatures: readonly string[], bridgeFeatures: readonly string[]): boolean {
  return extFeatures.includes(TASKS_FEATURE) && bridgeFeatures.includes(TASKS_FEATURE);
}

type Waiter<T> = { resolve: (r: T) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
const lists = new Map<string, Waiter<TaskSummary[]>>();
const labels = new Map<string, Waiter<{ ok: boolean; code?: string }>>();

function request<T>(map: Map<string, Waiter<T>>, msg: Record<string, unknown>, what: string, timeoutMs: number): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    if (!sender || !sender({ ...msg, id })) {
      reject(new TabAgentError("NO_EXTENSION", `The bridge is not connected, so tasks cannot be ${what}`));
      return;
    }
    const timer = setTimeout(() => {
      map.delete(id);
      reject(new TabAgentError("TIMEOUT", `The bridge did not answer in time (tasks ${what})`));
    }, timeoutMs);
    map.set(id, { resolve, reject, timer });
  });
}

/** `calls`: the task whose calls to include (the opened row). */
export function listTasks(limit?: number, calls?: string, timeoutMs = 5000): Promise<TaskSummary[]> {
  return request(lists, { type: "tasks.list", ...(limit ? { limit } : {}), ...(calls ? { calls } : {}) }, "listed", timeoutMs);
}

export function labelTask(taskId: string, outcome: "success" | "failed", timeoutMs = 5000): Promise<{ ok: boolean; code?: string }> {
  return request(labels, { type: "tasks.label", taskId, outcome }, "labeled", timeoutMs);
}

/** Route a bridge message; true when it was a tasks.* message. */
export function onTasksBridgeMessage(msg: any): boolean {
  switch (msg?.type) {
    case "tasks.listed": {
      const r = TasksListedSchema.safeParse(msg);
      const w = r.success ? lists.get(r.data.id) : undefined;
      if (w && r.success) {
        lists.delete(r.data.id);
        clearTimeout(w.timer);
        w.resolve(r.data.tasks);
      }
      return true;
    }
    case "tasks.labeled": {
      const r = TasksLabeledSchema.safeParse(msg);
      const w = r.success ? labels.get(r.data.id) : undefined;
      if (w && r.success) {
        labels.delete(r.data.id);
        clearTimeout(w.timer);
        w.resolve({ ok: r.data.ok, ...(r.data.code ? { code: r.data.code } : {}) });
      }
      return true;
    }
    case "tasks.changed":
      changed?.();
      return true;
  }
  return false;
}
