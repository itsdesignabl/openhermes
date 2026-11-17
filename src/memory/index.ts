import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SearchHit {
  path: string;
  heading: string;
  snippet: string;
}

/**
 * Full-text index over the vault's Markdown. It is a cache in data/ and can be
 * deleted at any time; `sync()` rebuilds it from the files.
 */
export class MemoryIndex {
  private db: DatabaseSync;

  constructor(dbFile: string, private vaultDir: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED, heading, body, tokenize = 'porter unicode61');
    `);
  }

  /** Bring the index in line with the files on disk. Returns how many files were (re)indexed or removed. */
  sync(): { indexed: number; removed: number } {
    const known = new Map<string, { mtime: number; size: number }>();
    for (const row of this.db.prepare("SELECT path, mtime, size FROM files").all() as any[]) {
      known.set(row.path, { mtime: row.mtime, size: row.size });
    }
    let indexed = 0;
    const seen = new Set<string>();
    for (const abs of walkMarkdown(this.vaultDir)) {
      const rel = path.relative(this.vaultDir, abs).split(path.sep).join("/");
      seen.add(rel);
      const st = fs.statSync(abs);
      const prev = known.get(rel);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
      this.indexFile(rel, fs.readFileSync(abs, "utf8"), st.mtimeMs, st.size);
      indexed++;
    }
    let removed = 0;
    for (const rel of known.keys()) {
      if (!seen.has(rel)) {
        this.removeFile(rel);
        removed++;
      }
    }
    return { indexed, removed };
  }

  /** Re-index one file after a change. Removes it from the index if it no longer exists. */
  update(absPath: string): void {
    if (!absPath.toLowerCase().endsWith(".md")) return;
    const rel = path.relative(this.vaultDir, absPath).split(path.sep).join("/");
    if (rel.startsWith("..")) return;
    if (!fs.existsSync(absPath)) return this.removeFile(rel);
    const st = fs.statSync(absPath);
    if (!st.isFile()) return;
    this.indexFile(rel, fs.readFileSync(absPath, "utf8"), st.mtimeMs, st.size);
  }

  private indexFile(rel: string, text: string, mtime: number, size: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunks WHERE path = ?").run(rel);
      const insert = this.db.prepare("INSERT INTO chunks (path, heading, body) VALUES (?, ?, ?)");
      for (const c of chunkMarkdown(text)) insert.run(rel, c.heading, c.body);
      this.db
        .prepare("INSERT INTO files (path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size")
        .run(rel, mtime, size);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private removeFile(rel: string): void {
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(rel);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(rel);
  }

  search(query: string, limit = 5): SearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT path, heading, snippet(chunks, 2, '', '', ' … ', 40) AS snippet
         FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks, 0.0, 4.0, 1.0) LIMIT ?`,
      )
      .all(match, limit) as any[];
    return rows.map((r) => ({ path: r.path, heading: r.heading, snippet: String(r.snippet).replace(/\s+/g, " ").trim() }));
  }

  stats(): { files: number; chunks: number } {
    const files = (this.db.prepare("SELECT count(*) AS n FROM files").get() as any).n as number;
    const chunks = (this.db.prepare("SELECT count(*) AS n FROM chunks").get() as any).n as number;
    return { files, chunks };
  }

  close(): void {
    this.db.close();
  }
}

/** Any-word match on quoted terms, so user text can never be parsed as FTS5 syntax. */
function toMatchQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" OR ");
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(abs);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) yield abs;
  }
}

/** Split a note at headings so a hit points at a section, not a whole file. */
export function chunkMarkdown(text: string): { heading: string; body: string }[] {
  const chunks: { heading: string; body: string }[] = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body || heading) chunks.push({ heading, body });
    lines = [];
  };
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] ?? "").trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return chunks;
}
