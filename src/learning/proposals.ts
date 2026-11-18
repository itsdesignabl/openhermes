import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config, PolicyAction } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import { writeAtomic } from "../tools/builtin.js";
import { formatNote, parseNote } from "../vault/frontmatter.js";

const Target = z.enum(["memory", "user"]);

export const ProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory.add"), target: Target, text: z.string().min(3).max(600) }),
  z.object({ kind: z.literal("memory.replace"), target: Target, old_text: z.string().min(3), new_text: z.string().max(600) }),
  z.object({ kind: z.literal("entity.note"), name: z.string().min(1).max(80), text: z.string().min(3).max(600) }),
  z.object({
    kind: z.literal("skill.create"),
    name: z.string().min(2).max(64),
    description: z.string().min(5).max(300),
    body: z.string().min(20).max(20_000),
  }),
  z.object({ kind: z.literal("skill.patch"), name: z.string().min(2).max(64), old_text: z.string().min(3), new_text: z.string().max(20_000) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalOrigin {
  agent: string;
  /** Vault-relative path of the session note the proposal came from. */
  session: string;
}

export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

const EXEC_LANGS = /^(sh|bash|zsh|shell|console|powershell|pwsh|ps1|cmd|bat|batch|python|py|js|javascript|ts|node|ruby|perl)?$/i;

/** A skill "has executable steps" when it carries code blocks to run or tells the agent to run commands. */
export function hasExecutableSteps(body: string): boolean {
  if (/\brun_command\b/.test(body)) return true;
  let open = false;
  for (const m of body.matchAll(/^(?:```|~~~)[ \t]*([\w+-]*)[ \t]*$/gm)) {
    // fence lines alternate between opening and closing a block; only an opening one names a language
    open = !open;
    if (open && EXEC_LANGS.test(m[1] ?? "")) return true;
  }
  return false;
}

/** Text that looks like a credential is never written to memory. */
export function looksLikeSecret(text: string): boolean {
  return (
    /\b(pass(word|phrase)?|api[ _-]?key|secret|token|pin)\b\s*(is|=|:)\s*\S+/i.test(text) ||
    /\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  );
}

export function bodyHash(body: string): string {
  return crypto.createHash("sha256").update(body.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

export function describe(p: Proposal): string {
  switch (p.kind) {
    case "memory.add":
      return `Remember (${p.target}): ${p.text}`;
    case "memory.replace":
      return p.new_text ? `Update memory (${p.target}): "${short(p.old_text)}" → "${short(p.new_text)}"` : `Forget (${p.target}): "${short(p.old_text)}"`;
    case "entity.note":
      return `Note about ${p.name}: ${p.text}`;
    case "skill.create":
      return `New skill '${skillSlug(p.name)}': ${p.description}`;
    case "skill.patch":
      return `Improve skill '${skillSlug(p.name)}'`;
  }
}

const short = (s: string) => (s.length > 70 ? s.slice(0, 70) + "…" : s);

/** Which approval rule governs this proposal. */
export function policyActionFor(home: Home, p: Proposal): PolicyAction {
  if (p.kind === "skill.create") return hasExecutableSteps(p.body) ? "skill.edit_executable" : "skill.edit";
  if (p.kind === "skill.patch") {
    const file = skillFile(home, p.name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return hasExecutableSteps(p.new_text) || hasExecutableSteps(current) ? "skill.edit_executable" : "skill.edit";
  }
  return "memory.edit";
}

export function skillFile(home: Home, name: string): string {
  return path.join(home.vault, "Skills", skillSlug(name), "SKILL.md");
}

function memoryFile(home: Home, target: "memory" | "user"): string {
  return path.join(home.vault, "Memory", target === "memory" ? "MEMORY.md" : "USER.md");
}

export function memoryLimit(config: Config, target: "memory" | "user"): number {
  return target === "memory" ? config.memory.memory_max_chars : config.memory.user_max_chars;
}

export class ProposalError extends Error {}

/**
 * Carries out a proposal. Returns the files it changed.
 * Throws ProposalError with a plain reason when it cannot be applied (duplicate, text not found, over the limit).
 */
export function applyProposal(home: Home, config: Config, p: Proposal, origin: ProposalOrigin, approvedBy: "policy" | "user"): string[] {
  switch (p.kind) {
    case "memory.add": {
      if (looksLikeSecret(p.text)) throw new ProposalError("it looks like a password or key, which is never stored in memory");
      const file = memoryFile(home, p.target);
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const entry = p.text.replace(/\s+/g, " ").trim();
      if (normalized(current).includes(normalized(entry))) throw new ProposalError("already in memory");
      const next = current.replace(/\s*$/, "\n") + `- ${entry}\n`;
      if (next.length > memoryLimit(config, p.target)) throw new ProposalError("memory is full");
      writeAtomic(file, next);
      return [file];
    }
    case "memory.replace": {
      if (looksLikeSecret(p.new_text)) throw new ProposalError("it looks like a password or key, which is never stored in memory");
      const file = memoryFile(home, p.target);
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (current.split(p.old_text).length !== 2) throw new ProposalError("the text to change was not found exactly once");
      let next: string;
      if (p.new_text.trim()) next = current.replace(p.old_text, () => p.new_text.replace(/\s+/g, " ").trim());
      else {
        // removing: drop the whole list item when the text is all there is on its line
        const line = current.split("\n").find((l) => l.includes(p.old_text))!;
        next = line.replace(/^\s*[-*+]\s*/, "").trim() === p.old_text.trim() ? current.replace(line + "\n", "") : current.replace(p.old_text, "");
      }
      if (next.length > memoryLimit(config, p.target)) throw new ProposalError("memory is full");
      writeAtomic(file, next);
      return [file];
    }
    case "entity.note": {
      if (looksLikeSecret(p.text)) throw new ProposalError("it looks like a password or key, which is never stored in memory");
      const name = safeFileName(p.name);
      if (!name) throw new ProposalError("the name is not usable as a file name");
      const file = home.resolveInside(path.join("Memory", "Entities", `${name}.md`));
      const entry = p.text.replace(/\s+/g, " ").trim();
      if (!fs.existsSync(file)) {
        writeAtomic(file, `# ${name}\n\n- ${entry}\n`);
        return [file];
      }
      const current = fs.readFileSync(file, "utf8");
      if (normalized(current).includes(normalized(entry))) throw new ProposalError("already noted");
      writeAtomic(file, current.replace(/\s*$/, "\n") + `- ${entry}\n`);
      return [file];
    }
    case "skill.create": {
      const slug = skillSlug(p.name);
      if (!slug || slug.startsWith("_")) throw new ProposalError("the skill name is not usable");
      const file = skillFile(home, slug);
      home.resolveInside(file);
      if (fs.existsSync(file)) throw new ProposalError(`a skill named '${slug}' already exists`);
      const body = p.body.trim() + "\n";
      const now = new Date().toISOString();
      writeAtomic(
        file,
        formatNote(
          {
            name: slug,
            description: p.description.replace(/\s+/g, " ").trim(),
            trust: "trusted",
            provenance: { source: "self", agent: origin.agent, session: origin.session, approved_by: approvedBy, created: now, updated: now, hash: bodyHash(body) },
          },
          body,
        ),
      );
      return [file];
    }
    case "skill.patch": {
      const file = skillFile(home, p.name);
      if (!fs.existsSync(file)) throw new ProposalError(`there is no skill named '${skillSlug(p.name)}'`);
      const note = parseNote<Record<string, any>>(fs.readFileSync(file, "utf8"));
      if (note.body.split(p.old_text).length !== 2) throw new ProposalError("the text to change was not found exactly once in the skill");
      const body = note.body.replace(p.old_text, () => p.new_text);
      const provenance = { source: "user", ...(note.data.provenance ?? {}) };
      provenance.updated = new Date().toISOString();
      provenance.updated_by = origin.agent;
      provenance.hash = bodyHash(body);
      writeAtomic(file, formatNote({ ...note.data, provenance }, body));
      return [file];
    }
  }
}

function normalized(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Called when the agent writes a SKILL.md itself during a conversation: records where it came from.
 * A skill the user wrote by hand keeps `source: user`.
 */
export function stampSkill(file: string, origin: ProposalOrigin): void {
  const text = fs.readFileSync(file, "utf8");
  const note = parseNote<Record<string, any>>(text);
  const now = new Date().toISOString();
  const prev = note.data.provenance as Record<string, unknown> | undefined;
  const hash = bodyHash(note.body);
  if (prev?.hash === hash) return;
  const provenance = prev
    ? { ...prev, updated: now, updated_by: origin.agent, hash }
    : { source: "self", agent: origin.agent, session: origin.session, approved_by: "policy", created: now, updated: now, hash };
  const data = { name: path.basename(path.dirname(file)), description: "", trust: "trusted", ...note.data, provenance };
  fs.writeFileSync(file, formatNote(data, note.body));
}
