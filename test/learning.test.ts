import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { Gateway } from "../src/gateway/gateway.js";
import { dropDuplicateLines, readUsage } from "../src/learning/curator.js";
import { listInbox } from "../src/learning/inbox.js";
import { hasExecutableSteps, looksLikeSecret, skillSlug } from "../src/learning/proposals.js";
import { parseNote } from "../src/vault/frontmatter.js";
import { ScriptedProvider, tempHome } from "./helpers.js";

type Steps = ConstructorParameters<typeof ScriptedProvider>[0];
type Ctx = { app: App; provider: ScriptedProvider; home: App["home"]; logs: string[]; drain: () => Promise<void> };

async function withApp(steps: Steps, fn: (x: Ctx) => Promise<void>, opts: { config?: object; policies?: object; watch?: boolean; setup?: (home: App["home"]) => void } = {}) {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ gateway: { port: 0 }, learning: { reflect_every_turns: 2 }, ...opts.config })}\n---\n`);
  if (opts.policies) fs.writeFileSync(path.join(home.vault, "System", "policies.md"), `---\n${JSON.stringify({ policies: opts.policies })}\n---\n`);
  opts.setup?.(home);
  const provider = new ScriptedProvider(steps);
  const app = await App.start(home, { provider, watch: opts.watch ?? false, approver: async () => true });
  const logs: string[] = [];
  app.bus.on("log", (e) => void logs.push(`${e.level}: ${e.message}`));
  try {
    await fn({ app, provider, home, logs, drain: () => app.enqueue(async () => {}) });
  } finally {
    await app.stop();
    cleanup();
  }
}

const v = (home: App["home"], rel: string) => path.join(home.vault, rel);
const read = (home: App["home"], rel: string) => (fs.existsSync(v(home, rel)) ? fs.readFileSync(v(home, rel), "utf8") : "");
const call = (name: string, args: object) => ({ name, args });

const SAFE_SKILL = { name: "Weekly Report", description: "How to write the weekly report", steps: "1. Read the daily notes of the week.\n2. Summarise them in five bullet points.\n3. Save to Reports/." };
const EXEC_SKILL = { name: "deploy-site", description: "How to publish the website", steps: "1. Build it:\n\n```bash\nnpm run build\n```\n\n2. Upload the dist folder." };

test("what counts as executable, as a secret, and as a skill name", () => {
  assert.ok(hasExecutableSteps("Run:\n\n```bash\nls\n```\n"));
  assert.ok(hasExecutableSteps("Run:\n\n```\nls\n```\n"), "a code block with no language is treated as runnable");
  assert.ok(hasExecutableSteps("Then call run_command with the build script."));
  assert.ok(!hasExecutableSteps("1. Read the notes.\n2. Write a summary.\n\n```markdown\n# Title\n```\n"));
  assert.ok(!hasExecutableSteps("Write `inline code` and carry on."));

  for (const s of ["my password is hunter2", "API key: abc123", "token=xyz", "sk-abcdefghijklmnopqrstuv", "-----BEGIN RSA PRIVATE KEY-----"]) assert.ok(looksLikeSecret(s), s);
  for (const s of ["Prefers short passwords explained in talks", "Keeps the house key under the mat", "Uses token-based pricing"]) assert.ok(!looksLikeSecret(s), s);

  assert.equal(skillSlug("Weekly Report!"), "weekly-report");
  assert.equal(skillSlug("../../etc/passwd"), "etc-passwd");
  assert.deepEqual(dropDuplicateLines("# M\n- A fact.\n- Another\n- a fact\n\n- Another!\ntext\ntext\n"), { text: "# M\n- A fact.\n- Another\n\ntext\ntext\n", removed: 2 });
});

test("after enough turns the conversation is reviewed: facts and safe skills are saved, risky skills wait in the Inbox", async () => {
  await withApp(
    [
      { content: "Noted." },
      { content: "Here is how." },
      {
        calls: [
          call("save_memory", { target: "user", text: "Works as a marine surveyor" }),
          call("save_memory", { target: "user", text: "The door code is: password is 4411" }),
          call("note_entity", { name: "Dana", text: "Leads the harbour survey" }),
          call("create_skill", SAFE_SKILL),
          call("create_skill", EXEC_SKILL),
          call("save_memory", { target: "nowhere", text: "x" }),
        ],
      },
      { content: "DONE" },
    ],
    async ({ app, provider, home, drain, logs }) => {
      const chat: string[] = [];
      const created: any[] = [];
      const reflected: any[] = [];
      app.bus.on("assistant.message", (e) => void chat.push(e.text));
      app.bus.on("proposal.created", (e) => void created.push(e));
      app.bus.on("learning.reflected", (e) => void reflected.push(e));

      await app.send("I am a marine surveyor, Dana leads the harbour survey");
      assert.equal(provider.seen.length, 1, "no review after one message");
      await app.send("how do I write the weekly report and deploy the site?");
      await drain();

      // the review is a separate model call that sees memory, skills and the transcript
      const review = provider.seen[2]!;
      assert.match((review.messages[0] as any).content, /reviewing a finished conversation/);
      assert.match(review.messages[1]!.content, /USER: I am a marine surveyor[\s\S]*ASSISTANT: Here is how\./);
      assert.deepEqual(review.tools.map((t) => t.name), ["save_memory", "update_memory", "note_entity", "create_skill", "read_skill", "improve_skill"]);
      assert.deepEqual(chat, ["Noted.", "Here is how."], "the review does not appear as chat activity");

      assert.match(read(home, "Memory/USER.md"), /- Works as a marine surveyor\n/);
      assert.ok(!read(home, "Memory/USER.md").includes("4411"), "secrets are never saved");
      assert.equal(read(home, "Memory/Entities/Dana.md"), "# Dana\n\n- Leads the harbour survey\n");

      const skill = parseNote<any>(read(home, "Skills/weekly-report/SKILL.md"));
      assert.equal(skill.data.name, "weekly-report");
      assert.equal(skill.data.trust, "trusted");
      assert.equal(skill.data.provenance.source, "self");
      assert.equal(skill.data.provenance.approved_by, "policy");
      assert.match(skill.data.provenance.session, /^Sessions\/.*\.md$/);
      assert.match(skill.body, /Summarise them in five bullet points/);

      assert.ok(!fs.existsSync(v(home, "Skills/deploy-site")), "a skill with commands is not created without approval");
      const [item] = listInbox(home);
      assert.equal(item!.status, "pending");
      assert.equal(item!.title, "New skill 'deploy-site': How to publish the website");
      assert.deepEqual(created.map((c) => [c.id, c.title]), [[item!.id, item!.title]]);
      assert.match(fs.readFileSync(item!.file, "utf8"), /status: pending[\s\S]*commands or code the agent would run[\s\S]*npm run build/);

      assert.equal(reflected[0].applied.length, 3);
      assert.equal(reflected[0].pending.length, 1);
      assert.match(reflected[0].skipped[0], /password or key/);
      assert.match(provider.lastToolOutputs().at(-1)!, /Invalid|Error/, "a malformed suggestion is rejected back to the model");
      assert.ok(logs.some((l) => /Reviewed Sessions\/.* 3 saved, 1 waiting for approval/.test(l)));

      const log = await app.history.log(3);
      assert.match(log[0]!.message, /^Learned from Sessions\//);
      assert.match(log[0]!.message, /Skills\/weekly-report\/SKILL\.md/);

      // the new skill and facts are in the next turn's system prompt and in search
      await app.send("thanks");
      const system = (provider.seen.at(-1)!.messages[0] as any).content as string;
      assert.match(system, /weekly-report: How to write the weekly report/);
      assert.match(system, /Works as a marine surveyor/);
      assert.equal(app.memory.search("harbour survey")[0]?.path, "Memory/Entities/Dana.md");
    },
  );
});

test("a review that finds nothing changes nothing, and repeated facts are not saved twice", async () => {
  await withApp(
    [{ content: "a" }, { content: "b" }, { content: "DONE" }, { content: "c" }, { content: "d" }, { calls: [call("save_memory", { target: "user", text: "likes GREEN tea." })] }, { content: "DONE" }],
    async ({ app, home, drain }) => {
      fs.appendFileSync(v(home, "Memory/USER.md"), "- Likes green tea\n");
      const before = read(home, "Memory/USER.md");
      const outcomes: any[] = [];
      app.bus.on("learning.reflected", (e) => void outcomes.push(e));
      await app.send("one");
      await app.send("two");
      await drain();
      assert.deepEqual([outcomes[0].applied, outcomes[0].pending, outcomes[0].skipped], [[], [], []]);
      await app.send("three");
      await app.send("four");
      await drain();
      assert.match(outcomes[1].skipped[0], /already in memory/);
      assert.equal(read(home, "Memory/USER.md"), before);
      assert.equal(listInbox(home).length, 0);
    },
  );
});

test("Inbox: approve by command applies it, reject discards it, and both are filed under Done", async () => {
  await withApp([], async ({ app, home }) => {
    const origin = { agent: "main", session: "Sessions/s.md" };
    await app.learner.process(
      [
        { kind: "skill.create", name: EXEC_SKILL.name, description: EXEC_SKILL.description, body: EXEC_SKILL.steps },
        { kind: "skill.create", name: "other-thing", description: "Another risky one", body: "Use run_command to do it." },
      ],
      origin,
    );
    const [first, second] = app.learner.pending();
    const resolved: any[] = [];
    app.bus.on("proposal.resolved", (e) => void resolved.push(e));

    assert.equal((await app.learner.resolve(first!.id, true)).message, "Applied: New skill 'deploy-site': How to publish the website");
    const skill = parseNote<any>(read(home, "Skills/deploy-site/SKILL.md"));
    assert.equal(skill.data.provenance.approved_by, "user");
    assert.match(skill.body, /npm run build/);

    assert.equal((await app.learner.resolve("1", false)).outcome, "rejected", "the remaining item can be picked by position");
    assert.ok(!fs.existsSync(v(home, "Skills/other-thing")));

    assert.equal(app.learner.pending().length, 0);
    const done = fs.readdirSync(v(home, "Inbox/Done"));
    assert.equal(done.length, 2);
    assert.match(read(home, `Inbox/Done/${path.basename(first!.file)}`), /status: applied/);
    assert.match(read(home, `Inbox/Done/${path.basename(second!.file)}`), /status: rejected/);
    assert.deepEqual(resolved.map((r) => r.outcome), ["applied", "rejected"]);
    await assert.rejects(app.learner.resolve("zzzz", true), /Nothing is waiting under 'zzzz'/);
    assert.match((await app.history.log(1))[0]!.message, /^Rejected: New skill 'other-thing'/);
  });
});

test("Inbox: a decision typed into the note in Obsidian is picked up, including edits to the proposed text", async () => {
  await withApp(
    [],
    async ({ app, home, logs }) => {
      await app.learner.process([{ kind: "skill.create", name: EXEC_SKILL.name, description: EXEC_SKILL.description, body: EXEC_SKILL.steps }], { agent: "main", session: "Sessions/s.md" });
      const item = app.learner.pending()[0]!;
      const resolved = new Promise<any>((r) => app.bus.on("proposal.resolved", r));
      const text = fs.readFileSync(item.file, "utf8");
      // the user tightens the command and approves, as they would in Obsidian
      fs.writeFileSync(item.file, text.replace("status: pending", "status: Approved").replace("npm run build", "npm run build -- --prod"));
      assert.equal((await resolved).outcome, "applied");
      assert.match(read(home, "Skills/deploy-site/SKILL.md"), /npm run build -- --prod/);
      assert.ok(!fs.existsSync(item.file));

      // a note the user damaged is reported once and left alone
      await app.learner.process([{ kind: "skill.create", name: "second", description: "Another one here", body: "Use run_command for this." }], { agent: "main", session: "Sessions/s.md" });
      const second = app.learner.pending()[0]!;
      fs.writeFileSync(second.file, fs.readFileSync(second.file, "utf8").replace(/<!-- Proposed content[^\n]*\n/, "").replace("status: pending", "status: approved"));
      await new Promise((r) => setTimeout(r, 600));
      await app.learner.scanInbox();
      assert.equal(logs.filter((l) => /cannot be processed: the line that marks the start/.test(l)).length, 1);
      assert.ok(fs.existsSync(second.file) && !fs.existsSync(v(home, "Skills/second")));
    },
    { watch: true },
  );
});

test("an approval that can no longer be applied stays in the Inbox with the reason", async () => {
  await withApp([], async ({ app, home }) => {
    await app.learner.process([{ kind: "skill.create", name: EXEC_SKILL.name, description: EXEC_SKILL.description, body: EXEC_SKILL.steps }], { agent: "main", session: "s" });
    fs.mkdirSync(v(home, "Skills/deploy-site"), { recursive: true });
    fs.writeFileSync(v(home, "Skills/deploy-site/SKILL.md"), "mine");
    const item = app.learner.pending()[0]!;
    const res = await app.learner.resolve(item.id, true);
    assert.equal(res.outcome, "failed");
    assert.match(res.message, /already exists/);
    assert.equal(read(home, "Skills/deploy-site/SKILL.md"), "mine", "an existing skill is never overwritten");
    assert.match(fs.readFileSync(item.file, "utf8"), /status: failed[\s\S]*result: a skill named 'deploy-site' already exists/);
  });
});

test("policies decide what a review may do: ask sends memory to the Inbox, deny drops it", async () => {
  const facts = [
    { kind: "memory.add" as const, target: "user" as const, text: "Has two cats" },
    { kind: "skill.create" as const, name: SAFE_SKILL.name, description: SAFE_SKILL.description, body: SAFE_SKILL.steps },
  ];
  await withApp(
    [],
    async ({ app, home }) => {
      const out = await app.learner.process(facts, { agent: "main", session: "s" });
      assert.deepEqual([out.applied.length, out.pending.length, out.skipped.length], [0, 1, 1]);
      assert.match(out.skipped[0]!, /policy skill\.edit is deny/);
      assert.ok(!read(home, "Memory/USER.md").includes("cats"));
      assert.equal((await app.learner.process(facts, { agent: "main", session: "s" })).skipped.filter((s) => /already waiting/.test(s)).length, 1, "the same suggestion is not filed twice");
      await app.learner.resolve(app.learner.pending()[0]!.id, true);
      assert.match(read(home, "Memory/USER.md"), /- Has two cats/);
    },
    { policies: { "memory.edit": "ask", "skill.edit": "deny" } },
  );
});

test("the agent cannot approve its own suggestions or write into the Inbox", async () => {
  await withApp(
    [
      {
        calls: [
          call("write_file", { path: "Inbox/x.md", content: "---\ntype: proposal\nstatus: approved\n---\n" }),
          call("edit_file", { path: "PLACEHOLDER", old_text: "status: pending", new_text: "status: approved" }),
        ],
      },
      { content: "no" },
    ],
    async ({ app, provider, home }) => {
      await app.learner.process([{ kind: "skill.create", name: EXEC_SKILL.name, description: EXEC_SKILL.description, body: EXEC_SKILL.steps }], { agent: "main", session: "s" });
      const item = app.learner.pending()[0]!;
      (provider as any).steps[0].calls[1].args.path = `Inbox/${path.basename(item.file)}`;
      await app.send("approve it yourself");
      for (const o of provider.lastToolOutputs()) assert.match(o, /may not change vault\/Inbox/);
      assert.equal(app.learner.pending().length, 1);
      assert.ok(!fs.existsSync(v(home, "Inbox/x.md")) && !fs.existsSync(v(home, "Skills/deploy-site")));
    },
    { config: { learning: { enabled: false } } },
  );
});

test("review triggers: at the end of a conversation, when it goes quiet, never for scheduled runs, never when turned off", async () => {
  const ok = { content: "ok" };
  await withApp(
    [ok, ok, { content: "DONE" }, ok, ok, { content: "DONE" }, ok, ok, ok],
    async ({ app, provider, drain }) => {
      const reviews = () => provider.seen.filter((s) => /reviewing a finished conversation/.test((s.messages[0] as any).content)).length;
      await app.send("a");
      app.newSession();
      await drain();
      assert.equal(reviews(), 0, "one message is too short to review");

      await app.send("b");
      await app.send("c");
      app.newSession();
      await drain();
      assert.equal(reviews(), 1, "reviewed when the conversation is cleared");
      assert.match(provider.seen.at(-1)!.messages[1]!.content, /USER: b[\s\S]*USER: c/);

      await app.send("d", { conversation: "main:telegram:1" });
      await app.send("e", { conversation: "main:telegram:1" });
      app.learner.maintenance(new Date(Date.now() + 10 * 60_000));
      await drain();
      assert.equal(reviews(), 1, "not quiet for long enough yet");
      app.learner.maintenance(new Date(Date.now() + 31 * 60_000));
      await drain();
      assert.equal(reviews(), 2);
      app.learner.maintenance(new Date(Date.now() + 90 * 60_000));
      await drain();
      assert.equal(reviews(), 2, "the same messages are not reviewed twice");

      for (const key of ["main:job:daily", "main:heartbeat:main"]) {
        await app.send("x", { conversation: key });
        await app.send("y", { conversation: key });
        app.newSession(key);
      }
      await drain();
      assert.equal(reviews(), 2, "heartbeat and job runs are not reviewed");
    },
    { config: { learning: { reflect_every_turns: 50 } } },
  );

  await withApp(
    [ok, ok, ok],
    async ({ app, provider, drain }) => {
      await app.send("a");
      await app.send("b");
      app.newSession();
      await drain();
      assert.equal(provider.seen.length, 2);
    },
    { config: { learning: { enabled: false } } },
  );
});

test("review can correct or remove a remembered fact and improve an existing skill", async () => {
  await withApp(
    [
      { content: "ok" },
      { content: "ok" },
      { calls: [call("read_skill", { name: "weekly-report" })] },
      {
        calls: [
          call("update_memory", { target: "user", old_text: "Lives in Oslo", new_text: "Lives in Bergen" }),
          call("update_memory", { target: "user", old_text: "Owns a boat", new_text: "" }),
          call("update_memory", { target: "user", old_text: "not there", new_text: "x y z" }),
          call("improve_skill", { name: "weekly-report", old_text: "five bullet points", new_text: "three bullet points" }),
          call("create_skill", SAFE_SKILL),
        ],
      },
      { content: "DONE" },
    ],
    async ({ app, provider, home, drain }) => {
      const outcomes: any[] = [];
      app.bus.on("learning.reflected", (e) => void outcomes.push(e));
      await app.send("I moved to Bergen and sold the boat");
      await app.send("and the report should have three points");
      await drain();
      assert.equal(read(home, "Memory/USER.md").split("\n").filter((l) => l.startsWith("- ")).join("|"), "- Lives in Bergen|- Likes tea");
      const skill = parseNote<any>(read(home, "Skills/weekly-report/SKILL.md"));
      assert.match(skill.body, /three bullet points/);
      assert.equal(skill.data.provenance.source, "user", "a skill you wrote stays yours after the agent improves it");
      assert.equal(skill.data.provenance.updated_by, "main");
      assert.match(outcomes[0].skipped[0], /not found exactly once/);
      assert.match(provider.lastToolOutputs().at(-1)!, /already exists\. Use read_skill and improve_skill/);
    },
    {
      setup: (home) => {
        fs.appendFileSync(v(home, "Memory/USER.md"), "- Lives in Oslo\n- Owns a boat\n- Likes tea\n");
        fs.mkdirSync(v(home, "Skills/weekly-report"), { recursive: true });
        fs.writeFileSync(v(home, "Skills/weekly-report/SKILL.md"), "---\nname: weekly-report\ndescription: Weekly report\n---\n\nSummarise in five bullet points.\n");
      },
    },
  );
});

test("skills the agent writes in a conversation are stamped; reading a skill counts as use; unapproved and archived skills are handled", async () => {
  await withApp(
    [
      { calls: [call("write_file", { path: "Skills/tidy-desk/SKILL.md", content: "---\nname: tidy-desk\ndescription: Tidy the desk\n---\n\nPut things away.\n" })] },
      { calls: [call("read_file", { path: "Skills/tidy-desk/SKILL.md" }), call("read_file", { path: "Skills/tidy-desk/SKILL.md" })] },
      { content: "done" },
    ],
    async ({ app, provider, home }) => {
      for (const [dir, trust] of [["imported-one", "review"], ["_archive/old-one", "trusted"]] as const) {
        fs.mkdirSync(v(home, `Skills/${dir}`), { recursive: true });
        fs.writeFileSync(v(home, `Skills/${dir}/SKILL.md`), `---\nname: ${path.basename(dir)}\ndescription: Something\ntrust: ${trust}\n---\n\nSteps.\n`);
      }
      await app.send("write a skill and read it");
      const skill = parseNote<any>(read(home, "Skills/tidy-desk/SKILL.md"));
      assert.equal(skill.data.provenance.source, "self");
      assert.match(skill.data.provenance.session, /^Sessions\//);
      assert.equal(skill.body.trim(), "Put things away.");
      assert.equal(readUsage(home)["tidy-desk"]!.uses, 2);
      const system = (provider.seen[0]!.messages[0] as any).content as string;
      assert.match(system, /imported-one: Something \[not yet approved: you may read it, but do not run commands or scripts from it\]/);
      assert.ok(!system.includes("old-one"));
    },
    { config: { learning: { enabled: false } } },
  );
});

test("cleanup: removes repeats, merges a nearly full memory, archives only unused skills the agent wrote", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `- Fact number ${i} about the harbour survey and its many details`).join("\n");
  const merged = Array.from({ length: 20 }, (_, i) => `Merged fact ${i} about the harbour survey and the tides`);
  await withApp(
    [{ content: `Here you go:\n${merged.map((m, i) => (i % 2 ? "* " : "- ") + m).join("\n")}\nsome stray prose\n- password: hunter2` }],
    async ({ app, home }) => {
      fs.writeFileSync(v(home, "Memory/MEMORY.md"), `# Memory\n\n${filler}\n`);
      fs.appendFileSync(v(home, "Memory/USER.md"), "- Likes tea\n- likes tea.\n");
      const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const mk = (name: string, prov: object | null) => {
        fs.mkdirSync(v(home, `Skills/${name}`), { recursive: true });
        fs.writeFileSync(v(home, `Skills/${name}/SKILL.md`), `---\n${JSON.stringify({ name, description: "d", ...(prov ? { provenance: prov } : {}) })}\n---\n\nSteps.\n`);
      };
      mk("stale-self", { source: "self", created: old, updated: old });
      mk("used-self", { source: "self", created: old, updated: old });
      mk("fresh-self", { source: "self", created: new Date().toISOString() });
      mk("stale-user", { source: "user", created: old });
      mk("handwritten", null);
      fs.mkdirSync(path.join(home.data, "learning"), { recursive: true });
      fs.writeFileSync(path.join(home.data, "learning", "skill-usage.json"), JSON.stringify({ "used-self": { uses: 3, last_used: new Date().toISOString() } }));

      const report = await app.learner.curate();
      assert.equal(read(home, "Memory/USER.md").match(/tea/g)!.length, 1);
      assert.equal(read(home, "Memory/MEMORY.md"), `# Memory\n\n${merged.map((m) => `- ${m}`).join("\n")}\n`, "only clean list items are kept; a secret-looking line is dropped");
      assert.deepEqual(fs.readdirSync(v(home, "Skills")).sort(), ["_archive", "fresh-self", "handwritten", "stale-user", "used-self"]);
      assert.ok(fs.existsSync(v(home, "Skills/_archive/stale-self/SKILL.md")));
      assert.equal(report.actions.length, 3);
      assert.match((await app.history.log(1))[0]!.message, /^Cleanup: /);
      assert.deepEqual((await app.learner.curate()).actions, [], "a second run finds nothing to do");
    },
  );
});

test("cleanup refuses a merge that grows the file or throws most of it away", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `- Fact number ${i} about the harbour survey and its many details`).join("\n");
  for (const reply of ["- " + "x".repeat(5000), "- ok", "I cannot do that."]) {
    await withApp([{ content: reply }], async ({ app, home }) => {
      const original = `# Memory\n\n${filler}\n`;
      fs.writeFileSync(v(home, "Memory/MEMORY.md"), original);
      const report = await app.learner.curate();
      assert.equal(read(home, "Memory/MEMORY.md"), original);
      assert.match(report.actions[0]!, /nearly full and could not be merged automatically/);
    });
  }
});

test("when memory is full a new fact triggers one merge and is then saved", async () => {
  await withApp(
    [{ content: "- Facts zero to two, merged into one shorter entry\n- Facts three to five, merged into one shorter entry" }],
    async ({ app, home }) => {
      fs.writeFileSync(v(home, "Memory/USER.md"), "# User\n\n" + Array.from({ length: 6 }, (_, i) => `- A long-winded fact ${i} ${"padding ".repeat(4)}`).join("\n") + "\n");
      const out = await app.learner.process([{ kind: "memory.add", target: "user", text: "Has two cats" }], { agent: "main", session: "s" });
      assert.deepEqual(out.applied, ["Remember (user): Has two cats"]);
      assert.equal(read(home, "Memory/USER.md"), "# User\n\n- Facts zero to two, merged into one shorter entry\n- Facts three to five, merged into one shorter entry\n- Has two cats\n");
    },
    { config: { memory: { user_max_chars: 320 } } },
  );
});

test("a saved conversation can be reviewed by hand", async () => {
  await withApp(
    [{ content: "ok" }, { calls: [call("save_memory", { target: "user", text: "Plays the cello" })] }, { content: "DONE" }],
    async ({ app, provider, home }) => {
      await app.send("I play the cello");
      const rel = path.relative(home.vault, app.session.file);
      const outcome = await app.learner.reflectNote(rel);
      assert.deepEqual(outcome.applied, ["Remember (user): Plays the cello"]);
      assert.match(provider.seen[1]!.messages[1]!.content, /## User\n\nI play the cello/);
      await assert.rejects(async () => app.learner.reflectNote("../../outside.md"), /outside the home folder/);
    },
    { config: { learning: { reflect_every_turns: 50 } } },
  );
});

test("in chat: the user is told when something waits, and can list, approve and reject from there", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ gateway: { port: 0 }, learning: { reflect_every_turns: 1 } })}\n---\n`);
  const provider = new ScriptedProvider([{ content: "Sure." }, { calls: [call("create_skill", EXEC_SKILL), call("create_skill", { ...EXEC_SKILL, name: "backup-db" })] }, { content: "DONE" }]);
  const app = await App.start(home, { provider, watch: false });
  const gateway = new Gateway(app);
  await gateway.start({ scheduler: false });
  const sent: string[] = [];
  gateway.channels.set("fake", { name: "fake", state: "connected", start: async () => {}, stop: async () => {}, send: async (_p, t) => void sent.push(t) });
  const say = (text: string) => gateway.handleInbound({ channel: "fake", peer: "42", sender: "42", senderName: "Ada", text, isGroup: false, mentioned: false });
  try {
    gateway.pairing.approve(gateway.pairing.request("fake", "42", "Ada")!);
    await say("how do I deploy?");
    await app.enqueue(async () => {});
    await new Promise((r) => setImmediate(r));
    const [a, b] = app.learner.pending();
    assert.equal(sent[0], "Sure.");
    assert.match(sent[1]!, new RegExp(`needs your approval:\\n\\nNew skill 'deploy-site'[\\s\\S]*Reply /approve ${a!.id} or /reject ${a!.id}`));
    assert.equal(sent.length, 3);

    await say("/inbox");
    assert.match(sent.at(-1)!, new RegExp(`^${a!.id}  New skill 'deploy-site'.*\\n${b!.id}  New skill 'backup-db'`));
    await say(`/approve ${a!.id}`);
    assert.match(sent.at(-1)!, /^Applied: New skill 'deploy-site'/);
    assert.ok(fs.existsSync(path.join(home.vault, "Skills", "deploy-site", "SKILL.md")));
    await say(`/reject ${b!.id}`);
    assert.equal(sent.at(-1), "Rejected.");
    await say("/approve nope");
    assert.match(sent.at(-1)!, /Nothing is waiting under 'nope'/);
    await say("/inbox");
    assert.equal(sent.at(-1), "Nothing is waiting for approval.");
    assert.equal(provider.seen.length, 3, "commands never reach the model");
  } finally {
    await gateway.stop();
    await app.stop();
    cleanup();
  }
});
