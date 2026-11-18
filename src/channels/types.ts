import type { Config } from "../kernel/config.js";

export interface Inbound {
  channel: string;
  /** The chat to reply to: a direct chat or a group. */
  peer: string;
  /** The person who wrote the message. */
  sender: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  /** In a group: whether the bot was addressed. */
  mentioned: boolean;
}

export interface ChannelContext {
  config: () => Config;
  secret(name: string): string | undefined;
  onMessage(message: Inbound): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface Channel {
  readonly name: string;
  /** "connected", "connecting", or a short reason it is not running. */
  state: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peer: string, text: string): Promise<void>;
  typing?(peer: string): Promise<void>;
}

export type ChannelFactory = (ctx: ChannelContext) => Channel;

/** Split a long reply at paragraph or line breaks so each part fits the service's limit. */
export function chunkText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
