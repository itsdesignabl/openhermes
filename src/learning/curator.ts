import fs from "node:fs";
import path from "node:path";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import type { Provider } from "../provider/openai.js";
import { writeAtomic } from "../tools/builtin.js";
import { parseNote } from "../vault/frontmatter.js";
import { looksLikeSecret, memoryLimit } from "./proposals.js";

export interface CuratorReport {
  actions: string[];
  changed: string[];
}

interface Usage {
  [skill: string]: { uses: number; last_used: string };
}

export function usageFile(home: Home): string {
  return path.join(home.data, "learning", "skill-usage.json");
}

export function readUsage(home: Home): Usage {
  try {
    return JSON.parse(fs.readFileSync(usageFile(home), "utf8")) as Usage;
  } catch {
    return {};
  }
}

export function recordSkillUse(home: Home, skill: string): void {
  const usage = readUsage(home);
  usage[skill] = { uses: (usage[skill]?.uses ?? 0) + 1, last_used: new Date().toISOString() };
  fs.mkdirSync(path.dirname(usageFile(home)), { recursive: true });
  fs.writeFileSync(usageFile(home), JSON.stringify(usage, null, 2));
}

/** Removes list items that repeat an earlier item word for word (ignoring case and punctuation). */
export function dropDuplicateLines(text: string): { text: string; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const lines = text.split("\n").filter((line) => {
    const m = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!m) return true;
    const key = m[1]!.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key) return true;
    if (seen.has(key)) {
      removed++;
      return false;
    }
    seen.add(key);
    return true;
  });
  return { text: lines.join("\n"), removed };
}

const CONSOLIDATE = `You tidy a personal assistant's memory file. Rewrite the list below so that it is shorter and loses no fact:
- merge entries that say the same thing
- when two entries conflict, keep the later one (later entries are lower in the list)
- keep every name, number and date exactly
- one short sentence per entry, each starting with "- "
Reply with the list only.`;

/**
 * Asks the model to merge a memory file that is close to its size limit.
 * The result is used only if it is a clean, shorter list; otherwise the file is left alone.
 */
export async function consolidateMemory(provider: Provider, file: string, limit: number): Promise<string | null> {
  const original = fs.readFileSync(file, "utf8");
  const firstItem = original.search(/^[ \t]*[-*+]\s+/m);
  if (firstItem < 0) return null;
  const head = original.slice(0, firstItem);
  const list = original.slice(firstItem);
  const result = await provider.chat([{ role: "system", content: CONSOLIDATE }, { role: "user", content: list }], []);
  const items = result.content
    .split("\n")
    .map((l) => /^\s*[-*+]\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => !!l && !looksLikeSecret(l));
  if (items.length === 0) return null;
  const next = head + items.map((i) => `- ${i}`).join("\n") + "\n";
  // must be a real reduction, must fit, and must not have thrown most of the content away
  if (next.length >= original.length || next.length > limit || next.length < list.length * 0.25) return null;
  writeAtomic(file, next);
  return `merged ${path.basename(file)} from ${original.length} to ${next.length} characters`;
}

/** Housekeeping for memory and skills. Deterministic steps always run; the model is used only to merge a nearly full memory file. */
export async function curate(home: Home, config: Config, getProvider: () => Promise<Provider>, now = new Date()): Promise<CuratorReport> {
  const report: CuratorReport = { actions: [], changed: [] };

  for (const target of ["memory", "user"] as const) {
    const file = path.join(home.vault, "Memory", target === "memory" ? "MEMORY.md" : "USER.md");
    if (!fs.existsSync(file)) continue;
    const deduped = dropDuplicateLines(fs.readFileSync(file, "utf8"));
    if (deduped.removed) {
      writeAtomic(file, deduped.text);
      report.actions.push(`removed ${deduped.removed} repeated entr${deduped.removed === 1 ? "y" : "ies"} from ${path.basename(file)}`);
      report.changed.push(file);
    }
    const limit = memoryLimit(config, target);
    if (fs.statSync(file).size > limit * 0.8) {
      try {
        const action = await consolidateMemory(await getProvider(), file, limit);
        if (action) {
          report.actions.push(action);
          report.changed.push(file);
        } else report.actions.push(`${path.basename(file)} is nearly full and could not be merged automatically; edit it by hand`);
      } catch (err) {
        report.actions.push(`could not merge ${path.basename(file)}: ${(err as Error).message}`);
      }
    }
  }

  const days = config.learning.archive_unused_days;
  const skillsDir = path.join(home.vault, "Skills");
  if (days > 0 && fs.existsSync(skillsDir)) {
    const usage = readUsage(home);
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const file = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const { data } = parseNote<Record<string, any>>(fs.readFileSync(file, "utf8"));
      // only skills the agent wrote itself are ever archived; yours are left alone
      if (data.provenance?.source !== "self") continue;
      const lastTouched = Math.max(
        Date.parse(usage[entry.name]?.last_used ?? "") || 0,
        Date.parse(String(data.provenance?.updated ?? "")) || 0,
        Date.parse(String(data.provenance?.created ?? "")) || 0,
      );
      if (!lastTouched || now.getTime() - lastTouched < days * 86_400_000) continue;
      const archive = path.join(skillsDir, "_archive");
      fs.mkdirSync(archive, { recursive: true });
      let dest = path.join(archive, entry.name);
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(archive, `${entry.name}-${i}`);
      fs.renameSync(path.join(skillsDir, entry.name), dest);
      report.actions.push(`archived the unused skill '${entry.name}'`);
      report.changed.push(file, path.join(dest, "SKILL.md"));
    }
  }
  return report;
}
