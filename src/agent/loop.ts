import { z } from "zod";
import type { Bus } from "../kernel/bus.js";
import type { ChatMessage, Provider, ToolSpec } from "../provider/openai.js";
import type { HookRunner } from "../hooks/runner.js";
import type { Tool, ToolContext } from "../tools/types.js";

export interface TurnOptions {
  sessionId: string;
  system: string;
  history: ChatMessage[];
  userText: string;
  tools: Tool<any>[];
  provider: Provider;
  bus: Bus;
  toolContext: ToolContext;
  maxSteps: number;
  maxToolOutputChars: number;
  signal?: AbortSignal;
  hooks?: HookRunner;
  /** Extra fields given to hooks, such as the agent and conversation. */
  hookInfo?: Record<string, unknown>;
}

export interface TurnResult {
  text: string;
  steps: number;
  /** Messages produced this turn (user, assistant, tool), to append to the history. */
  messages: ChatMessage[];
  toolsUsed: string[];
  /** What the turn cost. Token counts are the endpoint's own when it reports them, otherwise an estimate from text length. */
  usage: TurnUsage;
}

export interface TurnUsage {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  ms: number;
}

/** Rough token count for endpoints that do not report one: about four characters per token. */
export function estimateTokens(messages: ChatMessage[], specs: ToolSpec[]): number {
  let chars = JSON.stringify(specs).length;
  for (const m of messages) chars += m.content.length + (m.role === "assistant" ? JSON.stringify(m.tool_calls ?? []).length : 0) + 8;
  return Math.ceil(chars / 4);
}

export function toolSpecs(tools: Tool<any>[]): ToolSpec[] {
  return tools.map((t) => {
    if (t.jsonSchema) return { name: t.name, description: t.description, parameters: t.jsonSchema };
    const { $schema, ...parameters } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

/** One user turn: call the model, run the tools it asks for, repeat until it answers in text. */
export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const produced: ChatMessage[] = [{ role: "user", content: o.userText }];
  const specs = toolSpecs(o.tools);
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const toolsUsed: string[] = [];
  await o.bus.emit("turn.started", { sessionId: o.sessionId, text: o.userText });

  let steps = 0;
  let finalText = "";
  const started = Date.now();
  const usage: TurnUsage = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimated: false, ms: 0 };
  for (;;) {
    steps++;
    const lastStep = steps > o.maxSteps;
    const messages: ChatMessage[] = [{ role: "system", content: o.system }, ...o.history, ...produced];
    if (lastStep) {
      messages.push({ role: "user", content: "You have reached the step limit. Stop using tools and tell me what you did and what remains." });
    }
    const result = await o.provider.chat(
      messages,
      lastStep ? [] : specs,
      (text) => void o.bus.emit("assistant.delta", { sessionId: o.sessionId, text }),
      o.signal,
    );
    usage.modelCalls++;
    if (result.usage) {
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
    } else {
      usage.estimated = true;
      usage.promptTokens += estimateTokens(messages, lastStep ? [] : specs);
      usage.completionTokens += Math.ceil((result.content.length + JSON.stringify(result.toolCalls).length) / 4);
    }
    produced.push({ role: "assistant", content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
    if (result.content) await o.bus.emit("assistant.message", { sessionId: o.sessionId, text: result.content });

    if (result.toolCalls.length === 0 || lastStep) {
      finalText = result.content;
      break;
    }

    for (const call of result.toolCalls) {
      let output: string;
      let ok = true;
      let args: unknown;
      const tool = byName.get(call.name);
      try {
        if (!tool) throw new Error(`Unknown tool '${call.name}'. Available: ${[...byName.keys()].join(", ")}`);
        try {
          args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
        } catch {
          throw new Error("Arguments were not valid JSON.");
        }
        await o.bus.emit("tool.requested", { sessionId: o.sessionId, id: call.id, name: call.name, args });
        let parsed = tool.schema.safeParse(args);
        if (!parsed.success) throw new Error("Invalid arguments: " + z.prettifyError(parsed.error));
        if (o.hooks) {
          const h = await o.hooks.run("tool.before", { ...o.hookInfo, tool: call.name, args: parsed.data });
          if (h.args !== undefined) {
            parsed = tool.schema.safeParse(h.args);
            if (!parsed.success) throw new Error("A hook changed the arguments into something invalid: " + z.prettifyError(parsed.error));
          }
        }
        output = await tool.run(parsed.data, o.toolContext);
        toolsUsed.push(call.name);
        if (o.hooks) {
          const h = await o.hooks.run("tool.after", { ...o.hookInfo, tool: call.name, args: parsed.data, output, ok: true });
          if (typeof h.output === "string") output = h.output;
        }
      } catch (err) {
        ok = false;
        output = `Error: ${(err as Error).message}`;
        if (args === undefined) await o.bus.emit("tool.requested", { sessionId: o.sessionId, id: call.id, name: call.name, args: call.arguments });
      }
      if (output.length > o.maxToolOutputChars) {
        output = output.slice(0, o.maxToolOutputChars) + `\n[truncated: ${output.length} characters in total]`;
      }
      produced.push({ role: "tool", tool_call_id: call.id, content: output });
      await o.bus.emit("tool.finished", {
        sessionId: o.sessionId,
        id: call.id,
        name: call.name,
        ok,
        summary: output.split("\n")[0]?.slice(0, 200) ?? "",
      });
    }
  }

  await o.bus.emit("turn.finished", { sessionId: o.sessionId, text: finalText, steps });
  usage.ms = Date.now() - started;
  return { text: finalText, steps, messages: produced, toolsUsed, usage };
}
