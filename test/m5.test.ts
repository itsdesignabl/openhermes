import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { compare, FAMILIES, formatReport, runBench, summarizeRuns, type Run } from "../src/eval/bench.js";
import { formatSummary, readTurns, summarize, type TurnRecord } from "../src/eval/metrics.js";
import { main } from "../src/main.js";
import { OpenAIProvider, type ChatResult, type Provider } from "../src/provider/openai.js";
import { ScriptedProvider, simulatedModel, tempHome } from "./helpers.js";

test("model client: reads token counts from the stream, and copes with an endpoint that rejects the option", async () => {
  const bodies: any[] = [];
  let strict = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      if (strict && body.stream_options) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "unknown field stream_options" }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      if (body.stream_options) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  try {
    const provider = new OpenAIProvider({ baseUrl, model: "m" });
    const a = await provider.chat([{ role: "user", content: "x" }], []);
    assert.deepEqual(a.usage, { promptTokens: 120, completionTokens: 7 });
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });

    strict = true;
    bodies.length = 0;
    const b = await provider.chat([{ role: "user", content: "x" }], []);
    assert.equal(b.content, "hi");
    assert.equal(b.usage, undefined);
    assert.deepEqual(bodies.map((x) => !!x.stream_options), [true, false], "retried once without the option");
    await provider.chat([{ role: "user", content: "x" }], []);
    assert.equal(bodies.length, 3, "and it is not sent again afterwards");
    assert.equal(bodies[2].stream_options, undefined);
  } finally {
    await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  }
});

test("each turn reports its cost: exact when the endpoint counts tokens, estimated otherwise", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ learning: { enabled: false } })}\n---\n`);
  try {
    let n = 0;
    const counting: Provider = {
      async chat(): Promise<ChatResult> {
        n++;
        return n === 1
          ? { content: "", toolCalls: [{ id: "c1", name: "list_files", arguments: "{}" }], usage: { promptTokens: 900, completionTokens: 12 } }
          : { content: "done", toolCalls: [], usage: { promptTokens: 1000, completionTokens: 5 } };
      },
    };
    let app = await App.start(home, { provider: counting, watch: false });
    const exact = (await app.send("list")).usage;
    assert.deepEqual({ ...exact, ms: 0 }, { modelCalls: 2, promptTokens: 1900, completionTokens: 17, estimated: false, ms: 0 });
    assert.ok(exact.ms >= 0);
    await app.stop();

    app = await App.start(home, { provider: new ScriptedProvider([{ content: "a reply of some length" }]), watch: false });
    const est = (await app.send("hello")).usage;
    assert.equal(est.estimated, true);
    assert.equal(est.modelCalls, 1);
    assert.ok(est.promptTokens > 300, "the system prompt and tool list are counted");
    assert.equal(est.completionTokens, Math.ceil(("a reply of some length".length + 2) / 4));
    await app.stop();
  } finally {
    cleanup();
  }
});

test("turns are logged as counts only, and stats summarises them by week and by skill", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ learning: { enabled: false } })}\n---\n`);
  fs.mkdirSync(path.join(home.vault, "Skills", "tidy"), { recursive: true });
  fs.writeFileSync(path.join(home.vault, "Skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidy up\n---\n\nSteps.\n");
  const provider = new ScriptedProvider([
    { calls: [{ name: "read_file", args: { path: "Skills/tidy/SKILL.md" } }, { name: "list_files", args: { path: "." } }] },
    { content: "tidied, the secret word is MARIGOLD" },
    { content: "chat reply" },
    { content: "job reply" },
  ]);
  const app = await App.start(home, { provider, watch: false });
  try {
    await app.send("please tidy, my private note says MARIGOLD");
    await app.send("hello", { conversation: "main:telegram:42" });
    await app.send("report", { conversation: "main:job:daily" });
    const turns = readTurns(home);
    assert.deepEqual(turns.map((t) => [t.kind, t.model_calls, t.tool_calls, t.skills]), [["local", 2, 2, ["tidy"]], ["chat", 1, 0, []], ["job", 1, 0, []]]);
    assert.ok(turns.every((t) => t.ok && t.estimated && t.prompt_tokens > 0 && t.agent === "main"));
    assert.ok(!fs.readFileSync(path.join(home.data, "metrics", "turns.jsonl"), "utf8").includes("MARIGOLD"), "no conversation text is stored");
    assert.equal(readTurns(home, Date.now() + 1000).length, 0);

    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      assert.equal(await main(["stats", "--home", home.root]), 0);
    } finally {
      console.log = log;
    }
    assert.match(lines[0]!, /Last 30 days[\s\S]*All turns\s+3\s[\s\S]*a skill was read\s+1\s+2\.0[\s\S]*no skill was read\s+1\s+1\.0[\s\S]*tidy\s+1\s[\s\S]*not a fair comparison/);
    assert.match(lines[0]!, /partly estimated/);
  } finally {
    await app.stop();
    cleanup();
  }

  const rec = (at: string, tokens: number, skills: string[] = [], kind = "chat"): TurnRecord => ({ at, agent: "main", kind, ok: true, model_calls: skills.length ? 2 : 4, tool_calls: 1, prompt_tokens: tokens, completion_tokens: 0, estimated: false, ms: 2000, skills });
  const s = summarize([rec("2026-11-02T10:00:00Z", 1000), rec("2026-11-08T23:00:00Z", 3000), rec("2026-11-09T01:00:00Z", 500, ["a", "b"]), rec("2026-11-10T01:00:00Z", 700, ["a"], "heartbeat")], 30);
  assert.deepEqual(s.weeks.map((x) => [x.week, x.turns, x.tokens]), [["2026-11-02", 2, 2000], ["2026-11-09", 2, 600]], "weeks run Monday to Sunday");
  assert.deepEqual([s.withSkill.turns, s.withoutSkill.turns], [1, 2], "heartbeat runs are left out of the with/without comparison");
  assert.deepEqual(s.skills.map((x) => [x.name, x.turns]), [["a", 2], ["b", 1]]);
  assert.equal(formatSummary(summarize([], 7)), "No turns recorded in the last 7 days.");
});

test("a difference is only called one with enough matched runs and a gap beyond the noise", () => {
  const pairs = (base: number[], other: number[]) => base.map((b, i) => [b, other[i]!] as [number, number]);
  assert.equal(compare(pairs([10, 10, 10], [5, 5, 5])).verdict, "too few runs");
  const lower = compare(pairs([100, 110, 90, 105, 95, 100], [60, 70, 55, 62, 58, 61]));
  assert.equal(lower.verdict, "lower");
  assert.equal(Math.round(lower.change_pct), -39);
  assert.equal(compare(pairs([60, 70, 55, 62, 58, 61], [100, 110, 90, 105, 95, 100])).verdict, "higher");
  assert.equal(compare(pairs([100, 50, 120, 80, 60, 110], [60, 110, 100, 90, 100, 70])).verdict, "no clear difference", "a mean gap inside the spread is not a finding");
  assert.equal(compare(pairs([5, 5, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5])).verdict, "no clear difference");
  assert.equal(compare(pairs([1000, 1010, 990, 1005, 995, 1000], [1020, 1030, 1010, 1025, 1015, 1020])).verdict, "no clear difference", "a steady gap of 2% is too small to report");
});

test("benchmark: a model that uses skills shows fewer calls and tokens with a learned or hand-written skill", async () => {
  const { home, cleanup } = tempHome();
  try {
    const before = fs.readdirSync(path.join(home.vault, "Skills"));
    const lines: string[] = [];
    const rep = await runBench(home, { provider: simulatedModel(), trials: 3, only: "weekly,release", log: (l) => void lines.push(l) });
    assert.deepEqual(rep.families, ["weekly-report", "release"], "--only picks task types by parts of their names");
    assert.equal(rep.runs.length, 2 * 3 * 3);
    assert.ok(rep.runs.every((x) => x.success && !x.error), "every arm solves the tasks, so only cost differs");

    const { baseline, learned, reference } = rep.summary;
    assert.equal(baseline!.success_pct, 100);
    assert.equal(baseline!.skill_read_pct, 0);
    assert.equal(learned!.skill_read_pct, 100);
    assert.equal(reference!.skill_read_pct, 100);
    assert.equal(baseline!.model_calls, (7 + 9) / 2, "explore, read the convention, do the work, answer");
    assert.equal(learned!.model_calls, (4 + 6) / 2, "read the skill, do the work, answer");
    assert.equal(reference!.model_calls, learned!.model_calls);
    assert.ok(learned!.tokens < baseline!.tokens);

    assert.equal(rep.versus_baseline.learned!.model_calls.verdict, "lower");
    assert.equal(rep.versus_baseline.learned!.tokens.verdict, "lower");
    assert.equal(rep.versus_baseline.learned!.tokens.pairs, 6);
    assert.equal(rep.versus_baseline.reference!.tokens.verdict, "lower");
    assert.equal(rep.learning!.skill_created_pct, 100);
    assert.ok(rep.learning!.review_tokens > 0);
    assert.ok(rep.learning!.break_even_repeats! >= 1);
    const learnedRun = rep.runs.find((x) => x.arm === "learned")!;
    assert.deepEqual([learnedRun.learning!.train_success, learnedRun.learning!.review_calls, learnedRun.learning!.skills_created], [true, 2, 1]);

    const text = formatReport(rep);
    assert.match(text, /baseline\s+6\s+100%\s+8\.0/);
    assert.match(text, /learned\s+6\s+100%\s+5\.0/);
    assert.match(text, /With the skill the agent learned itself: 100% of tasks done correctly, against 100% without a skill\. Cost was lower: -\d+% tokens and -\d+% model calls per task, over 6 matched runs\./);
    assert.match(text, /The review after the practice task wrote a skill in 100% of cases and cost [\d,]+ tokens on average\. At the measured saving that is paid back after \d+ repeats? of the task\./);
    assert.match(text, /Token counts are estimated/);
    assert.equal(lines.filter((l) => /^\[\d+\/18\]/.test(l)).length, 18, "one progress line per run");

    // everything happened inside throwaway homes under data/bench; the real vault is untouched
    assert.deepEqual(fs.readdirSync(path.join(home.vault, "Skills")), before);
    const [runDir] = fs.readdirSync(path.join(home.data, "bench"));
    const files = fs.readdirSync(path.join(home.data, "bench", runDir!));
    assert.ok(files.includes("results.json") && files.includes("report.txt") && files.includes("release-1-learned"));
    assert.ok(fs.existsSync(path.join(home.data, "bench", runDir!, "release-1-learned", "vault", "Skills", "release", "SKILL.md")), "the learned skill is there to inspect");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home.data, "bench", runDir!, "results.json"), "utf8")).runs.length, 18);
  } finally {
    cleanup();
  }
});

test("benchmark: reports no benefit when the model ignores skills, or when its review writes none", async () => {
  const { home, cleanup } = tempHome();
  try {
    const ignores = await runBench(home, { provider: simulatedModel({ usesSkills: false }), trials: 3, only: "weekly,release" });
    assert.equal(ignores.versus_baseline.learned!.tokens.verdict, "no clear difference");
    assert.equal(ignores.summary.reference!.skill_read_pct, 0);
    assert.equal(ignores.learning!.break_even_repeats, null);
    const text = ignores.conclusion.join("\n");
    assert.match(text, /No clear difference in cost/);
    assert.match(text, /No saving was measured that would pay this back/);
    assert.match(text, /the agent did not open the skill that was available, so the model is not making use of skills/);

    const noSkills = await runBench(home, { provider: simulatedModel({ writesSkills: false }), trials: 3, only: "weekly,release" });
    assert.equal(noSkills.learning!.skill_created_pct, 0);
    assert.equal(noSkills.versus_baseline.learned!.tokens.verdict, "no clear difference");
    assert.equal(noSkills.versus_baseline.reference!.tokens.verdict, "lower");
    assert.match(noSkills.conclusion.join("\n"), /A hand-written skill helped but the self-learned one did not: the model follows skills, and the weak point is the skills its review writes\./);
  } finally {
    cleanup();
  }
});

test("benchmark: wrong results count as wrong and are left out of the cost comparison; options are checked", async () => {
  const { home, cleanup } = tempHome();
  try {
    const rep = await runBench(home, { provider: simulatedModel({ breaks: "weekly-report" }), trials: 1, arms: ["baseline", "reference"] });
    assert.deepEqual(rep.families, FAMILIES.map((f) => f.name));
    assert.deepEqual(rep.arms, ["baseline", "reference"]);
    assert.equal(rep.runs.filter((x) => x.family === "weekly-report" && x.success).length, 0, "a report saved in the wrong place is not correct");
    assert.equal(rep.runs.filter((x) => x.family === "release" && x.success).length, 2);
    assert.equal(rep.versus_baseline.reference!.tokens.pairs, 1, "only pairs where both runs were correct are compared");
    assert.equal(rep.versus_baseline.reference!.tokens.verdict, "too few runs");
    assert.match(rep.conclusion[0]!, /too few matched successful runs \(1\).*Run more trials/);
    assert.equal(rep.learning, undefined);

    await assert.rejects(runBench(home, { provider: simulatedModel(), only: "nonsense" }), /No task type matches 'nonsense'\. Available: weekly-report, release, contact-card, order-status/);
    await assert.rejects(main(["bench", "--arms", "baseline,magic", "--home", home.root]), /Unknown arm 'magic'/);
    await assert.rejects(main(["bench", "--trials", "0", "--home", home.root]), /--trials must be a whole number/);
  } finally {
    cleanup();
  }
});

test("every task type: the check rejects an untouched vault and accepts a correct result", () => {
  for (const family of FAMILIES) {
    const { home, cleanup } = tempHome();
    try {
      const env = { home };
      family.seed(env);
      assert.equal(family.check(env, ""), false, `${family.name}: nothing done yet`);
      const v = (rel: string, text: string, append = false) => {
        const f = path.join(home.vault, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        append ? fs.appendFileSync(f, text) : fs.writeFileSync(f, text);
      };
      let answer = "";
      if (family.name === "weekly-report") {
        v("Reports/Weekly/2026-W13.md", "# Weekly report 2026-W13\nStatus: amber\n\n## Highlights\n\n- a\n- b\n- c\n");
      } else if (family.name === "release") {
        v("Project/VERSION", "1.4.4\n");
        v("Project/CHANGELOG.md", "# Changelog\n\n## 1.4.4\n\n- Add moon phases\n\n## 1.4.2\n\n- Faster chart loading\n");
        v("Project/releases.log", "1.4.4 released\n", true);
      } else if (family.name === "contact-card") {
        v("People/Kovacs, Imre.md", "# Imre Kovacs\n\n- Role: surveyor\n- Organisation: Tidewater Ltd\n- Met: 9 April\n\n## Notes\n");
        v("People/INDEX.md", "- Kovacs, Imre\n", true);
      } else {
        v("Data/lookups.log", "B-203 looked up\n", true);
        answer = "Order B-203 belongs to Dagny and is packed.";
      }
      assert.equal(family.check(env, answer), true, `${family.name}: correct result`);
      assert.ok(family.reference.body.length > 50 && family.train !== family.test);
    } finally {
      cleanup();
    }
  }
  // near misses
  const { home, cleanup } = tempHome();
  try {
    const report = FAMILIES[0]!;
    report.seed({ home });
    const f = path.join(home.vault, "Reports", "Weekly", "2026-W13.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "# Weekly report 2026-W13\nStatus: amber\n\n## Highlights\n\n- a\n- b\n- c\n- d\n");
    assert.equal(report.check({ home }, ""), false, "four highlights is not the house format");
    fs.writeFileSync(f, "# Weekly report 2026-W13\nStatus: green\n\n## Highlights\n\n- a\n- b\n- c\n");
    assert.equal(report.check({ home }, ""), false, "the status must come from the notes");
  } finally {
    cleanup();
  }
});

test("the summary names the right cause when only the hand-written skill helps", () => {
  const run = (arm: Run["arm"], trial: number, tokens: number, extra: Partial<Run> = {}): Run => ({ family: "f", trial, arm, success: true, model_calls: tokens / 100, tool_calls: 1, tokens, seconds: 1, skill_read: arm !== "baseline", ...extra });
  const runs: Run[] = [];
  for (let t = 1; t <= 6; t++) {
    runs.push(run("baseline", t, 1000 + t * 10));
    runs.push(run("learned", t, 1000 + (t % 2 ? 40 : -30), { learning: { train_success: true, review_calls: 2, review_tokens: 800, skills_created: 1, facts_saved: 0 } }));
    runs.push(run("reference", t, 600 + t * 5));
  }
  const s = summarizeRuns(runs, ["baseline", "learned", "reference"]);
  assert.equal(s.versus_baseline.learned!.tokens.verdict, "no clear difference");
  assert.equal(s.versus_baseline.reference!.tokens.verdict, "lower");
  assert.ok(s.conclusion.some((c) => /the weak point is the skills its review writes/.test(c)));
  assert.ok(!s.conclusion.some((c) => /not making use of skills/.test(c)));
});
