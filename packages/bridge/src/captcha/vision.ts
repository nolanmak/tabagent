// Vision provider (#61): one image-challenge round goes to an OpenAI-compatible chat-completions
// endpoint with image input; the model answers strict JSON (grid cells or normalised tap points) and
// the extension taps them with trusted CDP clicks. A refusal or an unparseable answer fails fast with
// its own reason; the caller never loops on it.
import { captchaUnsolved, type CaptchaReason, type VisionAnswer } from "@tabagent/protocol";
import type { VisionRound, VisionSolver } from "./provider";

export interface VisionOpts {
  /** e.g. https://api.openai.com/v1 (the path /chat/completions is appended). */
  baseUrl: string;
  model: string;
  /** Optional: local endpoints (Ollama, vLLM) may need none. */
  key?: string;
  fetch?: typeof globalThis.fetch;
  /** Per-round HTTP cap. */
  timeoutMs?: number;
}

const SYSTEM =
  "You look at a screenshot of an image-selection challenge and answer which parts match the instruction. " +
  "Reply with one JSON object and nothing else. " +
  'For a grid: {"cells":[i,...]} with 0-based indices, row-major, left to right then top to bottom; [] if none match. ' +
  'For a canvas: {"points":[{"x":0.0-1.0,"y":0.0-1.0},...]} normalised to the image width and height.';

const REFUSAL = /\b(i'?m sorry|i am sorry|i can(?:not|'t)|unable to|not able to|won'?t (?:help|assist)|can'?t (?:help|assist)|refuse)\b/i;

function userText(r: VisionRound): string {
  const shape = r.kind === "grid" ? `This is a grid of ${r.rows ?? 3} rows by ${r.cols ?? 3} columns (${(r.rows ?? 3) * (r.cols ?? 3)} cells). Answer {"cells":[...]}.` : 'This is a single canvas image. Answer {"points":[{"x":..,"y":..}]} with 1 to 20 points.';
  return `Instruction shown by the challenge: "${r.prompt.slice(0, 500)}"\n${shape}`;
}

/** Pull one JSON object out of the model's text and check it against the round. null = unparseable. */
export function parseVisionAnswer(text: string, r: VisionRound): VisionAnswer | null {
  const s = text.replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j: unknown;
  try {
    j = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (r.kind === "grid") {
    const n = (r.rows ?? 3) * (r.cols ?? 3);
    if (!Array.isArray(o.cells) || !o.cells.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) < n)) return null;
    return { cells: [...new Set(o.cells as number[])].sort((x, y) => x - y) };
  }
  if (!Array.isArray(o.points) || o.points.length < 1 || o.points.length > 20) return null;
  const pts: { x: number; y: number }[] = [];
  for (const p of o.points) {
    const x = Number((p as { x?: unknown })?.x);
    const y = Number((p as { y?: unknown })?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    pts.push({ x, y });
  }
  return { points: pts };
}

export class VisionProvider implements VisionSolver {
  readonly name = "vision" as const;
  private readonly fetchFn: typeof globalThis.fetch;
  constructor(private o: VisionOpts) {
    this.fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get model() {
    return this.o.model;
  }

  private fail(reason: CaptchaReason, r: VisionRound, detail: string): never {
    throw captchaUnsolved(reason, r.vendor, `vision ${detail}`);
  }

  async answer(r: VisionRound, signal?: AbortSignal): Promise<VisionAnswer> {
    const url = `${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: this.o.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: [{ type: "text", text: userText(r) }, { type: "image_url", image_url: { url: `data:${r.mime};base64,${r.imageBase64}` } }] },
      ],
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.key) headers.authorization = `Bearer ${this.o.key}`;
    const sig = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs ?? 60_000)]) : (signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 60_000));
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: sig });
    } catch {
      if (sig.aborted) this.fail("timeout", r, "no answer in time");
      this.fail("provider_error", r, "network error");
    }
    if (res.status === 401 || res.status === 403) this.fail("provider_auth", r, `HTTP ${res.status}`);
    if (res.status === 429) this.fail("rate_limited", r, "HTTP 429");
    if (!res.ok) this.fail("provider_error", r, `HTTP ${res.status}`);
    let j: any;
    try {
      j = await res.json();
    } catch {
      this.fail("vision_unparseable", r, "bad JSON from the endpoint");
    }
    const choice = j?.choices?.[0];
    const msg = choice?.message ?? {};
    if (typeof msg.refusal === "string" && msg.refusal) this.fail("vision_refused", r, "model refused");
    if (choice?.finish_reason === "content_filter") this.fail("vision_refused", r, "content filter");
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
    const parsed = parseVisionAnswer(text, r);
    if (parsed) return parsed;
    if (/"refuse"\s*:\s*true/i.test(text) || REFUSAL.test(text)) this.fail("vision_refused", r, "model refused");
    this.fail("vision_unparseable", r, "answer was not the expected JSON");
  }
}
