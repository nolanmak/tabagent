// D30 CLI arguments: `tabagent <tool> --json '{...}'` is canonical; scalar flags are generated sugar.
import { z } from "zod";
import { TabAgentError, type ToolDef } from "@tabagent/protocol";

export type Flags = Record<string, string | boolean>;

/** Flags that configure the CLI itself, never tool params. */
export const CLI_FLAGS = ["json", "raw", "out", "session", "port"] as const;

export function parseFlags(args: string[]): { f: Flags; rest: string[] } {
  const f: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) f[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith("--")) f[a.slice(2)] = args[++i];
      else f[a.slice(2)] = true;
    } else if (/^-[a-z]$/i.test(a)) {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) f[a.slice(1)] = args[++i];
      else f[a.slice(1)] = true;
    } else rest.push(a);
  }
  return { f, rest };
}

function base(s: z.ZodType): z.ZodType {
  let x = s;
  while (x instanceof z.ZodOptional || x instanceof z.ZodNullable || x instanceof z.ZodDefault) x = (x as any).unwrap() as z.ZodType;
  return x;
}

function coerce(key: string, v: string | boolean, schema: z.ZodType): unknown {
  const s = base(schema);
  if (typeof v === "boolean") return v;
  if (s instanceof z.ZodString || s instanceof z.ZodEnum) return v;
  if (s instanceof z.ZodNumber) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new TabAgentError("BAD_REQUEST", `--${key} must be a number`);
    return n;
  }
  if (s instanceof z.ZodBoolean) {
    if (v === "true") return true;
    if (v === "false") return false;
    throw new TabAgentError("BAD_REQUEST", `--${key} must be true or false`);
  }
  try {
    return JSON.parse(v);
  } catch {
    if (s instanceof z.ZodArray) return v.split(",").map((x) => x.trim());
    return v;
  }
}

/** Params for a tool from `--json` plus flag sugar. Flags win over the JSON. Unknown flags are errors. */
export function toolParamsFromArgs(tool: ToolDef, f: Flags): Record<string, unknown> {
  let params: Record<string, unknown> = {};
  if (f.json !== undefined) {
    if (typeof f.json !== "string") throw new TabAgentError("BAD_REQUEST", "--json needs a JSON object");
    try {
      params = JSON.parse(f.json);
    } catch (e) {
      throw new TabAgentError("BAD_REQUEST", `--json is not valid JSON: ${(e as Error).message}`);
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TabAgentError("BAD_REQUEST", "--json must be a JSON object");
  }
  const shape = tool.params.shape as Record<string, z.ZodType>;
  for (const [k, v] of Object.entries(f)) {
    if ((CLI_FLAGS as readonly string[]).includes(k)) continue;
    if (!(k in shape)) throw new TabAgentError("BAD_REQUEST", `Unknown flag --${k} for ${tool.name}. Params: ${Object.keys(shape).join(", ") || "(none)"}`);
    params[k] = coerce(k, v, shape[k]);
  }
  return params;
}
