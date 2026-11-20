/** "30m", "2h", "45s", "1d" → milliseconds. Returns null when the text is not a duration. */
export function parseDuration(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(text);
  if (!m) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase()]!;
  return Number(m[1]) * unit;
}

interface Field {
  values: Set<number>;
  any: boolean;
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(text: string, index: number): Field {
  const [min, max] = RANGES[index]!;
  const names = index === 3 ? MONTHS : index === 4 ? DAYS : [];
  const num = (s: string): number => {
    const named = names.indexOf(s.toLowerCase());
    const n = named >= 0 ? named + (index === 3 ? 1 : 0) : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`'${s}' is out of range in '${text}'`);
    return n;
  };
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in '${part}'`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      [lo, hi] = [num(a!), num(b!)];
    } else {
      lo = num(range!);
      hi = stepText === undefined ? lo : max;
    }
    if (lo > hi) throw new Error(`bad range '${part}'`);
    for (let v = lo; v <= hi; v += step) values.add(index === 4 && v === 7 ? 0 : v);
  }
  return { values, any: text === "*" };
}

/** Standard five-field cron: minute hour day-of-month month day-of-week, in local time. */
export function parseCron(expr: string): (date: Date) => boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a schedule needs five fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = parts.map(parseField) as [Field, Field, Field, Field, Field];
  return (d) => {
    if (!minute.values.has(d.getMinutes()) || !hour.values.has(d.getHours()) || !month.values.has(d.getMonth() + 1)) return false;
    const domOk = dom.values.has(d.getDate());
    const dowOk = dow.values.has(d.getDay());
    // cron rule: when both day fields are restricted, either one matching is enough
    return dom.any || dow.any ? domOk && dowOk : domOk || dowOk;
  };
}

/** The first matching minute strictly after `after`, or null if there is none within about a year. */
export function nextRun(expr: string, after: Date): Date | null {
  const matches = parseCron(expr);
  const d = new Date(after);
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(d)) return d;
  }
  return null;
}

/** "08:00-22:00" (may wrap past midnight). Empty text means always. */
export function withinHours(window: string, now: Date): boolean {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(window);
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}
