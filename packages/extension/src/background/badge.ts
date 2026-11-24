// Toolbar badge state machine (D40). Pure.
export type BadgeState = "off" | "connected" | "acting" | "approval" | "paused" | "yolo";

export interface BadgeInput {
  connected: boolean;
  paused: boolean;
  pendingPrompts: number;
  inflight: number;
  /** YOLO mode is on (review M1): shown whenever agents could act, so it is never forgotten. */
  yolo?: boolean;
}

/** Priority: paused > needs approval > off > YOLO > acting > connected. */
export function badgeState(i: BadgeInput): BadgeState {
  if (i.paused) return "paused";
  if (i.pendingPrompts > 0) return "approval";
  if (!i.connected) return "off";
  if (i.yolo) return "yolo";
  if (i.inflight > 0) return "acting";
  return "connected";
}

export const BADGE: Record<BadgeState, { text: string; color: string; title: string }> = {
  off: { text: "off", color: "#6b7280", title: "TabAgent: bridge not connected" },
  connected: { text: "", color: "#16a34a", title: "TabAgent: connected" },
  acting: { text: "•••", color: "#7c3aed", title: "TabAgent: an agent is acting" },
  approval: { text: "!", color: "#d97706", title: "TabAgent: an agent needs your approval (open the side panel)" },
  yolo: { text: "YOLO", color: "#db2777", title: "TabAgent: YOLO mode is on: agents can use every site without asking (turn it off in the side panel)" },
  paused: { text: "⏸", color: "#dc2626", title: "TabAgent: stopped by the kill switch (Resume in the side panel)" },
};
