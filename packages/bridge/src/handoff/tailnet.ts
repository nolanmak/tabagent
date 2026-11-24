// #61 Part B: find this machine's Tailscale IPv4 address (100.64.0.0/10).
//
// `tailscale ip -4` is the source of truth. The interface fallback only trusts interfaces named
// tailscale* (Linux): 100.64.0.0/10 is also carrier-grade NAT space, so a 100.x address on en0 or a
// cellular interface is NOT the tailnet and must never be bound.
import { execFile } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export function isTailnetIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

export interface DetectDeps {
  exec?: () => Promise<string>;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

const CLI_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function tailscaleIp(): Promise<string> {
  const tryOne = (i: number): Promise<string> =>
    i >= CLI_CANDIDATES.length
      ? Promise.reject(new Error("tailscale CLI not found"))
      : new Promise<string>((resolve, reject) =>
          execFile(CLI_CANDIDATES[i], ["ip", "-4"], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
        ).catch(() => tryOne(i + 1));
  return tryOne(0);
}

export async function detectTailnetIp(d: DetectDeps = {}): Promise<string | null> {
  try {
    const out = await (d.exec ?? tailscaleIp)();
    const ip = out.split(/\s+/).find(Boolean) ?? "";
    // The CLI answered: trust its answer only (a non-tailnet answer means something is wrong).
    return isTailnetIPv4(ip) ? ip : null;
  } catch {
    /* no CLI: fall back to the interface list */
  }
  const ifaces = (d.interfaces ?? networkInterfaces)();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!/^tailscale/i.test(name)) continue;
    for (const a of list ?? []) if ((a.family === "IPv4" || (a.family as unknown) === 4) && isTailnetIPv4(a.address)) return a.address;
  }
  return null;
}
