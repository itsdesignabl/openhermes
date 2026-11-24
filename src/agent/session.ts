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
  /** How much of the history the learning loop has already reviewed. */
  reflected = 0;
  /** What was said before the turns still held in `history`, in the model's own words. */
  summary = "";
  lastActive = Date.now();
  private persisted = false;
  private stateFile: string;

  constructor(private home: Home, readonly key: string, readonly agentName: string, opts: { resume?: boolean } = {}) {
    this.stateFile = path.join(home.data, "sessions", `${safe(key)}.json`);
    if (opts.resume && fs.existsSync(this.stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as { id: string; file: string; history: ChatMessage[]; reflected?: number; lastActive?: number; summary?: string };
        this.id = state.id;
        this.file = home.resolveInside(state.file, home.vault);
        this.history = state.history;
        this.reflected = Math.min(state.reflected ?? 0, state.history.length);
        this.lastActive = state.lastActive ?? Date.now();
        this.summary = state.summary ?? "";
        this.persisted = true;
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
    this.reflected = 0;
    this.summary = "";
    fs.rmSync(this.stateFile, { force: true });
  }

  /** Replaces the first `count` messages by a summary. The transcript note keeps everything. */
  compact(count: number, summary: string): void {
    this.history.splice(0, count);
    this.reflected = Math.max(0, this.reflected - count);
    this.summary = summary;
    if (this.persisted) this.save();
  }

  markReflected(): void {
    this.reflected = this.history.length;
    if (this.persisted) this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const state = { id: this.id, file: path.relative(this.home.vault, this.file), history: this.history, reflected: this.reflected, lastActive: this.lastActive, summary: this.summary };
    const tmp = this.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.stateFile);
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
    this.lastActive = Date.now();
    if (persist) {
      this.persisted = true;
      this.save();
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

/**
 * Messages left in place when an older part of the session is replaced by a summary.
 * Same cut as `recentHistory`, except when the newest turn is already over `maxChars`.
 * That turn stays whole. Keeping nothing there would drop the exchange that just happened,
 * and every turn before it.
 */
export function historyToKeep(history: ChatMessage[], maxChars: number): ChatMessage[] {
  const keep = recentHistory(history, maxChars);
  if (keep.length > 0 || history.length === 0) return keep;
  const lastUser = history.findLastIndex((m) => m.role === "user");
  return history.slice(lastUser < 0 ? 0 : lastUser);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
