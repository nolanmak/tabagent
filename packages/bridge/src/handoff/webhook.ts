// #61 Part B: the handoff start notification. Metadata only: never page content, never a screenshot.

export interface WebhookInfo {
  origin: string;
  reason: string;
  sessionLabel: string;
  /** The one-time remote link, or null when remote handoff is off (the user must go to the machine). */
  url: string | null;
  expiresAt: number;
}

export function webhookPayload(i: WebhookInfo) {
  return { event: "handoff.start", origin: i.origin, reason: i.reason, url: i.url, expiresAt: new Date(i.expiresAt).toISOString(), session: i.sessionLabel };
}

export async function postWebhook(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!r.ok) throw new Error(`webhook answered ${r.status}`);
}
