import type { z } from "zod";
import type { Config } from "../kernel/config.js";
import type { SettingsGuard } from "../kernel/guard.js";
import type { Home } from "../kernel/home.js";
import type { PolicyEngine } from "../kernel/policy.js";
import type { Backend } from "../backend/types.js";
import type { MemoryIndex } from "../memory/index.js";

export interface ToolContext {
  home: Home;
  config: () => Config;
  policy: PolicyEngine;
  memory: MemoryIndex;
  backend: Backend;
  /** Watches the agent's own settings around work that could change them, and puts them back. */
  guard: SettingsGuard;
  agentName: string;
  /** Text of the user's message for this turn. Used to tell user-referenced paths from agent-chosen ones. */
  userText: string;
  /** Call after every write inside the home folder, so it is indexed and versioned. */
  wrote(absPath: string): void;
  /** Call after reading a file, so skill use can be counted. */
  read?(absPath: string): void;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** For tools defined outside this program: the parameter schema to show the model, in place of one derived from `schema`. */
  jsonSchema?: Record<string, unknown>;
  run(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
