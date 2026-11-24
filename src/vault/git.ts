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
  private lock: Promise<unknown> = Promise.resolve();
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

  /** Commits the files recorded with `touch`. Used by background work, which runs one piece at a time. */
  commit(message: string): Promise<string | null> {
    const files = [...this.pending];
    this.pending.clear();
    return this.write(message, files);
  }

  /**
   * Commits exactly these files. Used by turns: several conversations can be running at once,
   * and each must record only what it changed itself.
   */
  commitFiles(message: string, absPaths: Iterable<string>): Promise<string | null> {
    const files = new Set<string>();
    for (const abs of absPaths) {
      const rel = path.relative(this.dir, abs);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) files.add(rel.split(path.sep).join("/"));
    }
    return this.write(message, [...files]);
  }

  /** Git operations must not interleave, so every commit waits for the one before it. */
  private write(message: string, files: string[]): Promise<string | null> {
    const run = this.lock.then(() => this.doCommit(message, files));
    this.lock = run.catch(() => {});
    return run;
  }

  private async doCommit(message: string, files: string[]): Promise<string | null> {
    if (files.length === 0) return null;
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
