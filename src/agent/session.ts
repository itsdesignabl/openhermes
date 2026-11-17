import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";
import type { ChatMessage } from "../provider/openai.js";
import { formatNote } from "../vault/frontmatter.js";

/** A conversation. The transcript is a Markdown note in vault/Sessions, so it is searchable and readable in Obsidian. */
export class Session {
  readonly id: string;
  readonly file: string;
  history: ChatMessage[] = [];

  constructor(home: Home, private agentName: string) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:T]/g, "-").slice(0, 19);
    this.id = stamp;
    this.file = path.join(home.vault, "Sessions", `${stamp}.md`);
  }

  append(messages: ChatMessage[]): void {
    this.history.push(...messages);
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, formatNote({ agent: this.agentName, started: new Date().toISOString() }, `# Session ${this.id}\n`));
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
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
