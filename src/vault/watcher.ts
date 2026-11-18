import fs from "node:fs";
import path from "node:path";

/**
 * Watches the vault for changes made outside the agent (for example in Obsidian).
 * Events are debounced per file. A file that is unchanged since the agent wrote it is reported as "agent".
 */
export class VaultWatcher {
  private watcher?: fs.FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();
  /** What each file looked like right after the agent last wrote it. */
  private agentWrites = new Map<string, string>();

  constructor(
    private dir: string,
    private onChange: (absPath: string, by: "agent" | "user") => void,
    private debounceMs = 250,
  ) {}

  start(): void {
    this.watcher = fs.watch(this.dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (rel.split(/[\\/]/).some((part) => part.startsWith("."))) return; // .git, .obsidian
      const abs = path.join(this.dir, rel);
      clearTimeout(this.timers.get(abs));
      this.timers.set(
        abs,
        setTimeout(() => {
          this.timers.delete(abs);
          // the change is the agent's own if the file still looks exactly as the agent left it
          const byAgent = this.agentWrites.get(abs) === fingerprint(abs);
          if (!byAgent) this.agentWrites.delete(abs);
          this.onChange(abs, byAgent ? "agent" : "user");
        }, this.debounceMs),
      );
    });
    this.watcher.on("error", () => {});
  }

  markAgentWrite(absPath: string): void {
    this.agentWrites.set(absPath, fingerprint(absPath));
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

function fingerprint(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
}
