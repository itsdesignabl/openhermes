import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import { writeAtomic } from "../tools/builtin.js";
import { formatNote, parseNote } from "../vault/frontmatter.js";
import { applyProposal, describe, ProposalError, ProposalSchema, skillSlug, type Proposal, type ProposalOrigin } from "./proposals.js";

const MARKER = "<!-- Proposed content starts below this line. You can edit it before approving. -->";

export interface InboxItem {
  id: string;
  file: string;
  title: string;
  status: string;
  proposal: Proposal;
  origin: ProposalOrigin;
  created: string;
}

/** The long text of a proposal lives in the note body so it can be read and edited comfortably. */
function splitContent(p: Proposal): { fields: Record<string, unknown>; content: string } {
  if (p.kind === "skill.create") {
    const { body, ...fields } = p;
    return { fields, content: body };
  }
  if (p.kind === "skill.patch" || p.kind === "memory.replace") {
    const { new_text, ...fields } = p;
    return { fields, content: new_text };
  }
  const { text, ...fields } = p;
  return { fields, content: text };
}

function joinContent(fields: Record<string, unknown>, content: string): unknown {
  const kind = fields.kind;
  const text = content.trim();
  if (kind === "skill.create") return { ...fields, body: text };
  if (kind === "skill.patch" || kind === "memory.replace") return { ...fields, new_text: text };
  return { ...fields, text };
}

export function inboxDir(home: Home): string {
  return path.join(home.vault, "Inbox");
}

/** Writes a pending proposal as a note the user can approve by changing one property. */
export function createInboxNote(home: Home, p: Proposal, origin: ProposalOrigin, reason: string): InboxItem {
  const id = crypto.randomBytes(2).toString("hex");
  const label = p.kind.startsWith("skill") ? `skill ${skillSlug((p as { name: string }).name)}` : p.kind.replace(".", " ");
  const file = path.join(inboxDir(home), `${id} ${label}.md`);
  const { fields, content } = splitContent(p);
  const title = describe(p);
  const created = new Date().toISOString();
  const body = [
    `# ${title}`,
    "",
    `The agent **${origin.agent}** suggests this after the conversation [[${origin.session.replace(/\.md$/, "")}]].`,
    `It needs your approval because ${reason}.`,
    "",
    "**To decide:** change `status` in the properties above to `approved` or `rejected`.",
    p.kind === "skill.patch" || p.kind === "memory.replace" ? `\nText to be replaced:\n\n> ${String((p as any).old_text).split("\n").join("\n> ")}\n` : "",
    MARKER,
    "",
    content.trim(),
    "",
  ].join("\n");
  writeAtomic(file, formatNote({ type: "proposal", status: "pending", id, ...fields, agent: origin.agent, session: origin.session, created }, body));
  return { id, file, title, status: "pending", proposal: p, origin, created };
}

/** Reads one Inbox note. Returns null for notes that are not proposals, or an error text for a damaged one. */
export function readInboxNote(file: string): InboxItem | string | null {
  let data: Record<string, any>, body: string;
  try {
    ({ data, body } = parseNote<Record<string, any>>(fs.readFileSync(file, "utf8")));
  } catch (err) {
    return `its properties cannot be read: ${(err as Error).message}`;
  }
  if (data.type !== "proposal") return null;
  const { type, status, id, agent, session, created, resolved, result, ...fields } = data;
  const at = body.indexOf(MARKER);
  if (at < 0) return "the line that marks the start of the proposed content is missing";
  const parsed = ProposalSchema.safeParse(joinContent(fields, body.slice(at + MARKER.length)));
  if (!parsed.success) return `the proposal is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  return {
    id: String(id ?? path.basename(file).slice(0, 4)),
    file,
    title: describe(parsed.data),
    status: String(status ?? "pending").trim().toLowerCase(),
    proposal: parsed.data,
    origin: { agent: String(agent ?? "main"), session: String(session ?? "") },
    created: String(created instanceof Date ? created.toISOString() : (created ?? "")),
  };
}

export function listInbox(home: Home): InboxItem[] {
  const dir = inboxDir(home);
  if (!fs.existsSync(dir)) return [];
  const items: InboxItem[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    const item = readInboxNote(path.join(dir, f));
    if (item && typeof item !== "string") items.push(item);
  }
  return items.sort((a, b) => a.created.localeCompare(b.created));
}

export interface Resolution {
  item: InboxItem;
  outcome: "applied" | "rejected" | "failed";
  message: string;
  changed: string[];
}

function setProperties(file: string, props: Record<string, unknown>): void {
  const note = parseNote<Record<string, unknown>>(fs.readFileSync(file, "utf8"));
  writeAtomic(file, formatNote({ ...note.data, ...props }, note.body));
}

/** Carries out a decision on an Inbox note and files the note under Inbox/Done. A failed one stays, with the reason. */
export function resolveInboxItem(home: Home, config: Config, item: InboxItem, approve: boolean): Resolution {
  let outcome: Resolution["outcome"] = "rejected";
  let message = "Rejected.";
  let changed: string[] = [];
  if (approve) {
    try {
      changed = applyProposal(home, config, item.proposal, item.origin, "user");
      outcome = "applied";
      message = `Applied: ${item.title}`;
    } catch (err) {
      if (!(err instanceof ProposalError)) throw err;
      setProperties(item.file, { status: "failed", result: err.message });
      return { item, outcome: "failed", message: `Could not apply (${err.message}): ${item.title}`, changed: [item.file] };
    }
  }
  setProperties(item.file, { status: outcome, resolved: new Date().toISOString() });
  const done = path.join(inboxDir(home), "Done");
  fs.mkdirSync(done, { recursive: true });
  const dest = path.join(done, path.basename(item.file));
  fs.renameSync(item.file, dest);
  return { item, outcome, message, changed: [...changed, item.file, dest] };
}

/** Finds a pending item by its id or by its position in the pending list (1, 2, ...). */
export function findPending(home: Home, ref: string): InboxItem | undefined {
  const pending = listInbox(home).filter((i) => i.status === "pending");
  const n = Number(ref);
  if (/^\d{1,2}$/.test(ref) && n >= 1 && n <= pending.length && !pending.some((i) => i.id === ref)) return pending[n - 1];
  return pending.find((i) => i.id === ref.toLowerCase());
}
