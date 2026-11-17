import fs from "node:fs";
import path from "node:path";

/**
 * Watches the vault for changes made outside the agent (for example in Obsidian).
 * Events are debounced per file. Paths the agent itself just wrote are reported as "agent".
 */
export class VaultWatcher {
  private watcher?: fs.FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();
  private agentWrites = new Map<string, number>();

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
          const stamp = this.agentWrites.get(abs);
          const byAgent = stamp !== undefined && Date.now() - stamp < 2000;
          if (byAgent) this.agentWrites.delete(abs);
          this.onChange(abs, byAgent ? "agent" : "user");
        }, this.debounceMs),
      );
    });
    this.watcher.on("error", () => {});
  }

  markAgentWrite(absPath: string): void {
    this.agentWrites.set(absPath, Date.now());
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
