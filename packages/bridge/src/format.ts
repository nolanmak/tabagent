import { wrapUntrusted, type ToolDef } from "@tabagent/protocol";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Turn a tool result into compact, model-friendly MCP content. */
export function formatResult(tool: ToolDef, result: unknown): Content[] {
  const out: Content[] = [];
  if (result == null || typeof result !== "object") {
    out.push({ type: "text", text: String(result ?? "ok") });
    return out;
  }
  const r = { ...(result as Record<string, unknown>) };
  if (r.image && typeof r.image === "object") {
    const img = r.image as { data: string; mimeType: string };
    out.push({ type: "image", data: img.data, mimeType: img.mimeType });
    delete r.image;
  }
  const pageText: string[] = [];
  for (const k of ["snapshot", "diff", "markdown", "text", "csv"]) {
    if (typeof r[k] === "string") {
      pageText.push(String(r[k]));
      delete r[k];
    }
  }
  let diffText: string | undefined;
  if (typeof r.snapshotDiff === "string") {
    diffText = r.snapshotDiff;
    delete r.snapshotDiff;
  }
  const meta = Object.keys(r).length ? JSON.stringify(r) : "";
  let text: string;
  if (pageText.length) text = [meta, wrapUntrusted(pageText.join("\n\n"))].filter(Boolean).join("\n");
  else if (tool.pageContent) text = wrapUntrusted(meta);
  else text = meta || "ok";
  if (diffText) text += `\nsnapshotDiff:\n${diffText.startsWith("(") ? diffText : wrapUntrusted(diffText)}`;
  out.unshift({ type: "text", text });
  return out;
}

/** Plain-text rendering for the CLI. */
export function formatCli(tool: ToolDef, result: unknown): string {
  return formatResult(tool, result)
    .map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}, ${Math.round((c.data.length * 3) / 4 / 1024)} KB]`))
    .join("\n");
}
