import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { Calibration, contextBudget, conversationSize, fitConversation, isContextOverflow, toolsWireChars } from "../src/agent/budget.js";
import { historyToKeep, recentHistory } from "../src/agent/session.js";
import { toolSpecs } from "../src/agent/loop.js";
import { main } from "../src/main.js";
import type { ChatMessage, ChatResult, Provider, ToolSpec } from "../src/provider/openai.js";
import { builtinTools } from "../src/tools/builtin.js";
import { tempHome } from "./helpers.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const says = (content: string): ChatMessage => ({ role: "assistant", content });
const calls = (id: string): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, name: "read_file", arguments: "{}" }] });
const result = (id: string, chars: number): ChatMessage => ({ role: "tool", tool_call_id: id, content: "x".repeat(chars) });

/** Every tool call still has its result, in order, and no result stands alone. */
function pairsIntact(messages: ChatMessage[]): boolean {
  const open: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) open.push(c.id);
    else if (m.role === "tool") {
      if (open.shift() !== m.tool_call_id) return false;
    } else if (open.length) return false;
  }
  return open.length === 0;
}

test("the window is divided into a fixed part, room for the answer, and the conversation", () => {
  const specs = toolSpecs(builtinTools);
  const b = contextBudget({ windowTokens: 8192, reserveTokens: 1024, system: "s".repeat(4000), specs, charsPerToken: 4 });
  assert.equal(b.fixedTokens, Math.ceil((4000 + toolsWireChars(specs) + 600) / 4));
  assert.equal(b.conversationTokens, 8192 - 1024 - b.fixedTokens);
  assert.equal(b.conversationChars, b.conversationTokens * 4);
  assert.ok(b.fixedTokens < 2200, "the built-in tools and a full set of instructions stay well under a third of an 8K window");
  // a window too small for the fixed part still yields a usable minimum instead of a negative budget
  assert.equal(contextBudget({ windowTokens: 1024, reserveTokens: 512, system: "s".repeat(9000), specs, charsPerToken: 4 }).conversationTokens, 200);
});

test("fitting: nothing changes while the conversation fits", () => {
  const history = [user("a"), says("b")];
  const produced = [user("c"), calls("1"), result("1", 500)];
  const fit = fitConversation(history, produced, 10_000);
  assert.deepEqual(fit, { messages: [...history, ...produced], elided: 0, droppedTurns: 0, fits: true });
});

test("fitting: space is freed in order of least loss, and tool calls keep their results", () => {
  const history = [
    user("first question"), calls("h1"), result("h1", 3000), says("first answer"),
    user("second question"), calls("h2"), result("h2", 3000), says("second answer"),
  ];
  const produced = [user("third question"), calls("p1"), result("p1", 3000), calls("p2"), result("p2", 3000), calls("p3"), result("p3", 3000)];
  const total = conversationSize(history) + conversationSize(produced);
  const toolText = (f: { messages: ChatMessage[] }) => f.messages.filter((m) => m.role === "tool").map((m) => (m.content.startsWith("[output removed") ? "gone" : m.content.length > 2999 ? "full" : "cut"));

  // 1. results from earlier turns go first
  let fit = fitConversation(history, produced, total - 2000);
  assert.deepEqual(toolText(fit), ["gone", "full", "full", "full", "full"]);
  assert.deepEqual([fit.elided, fit.droppedTurns, fit.fits], [1, 0, true]);

  // 2. then this turn's results, except the latest two
  fit = fitConversation(history, produced, total - 7000);
  assert.deepEqual(toolText(fit), ["gone", "gone", "gone", "full", "full"]);
  assert.equal(fit.messages.length, history.length + produced.length, "no message is removed yet, only their bulk");
  assert.match(fit.messages.find((m) => m.role === "tool")!.content, /^\[output removed to save space \(3000 characters\)\. Run the tool again if you need it\.\]$/);

  // 3. then whole earlier turns, oldest first
  fit = fitConversation(history, produced, 6600);
  assert.equal(fit.messages[0]!.content, "second question");
  assert.equal(fit.droppedTurns, 1);
  fit = fitConversation(history, produced, 6400);
  assert.equal(fit.messages[0]!.content, "third question");
  assert.deepEqual(toolText(fit), ["gone", "full", "full"]);

  // 4. then all but the latest result of this turn, 5. and finally the latest one is cut short
  fit = fitConversation(history, produced, 3500);
  assert.deepEqual(toolText(fit), ["gone", "gone", "full"]);
  fit = fitConversation(history, produced, 1500);
  assert.deepEqual(toolText(fit), ["gone", "gone", "cut"]);
  assert.match(fit.messages.at(-1)!.content, /\[cut: \d+ more characters did not fit\]$/);
  assert.ok(fit.fits);

  for (const budget of [total - 2000, total - 7000, 6600, 6400, 3500, 1500, 100]) {
    const f = fitConversation(history, produced, budget);
    assert.ok(pairsIntact(f.messages), `tool calls and results stay paired at budget ${budget}`);
    assert.ok(f.messages.includes(produced[0]!), "this turn's question is always kept");
  }
  assert.equal(fitConversation(history, produced, 100).fits, false, "when even that is not enough, it says so");
  assert.equal(history[2]!.content.length, 3000, "what is stored is never altered");
});

test("a newest turn that is over the kept slice is still the part a summary must leave in place", () => {
  const history = [user("The deadline is Friday"), says("Noted."), user("x".repeat(5000)), says("Read.")];
  assert.equal(recentHistory(history, 1000).length, 0, "the newest turn alone is over the slice, so the usual cut keeps nothing");
  const keep = historyToKeep(history, 1000);
  assert.equal(keep[0]!.content, "x".repeat(5000));
  assert.equal(keep.at(-1)!.content, "Read.");
  assert.equal(history.length - keep.length, 2, "only the earlier turn is eligible to be replaced");
  assert.deepEqual(historyToKeep(history, 100_000), history, "a conversation that fits is left untouched");
});

test("overflow errors from different model servers are recognised", () => {
  for (const m of [
    "Model endpoint returned 400: the request exceeds the available context size, try increasing it",
    "Model endpoint returned 400: This model's maximum context length is 8192 tokens",
    "error: context_length_exceeded",
    "prompt is too long: 9000 tokens > n_ctx",
  ]) assert.ok(isContextOverflow(new Error(m)), m);
  for (const m of ["Model endpoint returned 401: bad key", "fetch failed", "Model endpoint returned 500: out of memory"]) assert.ok(!isContextOverflow(new Error(m)), m);
});

test("calibration moves towards what the endpoint measures, ignores tiny samples, and survives a restart", () => {
  const { home, cleanup } = tempHome();
  try {
    const c = new Calibration(home.data);
    assert.equal(c.charsPerToken, 3.5);
    c.update(300, 100);
    assert.equal(c.charsPerToken, 3.5, "too small a sample to learn from");
    c.update(6000, 2000);
    assert.equal(c.charsPerToken, 3, "the first real measurement is taken as it is");
    c.update(8000, 2000);
    assert.ok(Math.abs(c.charsPerToken - 3.3) < 1e-9, "later ones move it gradually");
    c.update(100_000, 1000);
    assert.ok(c.charsPerToken <= 6, "absurd measurements are capped");
    assert.equal(new Calibration(home.data).charsPerToken, Number((c.charsPerToken as number).toFixed(3)));
  } finally {
    cleanup();
  }
});

interface Seen {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  chars: number;
}

/** A model stand-in driven by a function, which records the size of everything it is sent. */
function recorder(reply: (seen: Seen, n: number) => ChatResult | Promise<ChatResult>): Provider & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    async chat(messages, tools) {
      const s: Seen = { system: messages[0]!.content, messages: structuredClone(messages.slice(1)), tools, chars: conversationSize(messages.slice(1)) };
      seen.push(s);
      return reply(s, seen.length);
    },
  };
}

const text = (content: string): ChatResult => ({ content, toolCalls: [] });
const tool = (n: number, name: string, args: object): ChatResult => ({ content: "", toolCalls: [{ id: `c${n}`, name, arguments: JSON.stringify(args) }] });

function smallWindowHome(config: object = {}) {
  const t = tempHome();
  fs.writeFileSync(
    path.join(t.home.vault, "System", "config.md"),
    `---\n${JSON.stringify({ provider: { context_tokens: 3000, reserve_output_tokens: 300 }, learning: { enabled: false }, ...config })}\n---\n`,
  );
  return t;
}

test("inside one turn: large tool results never push a request past the window, and the transcript keeps everything", async () => {
  const { home, cleanup } = smallWindowHome({ session: { summarize: false } });
  try {
    for (const n of [1, 2, 3, 4, 5]) fs.writeFileSync(path.join(home.vault, `big${n}.md`), `# File ${n}\n\n` + `Line of file ${n}. `.repeat(600));
    const provider = recorder((_s, n) => (n <= 5 ? tool(n, "read_file", { path: `big${n}.md` }) : text("Read all five.")));
    const app = await App.start(home, { provider, watch: false });
    try {
      const budget = app.describeContext();
      assert.equal(budget.windowTokens, 3000);
      const turn = await app.send("read the five big files");
      assert.equal(turn.text, "Read all five.");
      assert.equal(provider.seen.length, 6);
      for (const [i, s] of provider.seen.entries()) {
        assert.ok(s.chars <= budget.conversationChars, `request ${i + 1} is ${s.chars} characters, within the ${budget.conversationChars} available`);
        assert.ok(pairsIntact(s.messages));
      }
      const last = provider.seen.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
      assert.ok(last[0]!.startsWith("[output removed to save space"), "the oldest result has been set aside");
      assert.match(last.at(-1)!, /^# File 5/, "the newest one is there to read");
      assert.ok(last.at(-1)!.length <= Math.floor(budget.conversationChars * 0.4) + 60, "one result may take at most 40% of the room");
      assert.ok(turn.usage.elided >= 2);

      // what is stored is complete: the model only saw less
      const stored = app.session.history.filter((m) => m.role === "tool");
      assert.equal(stored.length, 5);
      assert.ok(stored.every((m) => m.content.startsWith("# File")));
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("across turns: earlier turns are summarised in the background and the summary is what the model keeps", async () => {
  const { home, cleanup } = smallWindowHome({ learning: { enabled: true, reflect_every_turns: 100 } });
  try {
    const filler = "Some detail about the harbour survey that takes up room. ".repeat(18);
    const provider = recorder((s) => {
      if (s.system.startsWith("You are keeping notes")) return text("<think>hm</think>The user is planning the harbour survey for pier 4 and wants the report by Friday.");
      if (s.system.startsWith("You are reviewing")) return text("DONE");
      return text(`Answer. ${filler}`);
    });
    let app = await App.start(home, { provider, watch: false });
    const key = "main:telegram:42";
    const send = (t: string) => app.send(t, { conversation: key, persist: true });
    const drain = () => app.enqueue(async () => {});
    const budget = app.describeContext();
    try {
      for (let i = 1; i <= 8; i++) {
        await send(`Message ${i} about pier 4`);
        await drain();
      }
      const notes = provider.seen.filter((s) => s.system.startsWith("You are keeping notes"));
      const reviews = provider.seen.filter((s) => s.system.startsWith("You are reviewing"));
      assert.ok(notes.length >= 1, "a summary was written once the conversation outgrew the window");
      assert.ok(reviews.length >= 1, "the turns were reviewed for learning before they were replaced");
      assert.match(notes[0]!.messages[0]!.content, /Conversation to add to the summary:\nUSER: Message 1 about pier 4/);

      const session = app.conversation(key);
      assert.equal(session.summary, "The user is planning the harbour survey for pier 4 and wants the report by Friday.", "the model's thinking is stripped");
      assert.ok(session.history.length < 16, "the summarised turns are no longer carried along");
      assert.equal(session.history[0]!.role, "user");
      assert.ok(conversationSize(session.history) <= budget.conversationChars);

      await send("What was the deadline again?");
      const turn = provider.seen.filter((s) => !s.system.startsWith("You are")).at(-1)!;
      assert.match(turn.system, /## Earlier in this conversation\n\nThe user is planning the harbour survey for pier 4 and wants the report by Friday\.$/);
      assert.ok(turn.chars <= budget.conversationChars);
      assert.match(fs.readFileSync(session.file, "utf8"), /Message 1 about pier 4[\s\S]*Message 8 about pier 4/, "the note in the vault still has the whole conversation");
      if (notes.length > 1) assert.match(notes[1]!.messages[0]!.content, /^Summary so far:\nThe user is planning/, "a later summary builds on the earlier one");
    } finally {
      await app.stop();
    }

    // after a restart the conversation resumes with its summary
    app = await App.start(home, { provider, watch: false });
    try {
      await send("And who is it for?");
      assert.match(provider.seen.at(-1)!.system, /## Earlier in this conversation\n\nThe user is planning the harbour survey/);
      app.newSession(key);
      await send("Fresh start");
      assert.ok(!provider.seen.at(-1)!.system.includes("Earlier in this conversation"), "a new conversation starts without the old summary");
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("summarising leaves the newest turn in the session when that turn is too big for the kept slice", async () => {
  const { home, cleanup } = smallWindowHome({ learning: { enabled: false } });
  try {
    const provider = recorder((s) => {
      if (s.system.startsWith("You are keeping notes")) return text("The deadline is Friday.");
      return text("Answer.");
    });
    const app = await App.start(home, { provider, watch: false });
    try {
      const budget = app.describeContext();
      await app.send("The deadline is Friday");
      await app.enqueue(async () => {});
      const pasted = "Pasted survey notes. ".repeat(Math.ceil(budget.conversationChars / 20));
      await app.send(pasted);
      await app.enqueue(async () => {});

      const session = app.session;
      assert.equal(session.history[0]!.content, pasted, "the turn that just happened is not replaced by the summary");
      assert.equal(session.history.at(-1)!.content, "Answer.");
      assert.ok(!session.history.some((m) => m.content === "The deadline is Friday"), "the earlier turn is the part that was replaced");
      assert.equal(session.summary, "The deadline is Friday.");
      const notes = provider.seen.filter((s) => s.system.startsWith("You are keeping notes"));
      assert.equal(notes.length, 1);
      assert.match(notes[0]!.messages[0]!.content, /The deadline is Friday/);
      assert.ok(!notes[0]!.messages[0]!.content.includes(pasted.slice(0, 200)), "the oversized newest turn is not what crowds the summary");

      await app.send("What was the deadline?");
      const asked = provider.seen.filter((s) => s.messages.some((m) => m.content === "What was the deadline?")).at(-1)!;
      assert.match(asked.system, /## Earlier in this conversation\n\nThe deadline is Friday\.$/);
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("one oversized turn is summarised beside the messages, not deleted", async () => {
  const { home, cleanup } = smallWindowHome({ learning: { enabled: false } });
  try {
    const provider = recorder((s) => (s.system.startsWith("You are keeping notes") ? text("The survey is due on Friday.") : text("Answer.")));
    const app = await App.start(home, { provider, watch: false });
    try {
      const budget = app.describeContext();
      const pasted = "Pasted survey notes. ".repeat(Math.ceil(budget.conversationChars / 20));
      await app.send(pasted);
      await app.enqueue(async () => {});
      assert.equal(app.session.history[0]!.content, pasted);
      assert.equal(app.session.summary, "The survey is due on Friday.");

      await app.send("What was the date in it?");
      const asked = provider.seen.filter((s) => s.messages.some((m) => m.content === "What was the date in it?")).at(-1)!;
      assert.match(asked.system, /## Earlier in this conversation\n\nThe survey is due on Friday\.$/);
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("when summarising is off or yields nothing, older turns are simply left out and requests still fit", async () => {
  for (const config of [{ session: { summarize: false } }, {}]) {
    const { home, cleanup } = smallWindowHome(config);
    try {
      const filler = "Padding sentence to use up space in the window. ".repeat(20);
      const provider = recorder((s) => (s.system.startsWith("You are keeping notes") ? text("   ") : text(`Reply. ${filler}`)));
      const app = await App.start(home, { provider, watch: false });
      try {
        const budget = app.describeContext();
        for (let i = 1; i <= 9; i++) {
          await app.send(`Turn ${i}`);
          await app.enqueue(async () => {});
        }
        const turns = provider.seen.filter((s) => !s.system.startsWith("You are"));
        assert.ok(turns.every((s) => s.chars <= budget.conversationChars));
        const lastTurn = turns.at(-1)!;
        assert.equal(lastTurn.messages.at(-1)!.content, "Turn 9");
        assert.notEqual(lastTurn.messages[0]!.content, "Turn 1", "the oldest turns are no longer sent");
        assert.equal(lastTurn.messages[0]!.role, "user");
        assert.equal(app.session.summary, "");
        assert.equal(app.session.history.filter((m) => m.role === "user").length, 9, "nothing was discarded from the stored conversation");
      } finally {
        await app.stop();
      }
    } finally {
      cleanup();
    }
  }
});

test("if the model server still says the request is too long, it is retried once with half the room, then explained", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ learning: { enabled: false }, session: { summarize: false } })}\n---\n`);
  try {
    let fail = 0;
    const provider = recorder((s, n) => {
      if (fail > 0) {
        fail--;
        throw new Error("Model endpoint returned 400: the request exceeds the available context size");
      }
      return text(`ok ${n}`);
    });
    const app = await App.start(home, { provider, watch: false });
    try {
      const long = "A long earlier exchange. ".repeat(200);
      await app.send(long);
      await app.send(long);
      const before = provider.seen.length;
      fail = 1; // the server's window is smaller than the settings claim
      const turn = await app.send("short question");
      assert.match(turn.text, /^ok/);
      const [first, second] = provider.seen.slice(before);
      assert.ok(second!.chars <= first!.chars / 2, `retried with ${second!.chars} characters after ${first!.chars} were refused`);
      assert.equal(second!.messages.at(-1)!.content, "short question");

      fail = 2;
      await assert.rejects(app.send("another"), /no longer fits in the model's context window.*Start a new conversation, or use a model with a larger window \(provider\.context_tokens\)/);
      fail = 0;
      await assert.rejects(
        (async () => {
          const other = recorder(() => {
            throw new Error("Model endpoint returned 401: bad key");
          });
          const app2 = await App.start(home, { provider: other, watch: false });
          try {
            await app2.send("x");
          } finally {
            assert.equal(other.seen.length, 1, "other errors are not retried");
            await app2.stop();
          }
        })(),
        /401: bad key/,
      );
    } finally {
      await app.stop();
    }
  } finally {
    cleanup();
  }
});

test("token counts reported by the endpoint tune the budget, and doctor shows how the window is used", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ provider: { base_url: "http://127.0.0.1:9/v1", context_tokens: 4096 }, learning: { enabled: false } })}\n---\n`);
  try {
    // this model's tokens are short: 2.5 characters each
    const provider: Provider = {
      async chat(messages, tools) {
        const chars = conversationSize(messages.slice(1)) + messages[0]!.content.length + toolsWireChars(tools);
        return { content: "ok", toolCalls: [], usage: { promptTokens: Math.round(chars / 2.5), completionTokens: 1 } };
      },
    };
    const app = await App.start(home, { provider, watch: false });
    try {
      const before = app.describeContext();
      assert.equal(before.charsPerToken, 3.5);
      await app.send("hello");
      const after = app.describeContext();
      assert.ok(Math.abs(after.charsPerToken - 2.5) < 0.05, `measured ${after.charsPerToken}`);
      assert.ok(after.fixedTokens > before.fixedTokens && after.conversationChars < before.conversationChars, "the same text now counts for more tokens, so less is sent");
    } finally {
      await app.stop();
    }

    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await main(["doctor", "--home", home.root]);
      const line = lines.find((l) => l.includes("context:"))!;
      assert.match(line, /^ok {4}context: of 4096 tokens, about \d+ go to instructions, memory and tools, 1024 are kept for the answer, and \d+ \(\d+%\) are left for the conversation$/);

      fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ provider: { base_url: "http://127.0.0.1:9/v1", context_tokens: 2048 } })}\n---\n`);
      fs.appendFileSync(path.join(home.vault, "Memory", "MEMORY.md"), "- fact\n".repeat(400));
      lines.length = 0;
      await main(["doctor", "--home", home.root]);
      assert.match(lines.find((l) => l.includes("context:"))!, /^warn  context: of 2048 tokens.*Use a model with a larger window, shorten MEMORY\.md and USER\.md, or limit the agent's tools in agent\.md\.$/);
    } finally {
      console.log = log;
    }
  } finally {
    cleanup();
  }
});
