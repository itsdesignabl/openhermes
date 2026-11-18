import fs from "node:fs";
import path from "node:path";
import type { App } from "../app.js";
import type { Session } from "../agent/session.js";
import { parseDuration } from "../gateway/cron.js";
import type { ChatMessage } from "../provider/openai.js";
import { consolidateMemory, curate, type CuratorReport } from "./curator.js";
import { createInboxNote, findPending, inboxDir, listInbox, readInboxNote, resolveInboxItem, type InboxItem, type Resolution } from "./inbox.js";
import { applyProposal, describe, memoryLimit, policyActionFor, ProposalError, type Proposal, type ProposalOrigin } from "./proposals.js";
import { reflect, renderTranscript } from "./reflect.js";
import { scanText } from "./scanner.js";

export interface ReflectionOutcome {
  session: string;
  applied: string[];
  pending: string[];
  skipped: string[];
}

const REASONS: Record<string, string> = {
  "skill.edit_executable": "it contains commands or code the agent would run",
  "skill.edit": "your policy asks for approval before skills change",
  "memory.edit": "your policy asks for approval before memory changes",
};

/** The learning loop: reviews conversations, turns what it finds into memory and skills, and keeps both tidy. */
export class Learner {
  private stateFile: string;
  /** Inbox notes already reported as damaged, so the message is not repeated on every save. */
  private reported = new Map<string, string>();

  constructor(private app: App) {
    this.stateFile = path.join(app.home.data, "learning", "state.json");
  }

  private get cfg() {
    return this.app.config.learning;
  }

  private eligible(session: Session): boolean {
    return this.cfg.enabled && !/:(heartbeat|job):/.test(session.key);
  }

  private pendingTurns(session: Session): number {
    return session.history.slice(session.reflected).filter((m) => m.role === "user").length;
  }

  /** After each turn: review once enough new messages have accumulated. */
  afterTurn(session: Session): void {
    if (this.eligible(session) && this.pendingTurns(session) >= this.cfg.reflect_every_turns) this.schedule(session);
  }

  /** Before a conversation is cleared: review what has not been reviewed yet. */
  beforeReset(session: Session): void {
    if (this.eligible(session) && this.pendingTurns(session) >= this.cfg.min_turns) this.schedule(session);
  }

  /** Periodic work while the gateway runs: review quiet conversations and run the cleanup when it is due. */
  maintenance(now: Date): void {
    if (!this.cfg.enabled) return;
    const idleMs = this.cfg.reflect_idle_minutes * 60_000;
    if (idleMs > 0) {
      for (const session of this.app.conversations()) {
        if (this.eligible(session) && this.pendingTurns(session) >= this.cfg.min_turns && now.getTime() - session.lastActive >= idleMs) {
          this.schedule(session);
        }
      }
    }
    const every = parseDuration(this.cfg.curator_every);
    if (every) {
      const state = this.readState();
      if (!state.last_curated) this.writeState({ ...state, last_curated: now.toISOString() });
      else if (now.getTime() - Date.parse(state.last_curated) >= every) {
        this.writeState({ ...state, last_curated: now.toISOString() });
        void this.curate().catch((err) => this.log("error", `cleanup failed: ${(err as Error).message}`));
      }
    }
  }

  private readState(): { last_curated?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return {};
    }
  }

  private writeState(state: object): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state));
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    void this.app.bus.emit("log", { level, message });
  }

  /** Takes a snapshot now (the conversation may be cleared right after) and reviews it when the agent is free. */
  private schedule(session: Session): void {
    const messages = session.history.slice(session.reflected);
    session.markReflected();
    const origin: ProposalOrigin = { agent: session.agentName, session: path.relative(this.app.home.vault, session.file).split(path.sep).join("/") };
    void this.app
      .enqueue(() => this.review(messages, origin))
      .catch((err) => this.log("error", `review of ${origin.session} failed: ${(err as Error).message}`));
  }

  /** Review a saved session note by hand (`openhermes reflect`). */
  reflectNote(file: string): Promise<ReflectionOutcome> {
    const abs = this.app.home.resolveInside(file, this.app.home.vault);
    const text = fs.readFileSync(abs, "utf8");
    const agent = /^agent:\s*(\S+)/m.exec(text)?.[1] ?? this.app.defaultAgent;
    const origin = { agent, session: path.relative(this.app.home.vault, abs).split(path.sep).join("/") };
    const max = this.cfg.max_transcript_chars;
    return this.app.enqueue(() => this.reviewText(text.length > max ? text.slice(text.length - max) : text, origin));
  }

  private review(messages: ChatMessage[], origin: ProposalOrigin): Promise<ReflectionOutcome> {
    return this.reviewText(renderTranscript(messages, this.cfg.max_transcript_chars), origin);
  }

  private async reviewText(transcript: string, origin: ProposalOrigin): Promise<ReflectionOutcome> {
    const provider = await this.app.getProvider(origin.agent);
    const proposals = await reflect({
      home: this.app.home,
      agent: origin.agent,
      provider,
      transcript,
      toolContext: this.app.toolContext(origin.agent, "", undefined),
    });
    const outcome = await this.process(proposals, origin);
    await this.app.history.commit(`Learned from ${origin.session}`).catch(() => {});
    await this.app.bus.emit("learning.reflected", outcome);
    if (outcome.applied.length || outcome.pending.length) {
      this.log("info", `Reviewed ${origin.session}: ${outcome.applied.length} saved, ${outcome.pending.length} waiting for approval`);
    }
    return outcome;
  }

  /** Each proposal is applied, sent to the Inbox, or dropped, as the policies say. */
  async process(proposals: Proposal[], origin: ProposalOrigin): Promise<ReflectionOutcome> {
    const outcome: ReflectionOutcome = { session: origin.session, applied: [], pending: [], skipped: [] };
    const waiting = new Set(listInbox(this.app.home).filter((i) => i.status === "pending").map((i) => i.title));
    for (const p of proposals) {
      const title = describe(p);
      // a skill the agent drafts is held to the same checks as an imported one
      const text = p.kind === "skill.create" ? p.body : p.kind === "skill.patch" ? p.new_text : "";
      const blocked = text ? scanText(text, "SKILL.md").find((f) => f.severity === "block") : undefined;
      if (blocked) {
        outcome.skipped.push(`${title} (the skill scanner blocks it: ${blocked.rule})`);
        continue;
      }
      const action = policyActionFor(this.app.home, p);
      const rule = this.app.policies.policies[action];
      if (rule === "deny") {
        outcome.skipped.push(`${title} (policy ${action} is deny)`);
      } else if (rule === "ask") {
        if (waiting.has(title)) {
          outcome.skipped.push(`${title} (already waiting in the Inbox)`);
          continue;
        }
        const item = createInboxNote(this.app.home, p, origin, REASONS[action] ?? "your policy asks for it");
        waiting.add(title);
        this.app.recordWrite(item.file);
        outcome.pending.push(title);
        await this.app.bus.emit("proposal.created", { id: item.id, title, file: item.file, agent: origin.agent });
      } else {
        try {
          let changed: string[];
          try {
            changed = applyProposal(this.app.home, this.app.config, p, origin, "policy");
          } catch (err) {
            if (!(err instanceof ProposalError) || err.message !== "memory is full" || (p.kind !== "memory.add" && p.kind !== "memory.replace")) throw err;
            // make room once, then try again
            const file = path.join(this.app.home.vault, "Memory", p.target === "memory" ? "MEMORY.md" : "USER.md");
            const merged = await consolidateMemory(await this.app.getProvider(origin.agent), file, memoryLimit(this.app.config, p.target));
            if (!merged) throw err;
            this.app.recordWrite(file);
            changed = applyProposal(this.app.home, this.app.config, p, origin, "policy");
          }
          changed.forEach((f) => this.app.recordWrite(f));
          outcome.applied.push(title);
        } catch (err) {
          if (!(err instanceof ProposalError)) throw err;
          outcome.skipped.push(`${title} (${err.message})`);
        }
      }
    }
    return outcome;
  }

  pending(): InboxItem[] {
    return listInbox(this.app.home).filter((i) => i.status === "pending");
  }

  /** Approve or reject a waiting item by id or list position. */
  resolve(ref: string, approve: boolean): Promise<Resolution> {
    return this.app.enqueue(async () => {
      const item = findPending(this.app.home, ref.trim());
      if (!item) throw new Error(`Nothing is waiting under '${ref}'. See the list with /inbox or: openhermes inbox`);
      return this.finish(item, approve);
    });
  }

  private async finish(item: InboxItem, approve: boolean): Promise<Resolution> {
    const res = resolveInboxItem(this.app.home, this.app.config, item, approve);
    res.changed.forEach((f) => this.app.recordWrite(f));
    await this.app.history.commit(`${res.outcome === "applied" ? "Approved" : res.outcome === "rejected" ? "Rejected" : "Could not apply"}: ${item.title}`).catch(() => {});
    await this.app.bus.emit("proposal.resolved", { id: item.id, title: item.title, outcome: res.outcome, message: res.message });
    return res;
  }

  /** Picks up decisions made by editing notes in Obsidian: status set to approved or rejected. */
  scanInbox(): Promise<void> {
    return this.app.enqueue(async () => {
      const dir = inboxDir(this.app.home);
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith(".md")) continue;
        const file = path.join(dir, f);
        const item = readInboxNote(file);
        if (item === null) continue;
        if (typeof item === "string") {
          if (this.reported.get(file) !== item) this.log("warn", `Inbox/${f} cannot be processed: ${item}`);
          this.reported.set(file, item);
          continue;
        }
        this.reported.delete(file);
        if (/^(approved?|yes|accept(ed)?)$/.test(item.status)) await this.finish(item, true);
        else if (/^(reject(ed)?|no|den(y|ied))$/.test(item.status)) await this.finish(item, false);
      }
    });
  }

  curate(): Promise<CuratorReport> {
    return this.app.enqueue(async () => {
      const report = await curate(this.app.home, this.app.config, () => this.app.getProvider());
      report.changed.forEach((f) => this.app.recordWrite(f));
      if (report.changed.length) await this.app.history.commit(`Cleanup: ${report.actions.join("; ").slice(0, 120)}`).catch(() => {});
      if (report.actions.length) this.log("info", `Cleanup: ${report.actions.join("; ")}`);
      return report;
    });
  }
}
