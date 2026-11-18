import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseNote } from "../vault/frontmatter.js";

export interface Finding {
  /** "block": the skill must not be used. "warn": worth a look before approving. */
  severity: "block" | "warn";
  rule: string;
  file: string;
  line: number;
  excerpt: string;
}

interface Rule {
  severity: "block" | "warn";
  rule: string;
  pattern: RegExp;
  /** Only in Markdown instructions (true) or everywhere (false). */
  markdownOnly?: boolean;
}

const RULES: Rule[] = [
  { severity: "block", rule: "downloads a program and runs it", pattern: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|iex|invoke-expression)\b/i },
  { severity: "block", rule: "downloads a program and runs it", pattern: /\b(iex|invoke-expression)\b\s*\(?\s*\(?\s*(new-object\s+(system\.)?net\.webclient|iwr|irm|invoke-webrequest|invoke-restmethod)/i },
  { severity: "block", rule: "runs hidden (encoded) commands", pattern: /powershell(\.exe)?\b[^\n]*\s-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i },
  { severity: "block", rule: "runs hidden (encoded) commands", pattern: /base64\s+(-d|-D|--decode)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?)\b/ },
  { severity: "block", rule: "runs hidden (encoded) commands", pattern: /\b(eval|exec)\s*\(\s*(atob|Buffer\.from|base64\.b64decode|bytes\.fromhex|codecs\.decode)\b/ },
  { severity: "block", rule: "opens a remote-control connection", pattern: /\/dev\/tcp\/|\bnc(at)?\b[^\n]*\s(-e|--exec)\s|bash\s+-i\s+>&/ },
  { severity: "block", rule: "reads passwords, keys or browser data", pattern: /(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[\\/]\.(ssh|aws|gnupg|kube|docker)\b|\bid_(rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials|wallet\.dat|(Chrome|Chromium|Edge|Firefox)[^\n]*(Login Data|Cookies|logins\.json)/i },
  { severity: "block", rule: "reads this agent's own keys", pattern: /secrets[\\/]keys\.json|gateway-token/i },
  { severity: "block", rule: "deletes large parts of the disk", pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*)(\s|$)|\bmkfs(\.\w+)?\s|\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)|\bformat\s+[a-z]:|\b(del|rd|rmdir)\s+\/s\b[^\n]*\s[a-z]:\\(\s|$)/i },
  { severity: "block", rule: "tries to change the agent's approval rules", pattern: /System[\\/]policies\.md|command_allowlist/i },
  { severity: "block", rule: "contains instructions aimed at overriding the agent's rules", markdownOnly: true, pattern: /ignore (all |any )?(of )?(the |your )?(previous|prior|above|earlier) (instructions|rules|messages)|disregard (your|the|all) (system prompt|rules|instructions)|do not (tell|inform|mention (this |it )?to|notify) the user|without (telling|asking|informing|notifying) the user/i },
  { severity: "block", rule: "contains invisible characters that can hide text", pattern: /[​-‏‪-‮⁦-⁩]/ },
  { severity: "warn", rule: "uses the network", pattern: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b|\brequests\.(get|post|put)\b|\burllib\.request\b|\bfetch\(\s*["'`]https?:/i },
  { severity: "warn", rule: "asks for administrator rights", pattern: /\bsudo\b|Set-ExecutionPolicy|runas\s+\/user/i },
  { severity: "warn", rule: "reads environment variables", pattern: /\bprintenv\b|\bos\.environ\b|\bprocess\.env\b|\bGet-ChildItem\s+env:/i },
  { severity: "warn", rule: "contains a long encoded block that cannot be read", pattern: /[A-Za-z0-9+/]{240,}={0,2}/ },
];

const EXECUTABLES = new Set([".exe", ".dll", ".so", ".dylib", ".msi", ".scr", ".com", ".jar"]);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 300;

export function scanText(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const isMarkdown = /\.(md|markdown|txt)$/i.test(file);
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const r of RULES) {
      if (r.markdownOnly && !isMarkdown) continue;
      if (!r.pattern.test(line)) continue;
      if (findings.some((f) => f.rule === r.rule && f.file === file)) continue; // one finding per rule per file
      findings.push({ severity: r.severity, rule: r.rule, file, line: i + 1, excerpt: line.trim().replace(/[​-‏‪-‮⁦-⁩]/g, "␣").slice(0, 160) });
    }
  }
  return findings;
}

function* walk(dir: string, base = dir): Generator<{ abs: string; rel: string; link: boolean }> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (entry.isSymbolicLink()) yield { abs, rel, link: true };
    else if (entry.isDirectory()) yield* walk(abs, base);
    else if (entry.isFile()) yield { abs, rel, link: false };
  }
}

/** Looks through every file of a skill for things an imported skill should not do. Reads only; runs nothing. */
export function scanSkillDir(dir: string): Finding[] {
  const findings: Finding[] = [];
  let count = 0;
  for (const f of walk(dir)) {
    if (++count > MAX_FILES) {
      findings.push({ severity: "warn", rule: "has more files than the scanner checks", file: f.rel, line: 0, excerpt: `only the first ${MAX_FILES} files were checked` });
      break;
    }
    if (f.link) {
      findings.push({ severity: "block", rule: "contains a link to a location outside the skill", file: f.rel, line: 0, excerpt: "" });
      continue;
    }
    if (EXECUTABLES.has(path.extname(f.rel).toLowerCase())) {
      findings.push({ severity: "block", rule: "contains a compiled program that cannot be inspected", file: f.rel, line: 0, excerpt: "" });
      continue;
    }
    const size = fs.statSync(f.abs).size;
    if (size > MAX_FILE) {
      findings.push({ severity: "warn", rule: "contains a file too large to check", file: f.rel, line: 0, excerpt: `${Math.round(size / 1024)} KB` });
      continue;
    }
    const buf = fs.readFileSync(f.abs);
    if (buf.includes(0)) {
      findings.push({ severity: "warn", rule: "contains a file that is not text and cannot be checked", file: f.rel, line: 0, excerpt: "" });
      continue;
    }
    findings.push(...scanText(buf.toString("utf8").replace(/^﻿/, ""), f.rel));
  }
  return findings;
}

/** A fingerprint of everything in a skill except SKILL.md's properties. Approval is tied to it. */
export function skillTreeHash(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const f of walk(dir)) {
    h.update(f.rel + "\0");
    if (f.link) h.update("link");
    else if (f.rel === "SKILL.md") h.update(parseNote(fs.readFileSync(f.abs, "utf8")).body.replace(/\r\n/g, "\n").trim());
    else h.update(fs.readFileSync(f.abs));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export type Trust = "trusted" | "review" | "blocked";

/**
 * How far a skill is trusted right now. A skill you wrote yourself is trusted. An imported skill
 * is trusted only while it is exactly what you approved; any later change puts it back under review.
 */
export function effectiveTrust(skillFile: string): Trust {
  let data: Record<string, any>;
  try {
    data = parseNote<Record<string, any>>(fs.readFileSync(skillFile, "utf8")).data;
  } catch {
    return "review";
  }
  if (data.trust === "blocked") return "blocked";
  if (data.provenance?.source !== "import") return data.trust === "review" ? "review" : "trusted";
  if (data.trust !== "trusted") return "review";
  return data.provenance.approved_hash === skillTreeHash(path.dirname(skillFile)) ? "trusted" : "review";
}
