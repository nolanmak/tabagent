// Toolbar badge state machine (D40). Pure.
export type BadgeState = "off" | "connected" | "acting" | "approval" | "paused";

export interface BadgeInput {
  connected: boolean;
  paused: boolean;
  pendingPrompts: number;
  inflight: number;
}

/** Priority: paused > needs approval > off > acting > connected. */
export function badgeState(i: BadgeInput): BadgeState {
  if (i.paused) return "paused";
  if (i.pendingPrompts > 0) return "approval";
  if (!i.connected) return "off";
  if (i.inflight > 0) return "acting";
  return "connected";
}

export const BADGE: Record<BadgeState, { text: string; color: string; title: string }> = {
  off: { text: "off", color: "#6b7280", title: "TabAgent: bridge not connected" },
  connected: { text: "", color: "#16a34a", title: "TabAgent: connected" },
  acting: { text: "•••", color: "#7c3aed", title: "TabAgent: an agent is acting" },
  approval: { text: "!", color: "#d97706", title: "TabAgent: an agent needs your approval (open the side panel)" },
  paused: { text: "⏸", color: "#dc2626", title: "TabAgent: stopped by the kill switch (Resume in the side panel)" },
};
