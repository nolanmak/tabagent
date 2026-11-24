// Real-world deps for `tabagent captcha …` (kept out of cli.ts so its hook stays one line).
import { createInterface } from "node:readline";
import type { Out } from "../commands";
import { loadConfig } from "../config";
import { CapSolverProvider } from "./capsolver";
import { captchaCommand } from "./cli";
import { TwoCaptchaProvider } from "./twocaptcha";

type Flags = Record<string, string | boolean>;

/** stdin when piped (`tabagent captcha enable < keyfile`), else a prompt that does not echo. */
async function readKey(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() || null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void };
  process.stderr.write(prompt);
  out._writeToOutput = () => {}; // hide what is typed
  const answer = await new Promise<string>((r) => rl.question("", r));
  rl.close();
  process.stderr.write("\n");
  return answer.trim() || null;
}

export async function captchaCli(pos: string[], f: Flags): Promise<Out> {
  return captchaCommand(pos, f, {
    readKey,
    balance: (name, key) => (name === "2captcha" ? new TwoCaptchaProvider({ key }) : new CapSolverProvider({ key })).balance(),
    autoTokens: () => loadConfig().tokens.filter((t) => t.autoCaptcha).map((t) => t.name),
  });
}
