import type { ChatMessage, ChatResult, Provider, ToolSpec } from "../provider/openai.js";

/**
 * Lets at most `limit()` callers through at a time; the rest wait their turn in order.
 * Used for the model: conversations run side by side, but a single local model answers one
 * request at a time, so requests to it are handed over one by one.
 */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: () => number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= Math.max(1, this.limit())) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(signal!.reason instanceof Error ? signal!.reason : new Error("Stopped."));
        };
        if (signal?.aborted) return stop();
        signal?.addEventListener("abort", stop, { once: true });
        this.waiting.push(go);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      if (this.waiting.length && this.active < Math.max(1, this.limit())) this.waiting.shift()!();
    }
  }
}

/** A provider whose requests pass through the gate. */
export function gated(provider: Provider, gate: Gate): Provider {
  return {
    chat(messages: ChatMessage[], tools: ToolSpec[], onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ChatResult> {
      return gate.run(() => provider.chat(messages, tools, onDelta, signal), signal);
    },
  };
}
