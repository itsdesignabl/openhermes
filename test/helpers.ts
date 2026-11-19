import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Home } from "../src/kernel/home.js";
import type { ChatMessage, ChatResult, Provider, ToolSpec } from "../src/provider/openai.js";
import { FAMILIES } from "../src/eval/bench.js";
import { scaffold } from "../src/vault/layout.js";

export function tempHome(): { home: Home; outside: string; cleanup: () => void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhermes-test-")));
  const home = new Home(path.join(base, "Openhermes Programming Files"));
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  scaffold(home);
  return { home, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

type Step = { content?: string; calls?: { name: string; args: unknown }[] };

/** A provider that replays a fixed script, and records what it was sent. */
export class ScriptedProvider implements Provider {
  seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private steps: Step[]) {}
  async chat(messages: ChatMessage[], tools: ToolSpec[], onDelta?: (t: string) => void): Promise<ChatResult> {
    this.seen.push({ messages: structuredClone(messages), tools });
    const step = this.steps.shift() ?? { content: "(script ended)" };
    if (step.content) onDelta?.(step.content);
    return {
      content: step.content ?? "",
      toolCalls: (step.calls ?? []).map((c, i) => ({ id: `c${this.seen.length}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
    };
  }
  lastToolOutputs(): string[] {
    const last = this.seen.at(-1)?.messages ?? [];
    return last.filter((m) => m.role === "tool").map((m) => m.content);
  }
}

/** A tiny OpenAI-compatible server that streams the given chunks as server-sent events. */
export async function sseServer(chunks: unknown[]): Promise<{ url: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

// A simulated model. With no skill listed in its instructions it looks around before doing the work;
// with one, it reads the skill and goes straight to the work. When asked to review, it writes the skill.
export function simulatedModel(opts: { usesSkills?: boolean; writesSkills?: boolean; breaks?: string } = {}): Provider {
  const uses = opts.usesSkills ?? true;
  const call = (i: number, name: string, args: object) => ({ id: `s${i}`, name, arguments: JSON.stringify(args) });
  const explore: Record<string, object[]> = {
    "weekly-report": [{ path: "." }, { path: "Docs" }, { path: "Docs/Conventions" }],
    release: [{ path: "." }, { path: "Docs" }, { path: "Project" }],
  };
  const docs: Record<string, string> = { "weekly-report": "Docs/Conventions/reports.md", release: "Docs/release-process.md" };
  return {
    async chat(messages: ChatMessage[], _tools: ToolSpec[]): Promise<ChatResult> {
      const system = messages[0]!.content;
      const lastUser = messages.map((m) => m.role).lastIndexOf("user");
      const user = messages[lastUser]!.content;
      const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
      const toolOutputs = messages.slice(lastUser + 1).filter((m) => m.role === "tool").map((m) => m.content);
      const say = (content: string): ChatResult => ({ content, toolCalls: [] });
      const tool = (name: string, args: object): ChatResult => ({ content: "", toolCalls: [call(done, name, args)] });

      if (system.startsWith("You are reviewing")) {
        if (done > 0 || opts.writesSkills === false) return say("DONE");
        const family = /weekly report/i.test(user) ? FAMILIES.find((f) => f.name === "weekly-report")! : FAMILIES.find((f) => f.name === "release")!;
        return tool("create_skill", { name: family.reference.name, description: family.reference.description, steps: family.reference.body });
      }

      const family = /weekly report/i.test(user) ? "weekly-report" : "release";
      const skill = uses ? /\((Skills\/[^/]+\/SKILL\.md)\)/.exec(system)?.[1] : undefined;
      const prelude: [string, object][] = skill ? [["read_file", { path: skill }]] : [...explore[family]!.map((a) => ["list_files", a] as [string, object]), ["read_file", { path: docs[family] }]];
      if (done < prelude.length) return tool(...prelude[done]!);
      const step = done - prelude.length;

      if (family === "weekly-report") {
        const week = /week (\d+)/.exec(user)![1];
        if (step === 0) return tool("read_file", { path: `Notes/week-${week}.md` });
        const status = /amber/.test(toolOutputs.at(-1) ?? "") ? "amber" : "green";
        const where = opts.breaks === "weekly-report" ? `Archive/week-${week}.txt` : `Reports/Weekly/2026-W${week}.md`;
        if (step === 1) return tool("write_file", { path: where, content: `# Weekly report 2026-W${week}\nStatus: ${status}\n\n## Highlights\n\n- One\n- Two\n- Three\n` });
        return say("The report is written.");
      }
      const version = /version ([\d.]+)/.exec(user)![1]!;
      const change = /change is: (.*?)\. Follow/.exec(user)![1]!;
      if (step === 0) return tool("write_file", { path: "Project/VERSION", content: version + "\n" });
      if (step === 1) return tool("edit_file", { path: "Project/CHANGELOG.md", old_text: "# Changelog\n\n", new_text: `# Changelog\n\n## ${version}\n\n- ${change}\n\n` });
      if (step === 2) return tool("read_file", { path: "Project/releases.log" });
      if (step === 3) return tool("write_file", { path: "Project/releases.log", content: toolOutputs.at(-1)!.replace(/\s*$/, "\n") + `${version} released\n` });
      return say(`Version ${version} is released.`);
    },
  };
}

