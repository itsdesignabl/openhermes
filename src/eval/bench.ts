import fs from "node:fs";
import path from "node:path";
import { App } from "../app.js";
import { loadConfig } from "../kernel/config.js";
import { Home } from "../kernel/home.js";
import type { ChatMessage, ChatResult, Provider, ToolSpec } from "../provider/openai.js";
import { scaffold } from "../vault/layout.js";
import { estimateTokens } from "../agent/loop.js";
import { mean } from "./metrics.js";

export type Arm = "baseline" | "learned" | "reference";
export const ARMS: Arm[] = ["baseline", "learned", "reference"];

interface Env {
  home: Home;
}

/**
 * A kind of task the user asks for repeatedly. Doing it right depends on conventions that are
 * written down somewhere in the vault, so the first time takes exploring. `train` and `test`
 * are two different instances of the same kind of task.
 */
export interface Family {
  name: string;
  seed(env: Env): void;
  train: string;
  test: string;
  check(env: Env, answer: string): boolean;
  /** A correct, hand-written skill: the best case for what learning could produce. */
  reference: { name: string; description: string; body: string };
}

const w = (env: Env, rel: string, text: string) => {
  const f = path.join(env.home.vault, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const r = (env: Env, rel: string) => {
  const f = path.join(env.home.vault, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

export const FAMILIES: Family[] = [
  {
    name: "weekly-report",
    seed(env) {
      w(env, "Docs/Conventions/reports.md", "# Weekly reports\n\nWeekly reports are saved as `Reports/Weekly/YYYY-Www.md`, for example `Reports/Weekly/2026-W07.md`.\n\nThe note has exactly this shape:\n\n- first line: `# Weekly report YYYY-Www`\n- then a line `Status: green`, `Status: amber` or `Status: red`\n- then a heading `## Highlights` with exactly three bullet points\n");
      w(env, "Docs/Conventions/naming.md", "# Naming\n\nUse lower-case file names with hyphens for project notes.\n");
      w(env, "Docs/Old/reports-2019.md", "# Reports (outdated, do not use)\n\nUntil 2019 reports were saved in `Archive/` as plain text.\n");
      w(env, "Notes/week-12.md", "# Week 12\n\nAll on track.\n\n- Finished the harbour survey\n- Ordered the new depth sounder\n- Trained two volunteers\n- Fixed the trailer light\n");
      w(env, "Notes/week-13.md", "# Week 13\n\nBehind schedule because of the storm, so status is amber.\n\n- Storm damage on pier 4 inspected\n- Depth sounder arrived\n- Survey of the east channel postponed\n- Volunteer rota drawn up\n");
    },
    train: "Write the weekly report for week 12 of 2026 from Notes/week-12.md. Follow our conventions for weekly reports; they are written down somewhere in the vault.",
    test: "Write the weekly report for week 13 of 2026 from Notes/week-13.md. Follow our conventions for weekly reports; they are written down somewhere in the vault.",
    check(env) {
      const t = r(env, "Reports/Weekly/2026-W13.md").trim();
      const bullets = (t.split(/^## Highlights\s*$/m)[1] ?? "").split(/^#/m)[0]!.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
      return /^# Weekly report 2026-W13\s*$/m.test(t.split("\n")[0] ?? "") && /^Status: amber\s*$/m.test(t) && bullets.length === 3;
    },
    reference: {
      name: "weekly-report",
      description: "How to write a weekly report in the house format",
      body: "1. Read the week's notes in `Notes/week-NN.md`.\n2. Create `Reports/Weekly/YYYY-Www.md` (for example `Reports/Weekly/2026-W07.md`).\n3. First line: `# Weekly report YYYY-Www`.\n4. Next, a line `Status: green`, `Status: amber` or `Status: red`, taken from the notes.\n5. Then the heading `## Highlights` with exactly three bullet points: the three most important items.\n\nThe conventions are in `Docs/Conventions/reports.md` if anything is unclear.",
    },
  },
  {
    name: "release",
    seed(env) {
      w(env, "Project/VERSION", "1.4.2\n");
      w(env, "Project/CHANGELOG.md", "# Changelog\n\n## 1.4.2\n\n- Faster chart loading\n\n## 1.4.1\n\n- First public version\n");
      w(env, "Project/releases.log", "1.4.1 released\n1.4.2 released\n");
      w(env, "Docs/release-process.md", "# Release process\n\nA release has three steps, all in the `Project` folder:\n\n1. Put the new version number in `VERSION` (the number only).\n2. Add a section `## <version>` to `CHANGELOG.md`, directly under the title and above the older sections, with the change as a bullet point.\n3. Add a line `<version> released` at the end of `releases.log`.\n");
      w(env, "Docs/coding-style.md", "# Coding style\n\nFour spaces, no tabs.\n");
    },
    train: "Release version 1.4.3 of the project. The change is: Fix tide table rounding. Follow our release process, which is documented in the vault.",
    test: "Release version 1.4.4 of the project. The change is: Add moon phases. Follow our release process, which is documented in the vault.",
    check(env) {
      const log = r(env, "Project/CHANGELOG.md");
      const at = log.indexOf("## 1.4.4");
      return r(env, "Project/VERSION").trim() === "1.4.4" && at > 0 && at < log.indexOf("## 1.4.2") && /moon phases/i.test(log.slice(at, log.indexOf("## 1.4.2"))) && /^1\.4\.4 released\s*$/m.test(r(env, "Project/releases.log"));
    },
    reference: {
      name: "release",
      description: "How to release a new version of the project",
      body: "All files are in the `Project` folder.\n\n1. Replace the content of `Project/VERSION` with the new version number only.\n2. In `Project/CHANGELOG.md`, add a section `## <version>` directly under the `# Changelog` title, above the older sections, with the change as one bullet point.\n3. Append a line `<version> released` to the end of `Project/releases.log`.\n\nThe process is described in `Docs/release-process.md`.",
    },
  },
  {
    name: "contact-card",
    seed(env) {
      w(env, "Templates/person.md", "# {First name} {Last name}\n\n- Role:\n- Organisation:\n- Met:\n\n## Notes\n");
      w(env, "Docs/Conventions/people.md", "# People notes\n\nEvery person gets a note `People/<Last name>, <First name>.md`, made from `Templates/person.md` with the fields filled in.\n\nAlso add the person to `People/INDEX.md` as a line `- <Last name>, <First name>`.\n");
      w(env, "People/INDEX.md", "# People\n\n- Aaland, Signe\n");
      w(env, "People/Aaland, Signe.md", "# Signe Aaland\n\n- Role: skipper\n- Organisation: Fjord Ferries\n- Met: 12 January\n\n## Notes\n");
    },
    train: "Add a note for Dana Whitlock. She is the harbour master at the Port Authority and we met on 3 March. Use our convention for people notes.",
    test: "Add a note for Imre Kovacs. He is a surveyor at Tidewater Ltd and we met on 9 April. Use our convention for people notes.",
    check(env) {
      const t = r(env, "People/Kovacs, Imre.md");
      return /^# Imre Kovacs/m.test(t) && /Role:\s*surveyor/i.test(t) && /Organisation:\s*Tidewater/i.test(t) && /Met:\s*9 April/i.test(t) && /^- Kovacs, Imre\s*$/m.test(r(env, "People/INDEX.md"));
    },
    reference: {
      name: "people-note",
      description: "How to add a note about a person",
      body: "1. Create `People/<Last name>, <First name>.md` with this content, filled in:\n\n   # <First name> <Last name>\n\n   - Role: <role>\n   - Organisation: <organisation>\n   - Met: <date>\n\n   ## Notes\n\n2. Add a line `- <Last name>, <First name>` at the end of `People/INDEX.md`.\n\nThe convention is in `Docs/Conventions/people.md` and the template in `Templates/person.md`.",
    },
  },
  {
    name: "order-status",
    seed(env) {
      w(env, "Data/README.md", "# Data\n\nOrder exports are kept per year in `Data/Exports/<year>/orders.md`, one line per order: `order id | customer | status`.\n\nWhen asked about an order, answer with the customer and the status, and log the question as a line `<order id> looked up` at the end of `Data/lookups.log`.\n");
      w(env, "Data/Exports/2025/orders.md", "A-100 | Aldous | delivered\nA-101 | Beryl | delivered\n");
      w(env, "Data/Exports/2026/orders.md", "B-200 | Aldous | shipped\nB-201 | Beryl | waiting for payment\nB-202 | Corin | cancelled\nB-203 | Dagny | packed\n");
      w(env, "Data/lookups.log", "A-100 looked up\n");
    },
    train: "What is the state of order B-201 from 2026? Our order data and the way we handle such questions are described somewhere under Data.",
    test: "What is the state of order B-203 from 2026? Our order data and the way we handle such questions are described somewhere under Data.",
    check(env, answer) {
      return /dagny/i.test(answer) && /packed/i.test(answer) && /^B-203 looked up\s*$/m.test(r(env, "Data/lookups.log"));
    },
    reference: {
      name: "order-lookup",
      description: "How to answer a question about an order",
      body: "1. Read `Data/Exports/<year>/orders.md`. Each line is `order id | customer | status`.\n2. Answer with the customer and the status of the order.\n3. Append a line `<order id> looked up` to the end of `Data/lookups.log`.\n\nThe rules are in `Data/README.md`.",
    },
  },
];

interface Count {
  calls: number;
  tokens: number;
  estimated: boolean;
}

/** Wraps the real model so every call is counted in whichever phase is current. */
class CountingProvider implements Provider {
  current: Count = { calls: 0, tokens: 0, estimated: false };
  constructor(private inner: Provider) {}
  phase(): Count {
    return (this.current = { calls: 0, tokens: 0, estimated: false });
  }
  async chat(messages: ChatMessage[], tools: ToolSpec[], onDelta?: (t: string) => void, signal?: AbortSignal): Promise<ChatResult> {
    const result = await this.inner.chat(messages, tools, onDelta, signal);
    this.current.calls++;
    if (result.usage) this.current.tokens += result.usage.promptTokens + result.usage.completionTokens;
    else {
      this.current.estimated = true;
      this.current.tokens += estimateTokens(messages, tools) + Math.ceil((result.content.length + JSON.stringify(result.toolCalls).length) / 4);
    }
    return result;
  }
}

export interface Run {
  family: string;
  trial: number;
  arm: Arm;
  success: boolean;
  model_calls: number;
  tool_calls: number;
  tokens: number;
  seconds: number;
  /** Whether the agent opened a skill while doing the task. */
  skill_read: boolean;
  error?: string;
  /** Learned arm only: what the practice run and the review cost and produced. */
  learning?: { train_success: boolean; review_calls: number; review_tokens: number; skills_created: number; facts_saved: number };
}

export interface Comparison {
  pairs: number;
  base: number;
  other: number;
  change_pct: number;
  verdict: "lower" | "higher" | "no clear difference" | "too few runs";
}

/**
 * Compares a measure between two arms over matched runs (same task, same trial).
 * Calls it a difference only with at least six pairs, a mean difference beyond twice its standard error,
 * and a change of at least 5%.
 */
export function compare(pairs: [number, number][]): Comparison {
  const base = mean(pairs.map((p) => p[0]));
  const other = mean(pairs.map((p) => p[1]));
  const out: Comparison = { pairs: pairs.length, base, other, change_pct: base ? ((other - base) / base) * 100 : 0, verdict: "too few runs" };
  if (pairs.length < 6) return out;
  const diffs = pairs.map((p) => p[1] - p[0]);
  const m = mean(diffs);
  const se = Math.sqrt(mean(diffs.map((d) => (d - m) ** 2)) * (diffs.length / (diffs.length - 1)) / diffs.length);
  // beyond the noise, and large enough to matter: a steady 1% gap is not worth reporting as a difference
  const real = m !== 0 && Math.abs(m) > 2 * se && Math.abs(out.change_pct) >= 5;
  out.verdict = real ? (m < 0 ? "lower" : "higher") : "no clear difference";
  return out;
}

export interface BenchReport {
  started: string;
  model: string;
  trials: number;
  families: string[];
  arms: Arm[];
  estimated_tokens: boolean;
  runs: Run[];
  summary: Record<string, { runs: number; success_pct: number; model_calls: number; tool_calls: number; tokens: number; seconds: number; skill_read_pct: number }>;
  /** Each arm against the baseline, over pairs where both runs succeeded. */
  versus_baseline: Record<string, { tokens: Comparison; model_calls: Comparison }>;
  learning?: { skill_created_pct: number; review_tokens: number; break_even_repeats: number | null };
  conclusion: string[];
}

export function summarizeRuns(runs: Run[], arms: Arm[]): Pick<BenchReport, "summary" | "versus_baseline" | "learning" | "conclusion"> {
  const summary: BenchReport["summary"] = {};
  for (const arm of arms) {
    const rs = runs.filter((x) => x.arm === arm);
    if (!rs.length) continue;
    summary[arm] = {
      runs: rs.length,
      success_pct: (rs.filter((x) => x.success).length / rs.length) * 100,
      model_calls: mean(rs.map((x) => x.model_calls)),
      tool_calls: mean(rs.map((x) => x.tool_calls)),
      tokens: mean(rs.map((x) => x.tokens)),
      seconds: mean(rs.map((x) => x.seconds)),
      skill_read_pct: (rs.filter((x) => x.skill_read).length / rs.length) * 100,
    };
  }
  const versus: BenchReport["versus_baseline"] = {};
  const pairsFor = (arm: Arm, pick: (x: Run) => number): [number, number][] => {
    const out: [number, number][] = [];
    for (const b of runs.filter((x) => x.arm === "baseline" && x.success)) {
      const o = runs.find((x) => x.arm === arm && x.family === b.family && x.trial === b.trial && x.success);
      if (o) out.push([pick(b), pick(o)]);
    }
    return out;
  };
  for (const arm of arms) {
    if (arm === "baseline" || !summary.baseline || !summary[arm]) continue;
    versus[arm] = { tokens: compare(pairsFor(arm, (x) => x.tokens)), model_calls: compare(pairsFor(arm, (x) => x.model_calls)) };
  }

  const conclusion: string[] = [];
  const say = (arm: Arm, label: string) => {
    const v = versus[arm];
    const s = summary[arm];
    if (!v || !s) return;
    const success = `${Math.round(s.success_pct)}% of tasks done correctly, against ${Math.round(summary.baseline!.success_pct)}% without a skill`;
    if (v.tokens.verdict === "too few runs") conclusion.push(`${label}: ${success}. There are too few matched successful runs (${v.tokens.pairs}) to say anything about cost. Run more trials.`);
    else if (v.tokens.verdict === "no clear difference") conclusion.push(`${label}: ${success}. No clear difference in cost (${fmtPct(v.tokens.change_pct)} tokens over ${v.tokens.pairs} matched runs, within the noise).`);
    else conclusion.push(`${label}: ${success}. Cost was ${v.tokens.verdict}: ${fmtPct(v.tokens.change_pct)} tokens and ${fmtPct(v.model_calls.change_pct)} model calls per task, over ${v.tokens.pairs} matched runs.`);
  };
  say("learned", "With the skill the agent learned itself");
  say("reference", "With a hand-written skill");

  let learning: BenchReport["learning"];
  const learned = runs.filter((x) => x.arm === "learned" && x.learning);
  if (learned.length) {
    const review = mean(learned.map((x) => x.learning!.review_tokens));
    const v = versus.learned?.tokens;
    const saving = v && v.verdict === "lower" ? v.base - v.other : 0;
    learning = {
      skill_created_pct: (learned.filter((x) => x.learning!.skills_created > 0).length / learned.length) * 100,
      review_tokens: review,
      break_even_repeats: saving > 0 ? Math.ceil(review / saving) : null,
    };
    conclusion.push(
      `The review after the practice task wrote a skill in ${Math.round(learning.skill_created_pct)}% of cases and cost ${Math.round(review).toLocaleString("en-US")} tokens on average.` +
        (learning.break_even_repeats ? ` At the measured saving that is paid back after ${learning.break_even_repeats} repeat${learning.break_even_repeats === 1 ? "" : "s"} of the task.` : " No saving was measured that would pay this back."),
    );
    if (versus.reference?.tokens.verdict === "lower" && versus.learned?.tokens.verdict !== "lower") {
      conclusion.push("A hand-written skill helped but the self-learned one did not: the model follows skills, and the weak point is the skills its review writes.");
    }
    if (summary.reference && summary.reference.skill_read_pct < 50) conclusion.push("In most runs the agent did not open the skill that was available, so the model is not making use of skills.");
  }
  return { summary, versus_baseline: versus, learning, conclusion };
}

const fmtPct = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;

export function formatReport(rep: BenchReport): string {
  const lines = [
    `Benchmark of learned skills`,
    `Model: ${rep.model}. ${rep.families.length} task type${rep.families.length === 1 ? "" : "s"} (${rep.families.join(", ")}), ${rep.trials} trial${rep.trials === 1 ? "" : "s"} each.`,
    rep.estimated_tokens ? "Token counts are estimated from text length: the model endpoint does not report them." : "",
    "",
    "Averages per task (the second, unseen instance of each task type):",
    "",
    `${"".padEnd(11)}${"runs".padStart(5)}${"correct".padStart(9)}${"model calls".padStart(13)}${"tool calls".padStart(12)}${"tokens".padStart(10)}${"seconds".padStart(9)}${"skill opened".padStart(14)}`,
  ];
  for (const arm of rep.arms) {
    const s = rep.summary[arm];
    if (!s) continue;
    lines.push(
      `${arm.padEnd(11)}${String(s.runs).padStart(5)}${`${Math.round(s.success_pct)}%`.padStart(9)}${s.model_calls.toFixed(1).padStart(13)}${s.tool_calls.toFixed(1).padStart(12)}${Math.round(s.tokens).toLocaleString("en-US").padStart(10)}${s.seconds.toFixed(1).padStart(9)}${(arm === "baseline" ? "-" : `${Math.round(s.skill_read_pct)}%`).padStart(14)}`,
    );
  }
  lines.push("", "  baseline   no skill available", "  learned    the agent did one practice task of the same type, then reviewed it", "  reference  a correct hand-written skill was installed", "");
  lines.push("What this shows:", ...rep.conclusion.map((c) => `- ${c}`));
  const failed = rep.runs.filter((x) => x.error);
  if (failed.length) lines.push("", `${failed.length} run${failed.length === 1 ? "" : "s"} ended with an error, for example: ${failed[0]!.error}`);
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}

export interface BenchOptions {
  provider?: Provider;
  trials?: number;
  only?: string;
  arms?: Arm[];
  log?: (line: string) => void;
}

/**
 * Runs every task type under each arm in fresh throwaway homes (inside data/bench of the real home),
 * using the real home's model. Plugins, hooks, tool servers and the sandbox are left out so the
 * runs differ only in whether a skill is available.
 */
export async function runBench(realHome: Home, opts: BenchOptions = {}): Promise<BenchReport> {
  const log = opts.log ?? (() => {});
  const trials = Math.max(1, opts.trials ?? 3);
  const arms = opts.arms?.length ? opts.arms : ARMS;
  const wanted = (opts.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const families = FAMILIES.filter((f) => !wanted.length || wanted.some((x) => f.name.includes(x)));
  if (!families.length) throw new Error(`No task type matches '${opts.only}'. Available: ${FAMILIES.map((f) => f.name).join(", ")}`);
  const started = new Date().toISOString();
  const runRoot = path.join(realHome.data, "bench", started.replace(/[:.]/g, "-"));

  let owner: App | undefined;
  let inner = opts.provider;
  let model = "custom provider";
  if (!inner) {
    owner = await App.start(realHome, { watch: false });
    owner.bus.on("log", (e) => log(`[${e.level}] ${e.message}`));
    inner = await owner.getProvider();
    model = owner.modelLabel();
  }
  const provider = new CountingProvider(inner);
  const real = loadConfig(realHome);
  const config = {
    provider: real.provider,
    local_model: real.local_model,
    agent_loop: real.agent_loop,
    memory: real.memory,
    // reviews are started by the benchmark itself, at a known point
    learning: { enabled: true, reflect_every_turns: 100000, reflect_idle_minutes: 0, min_turns: 1, curator_every: "0m", notify: false },
  };
  const policies = { policies: { "memory.edit": "auto", "vault.write": "auto", "skill.edit": "auto", "skill.edit_executable": "auto", "command.other": "auto" } };

  const runs: Run[] = [];
  let n = 0;
  const total = families.length * trials * arms.length;
  try {
    for (let trial = 1; trial <= trials; trial++) {
      for (const family of families) {
        for (const arm of arms) {
          n++;
          const env: Env = { home: new Home(path.join(runRoot, `${family.name}-${trial}-${arm}`)) };
          scaffold(env.home);
          fs.writeFileSync(path.join(env.home.vault, "System", "config.md"), `---\n${JSON.stringify(config)}\n---\n`);
          fs.writeFileSync(path.join(env.home.vault, "System", "policies.md"), `---\n${JSON.stringify(policies)}\n---\n`);
          family.seed(env);
          if (arm === "reference") {
            const s = family.reference;
            const file = path.join(env.home.vault, "Skills", s.name, "SKILL.md");
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`);
          }
          const run: Run = { family: family.name, trial, arm, success: false, model_calls: 0, tool_calls: 0, tokens: 0, seconds: 0, skill_read: false };
          const app = await App.start(env.home, { provider, approver: async () => true, watch: false });
          try {
            if (arm === "learned") {
              provider.phase();
              let trainOk = false;
              try {
                await app.send(family.train);
                // the practice task is judged leniently: it only has to finish
                trainOk = true;
              } catch {}
              const review = provider.phase();
              let created = 0;
              let facts = 0;
              const off = app.bus.on("learning.reflected", (e) => {
                created += e.applied.filter((t) => /skill/i.test(t)).length;
                facts += e.applied.filter((t) => !/skill/i.test(t)).length;
              });
              app.newSession(); // ends the practice conversation, which starts the review
              await app.idle();
              off();
              run.learning = { train_success: trainOk, review_calls: review.calls, review_tokens: review.tokens, skills_created: created, facts_saved: facts };
            }
            const count = provider.phase();
            const off = app.bus.on("tool.requested", (e) => {
              const p = (e.args as { path?: unknown } | undefined)?.path;
              if (e.name === "read_file" && typeof p === "string" && /^(vault\/)?skills\//i.test(p.replace(/\\/g, "/"))) run.skill_read = true;
            });
            const t0 = Date.now();
            try {
              const result = await app.send(family.test);
              run.tool_calls = result.toolsUsed.length;
              run.success = family.check(env, result.text);
            } catch (err) {
              run.error = (err as Error).message;
            }
            off();
            run.seconds = (Date.now() - t0) / 1000;
            run.model_calls = count.calls;
            run.tokens = count.tokens;
            if (count.estimated) (run as Run & { est?: boolean }).est = true;
          } finally {
            await app.stop();
          }
          runs.push(run);
          log(
            `[${n}/${total}] ${family.name.padEnd(14)} ${arm.padEnd(10)} ${run.success ? "correct" : "wrong  "}  ${run.model_calls} calls, ${run.tokens.toLocaleString("en-US")} tokens, ${run.seconds.toFixed(1)}s` +
              (run.learning ? `  (review wrote ${run.learning.skills_created} skill${run.learning.skills_created === 1 ? "" : "s"})` : "") +
              (run.error ? `  ${run.error}` : ""),
          );
        }
      }
    }
  } finally {
    await owner?.stop();
  }
  const estimated = runs.some((x) => (x as Run & { est?: boolean }).est);
  const report: BenchReport = { started, model, trials, families: families.map((f) => f.name), arms, estimated_tokens: estimated, runs, ...summarizeRuns(runs, arms) };
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(runRoot, "report.txt"), formatReport(report) + "\n");
  log(`\n${formatReport(report)}\n\nEvery run's home folder and the full results are in ${realHome.display(runRoot)}`);
  return report;
}
