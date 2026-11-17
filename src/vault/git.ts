import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";

const AUTHOR = { name: "OpenHermes agent", email: "agent@openhermes.local" };

/**
 * History of the agent's own edits, stored in vault/.git (inside the home folder).
 * Pure JavaScript, so no git installation is needed.
 */
export class VaultHistory {
  private pending = new Set<string>();
  constructor(private dir: string) {}

  async init(): Promise<void> {
    if (fs.existsSync(path.join(this.dir, ".git"))) return;
    await git.init({ fs, dir: this.dir, defaultBranch: "main" });
    const files = await git.statusMatrix({ fs, dir: this.dir });
    for (const [file] of files) await git.add({ fs, dir: this.dir, filepath: file });
    await git.commit({ fs, dir: this.dir, message: "Initial vault", author: AUTHOR });
  }

  /** Record that the agent changed this file. Committed at the end of the turn. */
  touch(absPath: string): void {
    const rel = path.relative(this.dir, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return; // outside the vault: not versioned
    this.pending.add(rel.split(path.sep).join("/"));
  }

  async commit(message: string): Promise<string | null> {
    if (this.pending.size === 0) return null;
    const files = [...this.pending];
    this.pending.clear();
    for (const f of files) {
      if (fs.existsSync(path.join(this.dir, f))) await git.add({ fs, dir: this.dir, filepath: f });
      else await git.remove({ fs, dir: this.dir, filepath: f }).catch(() => {});
    }
    const body = files.map((f) => `- ${f}`).join("\n");
    return git.commit({ fs, dir: this.dir, message: `${message}\n\n${body}`, author: AUTHOR });
  }

  async log(depth = 10): Promise<{ oid: string; message: string; date: Date }[]> {
    const entries = await git.log({ fs, dir: this.dir, depth });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message,
      date: new Date(e.commit.author.timestamp * 1000),
    }));
  }
}
