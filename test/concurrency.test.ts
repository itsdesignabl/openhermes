import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import type { Channel } from "../src/channels/types.js";
import { Gateway } from "../src/gateway/gateway.js";
import { Gate } from "../src/kernel/gate.js";
import type { ChatMessage, ChatResult, Provider } from "../src/provider/openai.js";
import { tempHome } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (content: string): ChatResult => ({ content, toolCalls: [] });
const tool = (name: string, args: object, id = "c1"): ChatResult => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

interface Call {
  system: string;
  user: string;
  last: ChatMessage;
  step: number;
}

/** A model stand-in driven by a function. Records how many requests were in flight at once. */
function model(reply: (c: Call) => ChatResult | Promise<ChatResult>) {
  const state = { active: 0, peak: 0, log: [] as string[] };
  const provider: Provider = {
    async chat(messages) {
      const users = messages.filter((m) => m.role === "user");
      const lastUser = messages.map((m) => m.role).lastIndexOf("user");
      const call: Call = { system: messages[0]!.content, user: users.at(-1)?.content ?? "", last: messages.at(-1)!, step: messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length };
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      state.log.push(`start:${call.user}`);
      try {
        return await reply(call);
      } finally {
        state.active--;
        state.log.push(`end:${call.user}`);
      }
    },
  };
  return Object.assign(provider, { state });
}

class FakeChannel implements Channel {
  readonly name = "fake";
  state = "connected";
  sent: { peer: string; text: string }[] = [];
  async start() {}
  async stop() {}
  async send(peer: string, t: string) {
    this.sent.push({ peer, text: t });
  }
  to(peer: string) {
    return this.sent.filter((s) => s.peer === peer).map((s) => s.text);
  }
  async until(cond: () => boolean, what: string) {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; sent: ${JSON.stringify(this.sent)}`);
      await sleep(5);
    }
  }
}

function config(home: { vault: string }, extra: object = {}) {
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ gateway: { port: 0, approval_timeout_s: 30 }, learning: { enabled: false }, ...extra })}\n---\n`);
}

async function withGateway(provider: Provider, fn: (x: { app: App; gateway: Gateway; chan: FakeChannel; home: App["home"]; say: (peer: string, t: string) => Promise<void> }) => Promise<void>, extra: object = {}) {
  const { home, cleanup } = tempHome();
  config(home, extra);
  const app = await App.start(home, { provider, watch: false });
  const gateway = new Gateway(app);
  await gateway.start({ scheduler: false });
  const chan = new FakeChannel();
  gateway.channels.set("fake", chan);
  for (const id of ["A", "B", "C"]) gateway.pairing.approve(gateway.pairing.request("fake", id, id)!);
  const say = (peer: string, t: string) => gateway.handleInbound({ channel: "fake", peer, sender: peer, senderName: peer, text: t, isGroup: false, mentioned: false });
  try {
    await fn({ app, gateway, chan, home, say });
  } finally {
    await gateway.stop();
    await app.stop();
    cleanup();
  }
}

test("a chat waiting for an approval does not hold up another chat", async () => {
  const provider = model((c) => {
    if (c.user === "run the build") return c.step === 0 ? tool("run_command", { command: "node -p 6*7" }) : text(`Build finished: ${c.last.content.split("\n")[1]}`);
    return text(`Answer to "${c.user}"`);
  });
  await withGateway(provider, async ({ chan, say, app }) => {
    const turnA = say("A", "run the build");
    await chan.until(() => chan.to("A").length === 1, "the approval question in chat A");
    assert.match(chan.to("A")[0]!, /^Approval needed \(command\.other\)/);

    // while A's question is unanswered, B and C are served, twice each
    await say("B", "what time is it");
    await say("C", "hello");
    await say("B", "and tomorrow");
    assert.deepEqual(chan.to("B"), ['Answer to "what time is it"', 'Answer to "and tomorrow"']);
    assert.deepEqual(chan.to("C"), ['Answer to "hello"']);
    assert.equal(chan.to("A").length, 1, "A is still waiting");

    await say("A", "yes");
    await turnA;
    assert.equal(chan.to("A").at(-1), "Build finished: 42");
    await app.idle();
    const log = (await app.history.log(6)).map((e) => e.message.split("\n")[0]);
    assert.equal(log.at(-1), "Initial vault");
    assert.equal(log[0], "Turn (main): run the build", "the turn that waited is recorded last");
  });
});

test("within one conversation, messages are still handled strictly in order", async () => {
  const provider = model(async (c) => {
    if (c.user === "first") await sleep(120);
    return text(`re: ${c.user}`);
  });
  await withGateway(provider, async ({ chan, say, app }) => {
    const a = say("A", "first");
    const b = say("A", "second");
    const c = say("A", "third");
    await Promise.all([a, b, c]);
    assert.deepEqual(chan.to("A"), ["re: first", "re: second", "re: third"]);
    assert.deepEqual(provider.state.log, ["start:first", "end:first", "start:second", "end:second", "start:third", "end:third"]);
    const users = app.conversation("main:fake:A").history.filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(users, ["first", "second", "third"]);
  });
});

test("the model gets one request at a time by default, and more when the settings allow it", async () => {
  for (const [max, expected] of [[undefined, 1], [3, 3]] as const) {
    const provider = model(async (c) => {
      await sleep(60);
      return text(`re: ${c.user}`);
    });
    await withGateway(
      provider,
      async ({ chan, say }) => {
        const started = Date.now();
        await Promise.all([say("A", "a"), say("B", "b"), say("C", "c")]);
        assert.equal(provider.state.peak, expected, `max_parallel ${max ?? "default"}`);
        assert.deepEqual([chan.to("A"), chan.to("B"), chan.to("C")], [["re: a"], ["re: b"], ["re: c"]]);
        if (expected === 1) assert.ok(Date.now() - started >= 170, "three requests of 60 ms each ran one after another");
      },
      max ? { provider: { max_parallel: max } } : {},
    );
  }
});

test("the gate serves waiters in order, follows a raised limit, and lets a waiter give up", async () => {
  let limit = 1;
  const gate = new Gate(() => limit);
  const order: string[] = [];
  const job = (name: string, ms: number) => gate.run(async () => {
    order.push(`start ${name}`);
    await sleep(ms);
    order.push(`end ${name}`);
    return name;
  });
  assert.deepEqual(await Promise.all([job("1", 30), job("2", 5), job("3", 5)]), ["1", "2", "3"]);
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);

  // a waiter that is cancelled leaves the queue and does not block those behind it
  const first = job("slow", 60);
  const abort = new AbortController();
  const cancelled = gate.run(async () => "never", abort.signal);
  const after = job("after", 5);
  abort.abort();
  await assert.rejects(cancelled);
  assert.deepEqual([await first, await after], ["slow", "after"]);

  // a failing job still frees its place
  await assert.rejects(gate.run(async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(await job("fine", 1), "fine");

  limit = 2;
  order.length = 0;
  await Promise.all([job("x", 30), job("y", 30)]);
  assert.deepEqual(order.slice(0, 2), ["start x", "start y"], "two at once after the limit was raised");
});

test("overlapping turns each record only their own changes in the vault history", async () => {
  const provider = model(async (c) => {
    const who = /note for (\w+)/.exec(c.user)![1]!;
    if (c.step === 0) {
      await sleep(who === "A" ? 80 : 10);
      return tool("write_file", { path: `Notes/${who}.md`, content: `from ${who}\n` });
    }
    if (c.step === 1) {
      await sleep(who === "A" ? 10 : 80); // the two turns finish in the opposite order to how they started
      return tool("memory_add", { target: "daily", text: `wrote the note for ${who}` });
    }
    return text(`done ${who}`);
  });
  await withGateway(
    provider,
    async ({ say, app, home }) => {
      await Promise.all([say("A", "write a note for A"), say("B", "write a note for B")]);
      await app.idle();
      const commits = (await app.history.log(3)).filter((e) => e.message.startsWith("Turn"));
      assert.equal(commits.length, 2);
      for (const who of ["A", "B"]) {
        const commit = commits.find((e) => e.message.includes(`write a note for ${who}`))!;
        const files = commit.message.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        const other = who === "A" ? "B" : "A";
        assert.ok(files.includes(`Notes/${who}.md`), `${who}'s commit has its note`);
        assert.ok(!files.includes(`Notes/${other}.md`), `${who}'s commit does not claim ${other}'s note`);
        assert.ok(files.some((f) => f.startsWith("Sessions/") && f.includes(`fake_${who}`)));
        assert.ok(!files.some((f) => f.includes(`fake_${other}`)));
      }
      const daily = fs.readdirSync(path.join(home.vault, "Memory", "Daily"))[0]!;
      const log = fs.readFileSync(path.join(home.vault, "Memory", "Daily", daily), "utf8");
      assert.match(log, /wrote the note for A/);
      assert.match(log, /wrote the note for B/, "both additions to the shared daily note survive");
    },
    { provider: { max_parallel: 2 } },
  );
});

test("an edit waits for approval without overwriting what changed in the meantime", async () => {
  const { home, cleanup } = tempHome();
  config(home);
  fs.writeFileSync(path.join(home.vault, "System", "policies.md"), `---\n${JSON.stringify({ policies: { "vault.write": "ask" } })}\n---\n`);
  const file = path.join(home.vault, "plan.md");
  try {
    const provider = model((c) => (c.step === 0 ? tool("edit_file", { path: "plan.md", old_text: "Deadline: March", new_text: "Deadline: April" }) : text(c.last.content)));
    let whileWaiting: () => void = () => {};
    const app = await App.start(home, { provider, watch: false, approver: async () => (whileWaiting(), true) });
    try {
      // while the approval is pending, the user adds a line in Obsidian
      fs.writeFileSync(file, "# Plan\n\nDeadline: March\nBudget: 500\n");
      whileWaiting = () => fs.appendFileSync(file, "Owner: Dana\n");
      assert.match((await app.send("move the deadline")).text, /^Edited/);
      assert.equal(fs.readFileSync(file, "utf8"), "# Plan\n\nDeadline: April\nBudget: 500\nOwner: Dana\n", "both changes are there");

      // if the text to replace is gone by the time approval arrives, nothing is written
      fs.writeFileSync(file, "# Plan\n\nDeadline: March\n");
      whileWaiting = () => fs.writeFileSync(file, "# Plan\n\nDeadline: moved by hand to May\n");
      app.newSession();
      assert.match((await app.send("move the deadline")).text, /old_text was not found/);
      assert.equal(fs.readFileSync(file, "utf8"), "# Plan\n\nDeadline: moved by hand to May\n");
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("a slow review in the background does not delay chats, and its notice never overtakes the reply", async () => {
  const reviewing = { started: 0, done: 0 };
  const provider = model(async (c) => {
    if (c.system.startsWith("You are reviewing")) {
      if (c.step === 0) {
        reviewing.started++;
        await sleep(1500); // long enough that a whole turn fits inside it even on a slow machine
        return tool("create_skill", { name: "deploy-site", description: "How to publish the website", steps: "Run:\n\n```bash\nnpm run build\n```\n" });
      }
      reviewing.done++;
      return text("DONE");
    }
    return text(`re: ${c.user}`);
  });
  await withGateway(
    provider,
    async ({ chan, say, app }) => {
      await say("A", "how do I deploy?");
      assert.deepEqual(chan.to("A"), ["re: how do I deploy?"], "the reply is sent before any review output");
      await chan.until(() => reviewing.started === 1, "the review to start");

      await say("B", "quick question");
      assert.equal(reviewing.done, 0, "B was answered while the review was still running");
      assert.deepEqual(chan.to("B"), ["re: quick question"]);

      await app.idle();
      assert.equal(reviewing.done, 2, "both conversations were reviewed, one after the other");
      assert.match(chan.to("A")[1]!, /needs your approval:\n\nNew skill 'deploy-site'/);
      assert.equal(chan.to("A").length, 2);
      assert.equal(chan.to("B").length, 1, "the notice goes to the chat the conversation was in, not to whoever wrote last; the same suggestion is not filed twice");
    },
    { learning: { enabled: true, reflect_every_turns: 1 }, provider: { max_parallel: 2 } },
  );
});

test("starting a new conversation waits for the turn still running in that chat", async () => {
  const provider = model(async (c) => {
    if (c.user === "long task") await sleep(150);
    return text(`re: ${c.user}`);
  });
  await withGateway(provider, async ({ chan, say, app, home }) => {
    const turn = say("A", "long task");
    await sleep(30);
    const reset = say("A", "/new");
    const next = say("A", "fresh question");
    await Promise.all([turn, reset, next]);
    assert.deepEqual(chan.to("A"), ["re: long task", "Started a new conversation.", "re: fresh question"]);
    const session = app.conversation("main:fake:A");
    assert.deepEqual(session.history.filter((m) => m.role === "user").map((m) => m.content), ["fresh question"]);
    const notes = fs.readdirSync(path.join(home.vault, "Sessions")).sort();
    assert.equal(notes.length, 2);
    const texts = notes.map((n) => fs.readFileSync(path.join(home.vault, "Sessions", n), "utf8"));
    assert.equal(texts.filter((t) => /long task[\s\S]*re: long task/.test(t) && !t.includes("fresh question")).length, 1, "the running turn landed whole in the old conversation");
    assert.equal(texts.filter((t) => t.includes("fresh question") && !t.includes("long task")).length, 1);
  });
});

test("scheduled runs go side by side: one waiting for approval does not stop the others, and is not started twice", async () => {
  const provider = model((c) => {
    if (c.user.includes("needs a command")) return c.step === 0 ? tool("run_command", { command: "node -p 1" }) : text("ran it");
    if (c.user.includes("check-in")) return text("Something needs your attention.");
    return text(c.user === "Write the report." ? "Report ready." : "hello there");
  });
  await withGateway(provider, async ({ gateway, chan, say, home }) => {
    await say("A", "hi"); // makes chat A the place results go to
    const jobs = path.join(home.vault, "Jobs");
    fs.writeFileSync(path.join(jobs, "blocked.md"), "---\nevery: 1m\n---\n\nThis job needs a command.\n");
    fs.writeFileSync(path.join(jobs, "report.md"), "---\nevery: 1m\n---\n\nWrite the report.\n");
    fs.writeFileSync(path.join(home.vault, "Agents", "main", "HEARTBEAT.md"), "- look around\n");
    const start = Date.now();
    const at = (min: number) => new Date(start + min * 60_000);

    await gateway.scheduler.tick(at(0)); // jobs are first seen now
    const first = gateway.scheduler.tick(at(1.1));
    await chan.until(() => chan.to("A").some((t) => t.startsWith("Approval needed")) && chan.to("A").includes("Report ready."), "the other job to finish while one waits");
    assert.ok(!chan.to("A").includes("ran it"));

    // later ticks run what else is due, and do not start the waiting job again
    await gateway.scheduler.tick(at(2.2)).catch(() => {});
    assert.equal(chan.to("A").filter((t) => t.startsWith("Approval needed")).length, 1, "the waiting job was not started a second time");
    assert.equal(chan.to("A").filter((t) => t === "Report ready.").length, 2, "the report job ran again on schedule");

    const hb = gateway.scheduler.tick(at(31));
    await chan.until(() => chan.to("A").includes("Something needs your attention."), "the heartbeat");
    await say("A", "yes");
    await Promise.all([first, hb]);
    assert.ok(chan.to("A").includes("ran it"));
  });
});

test("idle resolves only when every conversation and all background work has finished", async () => {
  const provider = model(async (c) => {
    await sleep(c.system.startsWith("You are reviewing") ? 120 : 40);
    return text(c.system.startsWith("You are reviewing") ? "DONE" : `re: ${c.user}`);
  });
  const { home, cleanup } = tempHome();
  config(home, { learning: { enabled: true, reflect_every_turns: 1 }, provider: { max_parallel: 4 } });
  const app = await App.start(home, { provider, watch: false });
  try {
    const turns = [app.send("a", { conversation: "main:x:1" }), app.send("b", { conversation: "main:x:2" })];
    await app.idle();
    assert.equal(provider.state.active, 0);
    assert.equal(provider.state.log.filter((l) => l.startsWith("end:")).length, 4, "two turns and two reviews");
    assert.deepEqual((await Promise.all(turns)).map((t) => t.text), ["re: a", "re: b"]);
    await app.idle(); // nothing running: returns at once
  } finally {
    await app.stop();
    cleanup();
  }
});
