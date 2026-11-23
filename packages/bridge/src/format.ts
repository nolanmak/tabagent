// Output edge rendering: lays a response out for MCP and the CLI, so every surface carries identical text.
import type { OutputResponse } from "@tabagent/protocol";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function errorText(resp: OutputResponse): string {
  const e = resp.error!;
  return `${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`;
}

/** MCP content for a response: first line JSON, then a snapshotDiff block; screenshots as images. */
export function renderMcp(resp: OutputResponse): { content: Content[]; isError?: true } {
  if (!resp.ok) return { isError: true, content: [{ type: "text", text: errorText(resp) }] };
  const out: Content[] = [];
  const blocks: string[] = [];
  let line: string;
  const r = resp.result;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const o = { ...(r as Record<string, unknown>) };
    // D30 screenshot shape, plus the pre-D30 {image:{data,mimeType}} shape.
    if (typeof o.dataBase64 === "string" && typeof o.mime === "string") {
      out.push({ type: "image", data: o.dataBase64, mimeType: o.mime });
      delete o.dataBase64;
    } else if (o.image && typeof o.image === "object" && typeof (o.image as any).data === "string") {
      out.push({ type: "image", data: (o.image as any).data, mimeType: (o.image as any).mimeType });
      delete o.image;
    }
    for (const k of ["navigation", "dialogs", "downloads"] as const) if (resp[k]) o[k] = resp[k];
    line = JSON.stringify(o);
  } else if (r === undefined) {
    const o: Record<string, unknown> = {};
    for (const k of ["navigation", "dialogs", "downloads"] as const) if (resp[k]) o[k] = resp[k];
    line = Object.keys(o).length ? JSON.stringify(o) : "ok";
  } else line = typeof r === "string" ? r : JSON.stringify(r);
  if (resp.snapshotDiff) blocks.push(`snapshotDiff:\n${resp.snapshotDiff}`);
  out.unshift({ type: "text", text: [line, ...blocks].join("\n") });
  return { content: out };
}

/** CLI text: the same text as MCP; images are described (the CLI writes them to a file first). */
export function renderCli(resp: OutputResponse): string {
  return renderMcp(resp)
    .content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}, ${Math.round((c.data.length * 3) / 4 / 1024)} KB]`))
    .join("\n");
}
