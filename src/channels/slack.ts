import { FatalChannelError } from "./telegram.js";
import { chunkText, sleep, type Channel, type ChannelContext } from "./types.js";

const FATAL = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type", "missing_scope"]);

/**
 * Slack bot over Socket Mode: Slack pushes events through a WebSocket the bot opens, so no public
 * address is needed. Needs two tokens: an app-level token (xapp-…) and a bot token (xoxb-…).
 */
export class SlackChannel implements Channel {
  readonly name = "slack";
  state = "stopped";
  private abort = new AbortController();
  private ws?: WebSocket;
  private botUser = "";
  private backoff = 1000;
  private seen = new Set<string>();

  constructor(private ctx: ChannelContext) {}

  private get cfg() {
    return this.ctx.config().channels.slack;
  }

  private token(kind: "bot" | "app"): string {
    const name = kind === "bot" ? this.cfg.token_secret || "slack_bot_token" : this.cfg.app_token_secret || "slack_app_token";
    const token = this.ctx.secret(name);
    if (!token) throw new FatalChannelError(`no ${kind} token. Run: openhermes secret set ${name}`);
    return token;
  }

  private async api(method: string, kind: "bot" | "app", body: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`${this.cfg.api_base.replace(/\/+$/, "")}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token(kind)}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    if (res.status === 429) {
      const err = new Error("Slack asked to slow down") as Error & { retryAfter?: number };
      err.retryAfter = Number(res.headers.get("retry-after") ?? 1);
      throw err;
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!data.ok) {
      const reason = data.error ?? `HTTP ${res.status}`;
      if (FATAL.has(reason)) throw new FatalChannelError(`Slack rejected the ${kind} token (${reason})`);
      throw new Error(`Slack ${method} failed: ${reason}`);
    }
    return data;
  }

  async start(): Promise<void> {
    this.state = "connecting";
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.abort.signal.aborted) return;
    try {
      if (!this.botUser) this.botUser = (await this.api("auth.test", "bot")).user_id;
      const { url } = await this.api("apps.connections.open", "app");
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("message", (ev) => {
        let p: any;
        try {
          p = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (p.envelope_id) ws.send(JSON.stringify({ envelope_id: p.envelope_id })); // acknowledge, or Slack sends it again
        if (p.type === "hello") {
          this.state = "connected";
          this.backoff = 1000;
          this.ctx.log("info", "Slack connected");
        } else if (p.type === "disconnect") ws.close(1000);
        else if (p.type === "events_api") this.handle(p.payload?.event, p.payload?.event_id);
      });
      ws.addEventListener("close", () => {
        if (this.abort.signal.aborted) return void (this.state = "stopped");
        this.retry("the connection closed");
      });
      ws.addEventListener("error", () => {});
    } catch (err) {
      if (this.abort.signal.aborted) return;
      if (err instanceof FatalChannelError) {
        this.state = err.message;
        this.ctx.log("error", `Slack stopped: ${err.message}`);
        return;
      }
      this.retry((err as Error).message);
    }
  }

  private retry(reason: string): void {
    this.state = "reconnecting";
    this.ctx.log("warn", `Slack: ${reason}. Retrying in ${Math.round(this.backoff / 1000)}s`);
    void sleep(this.backoff, this.abort.signal).then(() => this.connect());
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  private handle(event: any, eventId?: string): void {
    // Only plain messages from people. A mention also arrives as a second "app_mention" event, which is ignored.
    if (event?.type !== "message" || event.subtype || event.bot_id || !event.user || !event.text) return;
    if (eventId) {
      if (this.seen.has(eventId)) return; // Slack repeats events it thinks were not acknowledged
      this.seen.add(eventId);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    }
    const mention = `<@${this.botUser}>`;
    this.ctx.onMessage({
      channel: this.name,
      peer: String(event.channel),
      sender: String(event.user),
      senderName: String(event.user),
      text: String(event.text).split(mention).join("").trim(),
      isGroup: event.channel_type !== "im",
      mentioned: String(event.text).includes(mention),
    });
  }

  async send(peer: string, text: string): Promise<void> {
    for (const part of chunkText(text, 3500)) {
      try {
        await this.api("chat.postMessage", "bot", { channel: peer, text: part });
      } catch (err) {
        const wait = (err as { retryAfter?: number }).retryAfter;
        if (wait === undefined || wait > 60) throw err;
        await sleep(wait * 1000, this.abort.signal);
        await this.api("chat.postMessage", "bot", { channel: peer, text: part });
      }
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.ws?.close(1000);
    this.state = "stopped";
  }
}
