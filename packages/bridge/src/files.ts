import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { TabAgentError } from "@tabagent/protocol";

/** Uploads must be existing files inside an allowed directory. Returns real paths. */
export function validateUploads(paths: string[], allowed: string[]): string[] {
  const roots = allowed.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (!existsSync(abs)) throw new TabAgentError("NOT_FOUND", `Upload file not found: ${p}`);
    const real = realpathSync(abs);
    if (!statSync(real).isFile()) throw new TabAgentError("BAD_REQUEST", `Not a file: ${p}`);
    if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) {
      throw new TabAgentError("PERMISSION_DENIED", `Uploads are limited to: ${allowed.join(", ")}`, `Move the file into one of those folders, or run: tabagent config add-upload-dir <dir>`);
    }
    return real;
  });
}

const TEXTY = /^(text\/|application\/(json|xml|csv|javascript|x-ndjson|x-yaml|yaml|sql|graphql))|\+(json|xml)$/i;

export function readDownload(path: string, mime: string, maxBytes: number) {
  if (!existsSync(path)) throw new TabAgentError("NOT_FOUND", `Downloaded file is gone: ${path}`);
  const size = statSync(path).size;
  const buf = readFileSync(path).subarray(0, maxBytes);
  const truncated = size > maxBytes;
  const looksText = TEXTY.test(mime) || /\.(txt|csv|json|md|xml|html?|tsv|log|ya?ml)$/i.test(path);
  if (looksText) {
    const text = buf.toString("utf8");
    if (!text.includes("�") || TEXTY.test(mime)) return { path, size, truncated, encoding: "utf8", content: text };
  }
  return { path, size, truncated, encoding: "base64", content: buf.toString("base64") };
}
