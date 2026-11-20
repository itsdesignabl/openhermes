import { chunkText, sleep, type Channel, type ChannelContext } from "./types.js";

/** Telegram bot over long polling. Needs no public address: the bot asks Telegram for new messages. */
export class TelegramChannel implements Channel {
  readonly name = "telegram";
  state = "stopped";
  private abort = new AbortController();
  private loop?: Promise<void>;
  private me = { id: 0, username: "" };

  constructor(private ctx: ChannelContext) {}

  private get cfg() {
    return this.ctx.config().channels.telegram;
  }

  private async api<T = any>(method: string, body: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const token = this.ctx.secret(this.cfg.token_secret || "telegram_bot_token");
    if (!token) throw new FatalChannelError("no bot token. Run: openhermes secret set telegram_bot_token");
    const res = await fetch(`${this.cfg.api_base.replace(/\/+$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !data.ok) {
      if (res.status === 401 || res.status === 404) throw new FatalChannelError("Telegram rejected the bot token");
      const err = new Error(`Telegram ${method} failed (${res.status}): ${data.description ?? "no details"}`) as Error & { retryAfter?: number };
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result as T;
  }

  async start(): Promise<void> {
    this.state = "connecting";
    this.loop = this.poll();
  }

  private async poll(): Promise<void> {
    let offset = 0;
    let backoff = 1000;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.me.id) {
          this.me = await this.api("getMe", {});
          this.state = "connected";
          this.ctx.log("info", `Telegram connected as @${this.me.username}`);
        }
        const updates = await this.api<any[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 40000);
        backoff = 1000;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          this.handle(u.message);
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        if (err instanceof FatalChannelError) {
          this.state = err.message;
          this.ctx.log("error", `Telegram stopped: ${err.message}`);
          return;
        }
        this.state = "reconnecting";
        this.ctx.log("warn", `${(err as Error).message}. Retrying in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    this.state = "stopped";
  }

  private handle(msg: any): void {
    if (!msg?.text || !msg.from || msg.from.is_bot) return;
    const isGroup = msg.chat.type !== "private";
    const tag = `@${this.me.username}`;
    const mentioned = msg.text.toLowerCase().includes(tag.toLowerCase()) || msg.reply_to_message?.from?.id === this.me.id;
    this.ctx.onMessage({
      channel: this.name,
      peer: String(msg.chat.id),
      sender: String(msg.from.id),
      senderName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.username || String(msg.from.id),
      text: msg.text.replace(new RegExp(escapeRegExp(tag), "ig"), "").trim(),
      isGroup,
      mentioned,
    });
  }

  async send(peer: string, text: string): Promise<void> {
    for (const part of chunkText(text, 4000)) {
      try {
        await this.api("sendMessage", { chat_id: peer, text: part });
      } catch (err) {
        const wait = (err as { retryAfter?: number }).retryAfter;
        if (wait === undefined || wait > 60) throw err;
        await sleep(wait * 1000, this.abort.signal);
        await this.api("sendMessage", { chat_id: peer, text: part });
      }
    }
  }

  async typing(peer: string): Promise<void> {
    await this.api("sendChatAction", { chat_id: peer, action: "typing" }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }
}

export class FatalChannelError extends Error {}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
