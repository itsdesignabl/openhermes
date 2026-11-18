import path from "node:path";
import { buildSystemPrompt } from "./agent/context.js";
import { runTurn, type TurnResult } from "./agent/loop.js";
import { recentHistory, Session } from "./agent/session.js";
import { Bus } from "./kernel/bus.js";
import {
  AgentSettingsSchema, configPath, loadAgentSettings, loadConfig, loadPolicies, policiesPath, readSecret,
  type AgentSettings, type Config, type Policies,
} from "./kernel/config.js";
import type { Home } from "./kernel/home.js";
import { loadPlugins, type Plugin, type Registry } from "./kernel/plugins.js";
import { PolicyEngine, type Approver } from "./kernel/policy.js";
import { MemoryIndex } from "./memory/index.js";
import { LocalModel } from "./model/local.js";
import { OpenAIProvider, type Provider } from "./provider/openai.js";
import { DiscordChannel } from "./channels/discord.js";
import { TelegramChannel } from "./channels/telegram.js";
import { builtinTools } from "./tools/builtin.js";
import type { ToolContext } from "./tools/types.js";
import { VaultHistory } from "./vault/git.js";
import { VaultWatcher } from "./vault/watcher.js";

export interface AppOptions {
  /** Used when a turn does not bring its own way of asking the user. */
  approver?: Approver;
  /** Use this provider instead of the configured one (tests, evaluation). */
  provider?: Provider;
  watch?: boolean;
}

export interface SendOptions {
  /** Conversation key. Default: "<default agent>:local". */
  conversation?: string;
  /** Agent to use when the conversation does not exist yet. */
  agent?: string;
  approver?: Approver;
  signal?: AbortSignal;
  /** Extra text placed after the system prompt for this turn only (used by scheduled runs). */
  systemNote?: string;
  /** Keep the message list on disk so the conversation survives a restart. */
  persist?: boolean;
}

const corePlugin: Plugin = {
  name: "core-tools",
  setup(api) {
    for (const tool of builtinTools) api.registerTool(tool);
  },
};

const channelsPlugin: Plugin = {
  name: "core-channels",
  setup(api) {
    api.registerChannel("telegram", (ctx) => new TelegramChannel(ctx));
    api.registerChannel("discord", (ctx) => new DiscordChannel(ctx));
  },
};

export const LOCAL_SUFFIX = ":local";

/** The running agent system: kernel, plugins, memory, history and any number of conversations. */
export class App {
  readonly bus = new Bus();
  config: Config;
  policies: Policies;
  registry!: Registry;
  memory!: MemoryIndex;
  history!: VaultHistory;
  private sessions = new Map<string, Session>();
  private watcher?: VaultWatcher;
  private localModel: LocalModel;
  private providers = new Map<string, Provider>();
  /** Turns run one at a time: one local model, one vault history. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly home: Home, private opts: AppOptions) {
    this.config = loadConfig(home);
    this.policies = loadPolicies(home);
    this.localModel = new LocalModel(home, () => this.config);
  }

  static async start(home: Home, opts: AppOptions = {}): Promise<App> {
    if (!home.exists()) throw new Error(`No OpenHermes home at ${home.root}. Run: openhermes init`);
    const app = new App(home, opts);
    app.registry = await loadPlugins(home, app.bus, () => app.config, [corePlugin, channelsPlugin]);
    app.memory = new MemoryIndex(path.join(home.data, "index.db"), home.vault);
    app.memory.sync();
    app.history = new VaultHistory(home.vault);
    await app.history.init();
    if (opts.watch !== false) {
      app.watcher = new VaultWatcher(home.vault, (abs, by) => void app.onFileChanged(abs, by));
      app.watcher.start();
    }
    return app;
  }

  private async onFileChanged(abs: string, by: "agent" | "user"): Promise<void> {
    try {
      this.memory.update(abs);
    } catch {
      // a file that vanished or is mid-write is picked up by the next change event
    }
    if (abs === configPath(this.home) || abs === policiesPath(this.home)) this.reloadConfig();
    await this.bus.emit("file.changed", { path: abs, by });
  }

  /** A broken edit keeps the last good settings and is reported. */
  reloadConfig(): void {
    try {
      const config = loadConfig(this.home);
      const policies = loadPolicies(this.home);
      this.config = config;
      this.policies = policies;
      void this.bus.emit("config.reloaded", { ok: true });
    } catch (err) {
      void this.bus.emit("config.reloaded", { ok: false, error: (err as Error).message });
    }
  }

  get defaultAgent(): string {
    return this.config.routing.default_agent || this.config.agent;
  }

  /** Settings for one agent. A broken agent.md falls back to the defaults and is reported. */
  agentSettings(agent: string): AgentSettings {
    try {
      return loadAgentSettings(this.home, agent);
    } catch (err) {
      void this.bus.emit("log", { level: "error", message: `Agents/${agent}/agent.md is not valid, using defaults: ${(err as Error).message}` });
      return loadAgentSettingsDefaults();
    }
  }

  async getProvider(agent: string = this.defaultAgent): Promise<Provider> {
    if (this.opts.provider) return this.opts.provider;
    if (this.registry.providerFactory) return this.registry.providerFactory();
    const base = this.config.provider;
    const over = this.agentSettings(agent).provider;
    const p = {
      base_url: over.base_url ?? base.base_url,
      model: over.model ?? base.model,
      api_key_secret: over.api_key_secret ?? base.api_key_secret,
      temperature: over.temperature ?? base.temperature,
    };
    const key = JSON.stringify(p);
    const cached = this.providers.get(key);
    if (cached) return cached;
    const baseUrl = p.base_url || (await this.localModel.ensureRunning((message) => void this.bus.emit("log", { level: "info", message })));
    const provider = new OpenAIProvider({
      baseUrl,
      model: p.model,
      apiKey: readSecret(this.home, p.api_key_secret),
      temperature: p.temperature,
      timeoutMs: base.request_timeout_s * 1000,
    });
    this.providers.set(key, provider);
    return provider;
  }

  modelLabel(): string {
    if (this.opts.provider) return "custom provider";
    return this.config.provider.base_url ? `${this.config.provider.model} @ ${this.config.provider.base_url}` : "bundled local model";
  }

  /** The conversation for a key, created on first use. */
  conversation(key: string, agent?: string, resume = false): Session {
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = new Session(this.home, key, agent ?? this.defaultAgent, { resume })));
    return s;
  }

  /** The local conversation used by `chat` and `ask`. */
  get session(): Session {
    return this.conversation(this.defaultAgent + LOCAL_SUFFIX);
  }

  newSession(key: string = this.defaultAgent + LOCAL_SUFFIX): void {
    this.conversation(key).reset();
  }

  send(text: string, options: SendOptions | AbortSignal = {}): Promise<TurnResult> {
    const o: SendOptions = options instanceof AbortSignal ? { signal: options } : options;
    const run = this.queue.then(() => this.turn(text, o));
    this.queue = run.catch(() => {});
    return run;
  }

  private async turn(text: string, o: SendOptions): Promise<TurnResult> {
    const session = this.conversation(o.conversation ?? (o.agent ?? this.defaultAgent) + LOCAL_SUFFIX, o.agent, o.persist);
    const agent = session.agentName;
    const settings = this.agentSettings(agent);
    const provider = await this.getProvider(agent);
    const ask = o.approver ?? this.opts.approver;
    const policy = new PolicyEngine(
      () => this.policies,
      async (action, detail) => {
        await this.bus.emit("approval.requested", { sessionId: session.id, action, detail });
        const approved = ask ? await ask(action, detail) : false;
        await this.bus.emit("approval.resolved", { sessionId: session.id, action, approved });
        return approved;
      },
    );
    const ctx: ToolContext = {
      home: this.home,
      config: () => this.config,
      policy,
      memory: this.memory,
      agentName: agent,
      userText: text,
      wrote: (abs) => {
        this.watcher?.markAgentWrite(abs);
        this.history.touch(abs);
        try {
          this.memory.update(abs);
        } catch {
          // indexing is best effort; the next sync repairs it
        }
      },
    };
    let tools = [...this.registry.tools.values()];
    if (settings.tools) tools = tools.filter((t) => settings.tools!.includes(t.name));
    const system = buildSystemPrompt(this.home, agent) + (o.systemNote ? `\n\n${o.systemNote}` : "");
    try {
      const result = await runTurn({
        sessionId: session.id,
        system,
        history: recentHistory(session.history, this.config.session.history_max_chars),
        userText: text,
        tools,
        provider,
        bus: this.bus,
        toolContext: ctx,
        maxSteps: this.config.agent_loop.max_steps,
        maxToolOutputChars: this.config.agent_loop.max_tool_output_chars,
        signal: o.signal,
      });
      session.append(result.messages, o.persist ?? false);
      this.watcher?.markAgentWrite(session.file);
      this.history.touch(session.file);
      this.memory.update(session.file);
      return result;
    } finally {
      // files written before a failure are still recorded in the history
      await this.history.commit(`Turn (${agent}): ${text.replace(/\s+/g, " ").slice(0, 60)}`).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.watcher?.stop();
    await this.queue;
    this.localModel.stop();
    this.memory.close();
  }
}

function loadAgentSettingsDefaults(): AgentSettings {
  return AgentSettingsSchema.parse({});
}
