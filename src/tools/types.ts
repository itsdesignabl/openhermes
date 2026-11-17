import type { z } from "zod";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import type { PolicyEngine } from "../kernel/policy.js";
import type { MemoryIndex } from "../memory/index.js";

export interface ToolContext {
  home: Home;
  config: () => Config;
  policy: PolicyEngine;
  memory: MemoryIndex;
  agentName: string;
  /** Text of the user's message for this turn. Used to tell user-referenced paths from agent-chosen ones. */
  userText: string;
  /** Call after every write inside the home folder, so it is indexed and versioned. */
  wrote(absPath: string): void;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
