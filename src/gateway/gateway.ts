import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "../app.js";
import type { Channel, Inbound } from "../channels/types.js";
import { readSecret } from "../kernel/config.js";
import { GatewayHttp } from "./http.js";
import { Pairing } from "./pairing.js";
import { HEARTBEAT_OK, Scheduler, type ScheduledRun } from "./scheduler.js";

interface PendingApproval {
  resolve: (ok: boolean | "always") => void;
  canAlways: boolean;
  timer: NodeJS.Timeout;
}

export function gatewayInfoFile(dataDir: string): string {
  return path.join(dataDir, "gateway", "gateway.json");
}

/** Reads the access token for the local control API, creating it on first use. */
export function gatewayToken(secretsDir: string): string {
  const file = path.join(secretsDir, "gateway-token");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(secretsDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * The always-on process: connects chat channels, decides who may talk to which agent,
 * runs heartbeats and jobs, and serves the local control API.
 */
export class Gateway {
  readonly channels = new Map<string, Channel>();
  readonly pairing: Pairing;
  readonly scheduler: Scheduler;
  readonly startedAt = Date.now();
  private http: GatewayHttp;
  private approvals = new Map<string, PendingApproval>();
  private pairingReplies = new Map<string, number>();
  private lastPeerFile: string;
  private lastPeer: Record<string, string> = {};
  private stopping?: Promise<void>;
  private maintenance?: NodeJS.Timeout;
  onStopped: () => void = () => {};

  constructor(readonly app: App) {
    this.pairing = new Pairing(app.home);
    this.lastPeerFile = path.join(app.home.data, "gateway", "last-peer.json");
    try {
      this.lastPeer = JSON.parse(fs.readFileSync(this.lastPeerFile, "utf8"));
    } catch {}
    this.scheduler = new Scheduler(
      app.home,
      () => app.defaultAgent,
      (agent) => app.agentSettings(agent).heartbeat,
      (r) => this.runScheduled(r),
      (level, message) => this.log(level, message),
    );
    this.http = new GatewayHttp(this, gatewayToken(app.home.secrets));
  }

  log(level: "info" | "warn" | "error", message: string): void {
    void this.app.bus.emit("log", { level, message });
  }

  async start(opts: { scheduler?: boolean } = {}): Promise<{ host: string; port: number }> {
    const cfg = this.app.config.gateway;
    if (!isLoopback(cfg.host) && !cfg.allow_remote) {
      throw new Error(
        `gateway.host is ${cfg.host}, which makes the gateway reachable from other computers. ` +
          `Set gateway.allow_remote: true in System/config.md if that is intended, or use 127.0.0.1.`,
      );
    }
    const infoFile = gatewayInfoFile(this.app.home.data);
    const port = await this.http.listen(cfg.host, cfg.port);
    fs.mkdirSync(path.dirname(infoFile), { recursive: true });
    fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, host: cfg.host, port, started: new Date().toISOString() }));

    for (const [name, factory] of this.app.registry.channels) {
      const known = (this.app.config.channels as Record<string, { enabled: boolean } | undefined>)[name];
      if (known && !known.enabled) continue;
      const channel = factory({
        config: () => this.app.config,
        secret: (secretName) => readSecret(this.app.home, secretName),
        onMessage: (m) => void this.handleInbound(m).catch((err) => this.log("error", `${m.channel}: ${(err as Error).message}`)),
        log: (level, message) => this.log(level, message),
      });
      this.channels.set(name, channel);
      await channel.start().catch((err) => {
        channel.state = (err as Error).message;
        this.log("error", `${name} did not start: ${(err as Error).message}`);
      });
    }
    if (opts.scheduler !== false) {
      this.scheduler.start();
      this.maintenance = setInterval(() => this.app.learner.maintenance(new Date()), 60_000);
    }
    this.app.bus.on("proposal.created", (e) => void this.notifyProposal(e).catch(() => {}));
    return { host: cfg.host, port };
  }

  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.scheduler.stop();
      clearInterval(this.maintenance);
      for (const [key, p] of this.approvals) {
        clearTimeout(p.timer);
        p.resolve(false);
        this.approvals.delete(key);
      }
      await Promise.all([...this.channels.values()].map((c) => c.stop().catch(() => {})));
      await this.http.close();
      fs.rmSync(gatewayInfoFile(this.app.home.data), { force: true });
      this.onStopped();
    })());
  }

  /** Tell the user in their last chat that something is waiting for approval. */
  private async notifyProposal(e: { id: string; title: string; agent: string }): Promise<void> {
    if (!this.app.config.learning.notify) return;
    const target = this.resolveTarget("last", e.agent);
    if (!target) return;
    await target.channel.send(
      target.peer,
      `I would like to keep something from our conversation, and it needs your approval:\n\n${e.title}\n\nReply /approve ${e.id} or /reject ${e.id}. The full text is in the Inbox folder of the vault.`,
    );
  }

  private inboxText(): string {
    const pending = this.app.learner.pending();
    if (!pending.length) return "Nothing is waiting for approval.";
    return pending.map((i) => `${i.id}  ${i.title}`).join("\n") + "\n\nReply /approve <id> or /reject <id>.";
  }

  /** Which agent answers this chat. The first matching binding wins. */
  route(channel: string, peer: string): string {
    const { bindings } = this.app.config.routing;
    const hit = bindings.find((b) => b.channel === channel && (b.peer === undefined || b.peer === peer));
    return hit?.agent ?? this.app.defaultAgent;
  }

  private channelSettings(name: string) {
    const known = (this.app.config.channels as Record<string, any>)[name];
    return { allow_from: [] as string[], pairing: true, require_mention: true, ...(known ?? {}) } as {
      allow_from: string[];
      pairing: boolean;
      require_mention: boolean;
    };
  }

  private isAllowed(m: Inbound): boolean {
    return this.channelSettings(m.channel).allow_from.includes(m.sender) || this.pairing.isApproved(m.channel, m.sender);
  }

  async handleInbound(m: Inbound): Promise<void> {
    const channel = this.channels.get(m.channel);
    if (!channel || !m.text) return;
    const settings = this.channelSettings(m.channel);
    const chatKey = `${m.channel}:${m.peer}`;

    if (!this.isAllowed(m)) {
      // Unknown people never reach the agent. In a direct chat they get a pairing code, at most once every 10 minutes.
      if (m.isGroup || !settings.pairing) return;
      const who = `${m.channel}:${m.sender}`;
      if (Date.now() - (this.pairingReplies.get(who) ?? 0) < 600_000) return;
      const code = this.pairing.request(m.channel, m.sender, m.senderName);
      if (!code) return;
      this.pairingReplies.set(who, Date.now());
      this.log("info", `Pairing request from ${m.senderName} (${who}). Approve with: openhermes pair approve ${code}`);
      await channel.send(m.peer, `This assistant is private. To get access, ask its owner to approve this code:\n\n${code}`);
      return;
    }

    // A pending approval question takes the next message from an allowed person in that chat.
    const pending = this.approvals.get(chatKey);
    if (pending) {
      const answer = m.text.trim().toLowerCase();
      const always = pending.canAlways && /^always\b/.test(answer);
      const yes = /^(y|yes|ok|allow|approve)\b/.test(answer);
      const no = /^(n|no|deny|decline|stop)\b/.test(answer);
      if (always || yes || no) {
        clearTimeout(pending.timer);
        this.approvals.delete(chatKey);
        pending.resolve(always ? "always" : yes);
        return;
      }
      await channel.send(m.peer, `I am waiting for your decision on the request above. Reply yes or no${pending.canAlways ? ", or always" : ""}.`);
      return;
    }

    if (m.isGroup && settings.require_mention && !m.mentioned) return;

    const agent = this.route(m.channel, m.peer);
    const conversation = `${agent}:${chatKey}`;
    const command = m.text.trim().toLowerCase();
    if (command === "/new" || command === "/reset") {
      this.app.newSession(conversation);
      this.app.conversation(conversation, agent, true);
      return channel.send(m.peer, "Started a new conversation.");
    }
    if (command === "/start" || command === "/help") {
      return channel.send(
        m.peer,
        `You are talking to the agent '${agent}'. Send a message to begin.\n/new starts a fresh conversation.\n/inbox lists what is waiting for your approval.`,
      );
    }
    if (command === "/inbox") return channel.send(m.peer, this.inboxText());
    const decision = /^\/(approve|reject)\s+(\S+)$/.exec(command);
    if (decision) {
      try {
        const res = await this.app.learner.resolve(decision[2]!, decision[1] === "approve");
        return channel.send(m.peer, res.message);
      } catch (err) {
        return channel.send(m.peer, (err as Error).message);
      }
    }

    this.lastPeer[agent] = chatKey;
    fs.mkdirSync(path.dirname(this.lastPeerFile), { recursive: true });
    fs.writeFileSync(this.lastPeerFile, JSON.stringify(this.lastPeer));

    const typing = setInterval(() => void channel.typing?.(m.peer), 4000);
    void channel.typing?.(m.peer);
    try {
      const result = await this.app.send(m.isGroup ? `[${m.senderName}]: ${m.text}` : m.text, {
        conversation,
        agent,
        persist: true,
        approver: (action, detail) => this.askPeer(m.channel, m.peer, action, detail),
      });
      await channel.send(m.peer, result.text.trim() || "(I have nothing to add.)");
    } catch (err) {
      this.log("error", `turn for ${chatKey} failed: ${(err as Error).message}`);
      await channel.send(m.peer, `Something went wrong: ${(err as Error).message}`).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  /** Ask for approval in a chat and wait for a yes or no. No answer within the time limit counts as no. */
  async askPeer(channelName: string, peer: string, action: string, detail: string): Promise<boolean | "always"> {
    const channel = this.channels.get(channelName);
    if (!channel) return false;
    const key = `${channelName}:${peer}`;
    if (this.approvals.has(key)) return false;
    const timeoutS = this.app.config.gateway.approval_timeout_s;
    const canAlways = action.startsWith("command.");
    // Register the question before sending it, so even an immediate reply is taken as the answer.
    const answer = new Promise<boolean | "always">((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(key);
        resolve(false);
        void channel.send(peer, "No answer, so I did not do it.").catch(() => {});
      }, timeoutS * 1000);
      this.approvals.set(key, { resolve, timer, canAlways });
    });
    try {
      await channel.send(peer, `Approval needed (${action}):\n${detail}\n\nReply yes or no${canAlways ? ", or always to allow this command from now on" : ""}.`);
    } catch (err) {
      const pending = this.approvals.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.approvals.delete(key);
      }
      this.log("error", `could not ask for approval in ${key}: ${(err as Error).message}`);
      return false;
    }
    return answer;
  }

  private resolveTarget(target: string, agent: string): { channel: Channel; peer: string } | null {
    const spec = target === "last" ? this.lastPeer[agent] : target === "none" ? undefined : target;
    if (!spec) return null;
    const i = spec.indexOf(":");
    const channel = this.channels.get(spec.slice(0, i));
    return channel && i > 0 ? { channel, peer: spec.slice(i + 1) } : null;
  }

  /** Runs a heartbeat or job in its own fresh conversation and delivers the result. Returns a short status. */
  async runScheduled(r: ScheduledRun): Promise<string> {
    const target = this.resolveTarget(r.target, r.agent);
    const conversation = `${r.agent}:${r.kind}:${r.name}`;
    this.app.newSession(conversation);
    const result = await this.app.send(r.prompt, {
      conversation,
      agent: r.agent,
      approver: target ? (action, detail) => this.askPeer(target.channel.name, target.peer, action, detail) : undefined,
      systemNote:
        r.kind === "job"
          ? `This is the scheduled job '${r.name}', not a live message. Nobody is waiting to answer questions. Your reply is delivered to the user as the job's result.`
          : undefined,
    });
    const text = result.text.trim();
    if (r.kind === "heartbeat" && text.replace(HEARTBEAT_OK, "").trim().length < 20 && text.includes(HEARTBEAT_OK)) return "nothing to report";
    if (!text) return "no output";
    if (!target) return "done (not delivered: no target chat)";
    await target.channel.send(target.peer, text.replace(HEARTBEAT_OK, "").trim());
    return "delivered";
  }

  status() {
    return {
      pid: process.pid,
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      home: this.app.home.root,
      model: this.app.modelLabel(),
      default_agent: this.app.defaultAgent,
      channels: [...this.channels.values()].map((c) => ({ name: c.name, state: c.state })),
      jobs: this.scheduler.describe(),
    };
  }
}
