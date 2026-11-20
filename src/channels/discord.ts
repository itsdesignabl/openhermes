import { FatalChannelError } from "./telegram.js";
import { chunkText, sleep, type Channel, type ChannelContext } from "./types.js";

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token",
  4013: "Discord rejected the requested intents",
  4014: "the Message Content intent is not enabled for this bot in the Discord developer portal",
};

/** Discord bot over the gateway WebSocket (receiving) and the REST API (sending). */
export class DiscordChannel implements Channel {
  readonly name = "discord";
  state = "stopped";
  private abort = new AbortController();
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private seq: number | null = null;
  private botId = "";
  private backoff = 1000;
  private acked = true;

  constructor(private ctx: ChannelContext) {}

  private get cfg() {
    return this.ctx.config().channels.discord;
  }

  private token(): string {
    const token = this.ctx.secret(this.cfg.token_secret || "discord_bot_token");
    if (!token) throw new FatalChannelError("no bot token. Run: openhermes secret set discord_bot_token");
    return token;
  }

  async start(): Promise<void> {
    try {
      this.token();
    } catch (err) {
      this.state = (err as Error).message;
      this.ctx.log("error", `Discord stopped: ${this.state}`);
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.abort.signal.aborted) return;
    this.state = this.state === "stopped" ? "connecting" : "reconnecting";
    this.acked = true;
    const ws = new WebSocket(this.cfg.gateway_url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let p: any;
      try {
        p = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof p.s === "number") this.seq = p.s;
      switch (p.op) {
        case 10: // HELLO
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (!this.acked) return ws.close(4000, "heartbeat not acknowledged");
            this.acked = false;
            ws.send(JSON.stringify({ op: 1, d: this.seq }));
          }, p.d.heartbeat_interval);
          ws.send(
            JSON.stringify({
              op: 2,
              d: { token: this.token(), intents: INTENTS, properties: { os: process.platform, browser: "openhermes", device: "openhermes" } },
            }),
          );
          break;
        case 11:
          this.acked = true;
          break;
        case 1:
          ws.send(JSON.stringify({ op: 1, d: this.seq }));
          break;
        case 7: // RECONNECT
        case 9: // INVALID SESSION
          ws.close(4000, "server asked for a reconnect");
          break;
        case 0:
          if (p.t === "READY") {
            this.botId = p.d.user.id;
            this.state = "connected";
            this.backoff = 1000;
            this.ctx.log("info", `Discord connected as ${p.d.user.username}`);
          } else if (p.t === "MESSAGE_CREATE") this.handle(p.d);
          break;
      }
    });
    ws.addEventListener("close", (ev) => {
      clearInterval(this.heartbeat);
      if (this.abort.signal.aborted) return void (this.state = "stopped");
      const fatal = FATAL_CLOSE[ev.code];
      if (fatal) {
        this.state = fatal;
        this.ctx.log("error", `Discord stopped: ${fatal}`);
        return;
      }
      this.state = "reconnecting";
      this.ctx.log("warn", `Discord connection closed (${ev.code}). Retrying in ${Math.round(this.backoff / 1000)}s`);
      void sleep(this.backoff, this.abort.signal).then(() => this.connect());
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
    ws.addEventListener("error", () => {});
  }

  private handle(msg: any): void {
    if (!msg?.content || !msg.author || msg.author.bot) return;
    const mention = new RegExp(`<@!?${this.botId}>`, "g");
    this.ctx.onMessage({
      channel: this.name,
      peer: String(msg.channel_id),
      sender: String(msg.author.id),
      senderName: msg.author.global_name || msg.author.username || String(msg.author.id),
      text: String(msg.content).replace(mention, "").trim(),
      isGroup: !!msg.guild_id,
      mentioned: (msg.mentions ?? []).some((u: any) => u.id === this.botId),
    });
  }

  private async rest(path: string, body?: unknown): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(this.cfg.api_base.replace(/\/+$/, "") + path, {
        method: "POST",
        headers: { authorization: `Bot ${this.token()}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      });
      if (res.ok) return;
      if (res.status === 429 && attempt === 0) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min((data.retry_after ?? 1) * 1000, 30000), this.abort.signal);
        continue;
      }
      throw new Error(`Discord request failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  }

  async send(peer: string, text: string): Promise<void> {
    for (const part of chunkText(text, 1900)) await this.rest(`/channels/${peer}/messages`, { content: part });
  }

  async typing(peer: string): Promise<void> {
    await this.rest(`/channels/${peer}/typing`).catch(() => {});
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearInterval(this.heartbeat);
    this.ws?.close(1000);
    this.state = "stopped";
  }
}
