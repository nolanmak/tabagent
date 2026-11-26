/** Small, deterministic five-field cron matcher used by local workflow schedules. */
export type CronFields = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}"`);
    let lo = min; let hi = max;
    if (base !== "*") {
      const pair = base.split("-"); lo = Number(pair[0]); hi = pair[1] == null ? lo : Number(pair[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`Invalid cron field "${part}"`);
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(cron: string): CronFields {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron must have five fields: minute hour day month weekday");
  return fields.map((v, i) => field(v, ranges[i][0], ranges[i][1])) as CronFields;
}

/** Intl supplies the requested IANA-zone local clock; no catch-up is implied. */
export function cronMatches(cron: string, when: Date, timeZone: string): boolean {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(when);
  const by = Object.fromEntries(p.filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(by.weekday);
  const f = parseCron(cron);
  return f[0].has(Number(by.minute)) && f[1].has(Number(by.hour)) && f[2].has(Number(by.day)) && f[3].has(Number(by.month)) && f[4].has(weekday);
}
