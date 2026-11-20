export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** Token counts as reported by the endpoint. Missing when it does not report them. */
  usage?: Usage;
}

export interface Provider {
  chat(messages: ChatMessage[], tools: ToolSpec[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ChatResult>;
}

export interface OpenAIProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
}

/** Client for any OpenAI-compatible chat endpoint: llama.cpp, Ollama, LM Studio, or a cloud provider. */
export class OpenAIProvider implements Provider {
  private usageOption = true;
  constructor(private opts: OpenAIProviderOptions) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ChatResult> {
    const body = {
      model: this.opts.model,
      temperature: this.opts.temperature ?? 0.2,
      stream: true,
      // ask for token counts at the end of the stream; dropped if the endpoint does not know the option
      ...(this.usageOption ? { stream_options: { include_usage: true } } : {}),
      messages: messages.map(toWire),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
        : {}),
    };
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 600_000);
    const post = (payload: object) =>
      fetch(this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    let res = await post(body);
    if ((res.status === 400 || res.status === 422) && this.usageOption) {
      // an endpoint that rejects the usage option: stop sending it and try once more
      const text = await res.text().catch(() => "");
      this.usageOption = false;
      const { stream_options, ...plain } = body as Record<string, unknown>;
      res = await post(plain);
      if (!res.ok) throw new Error(`Model endpoint returned ${res.status}: ${(await res.text().catch(() => text)).slice(0, 500)}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Model endpoint returned ${res.status}: ${text.slice(0, 500)}`);
    }

    let content = "";
    const calls = new Map<number, ToolCall>();
    let usage: Usage | undefined;
    const handle = (chunk: any) => {
      if (chunk?.usage && typeof chunk.usage.prompt_tokens === "number") {
        usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const delta = chunk?.choices?.[0]?.delta ?? chunk?.choices?.[0]?.message;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index: number = tc.index ?? calls.size;
        let call = calls.get(index);
        if (!call) calls.set(index, (call = { id: "", name: "", arguments: "" }));
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") call.arguments += tc.function.arguments;
      }
    };

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      handle(await res.json()); // endpoint ignored stream:true
    } else {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const part of res.body as any as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            handle(JSON.parse(data));
          } catch {
            // a malformed chunk is skipped; the rest of the stream is still usable
          }
        }
      }
    }

    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now().toString(36)}` }))
      .filter((c) => c.name);
    return { content, toolCalls, usage };
  }
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return m;
}
