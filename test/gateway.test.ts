import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { recentHistory } from "../src/agent/session.js";
import { chunkText, type Channel } from "../src/channels/types.js";
import { findGateway } from "../src/gateway/client.js";
import { nextRun, parseCron, parseDuration, withinHours } from "../src/gateway/cron.js";
import { Gateway } from "../src/gateway/gateway.js";
import { Pairing } from "../src/gateway/pairing.js";
import { heartbeatIsEmpty, loadJobs } from "../src/gateway/scheduler.js";
import type { ChatMessage } from "../src/provider/openai.js";
import { openBackend } from "../src/tui/backend.js";
import { ScriptedProvider, tempHome } from "./helpers.js";

class FakeChannel implements Channel {
  state = "connected";
  sent: { peer: string; text: string }[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly name = "fake") {}
  async start() {}
  async stop() {}
  async send(peer: string, text: string) {
    this.sent.push({ peer, text });
    this.waiters.splice(0).forEach((w) => w());
  }
  /** Resolves once at least `n` messages have been sent. */
  async until(n: number): Promise<void> {
    while (this.sent.length < n) await new Promise<void>((r) => this.waiters.push(r));
  }
  texts() {
    return this.sent.map((s) => s.text);
  }
}

type Steps = ConstructorParameters<typeof ScriptedProvider>[0];

async function withGateway(
  steps: Steps,
  fn: (x: { gateway: Gateway; app: App; chan: FakeChannel; provider: ScriptedProvider; home: App["home"] }) => Promise<void>,
  setup?: (home: App["home"]) => void,
) {
  const { home, cleanup } = tempHome();
  setConfig(home, {});
  setup?.(home);
  const provider = new ScriptedProvider(steps);
  const app = await App.start(home, { provider, watch: false });
  const gateway = new Gateway(app);
  await gateway.start({ scheduler: false });
  const chan = new FakeChannel();
  gateway.channels.set(chan.name, chan);
  try {
    await fn({ gateway, app, chan, provider, home });
  } finally {
    await gateway.stop();
    await app.stop();
    cleanup();
  }
}

function setConfig(home: App["home"], extra: Record<string, unknown>) {
  // port 0: let the system pick a free port for each test
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ gateway: { port: 0, approval_timeout_s: 1 }, ...extra })}\n---\n`);
}

const dm = (text: string, sender = "42", peer = sender) => ({ channel: "fake", peer, sender, senderName: "Ada", text, isGroup: false, mentioned: false });

test("schedules: cron fields, next run, durations, active hours", () => {
  const at = (s: string) => new Date(s);
  assert.equal(nextRun("0 9 * * 1-5", at("2026-11-20T10:00:00"))!.toString(), at("2026-11-23T09:00:00").toString(), "Friday 10:00 → Monday 09:00");
  assert.equal(nextRun("*/15 * * * *", at("2026-11-20T10:07:30"))!.toString(), at("2026-11-20T10:15:00").toString());
  assert.equal(nextRun("30 8 1 * *", at("2026-11-20T00:00:00"))!.toString(), at("2026-12-01T08:30:00").toString());
  assert.equal(nextRun("0 0 * * sun", at("2026-11-20T00:00:00"))!.getDay(), 0);
  assert.equal(nextRun("0 0 * * 7", at("2026-11-20T00:00:00"))!.getDay(), 0, "7 also means Sunday");
  // both day fields restricted: either matches
  const either = parseCron("0 0 13 * fri");
  assert.ok(either(at("2026-11-13T00:00:00")) && either(at("2026-11-20T00:00:00")) && !either(at("2026-11-21T00:00:00")));
  assert.equal(nextRun("0 0 30 2 *", at("2026-01-01T00:00:00")), null, "30 February never comes");
  for (const bad of ["* * * *", "61 * * * *", "* * * * mon-", "*/0 * * * *", "a b c d e"]) assert.throws(() => parseCron(bad), bad);

  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("0m"), 0);
  assert.equal(parseDuration("soon"), null);

  assert.ok(withinHours("08:00-22:00", at("2026-11-20T08:00:00")));
  assert.ok(!withinHours("08:00-22:00", at("2026-11-20T22:00:00")));
  assert.ok(withinHours("22:00-06:00", at("2026-11-20T23:30:00")), "window across midnight");
  assert.ok(!withinHours("22:00-06:00", at("2026-11-20T12:00:00")));
  assert.ok(withinHours("", at("2026-11-20T03:00:00")));
});

test("heartbeat file counts as empty only when it has no real items", () => {
  assert.ok(heartbeatIsEmpty("# Heartbeat\n\n<!-- a comment\nover lines -->\n\n- \n- [ ]\n"));
  assert.ok(!heartbeatIsEmpty("# Heartbeat\n\n- Check the inbox\n"));
  assert.ok(!heartbeatIsEmpty("Check the inbox"));
});

test("pairing: one code per sender, approval grants access, revoke removes it", () => {
  const { home, cleanup } = tempHome();
  try {
    const pairing = new Pairing(home);
    const code = pairing.request("telegram", "42", "Ada")!;
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(pairing.request("telegram", "42", "Ada"), code);
    assert.notEqual(pairing.request("telegram", "43", "Bob"), code);
    assert.ok(!pairing.isApproved("telegram", "42"));
    assert.equal(pairing.approve("WRONGCOD"), null);
    assert.equal(new Pairing(home).approve(code.toLowerCase())?.name, "Ada", "another process sees the request; case does not matter");
    assert.ok(pairing.isApproved("telegram", "42"));
    assert.ok(!pairing.isApproved("discord", "42"), "approval is per channel");
    assert.equal(pairing.approve(code), null, "a code works once");
    assert.ok(pairing.revoke("telegram:42"));
    assert.ok(!pairing.isApproved("telegram", "42"));
    for (let i = 0; i < 30; i++) pairing.request("telegram", `flood${i}`, "x");
    assert.ok(Object.keys(pairing.list().pending).length <= 20, "pending requests are capped");
  } finally {
    cleanup();
  }
});

test("history window keeps recent whole turns and never splits a tool call from its result", () => {
  const turn = (n: number): ChatMessage[] => [
    { role: "user", content: `question ${n} ${"x".repeat(100)}` },
    { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, name: "t", arguments: "{}" }] },
    { role: "tool", tool_call_id: `c${n}`, content: "r".repeat(100) },
    { role: "assistant", content: `answer ${n}` },
  ];
  const history = [1, 2, 3, 4].flatMap(turn);
  const recent = recentHistory(history, 500);
  assert.equal(recent[0]!.role, "user");
  assert.match(recent[0]!.content, /^question 3/);
  assert.equal(recent.length, 8);
  assert.equal(recentHistory(history, 10).length, 0, "nothing fits: send no history rather than a broken one");
  assert.equal(recentHistory(history, 1e6).length, 16);
});

test("long replies are split at paragraph breaks within the limit", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`).join("\n\n");
  const parts = chunkText(text, 1000);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n\n").replace(/\s+/g, " "), text.replace(/\s+/g, " ").trim());
  assert.deepEqual(chunkText("x".repeat(2500), 1000).map((p) => p.length), [1000, 1000, 500]);
});

test("unknown senders get a pairing code and never reach the agent; approved ones do", async () => {
  await withGateway([{ content: "Hello Ada." }], async ({ gateway, chan, provider }) => {
    await gateway.handleInbound(dm("hi, run rm -rf /"));
    assert.equal(provider.seen.length, 0);
    const code = /\n\n([A-Z0-9]{8})$/.exec(chan.sent[0]!.text)?.[1];
    assert.ok(code, "the reply contains the code");
    await gateway.handleInbound(dm("hello??"));
    assert.equal(chan.sent.length, 1, "no second pairing reply within ten minutes");

    // an unknown person in a group gets nothing at all, even when mentioning the bot
    await gateway.handleInbound({ ...dm("@bot hi", "99", "group1"), isGroup: true, mentioned: true });
    assert.equal(chan.sent.length, 1);

    gateway.pairing.approve(code!);
    await gateway.handleInbound(dm("hi"));
    assert.equal(chan.sent[1]!.text, "Hello Ada.");
    assert.equal(provider.seen.length, 1);
    assert.equal(provider.seen[0]!.messages.at(-1)!.content, "hi");
  });
});

test("pairing off: unknown senders are ignored; allow_from needs no pairing", async () => {
  await withGateway(
    [{ content: "ok" }],
    async ({ gateway, chan, home }) => {
      const telegram = new FakeChannel("telegram");
      gateway.channels.set("telegram", telegram);
      await gateway.handleInbound({ ...dm("hi", "666"), channel: "telegram" });
      assert.equal(telegram.sent.length, 0);
      await gateway.handleInbound({ ...dm("hi", "42"), channel: "telegram" });
      assert.deepEqual(telegram.texts(), ["ok"]);
      assert.equal(chan.sent.length, 0);
      assert.deepEqual(new Pairing(home).list().pending, {});
    },
    (home) => setConfig(home, { channels: { telegram: { enabled: false, allow_from: [42], pairing: false } } }),
  );
});

test("groups: answered only when mentioned, and the speaker is named to the model", async () => {
  await withGateway([{ content: "Hi all." }], async ({ gateway, chan, provider }) => {
    gateway.pairing.approve(gateway.pairing.request("fake", "42", "Ada")!);
    const group = { ...dm("what's for lunch", "42", "group1"), isGroup: true };
    await gateway.handleInbound(group);
    assert.equal(provider.seen.length, 0);
    await gateway.handleInbound({ ...group, mentioned: true });
    assert.equal(provider.seen[0]!.messages.at(-1)!.content, "[Ada]: what's for lunch");
    assert.deepEqual(chan.sent, [{ peer: "group1", text: "Hi all." }]);
  });
});

test("each chat has its own conversation, /new resets it, and a restart resumes it", async () => {
  const { home, cleanup } = tempHome();
  setConfig(home, {});
  try {
    const run = async (steps: Steps, fn: (g: Gateway, p: ScriptedProvider, c: FakeChannel) => Promise<void>) => {
      const provider = new ScriptedProvider(steps);
      const app = await App.start(home, { provider, watch: false });
      const gateway = new Gateway(app);
      await gateway.start({ scheduler: false });
      const chan = new FakeChannel();
      gateway.channels.set("fake", chan);
      new Pairing(home).approve(new Pairing(home).request("fake", "1", "A") ?? "");
      new Pairing(home).approve(new Pairing(home).request("fake", "2", "B") ?? "");
      try {
        await fn(gateway, provider, chan);
      } finally {
        await gateway.stop();
        await app.stop();
      }
    };
    const userTexts = (p: ScriptedProvider) => p.seen.at(-1)!.messages.filter((m) => m.role === "user").map((m) => m.content);

    await run([{ content: "a1" }, { content: "b1" }, { content: "a2" }], async (g, p) => {
      await g.handleInbound(dm("from A, first", "1"));
      await g.handleInbound(dm("from B", "2"));
      await g.handleInbound(dm("from A, second", "1"));
      assert.deepEqual(userTexts(p), ["from A, first", "from A, second"], "B's message is not in A's conversation");
    });

    await run([{ content: "a3" }, { content: "fresh" }], async (g, p, chan) => {
      await g.handleInbound(dm("from A, after restart", "1"));
      assert.deepEqual(userTexts(p), ["from A, first", "from A, second", "from A, after restart"]);
      await g.handleInbound(dm("/new", "1"));
      assert.equal(chan.sent.at(-1)!.text, "Started a new conversation.");
      await g.handleInbound(dm("clean slate", "1"));
      assert.deepEqual(userTexts(p), ["clean slate"]);
    });
    const notes = fs.readdirSync(path.join(home.vault, "Sessions"));
    assert.equal(notes.length, 3, "A's first conversation, B's, and A's new one are separate notes");
    assert.ok(notes.every((n) => /fake_[12]/.test(n)));
  } finally {
    cleanup();
  }
});

test("routing sends a chat to its bound agent, with that agent's persona, tools and model", async () => {
  await withGateway(
    [{ content: "work reply" }, { content: "main reply" }],
    async ({ gateway, provider }) => {
      for (const id of ["1", "2"]) gateway.pairing.approve(gateway.pairing.request("fake", id, "x")!);
      assert.equal(gateway.route("fake", "1"), "work");
      assert.equal(gateway.route("fake", "2"), "main");
      assert.equal(gateway.route("other", "1"), "main");
      await gateway.handleInbound(dm("hi", "1"));
      await gateway.handleInbound(dm("hi", "2"));
      const [work, main] = provider.seen;
      assert.match((work!.messages[0] as any).content, /terse work assistant/);
      assert.deepEqual(work!.tools.map((t) => t.name).sort(), ["memory_search", "read_file"]);
      assert.match((main!.messages[0] as any).content, /capable, direct personal assistant/);
      assert.ok(main!.tools.length > 5);
    },
    (home) => {
      setConfig(home, { routing: { bindings: [{ channel: "fake", peer: 1, agent: "work" }] } });
      fs.mkdirSync(path.join(home.vault, "Agents", "work"));
      fs.writeFileSync(path.join(home.vault, "Agents", "work", "SOUL.md"), "You are a terse work assistant.");
      fs.writeFileSync(path.join(home.vault, "Agents", "work", "agent.md"), "---\ntools: [read_file, memory_search]\n---\n");
    },
  );
});

test("approvals are asked in the chat: yes proceeds, no answer in time declines", async () => {
  const cmd = (file: string) => ({ calls: [{ name: "run_command", args: { command: `node -e "require('fs').writeFileSync('${file}','x')"` } }] });
  await withGateway([cmd("yes.txt"), { content: "Ran it." }, cmd("late.txt"), { content: "Did not run." }], async ({ gateway, chan, home, provider }) => {
    gateway.pairing.approve(gateway.pairing.request("fake", "42", "Ada")!);

    const first = gateway.handleInbound(dm("run it"));
    await chan.until(1);
    assert.match(chan.sent[0]!.text, /^Approval needed \(command\.other\):\nrun: node -e/);
    await gateway.handleInbound(dm("what is this?"));
    assert.match(chan.sent[1]!.text, /Reply yes or no/);
    await gateway.handleInbound(dm("Yes please"));
    await first;
    assert.ok(fs.existsSync(path.join(home.workspace, "yes.txt")));
    assert.equal(chan.sent.at(-1)!.text, "Ran it.");

    await gateway.handleInbound(dm("run another")); // nobody answers; timeout is 1s in this test
    assert.ok(!fs.existsSync(path.join(home.workspace, "late.txt")));
    assert.match(provider.lastToolOutputs().at(-1)!, /the user declined/);
    assert.ok(chan.texts().includes("No answer, so I did not do it."));
  });
});

test("heartbeat: skipped while the checklist is empty, silent on HEARTBEAT_OK, delivered otherwise", async () => {
  await withGateway(
    [{ content: "hello" }, { content: "HEARTBEAT_OK" }, { content: "Your inbox note is three days old." }],
    async ({ gateway, chan, provider, home }) => {
      gateway.pairing.approve(gateway.pairing.request("fake", "42", "Ada")!);
      await gateway.handleInbound(dm("hi")); // makes this chat the "last" one
      const start = Date.now();
      const tick = (minutes: number) => gateway.scheduler.tick(new Date(start + minutes * 60_000));

      await tick(31);
      assert.equal(provider.seen.length, 1, "empty HEARTBEAT.md: the model is not called");

      fs.writeFileSync(path.join(home.vault, "Agents", "main", "HEARTBEAT.md"), "# Heartbeat\n\n- Remind me about old inbox notes\n");
      await tick(45);
      assert.equal(provider.seen.length, 1, "not due again until a full interval has passed");
      await tick(62);
      assert.equal(provider.seen.length, 2);
      assert.match(provider.seen[1]!.messages.at(-1)!.content, /scheduled check-in.*Agents\/main\/HEARTBEAT\.md/);
      assert.equal(provider.seen[1]!.messages.filter((m) => m.role === "user").length, 1, "heartbeat runs in its own conversation");
      assert.equal(chan.sent.length, 1, "HEARTBEAT_OK is not delivered");

      await tick(93);
      assert.deepEqual(chan.sent.at(-1), { peer: "42", text: "Your inbox note is three days old." });
    },
  );
});

test("heartbeat respects 'every: 0m' and active hours", async () => {
  await withGateway(
    [{ content: "should not run" }],
    async ({ gateway, provider, home }) => {
      fs.writeFileSync(path.join(home.vault, "Agents", "main", "HEARTBEAT.md"), "- do things\n");
      const agentMd = path.join(home.vault, "Agents", "main", "agent.md");
      fs.writeFileSync(agentMd, "---\nheartbeat: { every: 0m }\n---\n");
      await gateway.scheduler.tick(new Date(Date.now() + 86_400_000));
      const now = new Date(Date.now() + 2 * 3_600_000);
      const hh = (h: number) => String((now.getHours() + h) % 24).padStart(2, "0") + ":00";
      fs.writeFileSync(agentMd, `---\nheartbeat: { every: 30m, active_hours: "${hh(2)}-${hh(4)}" }\n---\n`);
      await gateway.scheduler.tick(now);
      assert.equal(provider.seen.length, 0);
    },
  );
});

test("jobs: run when due, once per slot, deliver to their target; broken notes are reported", async () => {
  await withGateway(
    [{ content: "Morning summary." }, { content: "Reminder: call Dana." }, { content: "interval run" }],
    async ({ gateway, chan, provider, home, app }) => {
      const logs: string[] = [];
      app.bus.on("log", (e) => void logs.push(e.message));
      const jobs = path.join(home.vault, "Jobs");
      const base = new Date();
      base.setHours(8, 58, 0, 0);
      base.setDate(base.getDate() + 1);
      const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
      const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

      fs.writeFileSync(path.join(jobs, "morning.md"), `---\nschedule: "0 9 * * *"\ntarget: fake:42\n---\n\nSummarise yesterday.\n`);
      fs.writeFileSync(path.join(jobs, "once.md"), `---\nat: ${iso(at(5))}\ntarget: fake:77\n---\n\nRemind me to call Dana.\n`);
      fs.writeFileSync(path.join(jobs, "paused.md"), `---\nevery: 1m\nenabled: false\n---\n\nnever\n`);
      fs.writeFileSync(path.join(jobs, "broken.md"), `---\nschedule: "99 9 * * *"\n---\n\nx\n`);
      fs.writeFileSync(path.join(jobs, "empty.md"), `---\nevery: 5m\n---\n`);
      fs.writeFileSync(path.join(jobs, "quiet.md"), `---\nevery: 10m\ntarget: none\n---\n\nTidy up.\n`);

      assert.deepEqual(loadJobs(home, "main").map((j) => j.name), ["morning", "once", "quiet"]);

      await gateway.scheduler.tick(at(0)); // 08:58: nothing due
      assert.equal(provider.seen.length, 0);
      assert.ok(logs.some((l) => /Jobs\/broken\.md is not scheduled: .*out of range/.test(l)));
      assert.ok(logs.some((l) => /Jobs\/empty\.md is not scheduled: .*no text/.test(l)));

      await gateway.scheduler.tick(at(2)); // 09:00
      assert.deepEqual(chan.sent, [{ peer: "42", text: "Morning summary." }]);
      assert.match((provider.seen[0]!.messages[0] as any).content, /scheduled job 'morning'/);
      assert.equal(provider.seen[0]!.messages.at(-1)!.content, "Summarise yesterday.");

      await gateway.scheduler.tick(at(3)); // 09:01: the 09:00 slot does not fire twice
      assert.equal(provider.seen.length, 1);

      await gateway.scheduler.tick(at(6)); // one-time job
      assert.deepEqual(chan.sent.at(-1), { peer: "77", text: "Reminder: call Dana." });
      await gateway.scheduler.tick(at(8));
      assert.equal(provider.seen.length, 2, "a one-time job runs once");

      await gateway.scheduler.tick(at(11)); // interval job, target none: runs, delivers nothing
      assert.equal(provider.seen.length, 3);
      assert.equal(chan.sent.length, 2);
      assert.equal(logs.filter((l) => l.includes("broken.md")).length, 1, "a broken note is reported once, not every tick");

      const described = gateway.scheduler.describe(at(12));
      assert.match(described.find((j) => j.name === "morning")!.last, /delivered/);
      assert.equal(described.find((j) => j.name === "once")!.next, "done");
    },
  );
});

test("a scheduled run with nobody to ask declines anything that needs approval", async () => {
  await withGateway(
    [{ calls: [{ name: "run_command", args: { command: "node -e \"require('fs').writeFileSync('job.txt','x')\"" } }] }, { content: "Could not run it." }],
    async ({ gateway, provider, home }) => {
      const status = await gateway.runScheduled({ kind: "job", name: "j", agent: "main", prompt: "run", target: "none" });
      assert.match(provider.lastToolOutputs()[0]!, /the user declined/);
      assert.ok(!fs.existsSync(path.join(home.workspace, "job.txt")));
      assert.match(status, /not delivered/);
    },
  );
});

test("control API: token required, web pages refused, turn stream with approval, used by chat when the gateway runs", async () => {
  await withGateway(
    [
      { content: "Checking. ", calls: [{ name: "run_command", args: { command: "node -e \"require('fs').writeFileSync('api.txt','x')\"" } }] },
      { content: "All done." },
    ],
    async ({ home, app }) => {
      const client = (await findGateway(home))!;
      assert.ok(client, "the running gateway is found through data/gateway/gateway.json");
      const raw = (headers: Record<string, string>, p = "/v1/status") => fetch(client.url + p, { headers });
      assert.equal((await raw({})).status, 401);
      assert.equal((await raw({ authorization: "Bearer wrong" })).status, 401);
      const token = fs.readFileSync(path.join(home.secrets, "gateway-token"), "utf8");
      assert.equal((await raw({ authorization: `Bearer ${token}` })).status, 200);
      assert.equal((await raw({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403);
      assert.equal((await raw({}, "/health")).status, 200);

      const backend = await openBackend(home);
      assert.match(backend.label, /via gateway/);
      const events: string[] = [];
      const asked: string[] = [];
      const answer = await backend.send(
        "do the thing",
        (e) => void events.push(e.type === "tool_finished" ? `${e.type}:${e.ok}` : e.type),
        async (action) => {
          asked.push(action);
          return true;
        },
      );
      assert.equal(answer, "All done.");
      assert.deepEqual(asked, ["command.other"]);
      assert.deepEqual(events, ["delta", "message", "tool_requested", "tool_finished:true", "delta", "message"]);
      assert.ok(fs.existsSync(path.join(home.workspace, "api.txt")));
      assert.equal((await backend.policies())["command.other"], "ask");
      assert.match((await backend.history())[0]!.message, /^Turn \(main\): do the thing/);
      assert.equal((await backend.search("thing"))[0]?.path.startsWith("Sessions/"), true);
      await backend.newSession();
      assert.equal(app.session.history.length, 0);
    },
  );
});

test("the gateway refuses to listen beyond this computer unless explicitly allowed, and stops cleanly", async () => {
  const { home, cleanup } = tempHome();
  try {
    setConfig(home, { gateway: { host: "0.0.0.0", port: 0 } });
    const app = await App.start(home, { provider: new ScriptedProvider([]), watch: false });
    await assert.rejects(new Gateway(app).start({ scheduler: false }), /reachable from other computers/);
    assert.equal(await findGateway(home), null);

    setConfig(home, {});
    app.reloadConfig();
    const gateway = new Gateway(app);
    await gateway.start({ scheduler: false });
    const client = (await findGateway(home))!;
    const stopped = new Promise<void>((r) => (gateway.onStopped = r));
    await client.post("/v1/shutdown");
    await stopped;
    assert.equal(await findGateway(home), null);
    assert.ok(!fs.existsSync(path.join(home.data, "gateway", "gateway.json")));
    await app.stop();
  } finally {
    cleanup();
  }
});
