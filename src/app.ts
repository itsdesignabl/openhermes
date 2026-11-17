import path from "node:path";
import { buildSystemPrompt } from "./agent/context.js";
import { runTurn, type TurnResult } from "./agent/loop.js";
import { Session } from "./agent/session.js";
import { Bus } from "./kernel/bus.js";
import { configPath, loadConfig, loadPolicies, policiesPath, readSecret, type Config, type Policies } from "./kernel/config.js";
import type { Home } from "./kernel/home.js";
import { loadPlugins, type Plugin, type Registry } from "./kernel/plugins.js";
import { PolicyEngine, type Approver } from "./kernel/policy.js";
import { MemoryIndex } from "./memory/index.js";
import { LocalModel } from "./model/local.js";
import { OpenAIProvider, type Provider } from "./provider/openai.js";
import { builtinTools } from "./tools/builtin.js";
import type { ToolContext } from "./tools/types.js";
import { VaultHistory } from "./vault/git.js";
import { VaultWatcher } from "./vault/watcher.js";

export interface AppOptions {
  approver?: Approver;
  /** Use this provider instead of the configured one (tests, evaluation). */
  provider?: Provider;
  watch?: boolean;
}

const corePlugin: Plugin = {
  name: "core-tools",
  setup(api) {
    for (const tool of builtinTools) api.registerTool(tool);
  },
};

/** The running agent: kernel, plugins, memory, history and one conversation. */
export class App {
  readonly bus = new Bus();
  config: Config;
  policies: Policies;
  registry!: Registry;
  memory!: MemoryIndex;
  history!: VaultHistory;
  session!: Session;
  private watcher?: VaultWatcher;
  private localModel: LocalModel;
  private provider?: Provider;
  private policy: PolicyEngine;
  private busy = false;

  private constructor(readonly home: Home, private opts: AppOptions) {
    this.config = loadConfig(home);
    this.policies = loadPolicies(home);
    this.localModel = new LocalModel(home, () => this.config);
    const approver: Approver = async (action, detail) => {
      await this.bus.emit("approval.requested", { sessionId: this.session.id, action, detail });
      const approved = opts.approver ? await opts.approver(action, detail) : false;
      await this.bus.emit("approval.resolved", { sessionId: this.session.id, action, approved });
      return approved;
    };
    this.policy = new PolicyEngine(() => this.policies, approver);
  }

  static async start(home: Home, opts: AppOptions = {}): Promise<App> {
    if (!home.exists()) throw new Error(`No OpenHermes home at ${home.root}. Run: openhermes init`);
    const app = new App(home, opts);
    app.registry = await loadPlugins(home, app.bus, () => app.config, [corePlugin]);
    app.memory = new MemoryIndex(path.join(home.data, "index.db"), home.vault);
    app.memory.sync();
    app.history = new VaultHistory(home.vault);
    await app.history.init();
    app.session = new Session(home, app.config.agent);
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
      const providerChanged = JSON.stringify(config.provider) !== JSON.stringify(this.config.provider);
      this.config = config;
      this.policies = policies;
      if (providerChanged) this.provider = undefined;
      void this.bus.emit("config.reloaded", { ok: true });
    } catch (err) {
      void this.bus.emit("config.reloaded", { ok: false, error: (err as Error).message });
    }
  }

  async getProvider(): Promise<Provider> {
    if (this.opts.provider) return this.opts.provider;
    if (this.provider) return this.provider;
    if (this.registry.providerFactory) return (this.provider = this.registry.providerFactory());
    const p = this.config.provider;
    const baseUrl =
      p.base_url || (await this.localModel.ensureRunning((message) => void this.bus.emit("log", { level: "info", message })));
    return (this.provider = new OpenAIProvider({
      baseUrl,
      model: p.model,
      apiKey: readSecret(this.home, p.api_key_secret),
      temperature: p.temperature,
      timeoutMs: p.request_timeout_s * 1000,
    }));
  }

  modelLabel(): string {
    if (this.opts.provider) return "custom provider";
    return this.config.provider.base_url ? `${this.config.provider.model} @ ${this.config.provider.base_url}` : "bundled local model";
  }

  newSession(): void {
    this.session = new Session(this.home, this.config.agent);
  }

  async send(text: string, signal?: AbortSignal): Promise<TurnResult> {
    if (this.busy) throw new Error("A turn is already running.");
    this.busy = true;
    try {
      const provider = await this.getProvider();
      const ctx: ToolContext = {
        home: this.home,
        config: () => this.config,
        policy: this.policy,
        memory: this.memory,
        agentName: this.config.agent,
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
      const result = await runTurn({
        sessionId: this.session.id,
        system: buildSystemPrompt(this.home, this.config.agent),
        history: this.session.history,
        userText: text,
        tools: [...this.registry.tools.values()],
        provider,
        bus: this.bus,
        toolContext: ctx,
        maxSteps: this.config.agent_loop.max_steps,
        maxToolOutputChars: this.config.agent_loop.max_tool_output_chars,
        signal,
      });
      this.session.append(result.messages);
      this.watcher?.markAgentWrite(this.session.file);
      this.history.touch(this.session.file);
      this.memory.update(this.session.file);
      await this.history.commit(`Turn: ${text.replace(/\s+/g, " ").slice(0, 60)}`);
      return result;
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.watcher?.stop();
    this.localModel.stop();
    this.memory.close();
  }
}
