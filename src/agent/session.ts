import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";
import type { ChatMessage } from "../provider/openai.js";
import { formatNote } from "../vault/frontmatter.js";

function safe(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
}

/**
 * One conversation, identified by a key such as "main:telegram:12345".
 * The readable transcript is a note in vault/Sessions. The exact message list is kept in
 * data/sessions so a restarted gateway continues where it stopped.
 */
export class Session {
  id!: string;
  file!: string;
  history: ChatMessage[] = [];
  private stateFile: string;

  constructor(private home: Home, readonly key: string, readonly agentName: string, opts: { resume?: boolean } = {}) {
    this.stateFile = path.join(home.data, "sessions", `${safe(key)}.json`);
    if (opts.resume && fs.existsSync(this.stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as { id: string; file: string; history: ChatMessage[] };
        this.id = state.id;
        this.file = home.resolveInside(state.file, home.vault);
        this.history = state.history;
        return;
      } catch {
        // unreadable state: start a new conversation
      }
    }
    this.reset();
  }

  /** Start a new conversation under the same key. The old transcript note stays in the vault. */
  reset(): void {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const local = this.key.endsWith(":local");
    this.id = local ? stamp : `${stamp}-${safe(this.key)}`;
    let file = path.join(this.home.vault, "Sessions", `${this.id}.md`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(this.home.vault, "Sessions", `${this.id}-${i}.md`);
    this.file = file;
    this.history = [];
    fs.rmSync(this.stateFile, { force: true });
  }

  append(messages: ChatMessage[], persist: boolean): void {
    this.history.push(...messages);
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, formatNote({ agent: this.agentName, conversation: this.key, started: new Date().toISOString() }, `# Session ${this.id}\n`));
    }
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === "user") lines.push(`\n## User\n\n${m.content}\n`);
      else if (m.role === "assistant") {
        if (m.content) lines.push(`\n## Assistant\n\n${m.content}\n`);
        for (const c of m.tool_calls ?? []) lines.push(`\n> tool \`${c.name}\` ${truncate(c.arguments, 300)}\n`);
      } else if (m.role === "tool") lines.push(`> result: ${truncate(m.content.split("\n")[0] ?? "", 300)}\n`);
    }
    fs.appendFileSync(this.file, lines.join(""));
    if (persist) {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const state = { id: this.id, file: path.relative(this.home.vault, this.file), history: this.history };
      const tmp = this.stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.stateFile);
    }
  }
}

/**
 * The part of the history sent to the model: the most recent turns that fit in `maxChars`.
 * Cuts only at the start of a user turn, so a tool result is never separated from its call.
 */
export function recentHistory(history: ChatMessage[], maxChars: number): ChatMessage[] {
  let size = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    size += m.content.length + (m.role === "assistant" ? (m.tool_calls ?? []).reduce((n, c) => n + c.arguments.length, 0) : 0);
    if (size > maxChars) break;
    if (m.role === "user") cut = i;
  }
  return history.slice(cut);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
