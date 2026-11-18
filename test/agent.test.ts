import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { toolSpecs } from "../src/agent/loop.js";
import { runEval } from "../src/eval/toolcalling.js";
import { builtinTools } from "../src/tools/builtin.js";
import { ScriptedProvider, tempHome } from "./helpers.js";

async function withApp(
  steps: ConstructorParameters<typeof ScriptedProvider>[0],
  fn: (x: { app: App; provider: ScriptedProvider; home: App["home"]; outside: string; asked: string[]; answer: { value: boolean } }) => Promise<void>,
) {
  const { home, outside, cleanup } = tempHome();
  const provider = new ScriptedProvider(steps);
  const asked: string[] = [];
  const answer = { value: true };
  const app = await App.start(home, {
    provider,
    watch: false,
    approver: async (action, detail) => {
      asked.push(`${action}: ${detail}`);
      return answer.value;
    },
  });
  try {
    await fn({ app, provider, home, outside, asked, answer });
  } finally {
    await app.stop();
    cleanup();
  }
}

test("tool specs are valid JSON schema objects", () => {
  for (const spec of toolSpecs(builtinTools)) {
    assert.equal((spec.parameters as any).type, "object", spec.name);
    assert.ok(!("$schema" in spec.parameters));
  }
});

test("a turn runs tools, writes the vault, records the session and commits", async () => {
  await withApp(
    [
      { calls: [{ name: "write_file", args: { path: "Notes/todo.md", content: "buy milk\n" } }] },
      { calls: [{ name: "memory_add", args: { target: "user", text: "Prefers oat milk" } }] },
      { content: "Done." },
    ],
    async ({ app, provider, home }) => {
      const events: string[] = [];
      app.bus.on("tool.finished", (e) => void events.push(`${e.name}:${e.ok}`));
      const result = await app.send("make a todo");
      assert.equal(result.text, "Done.");
      assert.equal(result.steps, 3);
      assert.deepEqual(events, ["write_file:true", "memory_add:true"]);
      assert.equal(fs.readFileSync(path.join(home.vault, "Notes", "todo.md"), "utf8"), "buy milk\n");
      assert.match(fs.readFileSync(path.join(home.vault, "Memory", "USER.md"), "utf8"), /- Prefers oat milk/);

      // the system prompt carries the vault's persona and the tool list reaches the model
      const first = provider.seen[0]!;
      assert.match((first.messages[0] as any).content, /capable, direct personal assistant/);
      assert.ok(first.tools.some((t) => t.name === "import_file"));

      // session transcript is a note, and is searchable
      const transcript = fs.readFileSync(app.session.file, "utf8");
      assert.match(transcript, /## User\n\nmake a todo/);
      assert.match(transcript, /tool `write_file`/);
      assert.equal(app.memory.search("oat milk")[0]?.path, "Memory/USER.md");

      // one commit for the turn, listing the changed files
      const log = await app.history.log(2);
      assert.match(log[0]!.message, /^Turn \(main\): make a todo/);
      assert.match(log[0]!.message, /- Notes\/todo\.md/);
      assert.match(log[0]!.message, /- Memory\/USER\.md/);
      assert.equal(log[1]!.message.trim(), "Initial vault");

      // history carries over into the next turn
      await app.send("thanks");
      const roles = provider.seen.at(-1)!.messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user"]);
    },
  );
});

test("writes outside the home folder are refused and nothing is created", async () => {
  await withApp([], async ({ app, provider, outside, home }) => {
    const target = path.join(outside, "escape.txt");
    fs.symlinkSync(outside, path.join(home.vault, "link"), "junction");
    provider["steps"].push(
      {
        calls: [
          { name: "write_file", args: { path: target, content: "x" } },
          { name: "write_file", args: { path: "../../outside/escape.txt", content: "x" } },
          { name: "write_file", args: { path: "link/escape.txt", content: "x" } },
          { name: "edit_file", args: { path: target, old_text: "a", new_text: "b" } },
          { name: "read_file", args: { path: "/etc/hostname" } },
        ],
      },
      { content: "I could not." },
    );
    await app.send("write outside");
    const outputs = provider.lastToolOutputs();
    assert.equal(outputs.length, 5);
    for (const o of outputs) assert.match(o, /outside the home folder/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

test("the agent cannot change its own policies, secrets or program", async () => {
  await withApp(
    [
      {
        calls: [
          { name: "write_file", args: { path: "System/policies.md", content: "---\npolicies: {command.other: auto}\n---\n" } },
          { name: "write_file", args: { path: "vault/../secrets/keys.json", content: "{}" } },
          { name: "write_file", args: { path: "vault/../runtime/plugins/x.js", content: "" } },
          { name: "read_file", args: { path: "vault/../secrets/keys.json" } },
        ],
      },
      { content: "ok" },
    ],
    async ({ app, provider, home }) => {
      fs.writeFileSync(path.join(home.secrets, "keys.json"), '{"k":"v"}');
      const before = fs.readFileSync(path.join(home.vault, "System", "policies.md"), "utf8");
      await app.send("x");
      const outputs = provider.lastToolOutputs();
      assert.match(outputs[0]!, /may not change vault\/System\/policies\.md/);
      assert.match(outputs[1]!, /may not change secrets/);
      assert.match(outputs[2]!, /may not change runtime/);
      assert.match(outputs[3]!, /Secrets cannot be read/);
      assert.equal(fs.readFileSync(path.join(home.vault, "System", "policies.md"), "utf8"), before);
      assert.equal(fs.readFileSync(path.join(home.secrets, "keys.json"), "utf8"), '{"k":"v"}');
    },
  );
});

test("import copies an outside file in, leaves the original alone, and asks only when the agent chose the path", async () => {
  await withApp([], async ({ app, provider, outside, home, asked }) => {
    const named = path.join(outside, "letter.txt");
    const unnamed = path.join(outside, "diary.txt");
    fs.writeFileSync(named, "MARIGOLD");
    fs.writeFileSync(unnamed, "private");
    provider["steps"].push(
      { calls: [{ name: "import_file", args: { source: named } }, { name: "import_file", args: { source: unnamed } }] },
      { calls: [{ name: "read_file", args: { path: "Imports/letter.txt" } }, { name: "import_file", args: { source: named } }] },
      { content: "MARIGOLD" },
    );
    await app.send(`read ${named}`);
    assert.deepEqual(asked, [`import.agent: copy ${unnamed} into the vault`]);
    assert.equal(fs.readFileSync(path.join(home.vault, "Imports", "letter.txt"), "utf8"), "MARIGOLD");
    assert.match(fs.readFileSync(path.join(home.vault, "Imports", "letter.txt.source.md"), "utf8"), /imported_from: .*letter\.txt/);
    assert.equal(fs.readFileSync(named, "utf8"), "MARIGOLD");
    const outputs = provider.lastToolOutputs();
    assert.equal(outputs[2], "MARIGOLD");
    assert.ok(fs.existsSync(path.join(home.vault, "Imports", "letter-2.txt")), "a second import does not overwrite the first");
  });
});

test("declined approvals stop the action and the model is told", async () => {
  await withApp(
    [{ calls: [{ name: "run_command", args: { command: "node -e \"require('fs').writeFileSync('made.txt','x')\"" } }] }, { content: "Declined." }],
    async ({ app, provider, home, asked, answer }) => {
      answer.value = false;
      await app.send("run it");
      assert.equal(asked.length, 1);
      assert.match(asked[0]!, /^command\.other: run: node -e/);
      assert.match(provider.lastToolOutputs()[0]!, /the user declined/);
      assert.ok(!fs.existsSync(path.join(home.workspace, "made.txt")));
    },
  );
});

test("commands run in the workspace; allowlisted ones need no approval", async () => {
  await withApp(
    [
      { calls: [{ name: "run_command", args: { command: "node --version" } }] },
      { calls: [{ name: "run_command", args: { command: "node -e \"console.log(process.cwd())\"" } }] },
      { content: "ok" },
    ],
    async ({ app, provider, home, asked }) => {
      await app.send("go");
      const outputs = provider.lastToolOutputs();
      assert.match(outputs[0]!, new RegExp(`exit code 0\\n${process.version}`));
      assert.equal(asked.length, 1, "only the non-allowlisted command asked");
      assert.match(outputs[1]!, new RegExp(fs.realpathSync(home.workspace).replace(/[\\.]/g, "\\$&")));
    },
  );
});

test("memory is size-limited and edit_file demands a unique match", async () => {
  await withApp(
    [
      { calls: [{ name: "memory_add", args: { target: "memory", text: "y".repeat(500) } }] },
      { calls: [{ name: "edit_file", args: { path: "Notes/a.md", old_text: "cat", new_text: "dog" } }] },
      { calls: [{ name: "edit_file", args: { path: "Notes/a.md", old_text: "cat sat", new_text: "dog sat" } }] },
      { content: "ok" },
    ],
    async ({ app, provider, home }) => {
      fs.mkdirSync(path.join(home.vault, "Notes"));
      fs.writeFileSync(path.join(home.vault, "Notes", "a.md"), "the cat sat. another cat ran.");
      const memory = path.join(home.vault, "Memory", "MEMORY.md");
      fs.appendFileSync(memory, "x".repeat(3800));
      await app.send("go");
      const outputs = provider.lastToolOutputs();
      assert.match(outputs[0]!, /would exceed its limit of 4000 characters/);
      assert.match(outputs[1]!, /appears 2 times/);
      assert.match(outputs[2]!, /Edited/);
      assert.equal(fs.readFileSync(path.join(home.vault, "Notes", "a.md"), "utf8"), "the dog sat. another cat ran.");
      assert.ok(!fs.readFileSync(memory, "utf8").includes("yyyy"));
    },
  );
});

test("bad tool calls are reported back to the model instead of crashing the turn", async () => {
  await withApp(
    [
      { calls: [{ name: "no_such_tool", args: {} }, { name: "read_file", args: { wrong: 1 } }, { name: "read_file", args: { path: "missing.md" } }] },
      { content: "recovered" },
    ],
    async ({ app, provider }) => {
      const result = await app.send("go");
      assert.equal(result.text, "recovered");
      const outputs = provider.lastToolOutputs();
      assert.match(outputs[0]!, /Unknown tool 'no_such_tool'/);
      assert.match(outputs[1]!, /Invalid arguments/);
      assert.match(outputs[2]!, /No such file/);
    },
  );
});

test("the step limit ends a runaway loop with a final answer", async () => {
  const loop = Array.from({ length: 30 }, () => ({ calls: [{ name: "list_files", args: { path: "." } }] }));
  await withApp(loop, async ({ app, provider, home }) => {
    fs.writeFileSync(
      path.join(home.vault, "System", "config.md"),
      "---\nagent_loop:\n  max_steps: 3\n---\n",
    );
    app.reloadConfig();
    provider["steps"].splice(3, 0, { content: "Stopped at the limit." });
    const result = await app.send("loop");
    assert.equal(result.text, "Stopped at the limit.");
    assert.equal(provider.seen.at(-1)!.tools.length, 0, "the last call offers no tools");
  });
});

test("a broken settings edit keeps the previous settings", async () => {
  await withApp([], async ({ app, home }) => {
    const events: any[] = [];
    app.bus.on("config.reloaded", (e) => void events.push(e));
    fs.writeFileSync(path.join(home.vault, "System", "policies.md"), "---\npolicies:\n  command.other: maybe\n---\n");
    app.reloadConfig();
    assert.equal(events[0].ok, false);
    assert.equal(app.policies.policies["command.other"], "ask");
    fs.writeFileSync(path.join(home.vault, "System", "policies.md"), "---\npolicies:\n  command.other: deny\n---\n");
    app.reloadConfig();
    assert.equal(app.policies.policies["command.other"], "deny");
  });
});

test("skills in the vault are listed in the system prompt; blocked ones are not", async () => {
  await withApp([{ content: "hi" }], async ({ app, provider, home }) => {
    for (const [name, trust] of [["tidy-notes", "trusted"], ["bad-one", "blocked"]] as const) {
      fs.mkdirSync(path.join(home.vault, "Skills", name), { recursive: true });
      fs.writeFileSync(path.join(home.vault, "Skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\ntrust: ${trust}\n---\n\nSteps.\n`);
    }
    await app.send("hello");
    const system = (provider.seen[0]!.messages[0] as any).content as string;
    assert.match(system, /tidy-notes: Does tidy-notes \(Skills\/tidy-notes\/SKILL\.md\)/);
    assert.ok(!system.includes("bad-one"));
  });
});

test("evaluation harness scores cases and stays inside the home folder", async () => {
  const { home, cleanup } = tempHome();
  try {
    const good = new ScriptedProvider([
      { calls: [{ name: "write_file", args: { path: "Notes/todo.md", content: "buy milk" } }] },
      { content: "Created." },
    ]);
    const pass = await runEval(home, { provider: good, only: "write a file" });
    assert.deepEqual([pass.passed, pass.total], [1, 1]);
    const lazy = new ScriptedProvider([{ content: "I created it." }]);
    const fail = await runEval(home, { provider: lazy, only: "write a file" });
    assert.deepEqual([fail.passed, fail.total], [0, 1]);
    assert.ok(fs.existsSync(path.join(home.data, "eval")));
  } finally {
    cleanup();
  }
});

test("a user plugin from runtime/plugins can add a tool; a broken one is reported, not fatal", async () => {
  const { home, cleanup } = tempHome();
  try {
    const zodUrl = import.meta.resolve("zod");
    const dir = path.join(home.runtime, "plugins");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dice.js"),
      `import { z } from ${JSON.stringify(zodUrl)};
       export default { name: "dice", setup(api) {
         api.registerTool({ name: "roll_dice", description: "Roll", schema: z.object({ sides: z.number() }), run: async ({ sides }) => "rolled a " + sides });
       } };`,
    );
    fs.writeFileSync(path.join(dir, "broken.js"), "export default 42;");
    fs.writeFileSync(path.join(home.vault, "System", "config.md"), "---\nplugins: [dice, broken, ../../outside/evil]\n---\n");
    const provider = new ScriptedProvider([{ calls: [{ name: "roll_dice", args: { sides: 6 } }] }, { content: "ok" }]);
    const app = await App.start(home, { provider, watch: false });
    try {
      assert.deepEqual(app.registry.loaded, ["core-tools", "core-channels", "dice"]);
      await app.send("roll");
      assert.equal(provider.lastToolOutputs()[0], "rolled a 6");
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("edits made outside the agent are picked up while it runs: settings reload and search follows", async () => {
  const { home, cleanup } = tempHome();
  const app = await App.start(home, { provider: new ScriptedProvider([]) });
  try {
    const reloaded = new Promise<void>((resolve) => app.bus.on("config.reloaded", () => resolve()));
    fs.writeFileSync(path.join(home.vault, "System", "policies.md"), "---\npolicies:\n  command.other: deny\n---\n");
    fs.mkdirSync(path.join(home.vault, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(home.vault, "Notes", "typed-in-obsidian.md"), "# Idea\n\nBuild a kite from bamboo.\n");
    await reloaded;
    assert.equal(app.policies.policies["command.other"], "deny");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(app.memory.search("bamboo kite")[0]?.path, "Notes/typed-in-obsidian.md");
  } finally {
    await app.stop();
    cleanup();
  }
});
