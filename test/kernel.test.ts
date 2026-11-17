import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Bus } from "../src/kernel/bus.js";
import { loadConfig, loadPolicies, PoliciesSchema } from "../src/kernel/config.js";
import { ContainmentError } from "../src/kernel/home.js";
import { PolicyDenied, PolicyEngine } from "../src/kernel/policy.js";
import { MemoryIndex, chunkMarkdown } from "../src/memory/index.js";
import { OpenAIProvider } from "../src/provider/openai.js";
import { formatNote, parseNote } from "../src/vault/frontmatter.js";
import { scaffold } from "../src/vault/layout.js";
import { sseServer, tempHome } from "./helpers.js";

test("containment: paths inside the home resolve, everything else is refused", () => {
  const { home, outside, cleanup } = tempHome();
  try {
    assert.equal(home.resolveInside("Memory/MEMORY.md"), path.join(home.vault, "Memory", "MEMORY.md"));
    assert.equal(home.resolveInside("new/deep/file.md"), path.join(home.vault, "new", "deep", "file.md"));
    assert.throws(() => home.resolveInside("../../outside/x.txt"), ContainmentError);
    assert.throws(() => home.resolveInside(path.join(outside, "x.txt")), ContainmentError);
    assert.throws(() => home.resolveInside("../.."), ContainmentError);
    // a sibling folder whose name merely starts with the home's name
    assert.throws(() => home.resolveInside(home.root + "-evil/x"), ContainmentError);
  } finally {
    cleanup();
  }
});

test("containment: a link inside the vault that points outside is refused", () => {
  const { home, outside, cleanup } = tempHome();
  try {
    fs.symlinkSync(outside, path.join(home.vault, "escape"), "junction");
    assert.throws(() => home.resolveInside("escape/x.txt"), ContainmentError);
    assert.throws(() => home.resolveInside("escape/new/dir/x.txt"), ContainmentError);
  } finally {
    cleanup();
  }
});

test("scaffold creates the layout and never overwrites existing notes", () => {
  const { home, cleanup } = tempHome();
  try {
    const soul = path.join(home.vault, "Agents", "main", "SOUL.md");
    fs.writeFileSync(soul, "custom");
    const { created } = scaffold(home);
    assert.deepEqual(created, []);
    assert.equal(fs.readFileSync(soul, "utf8"), "custom");
    for (const d of ["vault", "models", "runtime", "data", "secrets", "workspace"]) assert.ok(fs.existsSync(path.join(home.root, d)));
    assert.equal(loadConfig(home).agent, "main");
    assert.equal(loadPolicies(home).policies["command.other"], "ask");
  } finally {
    cleanup();
  }
});

test("frontmatter round-trips", () => {
  const text = formatNote({ a: 1, list: ["x", "y"] }, "Body\n");
  const note = parseNote(text);
  assert.deepEqual(note.data, { a: 1, list: ["x", "y"] });
  assert.equal(note.body.trim(), "Body");
  assert.deepEqual(parseNote("no frontmatter").data, {});
});

test("policy: auto, ask and deny; allowlist rejects chained commands", async () => {
  const asked: string[] = [];
  let answer = true;
  const policies = PoliciesSchema.parse({ policies: { "vault.write": "deny" }, command_allowlist: ["git status", "ls"] });
  const engine = new PolicyEngine(() => policies, async (action) => {
    asked.push(action);
    return answer;
  });
  await engine.check("memory.edit", "x");
  assert.deepEqual(asked, []);
  await assert.rejects(engine.check("vault.write", "x"), PolicyDenied);
  await engine.check("command.other", "x");
  assert.deepEqual(asked, ["command.other"]);
  answer = false;
  await assert.rejects(engine.check("command.other", "x"), PolicyDenied);

  assert.ok(engine.isAllowlisted("git status"));
  assert.ok(engine.isAllowlisted("git status --short"));
  assert.ok(!engine.isAllowlisted("git statusx"));
  assert.ok(!engine.isAllowlisted("git status && rm -rf /"));
  assert.ok(!engine.isAllowlisted("ls; curl evil"));
  assert.ok(!engine.isAllowlisted("ls $(whoami)"));
  assert.ok(!engine.isAllowlisted("ls > /etc/passwd"));
});

test("bus: handlers run in order and one failure does not stop the rest", async () => {
  const bus = new Bus();
  const seen: string[] = [];
  bus.on("log", (e) => void seen.push("log:" + e.message));
  bus.on("turn.started", () => {
    throw new Error("boom");
  });
  bus.on("turn.started", (e) => void seen.push("second:" + e.text));
  await bus.emit("turn.started", { sessionId: "s", text: "hi" });
  assert.deepEqual(seen, ["log:handler for turn.started failed: boom", "second:hi"]);
});

test("memory index: finds sections, follows edits and deletions, survives odd queries", () => {
  const { home, cleanup } = tempHome();
  try {
    const note = path.join(home.vault, "Memory", "Entities", "Dana.md");
    fs.writeFileSync(note, "# Dana\n\nIntro.\n\n## Birthday\n\nDana's birthday is on 14 July.\n\n## Work\n\nHarbour survey.\n");
    const index = new MemoryIndex(path.join(home.data, "index.db"), home.vault);
    assert.ok(index.sync().indexed > 0);
    assert.equal(index.sync().indexed, 0, "unchanged files are not re-indexed");

    const hit = index.search("birthday")[0];
    assert.equal(hit?.path, "Memory/Entities/Dana.md");
    assert.equal(hit?.heading, "Birthday");
    assert.match(hit!.snippet, /14 July/);
    assert.equal(index.search("birthdays")[0]?.heading, "Birthday", "stemming");

    for (const q of ['"unbalanced', "AND OR NOT", "a:b (c", "*", ""]) assert.doesNotThrow(() => index.search(q));

    fs.writeFileSync(note, "# Dana\n\nMoved to the lighthouse project.\n");
    index.update(note);
    assert.equal(index.search("birthday").length, 0);
    assert.equal(index.search("lighthouse")[0]?.path, "Memory/Entities/Dana.md");

    fs.rmSync(note);
    assert.equal(index.sync().removed, 1);
    assert.equal(index.search("lighthouse").length, 0);
    index.close();
  } finally {
    cleanup();
  }
});

test("chunkMarkdown ignores headings inside code fences", () => {
  const chunks = chunkMarkdown("# A\n\ntext\n\n```\n# not a heading\n```\n\n## B\n\nmore\n");
  assert.deepEqual(chunks.map((c) => c.heading), ["A", "B"]);
});

test("provider: assembles streamed text and split tool-call arguments", async () => {
  const server = await sseServer([
    { choices: [{ delta: { role: "assistant", content: "Let me " } }] },
    { choices: [{ delta: { content: "look." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.md"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "list_files", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  try {
    const provider = new OpenAIProvider({ baseUrl: server.url, model: "m", apiKey: "k" });
    const deltas: string[] = [];
    const result = await provider.chat(
      [{ role: "user", content: "hi" }],
      [{ name: "read_file", description: "d", parameters: { type: "object" } }],
      (t) => deltas.push(t),
    );
    assert.equal(result.content, "Let me look.");
    assert.deepEqual(deltas, ["Let me ", "look."]);
    assert.deepEqual(result.toolCalls, [
      { id: "call_a", name: "read_file", arguments: '{"path":"x.md"}' },
      { id: "call_b", name: "list_files", arguments: "{}" },
    ]);
    const req = server.requests[0];
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer k");
    assert.equal(req.body.tools[0].function.name, "read_file");
  } finally {
    await server.close();
  }
});
