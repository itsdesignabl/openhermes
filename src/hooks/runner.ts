import { exec } from "../backend/exec.js";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";

export type HookEvent = "turn.before" | "turn.after" | "tool.before" | "tool.after";

/** What a hook may answer. Everything is optional; an empty answer means "carry on". */
export interface HookResult {
  /** "deny" stops the turn or tool call (before-events only). */
  decision?: "deny" | "allow";
  reason?: string;
  /** tool.before: replacement arguments. */
  args?: unknown;
  /** turn.before: replacement for the user's text. */
  text?: string;
  /** tool.after: replacement for the tool's output. */
  output?: string;
}

export type HookFn = (event: HookEvent, payload: Record<string, unknown>) => Promise<HookResult | void>;

interface Registered {
  event: HookEvent;
  match?: string;
  fn: HookFn;
  label: string;
}

export class HookDenied extends Error {
  constructor(reason: string) {
    super(`Blocked by a hook: ${reason}`);
    this.name = "HookDenied";
  }
}

/**
 * Runs hooks in order: first those added by plugins, then the programs listed under `hooks` in the settings.
 * A before-hook that fails or cannot be understood blocks the action, so a broken guard never lets things through.
 */
export class HookRunner {
  private registered: Registered[] = [];

  constructor(
    private home: Home,
    private config: () => Config,
    private log: (level: "info" | "warn" | "error", message: string) => void,
  ) {}

  add(event: HookEvent, fn: HookFn, label: string, match?: string): void {
    this.registered.push({ event, fn, label, match });
  }

  private scriptHooks(): Registered[] {
    return this.config().hooks.map((h) => ({
      event: h.event,
      match: h.match,
      label: h.command.join(" "),
      fn: async (event, payload) => {
        const result = await exec(h.command[0]!, h.command.slice(1), {
          cwd: this.home.runtime,
          timeoutS: h.timeout_s,
          input: JSON.stringify({ event, ...payload }),
          env: { ...process.env, OPENHERMES_HOME: this.home.root },
        });
        if (result.code !== 0) throw new Error(result.code === null ? result.output.split("\n").at(-1) || "it did not finish" : `it exited with code ${result.code}: ${result.output.slice(-300)}`);
        const out = result.output.trim();
        if (!out) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          throw new Error("its output was not JSON");
        }
        return parsed && typeof parsed === "object" ? (parsed as HookResult) : undefined;
      },
    }));
  }

  /** Returns the combined result. Throws HookDenied when a before-hook says no or fails. */
  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookResult> {
    const merged: HookResult = {};
    const before = event.endsWith(".before");
    const tool = typeof payload.tool === "string" ? payload.tool : undefined;
    for (const hook of [...this.registered, ...this.scriptHooks()]) {
      if (hook.event !== event || (hook.match && hook.match !== tool)) continue;
      let result: HookResult | void;
      try {
        result = await hook.fn(event, { ...payload, ...definedOnly(merged) });
      } catch (err) {
        const message = `hook '${hook.label}' failed: ${(err as Error).message}`;
        this.log("error", message);
        if (before) throw new HookDenied(message);
        continue;
      }
      if (!result) continue;
      if (result.decision === "deny") {
        if (before) throw new HookDenied(result.reason || `hook '${hook.label}' said no`);
        continue;
      }
      if (before && event === "tool.before" && result.args !== undefined) merged.args = result.args;
      if (before && event === "turn.before" && typeof result.text === "string") merged.text = result.text;
      if (event === "tool.after" && typeof result.output === "string") merged.output = result.output;
    }
    return merged;
  }
}

function definedOnly(o: HookResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
