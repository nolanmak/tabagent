// Vision provider against a stub OpenAI-compatible chat-completions endpoint: request shape (image +
// prompt), strict JSON answers, fail-fast on refusal / unparseable output, key hygiene.
import { describe, expect, it } from "vitest";
import { captchaReasonOf } from "@tabagent/protocol";
import { parseVisionAnswer, VisionProvider, type VisionRound } from "../src/captcha";

const KEY = "sk-vision-0123456789abcdef";
const ROUND: VisionRound = { vendor: "hcaptcha", prompt: "Please click each image containing a bus", kind: "grid", rows: 3, cols: 3, imageBase64: "iVBORw0KGgo=", mime: "image/png" };

function stub(content: unknown, status = 200, extra: Record<string, unknown> = {}) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    if (content instanceof Error) throw content;
    const body = typeof content === "string" ? { choices: [{ message: { content }, finish_reason: "stop" }], ...extra } : content;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const provider = (s: ReturnType<typeof stub>, o: Partial<ConstructorParameters<typeof VisionProvider>[0]> = {}) =>
  new VisionProvider({ baseUrl: "https://llm.test/v1/", model: "vis-1", key: KEY, fetch: s.fetch, ...o });

describe("VisionProvider", () => {
  it("posts the image and prompt to /chat/completions and returns grid cells", async () => {
    const s = stub('{"cells":[0,4,8]}');
    expect(await provider(s).answer(ROUND)).toEqual({ cells: [0, 4, 8] });
    const c = s.calls[0];
    expect(c.url).toBe("https://llm.test/v1/chat/completions");
    expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(c.body.model).toBe("vis-1");
    expect(c.body.temperature).toBe(0);
    const user = c.body.messages.find((m: any) => m.role === "user");
    expect(JSON.stringify(user)).toContain("Please click each image containing a bus");
    expect(JSON.stringify(user)).toContain("3 rows");
    expect(user.content.find((p: any) => p.type === "image_url").image_url.url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
  it("canvas rounds answer normalised points", async () => {
    const s = stub('```json\n{"points":[{"x":0.25,"y":0.5}]}\n```');
    expect(await provider(s).answer({ ...ROUND, kind: "canvas", rows: undefined, cols: undefined, prompt: "Tap on the thing you see in a coffee shop" })).toEqual({ points: [{ x: 0.25, y: 0.5 }] });
    expect(JSON.stringify(s.calls[0].body)).toMatch(/points/);
  });
  it("no key is allowed for a local endpoint (no authorization header)", async () => {
    const s = stub('{"cells":[]}');
    await provider(s, { key: undefined }).answer(ROUND);
    expect((s.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });
  it.each([
    ["I'm sorry, but I can't help with solving CAPTCHAs.", "vision_refused"],
    ['{"refuse": true}', "vision_refused"],
    ["The buses are in the top row.", "vision_unparseable"],
    ['{"cells":[9]}', "vision_unparseable"],
    ['{"cells":"0,1"}', "vision_unparseable"],
  ])("%s -> %s (fails fast)", async (content, reason) => {
    const s = stub(content);
    const e = await provider(s).answer(ROUND).catch((x) => x);
    expect(e.code).toBe("CAPTCHA_UNSOLVED");
    expect(captchaReasonOf(e.message)).toBe(reason);
    expect(s.calls).toHaveLength(1);
  });
  it("an OpenAI refusal field or content_filter finish is a refusal", async () => {
    const s = stub({ choices: [{ message: { content: null, refusal: "I can't assist with that." }, finish_reason: "stop" }] });
    expect(captchaReasonOf((await provider(s).answer(ROUND).catch((x) => x)).message)).toBe("vision_refused");
    const s2 = stub({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] });
    expect(captchaReasonOf((await provider(s2).answer(ROUND).catch((x) => x)).message)).toBe("vision_refused");
  });
  it("HTTP 401 is provider_auth; errors never carry the key", async () => {
    const s = stub({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401);
    const e = await provider(s).answer(ROUND).catch((x) => x);
    expect(captchaReasonOf(e.message)).toBe("provider_auth");
    expect(JSON.stringify(e.toJSON())).not.toContain(KEY);
    const s2 = stub(new Error(`ECONNREFUSED ${KEY}`));
    const e2 = await provider(s2).answer(ROUND).catch((x) => x);
    expect(captchaReasonOf(e2.message)).toBe("provider_error");
    expect(e2.message).not.toContain(KEY);
  });
});

describe("parseVisionAnswer", () => {
  it("accepts surrounding prose around one JSON object and dedupes/sorts cells", () => {
    expect(parseVisionAnswer('Answer: {"cells":[4,0,4]}', ROUND)).toEqual({ cells: [0, 4] });
  });
  it("grid answers must be cells; canvas answers must be 1..20 points in range", () => {
    expect(parseVisionAnswer('{"points":[{"x":0.1,"y":0.1}]}', ROUND)).toBeNull();
    const canvas = { ...ROUND, kind: "canvas" as const };
    expect(parseVisionAnswer('{"points":[]}', canvas)).toBeNull();
    expect(parseVisionAnswer('{"points":[{"x":2,"y":0.1}]}', canvas)).toBeNull();
  });
});
