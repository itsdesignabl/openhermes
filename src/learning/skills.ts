import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";
import { writeAtomic } from "../tools/builtin.js";
import { formatNote, parseNote } from "../vault/frontmatter.js";
import { skillSlug } from "./proposals.js";
import { effectiveTrust, scanSkillDir, skillTreeHash, type Finding, type Trust } from "./scanner.js";

export interface ImportResult {
  name: string;
  trust: Trust;
  findings: Finding[];
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function formatFinding(f: Finding): string {
  return `${f.severity === "block" ? "BLOCK" : "warn "}  ${f.rule}  (${f.file}${f.line ? `:${f.line}` : ""})${f.excerpt ? `\n         ${f.excerpt}` : ""}`;
}

function skillsDir(home: Home): string {
  return path.join(home.vault, "Skills");
}

function setSkillProps(file: string, change: (data: Record<string, any>) => void): void {
  const note = parseNote<Record<string, any>>(fs.readFileSync(file, "utf8"));
  change(note.data);
  writeAtomic(file, formatNote(note.data, note.body));
}

function scanSummary(findings: Finding[]) {
  return {
    scanned: new Date().toISOString(),
    verdict: findings.some((f) => f.severity === "block") ? "blocked" : findings.length ? "warnings" : "clean",
    findings: findings.map((f) => `${f.severity}: ${f.rule} (${f.file}${f.line ? `:${f.line}` : ""})`),
  };
}

/** Folders under `source` that are skills: `source` itself, or its direct children. */
function findSkillFolders(source: string): string[] {
  if (fs.existsSync(path.join(source, "SKILL.md"))) return [source];
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(source, e.name, "SKILL.md")))
    .map((e) => path.join(source, e.name));
}

/**
 * Copies skills from anywhere on the computer into the vault. Every imported skill is checked by the
 * scanner and starts as "review" (readable, not runnable) or "blocked". Nothing from it is executed.
 */
export function importSkills(home: Home, source: string): ImportResult[] {
  const src = path.resolve(source);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`${source} is not a folder.`);
  const folders = findSkillFolders(src);
  if (!folders.length) throw new Error(`No SKILL.md found in ${source} or its subfolders.`);
  const results: ImportResult[] = [];
  for (const folder of folders) {
    const original = parseNote<Record<string, any>>(fs.readFileSync(path.join(folder, "SKILL.md"), "utf8"));
    const base = skillSlug(String(original.data.name ?? path.basename(folder))) || "imported-skill";
    let name = base;
    for (let i = 2; fs.existsSync(path.join(skillsDir(home), name)); i++) name = `${base}-${i}`;
    const dest = home.resolveInside(path.join("Skills", name));

    let bytes = 0;
    fs.cpSync(folder, dest, {
      recursive: true,
      filter: (s) => {
        const st = fs.lstatSync(s);
        if (st.isSymbolicLink()) return false; // links could point outside the home folder
        if (st.isFile()) bytes += st.size;
        if (bytes > MAX_IMPORT_BYTES) throw new Error(`${path.basename(folder)} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB and was not imported.`);
        return true;
      },
    });
    const findings = scanSkillDir(dest);
    const trust: Trust = findings.some((f) => f.severity === "block") ? "blocked" : "review";
    setSkillProps(path.join(dest, "SKILL.md"), (data) => {
      data.name = name;
      data.description = String(data.description ?? "").replace(/\s+/g, " ").trim();
      data.trust = trust;
      data.provenance = { source: "import", imported_from: folder, imported_at: new Date().toISOString(), scan: scanSummary(findings) };
    });
    results.push({ name, trust, findings });
  }
  return results;
}

function requireSkill(home: Home, name: string): string {
  const file = path.join(skillsDir(home), skillSlug(name), "SKILL.md");
  if (!fs.existsSync(file)) throw new Error(`There is no skill named '${name}'. See: openhermes skills`);
  return file;
}

export function rescanSkill(home: Home, name: string): Finding[] {
  const file = requireSkill(home, name);
  const findings = scanSkillDir(path.dirname(file));
  setSkillProps(file, (data) => {
    data.provenance = { source: "user", ...(data.provenance ?? {}), scan: scanSummary(findings) };
    if (findings.some((f) => f.severity === "block")) data.trust = "blocked";
  });
  return findings;
}

/** The user approves a skill as it is now. A skill the scanner blocks needs `force`. */
export function trustSkill(home: Home, name: string, force = false): Finding[] {
  const file = requireSkill(home, name);
  const dir = path.dirname(file);
  const findings = scanSkillDir(dir);
  const blocking = findings.filter((f) => f.severity === "block");
  if (blocking.length && !force) {
    throw new Error(
      `The scanner blocks '${name}':\n${blocking.map(formatFinding).join("\n")}\n\nIf you have read the skill and are sure, approve it anyway with: openhermes skills trust ${name} --force`,
    );
  }
  setSkillProps(file, (data) => {
    data.trust = "trusted";
    data.provenance = { source: "user", ...(data.provenance ?? {}), approved_by: "user", approved_at: new Date().toISOString(), approved_hash: skillTreeHash(dir), scan: scanSummary(findings) };
  });
  return findings;
}

export function blockSkill(home: Home, name: string): void {
  setSkillProps(requireSkill(home, name), (data) => {
    data.trust = "blocked";
  });
}

export function skillTrust(home: Home, name: string): Trust {
  return effectiveTrust(requireSkill(home, name));
}
