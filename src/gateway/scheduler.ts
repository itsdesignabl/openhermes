import fs from "node:fs";
import path from "node:path";
import { listAgents } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import { parseNote } from "../vault/frontmatter.js";
import { nextRun, parseDuration, withinHours } from "./cron.js";

export const HEARTBEAT_OK = "HEARTBEAT_OK";

export const HEARTBEAT_PROMPT =
  `This is a scheduled check-in, not a message from the user. Read Agents/{agent}/HEARTBEAT.md and do what it asks. ` +
  `If nothing needs the user's attention, reply with exactly ${HEARTBEAT_OK} and nothing else. ` +
  `Otherwise reply with the short message the user should receive.`;

export interface ScheduledRun {
  kind: "heartbeat" | "job";
  name: string;
  agent: string;
  prompt: string;
  /** "last", "none" or "<channel>:<chat id>". */
  target: string;
}

export interface Job {
  file: string;
  name: string;
  agent: string;
  target: string;
  prompt: string;
  schedule?: string;
  every?: number;
  at?: Date;
}

interface State {
  heartbeat: Record<string, number>;
  jobs: Record<string, { lastRun: number; status: string }>;
}

/** True when HEARTBEAT.md has nothing to do: only headings, comments, blank lines or empty list items. */
export function heartbeatIsEmpty(text: string): boolean {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .every((line) => /^\s*(#.*|[-*+]\s*(\[[ xX]?\])?\s*)?$/.test(line));
}

/** Reads the job notes in vault/Jobs. A note without a schedule is ignored; a broken one is reported. */
export function loadJobs(home: Home, defaultAgent: string, onError: (file: string, message: string) => void = () => {}): Job[] {
  const dir = path.join(home.vault, "Jobs");
  if (!fs.existsSync(dir)) return [];
  const jobs: Job[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    try {
      const { data, body } = parseNote<Record<string, unknown>>(fs.readFileSync(path.join(dir, f), "utf8"));
      if (data.schedule === undefined && data.every === undefined && data.at === undefined) continue;
      if (data.enabled === false) continue;
      const job: Job = {
        file: f,
        name: f.replace(/\.md$/i, ""),
        agent: typeof data.agent === "string" ? data.agent : defaultAgent,
        target: data.target === undefined ? "last" : String(data.target),
        prompt: body.trim(),
      };
      if (!job.prompt) throw new Error("the note has no text below the properties to use as the instruction");
      if (data.schedule !== undefined) {
        job.schedule = String(data.schedule);
        nextRun(job.schedule, new Date()); // validates
      } else if (data.every !== undefined) {
        const ms = parseDuration(String(data.every));
        if (!ms || ms < 60_000) throw new Error(`'every: ${data.every}' must be a duration of at least 1m, such as 30m or 2h`);
        job.every = ms;
      } else {
        const at = data.at instanceof Date ? data.at : new Date(String(data.at));
        if (Number.isNaN(at.getTime())) throw new Error(`'at: ${data.at}' is not a date and time`);
        job.at = at;
      }
      jobs.push(job);
    } catch (err) {
      onError(f, (err as Error).message);
    }
  }
  return jobs;
}

/**
 * Decides when heartbeats and jobs are due. Runs missed while the gateway was off are not caught up,
 * except one-time `at` jobs less than a day late.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private state: State;
  private stateFile: string;
  private started = Date.now();
  private firstSeen = new Map<string, number>();
  private reported = new Map<string, string>();
  /** Heartbeats and jobs that are running right now. */
  private running = new Set<string>();

  constructor(
    private home: Home,
    private defaultAgent: () => string,
    private heartbeatSettings: (agent: string) => { every: string; target: string; active_hours: string },
    private run: (r: ScheduledRun) => Promise<string>,
    private log: (level: "info" | "warn" | "error", message: string) => void,
  ) {
    this.stateFile = path.join(home.data, "gateway", "schedule.json");
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as State;
      this.state = { heartbeat: s.heartbeat ?? {}, jobs: s.jobs ?? {} };
    } catch {
      this.state = { heartbeat: {}, jobs: {} };
    }
  }

  start(intervalMs = 30_000): void {
    this.started = Date.now();
    this.timer = setInterval(() => void this.tick(new Date()), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  jobs(): Job[] {
    return loadJobs(this.home, this.defaultAgent(), (file, message) => {
      if (this.reported.get(file) === message) return;
      this.reported.set(file, message);
      this.log("error", `Jobs/${file} is not scheduled: ${message}`);
    });
  }

  /** When each job last ran and when it runs next, for status output. */
  describe(now = new Date()): { name: string; agent: string; next: string; last: string }[] {
    return this.jobs().map((j) => {
      const last = this.state.jobs[j.file];
      const next = j.schedule
        ? nextRun(j.schedule, now)
        : j.every
          ? new Date((last?.lastRun ?? this.firstSeen.get(j.file) ?? now.getTime()) + j.every)
          : last
            ? null
            : j.at!;
      return {
        name: j.name,
        agent: j.agent,
        next: next ? next.toISOString() : "done",
        last: last ? `${new Date(last.lastRun).toISOString()} (${last.status})` : "never",
      };
    });
  }

  /**
   * Runs everything that is due at `now`, side by side, and resolves when those runs have finished.
   * Public so tests can drive time. A run that is still going (for example waiting for an approval)
   * is not started a second time, and does not hold up the others.
   */
  async tick(now: Date): Promise<void> {
    const t = now.getTime();
    const started: Promise<unknown>[] = [];
    const start = (id: string, fn: () => Promise<void>) => {
      if (this.running.has(id)) return;
      this.running.add(id);
      started.push(fn().finally(() => this.running.delete(id)));
    };

    for (const agent of listAgents(this.home)) {
      const hb = this.heartbeatSettings(agent);
      const every = parseDuration(hb.every);
      if (!every) continue;
      const last = this.state.heartbeat[agent] ?? this.started;
      if (t - last < every) continue;
      if (!withinHours(hb.active_hours, now)) continue;
      if (this.running.has(`heartbeat:${agent}`)) continue;
      this.state.heartbeat[agent] = t;
      this.save();
      const file = path.join(this.home.vault, "Agents", agent, "HEARTBEAT.md");
      if (!fs.existsSync(file) || heartbeatIsEmpty(fs.readFileSync(file, "utf8"))) continue;
      start(`heartbeat:${agent}`, async () => {
        await this.execute({ kind: "heartbeat", name: agent, agent, prompt: HEARTBEAT_PROMPT.replace("{agent}", agent), target: hb.target });
      });
    }

    for (const job of this.jobs()) {
      if (!this.firstSeen.has(job.file)) this.firstSeen.set(job.file, t);
      if (this.running.has(`job:${job.file}`)) continue;
      const last = this.state.jobs[job.file]?.lastRun;
      let due = false;
      if (job.schedule) {
        const since = new Date(Math.max(last ?? 0, this.firstSeen.get(job.file)! - 60_000));
        const next = nextRun(job.schedule, since);
        due = !!next && next.getTime() <= t;
      } else if (job.every) {
        due = t - (last ?? this.firstSeen.get(job.file)!) >= job.every;
      } else if (job.at) {
        due = last === undefined && job.at.getTime() <= t && t - job.at.getTime() < 86_400_000;
      }
      if (!due) continue;
      this.state.jobs[job.file] = { lastRun: t, status: "running" };
      this.save();
      start(`job:${job.file}`, async () => {
        const status = await this.execute({ kind: "job", name: job.name, agent: job.agent, prompt: job.prompt, target: job.target });
        this.state.jobs[job.file] = { lastRun: t, status };
        this.save();
      });
    }
    await Promise.all(started);
  }

  private async execute(r: ScheduledRun): Promise<string> {
    try {
      return await this.run(r);
    } catch (err) {
      this.log("error", `${r.kind} '${r.name}' failed: ${(err as Error).message}`);
      return "failed";
    }
  }
}
