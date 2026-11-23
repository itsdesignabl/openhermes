import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, ToolSpec } from "../provider/openai.js";

/** How the model's context window is divided for one turn. */
export interface ContextBudget {
  windowTokens: number;
  /** Kept free for the model's answer. */
  reserveTokens: number;
  /** Instructions, memory, skills and the tool list: sent on every call. */
  fixedTokens: number;
  /** What is left for the conversation: earlier turns plus this turn's messages and tool results. */
  conversationTokens: number;
  conversationChars: number;
  charsPerToken: number;
}

/** Characters the chat template adds around the tool list and each message, roughly. */
const TEMPLATE_OVERHEAD = 600;
const PER_MESSAGE = 16;

export function toolsWireChars(specs: ToolSpec[]): number {
  return specs.length ? JSON.stringify(specs.map((t) => ({ type: "function", function: t }))).length : 0;
}

export function messageChars(m: ChatMessage): number {
  return m.content.length + PER_MESSAGE + (m.role === "assistant" ? (m.tool_calls ?? []).reduce((n, c) => n + c.name.length + c.arguments.length + 24, 0) : 0);
}

export const conversationSize = (messages: ChatMessage[]) => messages.reduce((n, m) => n + messageChars(m), 0);

export function contextBudget(o: { windowTokens: number; reserveTokens: number; system: string; specs: ToolSpec[]; charsPerToken: number }): ContextBudget {
  const fixedChars = o.system.length + toolsWireChars(o.specs) + TEMPLATE_OVERHEAD;
  const fixedTokens = Math.ceil(fixedChars / o.charsPerToken);
  // never plan with less than a sliver: a window that small cannot work, and the endpoint will say so
  const conversationTokens = Math.max(200, o.windowTokens - o.reserveTokens - fixedTokens);
  return {
    windowTokens: o.windowTokens,
    reserveTokens: o.reserveTokens,
    fixedTokens,
    conversationTokens,
    conversationChars: Math.floor(conversationTokens * o.charsPerToken),
    charsPerToken: o.charsPerToken,
  };
}

export const ELIDED = (chars: number) => `[output removed to save space (${chars} characters). Run the tool again if you need it.]`;

export interface Fit {
  messages: ChatMessage[];
  /** Tool results replaced by a placeholder. */
  elided: number;
  /** Earlier turns left out. */
  droppedTurns: number;
  fits: boolean;
}

/**
 * Chooses what of the conversation is sent to the model so that it fits in `budgetChars`.
 * Nothing stored is changed: this builds the view for one call. In order, until it fits:
 *
 * 1. tool results from earlier turns are replaced by a short placeholder
 * 2. this turn's tool results, except the latest two, likewise
 * 3. whole earlier turns are left out, oldest first
 * 4. this turn's remaining tool results except the latest, likewise
 * 5. the latest tool result is cut short
 *
 * A tool call is never separated from its result, and this turn's own messages are never dropped.
 */
export function fitConversation(history: ChatMessage[], produced: ChatMessage[], budgetChars: number): Fit {
  let hist = history;
  let cur = produced;
  let elided = 0;
  let droppedTurns = 0;
  const size = () => conversationSize(hist) + conversationSize(cur);
  const done = (): Fit => ({ messages: [...hist, ...cur], elided, droppedTurns, fits: size() <= budgetChars });
  if (size() <= budgetChars) return done();

  const elide = (list: ChatMessage[], keepLast: number): ChatMessage[] => {
    const toolIdx = list.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    const candidates = keepLast ? toolIdx.slice(0, -keepLast) : toolIdx;
    const out = [...list];
    for (const i of candidates) {
      if (size() - conversationSize(list) + conversationSize(out) <= budgetChars) break;
      const m = out[i]!;
      const placeholder = ELIDED(m.content.length);
      if (m.content.length <= placeholder.length || m.content.startsWith("[output removed")) continue;
      out[i] = { ...m, content: placeholder } as ChatMessage;
      elided++;
    }
    return out;
  };

  hist = elide(hist, 0);
  if (size() <= budgetChars) return done();
  cur = elide(cur, 2);
  if (size() <= budgetChars) return done();

  // leave out whole earlier turns: a turn starts at a user message
  while (hist.length && size() > budgetChars) {
    let next = hist.findIndex((m, i) => i > 0 && m.role === "user");
    if (next < 0) next = hist.length;
    hist = hist.slice(next);
    droppedTurns++;
  }
  if (size() <= budgetChars) return done();

  cur = elide(cur, 1);
  if (size() <= budgetChars) return done();

  // last resort: cut the latest tool result to what is left, keeping its start
  const last = cur.map((m) => m.role).lastIndexOf("tool");
  if (last >= 0) {
    const m = cur[last]!;
    const over = size() - budgetChars;
    const keep = Math.max(400, m.content.length - over - 80);
    if (keep < m.content.length) {
      cur = [...cur];
      cur[last] = { ...m, content: `${m.content.slice(0, keep)}\n[cut: ${m.content.length - keep} more characters did not fit]` } as ChatMessage;
      elided++;
    }
  }
  return done();
}

/**
 * Learns how many characters this model's tokens cover, from the token counts the endpoint reports.
 * Starts cautious (3.5) and moves towards what is measured, so the budget matches the real model.
 */
export class Calibration {
  charsPerToken = 3.5;
  private file: string;
  private samples = 0;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "metrics", "context.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as { chars_per_token?: number };
      if (typeof saved.chars_per_token === "number" && saved.chars_per_token >= 2 && saved.chars_per_token <= 6) this.charsPerToken = saved.chars_per_token;
    } catch {}
  }

  update(sentChars: number, promptTokens: number): void {
    if (promptTokens < 200 || sentChars < 500) return; // too small to say anything
    const measured = Math.min(6, Math.max(2, sentChars / promptTokens));
    this.charsPerToken = this.samples === 0 ? measured : this.charsPerToken * 0.7 + measured * 0.3;
    this.samples++;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ chars_per_token: Number(this.charsPerToken.toFixed(3)) }));
    } catch {
      // measuring must never break a turn
    }
  }
}

/** Whether an error from the model endpoint says the prompt did not fit. */
export function isContextOverflow(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err).toLowerCase();
  return /context (size|length|window)|n_ctx|too many tokens|maximum context|exceeds? the (available )?context|prompt is too long|context_length_exceeded/.test(text);
}
