import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heartbeatIsEmpty } from "../gateway/scheduler.js";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import { looksLikeSecret } from "../learning/proposals.js";
import { importSkills } from "../learning/skills.js";
import { writeAtomic } from "../tools/builtin.js";
import { formatNote } from "../vault/frontmatter.js";
import { STARTER_NOTES } from "../vault/layout.js";

export type SourceKind = "openclaw" | "hermes";

export interface Step {
  /** "done": imported. "manual": kept for you to merge by hand. "skipped": deliberately not imported. */
  status: "done" | "manual" | "skipped";
  what: string;
  detail: string;
}

export interface ImportReport {
  kind: SourceKind;
  source: string;
  archive: string;
  dryRun: boolean;
  steps: Step[];
}

const NAMES: Record<SourceKind, string> = { openclaw: "OpenClaw", hermes: "Hermes Agent" };

export function defaultSource(kind: SourceKind): string | null {
  const candidates = kind === "openclaw" ? [".openclaw", ".clawdbot", ".moltbot"] : [".hermes"];
  for (const c of candidates) {
    const dir = path.join(os.homedir(), c);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** First existing file among the candidates, matched without regard to letter case. */
function find(dirs: string[], names: string[]): string | null {
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const entries = fs.readdirSync(dir);
    for (const name of names) {
      const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
      if (hit && fs.statSync(path.join(dir, hit)).isFile()) return path.join(dir, hit);
    }
  }
  return null;
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * Splits a memory file into single facts. Understands list items, entries separated by a line
 * holding only "§" (Hermes), and plain paragraphs.
 */
export function parseMemoryEntries(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  let chunks: string[];
  if (/^\s*§\s*$/m.test(body)) chunks = body.split(/^\s*§\s*$/m);
  else if (/^\s*[-*+]\s+\S/m.test(body)) {
    chunks = [];
    for (const line of body.split("\n")) {
      const item = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (item) chunks.push(item[1]!);
      else if (/^\s{2,}\S/.test(line) && chunks.length) chunks[chunks.length - 1] += " " + line.trim(); // continuation of the item above
    }
  } else chunks = body.split(/\n\s*\n/);
  return chunks
    .map((c) => c.split("\n").filter((l) => !/^\s*#/.test(l)).join(" ").replace(/\s+/g, " ").trim())
    .filter((c) => c.length >= 3);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

interface Merge {
  added: string[];
  duplicates: number;
  secrets: number;
  overflow: string[];
}

/** Decides what happens to each imported fact given the memory file as it is now and its size limit. */
export function planMemoryMerge(current: string, entries: string[], limit: number): Merge {
  const m: Merge = { added: [], duplicates: 0, secrets: 0, overflow: [] };
  let size = current.replace(/\s*$/, "\n").length;
  const have = norm(current);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = norm(e);
    if (looksLikeSecret(e)) m.secrets++;
    else if (!key || have.includes(key) || seen.has(key)) m.duplicates++;
    else if (e.length > 600 || size + e.length + 3 > limit) {
      m.overflow.push(e);
      seen.add(key);
    } else {
      m.added.push(e);
      seen.add(key);
      size += e.length + 3;
    }
  }
  return m;
}

function skillFolders(root: string, depth = 4): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  if (fs.existsSync(path.join(root, "SKILL.md"))) return [root];
  if (depth === 0) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => skillFolders(path.join(root, e.name), depth - 1));
}

/**
 * Brings an OpenClaw or Hermes Agent setup into the vault. Nothing in the source is changed.
 * Persona and memory are adopted where that is safe; rules written for the other program's tools,
 * and anything that would overwrite your own edits, are kept in Imports for you to merge by hand.
 * API keys, tokens and settings are never imported.
 */
export function importAgent(home: Home, config: Config, kind: SourceKind, sourceDir: string, opts: { agent?: string; dryRun?: boolean } = {}): ImportReport {
  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`${sourceDir} is not a folder.`);
  if (home.isInside(source)) throw new Error("The source is inside the OpenHermes home folder. Point at the other program's folder.");
  const agent = opts.agent ?? config.agent;
  const dry = !!opts.dryRun;
  const product = NAMES[kind];
  const steps: Step[] = [];
  const add = (status: Step["status"], what: string, detail: string) => void steps.push({ status, what, detail });

  const roots = kind === "openclaw" ? [path.join(source, "workspace"), source] : [source, path.join(source, "memories"), path.join(source, "workspace")];
  const memoryRoots = kind === "hermes" ? [path.join(source, "memories"), source] : roots;

  let archive = path.join(home.vault, "Imports", kind);
  for (let i = 2; fs.existsSync(archive); i++) archive = path.join(home.vault, "Imports", `${kind}-${i}`);
  const archiveRel = home.display(archive).replace(/^vault\//, "");
  const keep = (file: string, as = path.basename(file)) => {
    if (dry || fs.statSync(file).size > 1024 * 1024) return;
    fs.mkdirSync(path.dirname(path.join(archive, as)), { recursive: true });
    fs.copyFileSync(file, path.join(archive, as));
  };

  const agentDir = path.join(home.vault, "Agents", agent);
  const untouched = (file: string, starter: string) => !fs.existsSync(file) || readText(file).trim() === STARTER_NOTES[starter]!.trim();

  // Personality
  const soul = find(roots, ["SOUL.md"]);
  const identity = find(roots, ["IDENTITY.md"]);
  if (soul) {
    keep(soul);
    if (identity) keep(identity);
    const target = path.join(agentDir, "SOUL.md");
    if (untouched(target, "Agents/main/SOUL.md")) {
      const text = readText(soul).trim() + (identity ? `\n\n## Identity\n\n${readText(identity).replace(/^#\s+.*\n/, "").trim()}` : "") + "\n";
      if (!dry) writeAtomic(target, text);
      add("done", "Personality", `SOUL.md${identity ? " and IDENTITY.md" : ""} → Agents/${agent}/SOUL.md`);
    } else add("manual", "Personality", `You have already edited Agents/${agent}/SOUL.md, so it was left alone. The imported one is in ${archiveRel}/SOUL.md.`);
  }

  // Rules written for the other program
  for (const name of ["AGENTS.md", "TOOLS.md", "BOOT.md", "BOOTSTRAP.md"]) {
    const file = find(roots, [name]);
    if (!file) continue;
    keep(file);
    add("manual", name, `Written for ${product}'s tools, so it was not adopted. Copy the rules you still want from ${archiveRel}/${name} into Agents/${agent}/AGENTS.md.`);
  }

  // Heartbeat checklist
  const heartbeat = find(roots, ["HEARTBEAT.md"]);
  if (heartbeat) {
    keep(heartbeat);
    const target = path.join(agentDir, "HEARTBEAT.md");
    if (heartbeatIsEmpty(readText(heartbeat))) add("skipped", "Heartbeat", "The checklist is empty.");
    else if (!fs.existsSync(target) || heartbeatIsEmpty(readText(target))) {
      if (!dry) writeAtomic(target, readText(heartbeat));
      add("done", "Heartbeat", `HEARTBEAT.md → Agents/${agent}/HEARTBEAT.md`);
    } else add("manual", "Heartbeat", `Your checklist already has items. The imported one is in ${archiveRel}/HEARTBEAT.md.`);
  }

  // Long-term memory
  const overflow: string[] = [];
  for (const [name, target, limit] of [
    ["MEMORY.md", "MEMORY.md", config.memory.memory_max_chars],
    ["USER.md", "USER.md", config.memory.user_max_chars],
  ] as const) {
    const file = find(memoryRoots, [name]);
    if (!file) continue;
    keep(file);
    const dest = path.join(home.vault, "Memory", target);
    const current = fs.existsSync(dest) ? readText(dest) : "";
    const merge = planMemoryMerge(current, parseMemoryEntries(readText(file)), limit);
    if (merge.added.length && !dry) writeAtomic(dest, current.replace(/\s*$/, "\n") + merge.added.map((e) => `- ${e}`).join("\n") + "\n");
    if (merge.overflow.length) overflow.push(`## From ${name}\n\n${merge.overflow.map((e) => `- ${e}`).join("\n")}`);
    const parts = [`${merge.added.length} added to Memory/${target}`];
    if (merge.duplicates) parts.push(`${merge.duplicates} already known`);
    if (merge.overflow.length) parts.push(`${merge.overflow.length} did not fit the size limit`);
    if (merge.secrets) parts.push(`${merge.secrets} left out because they look like passwords or keys`);
    add(merge.added.length || !merge.overflow.length ? "done" : "manual", name, parts.join(", ") + ".");
  }
  if (overflow.length) {
    if (!dry) writeAtomic(path.join(archive, "memory-overflow.md"), `# Imported facts that did not fit\n\nThe agent can find these through search, but they are not part of its standing memory. Move the important ones into Memory/MEMORY.md or Memory/USER.md.\n\n${overflow.join("\n\n")}\n`);
    add("manual", "Memory overflow", `Facts that did not fit are in ${archiveRel}/memory-overflow.md. They are searchable; move the important ones into memory by hand.`);
  }

  // Daily notes
  const dailyDir = [path.join(source, "workspace", "memory"), path.join(source, "memory"), path.join(source, "memories")].find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  if (dailyDir) {
    const files = fs.readdirSync(dailyDir).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(f)).slice(0, 5000);
    let copied = 0;
    let appended = 0;
    for (const f of files) {
      const text = readText(path.join(dailyDir, f)).trim();
      if (!text) continue;
      const dest = path.join(home.vault, "Memory", "Daily", f);
      if (!fs.existsSync(dest)) {
        if (!dry) writeAtomic(dest, text + "\n");
        copied++;
      } else if (!readText(dest).includes(text)) {
        if (!dry) fs.appendFileSync(dest, `\n\n## Imported from ${product}\n\n${text}\n`);
        appended++;
      }
    }
    if (files.length) add("done", "Daily notes", `${copied} copied to Memory/Daily${appended ? `, ${appended} added to existing days` : ""}.`);
  }

  // Skills
  const skillRoots = kind === "openclaw" ? [path.join(source, "workspace", "skills"), path.join(source, "skills")] : [path.join(source, "skills")];
  const folders = [...new Set(skillRoots.flatMap((r) => skillFolders(r)))];
  let review = 0;
  let blocked = 0;
  for (const folder of folders) {
    if (dry) {
      review++;
      continue;
    }
    try {
      for (const r of importSkills(home, folder)) {
        if (r.trust === "blocked") {
          blocked++;
          add("manual", `Skill ${r.name}`, `Blocked by the scanner: ${[...new Set(r.findings.filter((f) => f.severity === "block").map((f) => f.rule))].join("; ")}. The agent will not see it.`);
        } else review++;
      }
    } catch (err) {
      add("skipped", `Skill ${path.basename(folder)}`, (err as Error).message);
    }
  }
  if (folders.length) {
    add("done", "Skills", dry ? `${folders.length} would be scanned and imported for review.` : `${review} imported for review${blocked ? `, ${blocked} blocked` : ""}. The agent can read a skill under review but not run anything from it. Approve each with: openhermes skills trust <name>`);
  }

  add("skipped", "Settings, API keys and tokens", `Not imported. Set up the model and channels in System/config.md, and store keys with: openhermes secret set <name>`);

  if (!steps.some((s) => s.status !== "skipped")) throw new Error(`Nothing to import was found in ${source}. Is this a ${product} folder?`);

  const report: ImportReport = { kind, source, archive, dryRun: dry, steps };
  if (!dry) {
    writeAtomic(
      path.join(archive, "README.md"),
      formatNote(
        { imported_from: source, imported_at: new Date().toISOString(), agent },
        `# Import from ${product}\n\nThe original files are kept in this folder. Nothing in \`${source}\` was changed.\n\n| | Item | What happened |\n|---|---|---|\n${steps
          .map((s) => `| ${s.status} | ${s.what} | ${s.detail.replace(/\|/g, "\\|")} |`)
          .join("\n")}\n`,
      ),
    );
  }
  return report;
}

/** Copies an existing notes folder (for example another Obsidian vault) into Imports. The original is not changed. */
export function importVault(home: Home, sourceDir: string): { dest: string; files: number } {
  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`${sourceDir} is not a folder.`);
  if (home.isInside(source)) throw new Error("That folder is already inside the OpenHermes home folder.");
  let dest = path.join(home.vault, "Imports", path.basename(source));
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(home.vault, "Imports", `${path.basename(source)}-${i}`);
  home.resolveInside(dest);
  let files = 0;
  let bytes = 0;
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (s) => {
      const st = fs.lstatSync(s);
      // settings, history and trash of the other vault are not notes; links could point anywhere
      if (st.isSymbolicLink() || (s !== source && path.basename(s).startsWith("."))) return false;
      if (st.isFile()) {
        files++;
        bytes += st.size;
        if (files > 50_000 || bytes > 2 * 1024 ** 3) throw new Error("The folder is larger than 50,000 files or 2 GB. Import a part of it.");
      }
      return true;
    },
  });
  writeAtomic(`${dest}.source.md`, formatNote({ imported_from: source, imported_at: new Date().toISOString(), files }, `Copy of \`${source}\`. The original was not changed, and later changes to it do not appear here.\n`));
  return { dest, files };
}
