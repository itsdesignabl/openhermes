import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";

/** One line per finished turn. Holds counts only, never any of the conversation's text. */
export interface TurnRecord {
  at: string;
  agent: string;
  /** "local" (terminal or Obsidian), "chat" (a chat channel), "heartbeat" or "job". */
  kind: string;
  ok: boolean;
  model_calls: number;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated: boolean;
  ms: number;
  /** Tool results and earlier turns hidden from the model because the conversation did not fit its window. */
  elided?: number;
  dropped_turns?: number;
  /** Skills the agent read during the turn. */
  skills: string[];
}

export function metricsFile(home: Home): string {
  return path.join(home.data, "metrics", "turns.jsonl");
}

export function recordTurn(home: Home, record: TurnRecord): void {
  try {
    fs.mkdirSync(path.dirname(metricsFile(home)), { recursive: true });
    fs.appendFileSync(metricsFile(home), JSON.stringify(record) + "\n");
  } catch {
    // measuring must never break a turn
  }
}

export function readTurns(home: Home, sinceMs = 0): TurnRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(metricsFile(home), "utf8");
  } catch {
    return [];
  }
  const out: TurnRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TurnRecord;
      if (Date.parse(r.at) >= sinceMs) out.push(r);
    } catch {
      // a damaged line is skipped
    }
  }
  return out;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Group {
  turns: number;
  model_calls: number;
  tokens: number;
  seconds: number;
}

function group(rs: TurnRecord[]): Group {
  return {
    turns: rs.length,
    model_calls: mean(rs.map((r) => r.model_calls)),
    tokens: mean(rs.map((r) => r.prompt_tokens + r.completion_tokens)),
    seconds: mean(rs.map((r) => r.ms / 1000)),
  };
}

export interface UsageSummary {
  days: number;
  all: Group;
  estimated: boolean;
  weeks: ({ week: string } & Group)[];
  /** Conversations with you only (not heartbeat or job runs). */
  withSkill: Group;
  withoutSkill: Group;
  skills: ({ name: string } & Group)[];
}

function weekStart(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

/** What the recorded turns of the last `days` days look like, overall, per week and per skill. */
export function summarize(records: TurnRecord[], days: number): UsageSummary {
  const weeks = new Map<string, TurnRecord[]>();
  for (const r of records) {
    const w = weekStart(r.at);
    weeks.set(w, [...(weeks.get(w) ?? []), r]);
  }
  const talk = records.filter((r) => r.kind === "local" || r.kind === "chat");
  const names = [...new Set(records.flatMap((r) => r.skills))].sort();
  return {
    days,
    all: group(records),
    estimated: records.some((r) => r.estimated),
    weeks: [...weeks.entries()].sort().map(([week, rs]) => ({ week, ...group(rs) })),
    withSkill: group(talk.filter((r) => r.skills.length)),
    withoutSkill: group(talk.filter((r) => !r.skills.length)),
    skills: names.map((name) => ({ name, ...group(records.filter((r) => r.skills.includes(name))) })).sort((a, b) => b.turns - a.turns),
  };
}

export function formatSummary(s: UsageSummary): string {
  if (!s.all.turns) return `No turns recorded in the last ${s.days} days.`;
  const row = (label: string, g: Group) =>
    `${label.padEnd(26)}${String(g.turns).padStart(6)}${g.model_calls.toFixed(1).padStart(13)}${Math.round(g.tokens).toLocaleString("en-US").padStart(11)}${g.seconds.toFixed(1).padStart(10)}`;
  const head = `${"".padEnd(26)}${"turns".padStart(6)}${"model calls".padStart(13)}${"tokens".padStart(11)}${"seconds".padStart(10)}`;
  const lines = [`Last ${s.days} days. Averages are per turn.${s.estimated ? " Token counts are partly estimated: the model endpoint does not report them." : ""}`, "", head, row("All turns", s.all), ""];
  lines.push("By week (starting Monday)", ...s.weeks.map((w) => row(`  ${w.week}`, w)), "");
  lines.push("Conversations with you", row("  a skill was read", s.withSkill), row("  no skill was read", s.withoutSkill), "");
  if (s.skills.length) lines.push("By skill", ...s.skills.map((k) => row(`  ${k.name.slice(0, 23)}`, k)), "");
  lines.push(
    "These are your real conversations, so the rows are not a fair comparison: the turns that used a skill were different tasks from those that did not.",
    "For a controlled comparison run: openhermes bench",
  );
  return lines.join("\n");
}
