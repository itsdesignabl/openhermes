import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PolicyAction } from "../kernel/config.js";
import { mentionsControlFiles } from "../kernel/guard.js";
import { ContainmentError } from "../kernel/home.js";
import { effectiveTrust } from "../learning/scanner.js";
import { formatNote } from "../vault/frontmatter.js";
import { defineTool, type Tool, type ToolContext } from "./types.js";

const MAX_READ = 60_000;

/** Atomic write: a reader (Obsidian, sync) never sees a half-written file. */
export function writeAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Which policy governs a write to this path. */
function writeAction(ctx: ToolContext, abs: string): PolicyAction | null {
  const rel = path.relative(ctx.home.vault, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null; // workspace/ and other home areas: no approval needed
  if (rel.startsWith("Memory/")) return "memory.edit";
  if (rel.startsWith("Skills/")) {
    const skillDir = path.join(ctx.home.vault, "Skills", rel.split("/")[1] ?? "");
    const isScript = !rel.toLowerCase().endsWith(".md");
    return isScript || hasScripts(skillDir) ? "skill.edit_executable" : "skill.edit";
  }
  return "vault.write";
}

function hasScripts(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { recursive: true }).some((f) => !String(f).toLowerCase().endsWith(".md") && fs.statSync(path.join(dir, String(f))).isFile());
}

/**
 * The agent may write only to the vault and the workspace, and never to the files that control it:
 * settings and policies (System/), per-agent settings (agent.md), the Inbox, or the vault history.
 */
function protectSystem(ctx: ToolContext, abs: string): void {
  const rel = path.relative(ctx.home.root, abs).split(path.sep).join("/");
  const lower = rel.toLowerCase();
  const writable = lower.startsWith("vault/") || lower.startsWith("workspace/");
  const controlled =
    lower.startsWith("vault/system/") || lower.startsWith("vault/inbox/") || lower.startsWith("vault/.git/") || lower.startsWith("vault/.obsidian/") ||
    /^vault\/agents\/[^/]+\/agent\.md$/.test(lower);
  if (!writable || controlled) {
    throw new Error(`The agent may not change ${rel}. Ask the user to edit it.`);
  }
}

const readFile = defineTool({
  name: "read_file",
  description:
    "Read a text file inside the home folder. Paths are relative to the vault (e.g. 'Memory/MEMORY.md') or start with 'workspace/'. Files outside the home folder must be imported first with import_file.",
  schema: z.object({ path: z.string() }),
  async run({ path: p }, ctx) {
    const abs = resolveUserPath(ctx, p);
    if (ctx.home.display(abs).startsWith("secrets/")) throw new Error("Secrets cannot be read.");
    if (!fs.existsSync(abs)) throw new Error(`No such file: ${p}`);
    if (fs.statSync(abs).isDirectory()) throw new Error(`${p} is a folder. Use list_files.`);
    const text = fs.readFileSync(abs, "utf8");
    ctx.read?.(abs);
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n\n[truncated: file is ${text.length} characters]` : text;
  },
});

const listFiles = defineTool({
  name: "list_files",
  description: "List files and folders inside the home folder. Path is relative to the vault; use '.' for the vault root or 'workspace/' for the scratch area.",
  schema: z.object({ path: z.string().default(".") }),
  async run({ path: p }, ctx) {
    const abs = resolveUserPath(ctx, p);
    if (!fs.existsSync(abs)) throw new Error(`No such folder: ${p}`);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort();
    return entries.length ? entries.join("\n") : "(empty)";
  },
});

const writeFile = defineTool({
  name: "write_file",
  description: "Create or overwrite a file inside the home folder. Paths are relative to the vault, or start with 'workspace/'. Parent folders are created.",
  schema: z.object({ path: z.string(), content: z.string() }),
  async run({ path: p, content }, ctx) {
    const abs = resolveUserPath(ctx, p);
    protectSystem(ctx, abs);
    const action = writeAction(ctx, abs);
    if (action) await ctx.policy.check(action, `write ${ctx.home.display(abs)}`);
    writeAtomic(abs, content);
    ctx.wrote(abs);
    return `Wrote ${ctx.home.display(abs)} (${content.length} characters).`;
  },
});

const editFile = defineTool({
  name: "edit_file",
  description: "Replace one exact piece of text in a file inside the home folder. old_text must appear exactly once.",
  schema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
  async run({ path: p, old_text, new_text }, ctx) {
    const abs = resolveUserPath(ctx, p);
    protectSystem(ctx, abs);
    if (!fs.existsSync(abs)) throw new Error(`No such file: ${p}`);
    const find = () => {
      const text = fs.readFileSync(abs, "utf8");
      const count = text.split(old_text).length - 1;
      if (count === 0) throw new Error("old_text was not found in the file. Read the file again and copy the text exactly.");
      if (count > 1) throw new Error(`old_text appears ${count} times. Include more surrounding text so it is unique.`);
      return text;
    };
    find(); // fail early, before asking anyone for approval
    const action = writeAction(ctx, abs);
    if (action) await ctx.policy.check(action, `edit ${ctx.home.display(abs)}`);
    // Read again at the moment of writing: while approval was pending, the user or another
    // conversation may have changed the file, and that change must not be overwritten.
    writeAtomic(abs, find().replace(old_text, () => new_text));
    ctx.wrote(abs);
    return `Edited ${ctx.home.display(abs)}.`;
  },
});

const memorySearch = defineTool({
  name: "memory_search",
  description: "Search all notes, memory and past sessions in the vault. Returns the best matching sections with their file paths.",
  schema: z.object({ query: z.string().min(1) }),
  async run({ query }, ctx) {
    const hits = ctx.memory.search(query, ctx.config().memory.search_results);
    if (!hits.length) return "No matches.";
    return hits.map((h) => `${h.path}${h.heading ? ` › ${h.heading}` : ""}\n  ${h.snippet}`).join("\n");
  },
});

const memoryAdd = defineTool({
  name: "memory_add",
  description:
    "Save a short durable fact. target 'memory' is for facts about the world, projects and how to do things; 'user' is for facts about the user; 'daily' appends to today's log (unlimited).",
  schema: z.object({ target: z.enum(["memory", "user", "daily"]), text: z.string().min(1).max(600) }),
  async run({ target, text }, ctx) {
    await ctx.policy.check("memory.edit", `remember (${target}): ${text}`);
    const cfg = ctx.config().memory;
    const today = new Date().toISOString().slice(0, 10);
    const file =
      target === "memory"
        ? path.join(ctx.home.vault, "Memory", "MEMORY.md")
        : target === "user"
          ? path.join(ctx.home.vault, "Memory", "USER.md")
          : path.join(ctx.home.vault, "Memory", "Daily", `${today}.md`);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : target === "daily" ? `# ${today}\n` : "";
    const entry = target === "daily" ? `- ${new Date().toTimeString().slice(0, 5)} ${text.trim()}` : `- ${text.trim()}`;
    const next = current.replace(/\s*$/, "\n") + entry + "\n";
    const limit = target === "memory" ? cfg.memory_max_chars : target === "user" ? cfg.user_max_chars : Infinity;
    if (next.length > limit) {
      throw new Error(
        `${ctx.home.display(file)} would exceed its limit of ${limit} characters. Merge or remove older entries with edit_file first, then try again.`,
      );
    }
    writeAtomic(file, next);
    ctx.wrote(file);
    return `Saved to ${ctx.home.display(file)}.`;
  },
});

const importFile = defineTool({
  name: "import_file",
  description:
    "Copy a file or folder from anywhere on the machine into the vault's Imports folder so it can be read. The original is never changed. Returns the new path.",
  schema: z.object({ source: z.string().describe("Absolute path outside the home folder") }),
  async run({ source }, ctx) {
    const src = path.resolve(source);
    if (ctx.home.isInside(src)) return `${ctx.home.display(src)} is already inside the home folder. Read it directly.`;
    if (!fs.existsSync(src)) throw new Error(`No such file or folder: ${source}`);
    const named = ctx.userText.toLowerCase().includes(source.toLowerCase()) || ctx.userText.toLowerCase().includes(src.toLowerCase());
    await ctx.policy.check(named ? "import.user" : "import.agent", `copy ${src} into the vault`);

    const { bytes, files } = measure(src);
    if (bytes > 200 * 1024 * 1024 || files > 5000) {
      throw new Error(`Too large to import (${files} files, ${Math.round(bytes / 1e6)} MB). Import a smaller folder or single files.`);
    }
    const importsDir = path.join(ctx.home.vault, "Imports");
    let dest = path.join(importsDir, path.basename(src));
    for (let i = 2; fs.existsSync(dest); i++) {
      const ext = path.extname(src);
      dest = path.join(importsDir, `${path.basename(src, ext)}-${i}${ext}`);
    }
    ctx.home.resolveInside(dest);
    fs.mkdirSync(importsDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (s) => !fs.lstatSync(s).isSymbolicLink() });
    const note = `${dest}.source.md`;
    writeAtomic(
      note,
      formatNote(
        { imported_from: src, imported_at: new Date().toISOString(), files, bytes },
        `Copy of \`${src}\`. The original was not changed and later changes to it are not reflected here.\n`,
      ),
    );
    ctx.wrote(dest);
    ctx.wrote(note);
    return `Imported to ${ctx.home.display(dest)} (${files} file${files === 1 ? "" : "s"}). Read it with read_file or list_files using the path '${path.relative(ctx.home.vault, dest).split(path.sep).join("/")}'.`;
  },
});

function measure(p: string): { bytes: number; files: number } {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      const m = measure(path.join(p, e));
      bytes += m.bytes;
      files += m.files;
      if (files > 5000) break;
    }
  }
  return { bytes, files };
}

/** A skill that has not been approved may be read, but nothing from its folder may be run. */
function unapprovedSkillIn(ctx: ToolContext, command: string): string | null {
  const dir = path.join(ctx.home.vault, "Skills");
  if (!fs.existsSync(dir)) return null;
  const text = command.replace(/\\/g, "/").toLowerCase();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !text.includes(`skills/${entry.name.toLowerCase()}`)) continue;
    if (effectiveTrust(path.join(dir, entry.name, "SKILL.md")) !== "trusted") return entry.name;
  }
  return null;
}

const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a shell command. It starts in the workspace folder. Use it for scripts and programs; use the file tools for reading and writing files.",
  schema: z.object({ command: z.string().min(1), timeout_s: z.number().min(1).max(600).default(60) }),
  async run({ command, timeout_s }, ctx) {
    const blocked = unapprovedSkillIn(ctx, command);
    if (blocked) throw new Error(`The skill '${blocked}' has not been approved by the user, so nothing from its folder may be run. Tell the user; they can approve it with: openhermes skills trust ${blocked}`);
    const action: PolicyAction = ctx.policy.isAllowlisted(command) ? "command.allowlisted" : ctx.backend.sandboxed ? "command.sandboxed" : "command.other";
    const label = `run${ctx.backend.name === "local" ? "" : ` (${ctx.backend.name})`}: ${command}`;
    if (!ctx.backend.vaultWritable) {
      await ctx.policy.check(action, label, command);
      const result = await ctx.backend.run(command, timeout_s);
      return `exit code ${result.code ?? "none"}\n${result.output || "(no output)"}`;
    }
    // The command can reach the vault. One that names the agent's own settings, approvals or keys is
    // always shown to the user first, whatever the policy or allowlist says.
    if (mentionsControlFiles(ctx.home, command)) await ctx.policy.ask(action, `${label}\n(This command refers to the agent's own settings, approvals or keys.)`);
    else await ctx.policy.check(action, label, command);
    // Whatever it names, its effect on those files is undone.
    const { result, restored } = await ctx.guard.run(() => ctx.backend.run(command, timeout_s));
    const note = restored.length
      ? `\n\nThe command changed files that control the agent (${restored.join(", ")}). Those changes were undone: only the user can change them.`
      : "";
    return `exit code ${result.code ?? "none"}\n${result.output || "(no output)"}${note}`;
  },
});

/** Model-facing paths: relative to the vault, or prefixed with workspace/. Absolute paths must still be inside the home. */
function resolveUserPath(ctx: ToolContext, p: string): string {
  const norm = p.replace(/\\/g, "/");
  try {
    if (norm === "workspace" || norm.startsWith("workspace/")) return ctx.home.resolveInside(norm, ctx.home.root);
    if (norm === "vault" || norm.startsWith("vault/")) return ctx.home.resolveInside(norm, ctx.home.root);
    return ctx.home.resolveInside(p, ctx.home.vault);
  } catch (err) {
    if (err instanceof ContainmentError) {
      throw new Error(`${p} is outside the home folder. Use import_file to copy it in, then work on the copy.`);
    }
    throw err;
  }
}

export const builtinTools: Tool<any>[] = [readFile, listFiles, writeFile, editFile, memorySearch, memoryAdd, importFile, runCommand];
