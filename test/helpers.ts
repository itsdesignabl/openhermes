import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Home } from "../src/kernel/home.js";
import type { ChatMessage, ChatResult, Provider, ToolSpec } from "../src/provider/openai.js";
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
