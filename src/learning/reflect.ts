import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listSkills } from "../agent/context.js";
import { runTurn } from "../agent/loop.js";
import { Bus } from "../kernel/bus.js";
import type { Home } from "../kernel/home.js";
import type { ChatMessage, Provider } from "../provider/openai.js";
import { defineTool, type Tool, type ToolContext } from "../tools/types.js";
import { ProposalSchema, skillFile, skillSlug, type Proposal } from "./proposals.js";

const SYSTEM = `You are reviewing a finished conversation between a user and their personal assistant. Decide what is worth keeping for the future, and record it with the tools.

What to keep:
- Durable facts about the user: preferences, people, projects, decisions, recurring needs. Use save_memory with target "user".
- Durable facts about how to do things in this environment. Use save_memory with target "memory".
- Facts about one particular person, project or topic. Use note_entity.
- A procedure: only when the conversation shows a task of several steps that worked and will plausibly be needed again. Use create_skill, and write the steps so that someone who did not see the conversation can follow them.
- If an existing skill was used and turned out to be wrong or incomplete, read it with read_skill and fix it with improve_skill instead of creating a new one.

What not to keep:
- Anything already in memory (shown below). If a fact there is now out of date, use update_memory.
- One-off details, small talk, things that only mattered today.
- Passwords, keys, tokens or other secrets.
- Anything the assistant got wrong or guessed.

Most conversations contain nothing worth keeping. In that case call no tools.
Each entry is one short sentence. When you are finished, reply with the single word DONE.`;

/** Plain-text rendering of a conversation for the reviewer. Keeps the end when it is too long. */
export function renderTranscript(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`USER: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content.trim()) lines.push(`ASSISTANT: ${m.content}`);
      for (const c of m.tool_calls ?? []) lines.push(`  [tool ${c.name} ${clip(c.arguments, 400)}]`);
    } else if (m.role === "tool") lines.push(`  [result: ${clip(m.content, 400)}]`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? "[earlier part omitted]\n" + text.slice(text.length - maxChars) : text;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ");

function readTrimmed(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
}

function reviewTools(home: Home, out: Proposal[]): Tool<any>[] {
  const record = (raw: unknown): string => {
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    out.push(parsed.data);
    return "Recorded.";
  };
  const target = z.enum(["memory", "user"]);
  return [
    defineTool({
      name: "save_memory",
      description: "Record one durable fact. target 'user' for facts about the user, 'memory' for everything else.",
      schema: z.object({ target, text: z.string() }),
      run: async (a) => record({ kind: "memory.add", ...a }),
    }),
    defineTool({
      name: "update_memory",
      description: "Correct or remove a fact that is already in memory. old_text must be copied exactly from the memory shown. Leave new_text empty to remove it.",
      schema: z.object({ target, old_text: z.string(), new_text: z.string().default("") }),
      run: async (a) => record({ kind: "memory.replace", ...a }),
    }),
    defineTool({
      name: "note_entity",
      description: "Record a fact about one person, project or topic in that entity's own note.",
      schema: z.object({ name: z.string(), text: z.string() }),
      run: async (a) => record({ kind: "entity.note", ...a }),
    }),
    defineTool({
      name: "create_skill",
      description: "Save a reusable procedure. name is short and hyphenated. description says when to use it. steps is the full procedure in Markdown.",
      schema: z.object({ name: z.string(), description: z.string(), steps: z.string() }),
      run: async (a) => {
        if (fs.existsSync(skillFile(home, a.name))) throw new Error(`A skill named '${skillSlug(a.name)}' already exists. Use read_skill and improve_skill.`);
        return record({ kind: "skill.create", name: a.name, description: a.description, body: a.steps });
      },
    }),
    defineTool({
      name: "read_skill",
      description: "Read an existing skill before improving it.",
      schema: z.object({ name: z.string() }),
      run: async (a) => {
        const file = skillFile(home, a.name);
        if (!fs.existsSync(file)) throw new Error(`There is no skill named '${skillSlug(a.name)}'.`);
        return fs.readFileSync(file, "utf8");
      },
    }),
    defineTool({
      name: "improve_skill",
      description: "Change part of an existing skill. old_text must be copied exactly from the skill and appear once.",
      schema: z.object({ name: z.string(), old_text: z.string(), new_text: z.string() }),
      run: async (a) => record({ kind: "skill.patch", ...a }),
    }),
  ];
}

/** Asks the model what to keep from a conversation. Returns its proposals; nothing is written here. */
export async function reflect(o: {
  home: Home;
  agent: string;
  provider: Provider;
  transcript: string;
  toolContext: ToolContext;
  maxSteps?: number;
}): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  const skills = listSkills(o.home);
  const context = [
    "## Memory about the user (already saved)",
    readTrimmed(path.join(o.home.vault, "Memory", "USER.md")) || "(empty)",
    "## Other memory (already saved)",
    readTrimmed(path.join(o.home.vault, "Memory", "MEMORY.md")) || "(empty)",
    "## Existing skills",
    skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "(none)",
    "## The conversation to review",
    o.transcript,
  ].join("\n\n");
  await runTurn({
    sessionId: "reflection",
    system: SYSTEM,
    history: [],
    userText: context,
    tools: reviewTools(o.home, proposals),
    provider: o.provider,
    bus: new Bus(), // private: a review never shows up as chat activity
    toolContext: o.toolContext,
    maxSteps: o.maxSteps ?? 6,
    maxToolOutputChars: 6000,
  });
  return proposals;
}
