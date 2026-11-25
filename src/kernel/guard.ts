import fs from "node:fs";
import path from "node:path";
import type { Home } from "./home.js";

/**
 * The files that decide what the agent may do: settings and policies, per-agent settings,
 * and the notes in the Inbox through which the user approves things. The agent's file tools
 * refuse to write them. A shell command that runs directly on the computer is not bound by
 * that, so these files are watched around every such command and put back if they changed.
 */
export function controlFiles(home: Home): string[] {
  const out: string[] = [];
  const list = (dir: string, keep: (name: string) => boolean) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile() && keep(e.name)) out.push(path.join(dir, e.name));
  };
  list(path.join(home.vault, "System"), () => true);
  list(path.join(home.vault, "Inbox"), (n) => n.toLowerCase().endsWith(".md"));
  const agents = path.join(home.vault, "Agents");
  if (fs.existsSync(agents)) {
    for (const e of fs.readdirSync(agents, { withFileTypes: true })) {
      const f = path.join(agents, e.name, "agent.md");
      if (e.isDirectory() && fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

/** Whether a command's text refers to the agent's own settings, approvals, keys or program. */
export function mentionsControlFiles(home: Home, command: string): boolean {
  const text = command.replace(/\\/g, "/").toLowerCase();
  if (/(^|[\s"'`=(/])(system\/|inbox\/|secrets\/|runtime\/|\.git\/)/.test(text)) return true;
  if (/policies\.md|config\.md|agent\.md|keys(\.enc)?\.json|gateway-token|command_allowlist|mcp_allowlist/.test(text)) return true;
  const root = home.root.replace(/\\/g, "/").toLowerCase();
  return ["secrets", "runtime", "vault/system", "vault/inbox"].some((d) => text.includes(`${root}/${d}`));
}

export interface GuardResult<T> {
  result: T;
  /** Files (relative to the home folder) that were changed, created or deleted, and have been put back. */
  restored: string[];
}

/**
 * Wraps work that could touch the control files. While any such work is running, one snapshot
 * taken at the start is the reference; everything that differs from it afterwards is undone.
 * Overlapping runs share that snapshot, so one run cannot "restore" another's tampering.
 * A file this process recorded with note() is left as that write left it, unless the command changed it again.
 */
export class SettingsGuard {
  private depth = 0;
  private baseline = new Map<string, Buffer>();
  /**
   * Control files this process wrote while a command was running, and what they held afterwards.
   * null means the write removed the file. A shell command is not recorded here, so its changes
   * are still undone. Several conversations run at once, and a review or an "always" approval
   * can write one of these files during someone else's command.
   */
  private agentWrites = new Map<string, Buffer | null>();

  constructor(
    private home: Home,
    private onSettled: () => void = () => {},
    private onRestored: (files: string[]) => void = () => {},
  ) {}

  /** True while guarded work is running: file-change events for control files should be ignored until it ends. */
  get active(): boolean {
    return this.depth > 0;
  }

  covers(abs: string): boolean {
    const rel = path.relative(this.home.vault, abs).split(path.sep).join("/").toLowerCase();
    return rel.startsWith("system/") || (rel.startsWith("inbox/") && !rel.slice(6).includes("/")) || /^agents\/[^/]+\/agent\.md$/.test(rel);
  }

  private snapshot(): Map<string, Buffer> {
    const snap = new Map<string, Buffer>();
    for (const f of controlFiles(this.home)) {
      try {
        snap.set(path.resolve(f), fs.readFileSync(f));
      } catch {
        // unreadable right now: not part of the reference
      }
    }
    return snap;
  }

  /**
   * Call after this process writes a file. While a command is running, that write is kept:
   * putting the file back would throw away an approval, an allowlist entry, or an Inbox
   * proposal that landed during the command. A later change by the command does not match
   * what was recorded, so it is still undone.
   */
  note(abs: string): void {
    if (this.depth === 0 || !this.covers(abs)) return;
    const file = path.resolve(abs);
    try {
      this.agentWrites.set(file, fs.readFileSync(file));
    } catch {
      this.agentWrites.set(file, null);
    }
  }

  /** True when the file still holds exactly what this process wrote, including having been removed. */
  private keptByAgent(file: string, current: Buffer | null): boolean {
    if (!this.agentWrites.has(file)) return false;
    const noted = this.agentWrites.get(file) ?? null;
    if (noted === null) return current === null;
    return current !== null && current.equals(noted);
  }

  private read(file: string): Buffer | null {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  /** Puts every control file back to the reference. Returns what had to be put back. */
  private restore(): string[] {
    const restored: string[] = [];
    const now = new Set(controlFiles(this.home).map((f) => path.resolve(f)));
    for (const [file, content] of this.baseline) {
      const current = this.read(file);
      if (current && current.equals(content)) continue;
      if (this.keptByAgent(file, current)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      restored.push(file);
    }
    for (const file of now) {
      if (this.baseline.has(file)) continue;
      if (this.keptByAgent(file, this.read(file))) continue;
      fs.rmSync(file, { force: true }); // a control file that did not exist before, such as a ready-approved Inbox note
      restored.push(file);
    }
    const names = restored.map((f) => this.home.display(f));
    if (names.length) this.onRestored(names);
    return names;
  }

  async run<T>(fn: () => Promise<T>): Promise<GuardResult<T>> {
    if (this.depth === 0) this.baseline = this.snapshot();
    this.depth++;
    let restored: string[] = [];
    try {
      const result = await fn();
      restored = this.restore();
      return { result, restored };
    } catch (err) {
      restored = this.restore();
      throw err;
    } finally {
      this.depth--;
      if (this.depth === 0) {
        this.baseline = new Map();
        this.agentWrites = new Map();
        // events for these files were ignored meanwhile: let the owner look at the settled state once
        this.onSettled();
      }
    }
  }
}
