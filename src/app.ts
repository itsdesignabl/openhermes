import path from "node:path";
import { buildSystemPrompt } from "./agent/context.js";
import { Calibration, contextBudget, conversationSize, type ContextBudget } from "./agent/budget.js";
import { runTurn, toolSpecs, type TurnResult } from "./agent/loop.js";
import { renderTranscript } from "./learning/reflect.js";
import { historyToKeep, recentHistory, Session } from "./agent/session.js";
import { Bus } from "./kernel/bus.js";
import { Gate, gated } from "./kernel/gate.js";
import { SettingsGuard } from "./kernel/guard.js";
import { exec } from "./backend/exec.js";
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
import { DockerBackend } from "./backend/docker.js";
import { LocalBackend } from "./backend/local.js";
import { SshBackend } from "./backend/ssh.js";
import type { Backend } from "./backend/types.js";
import { formatNote, parseNote } from "./vault/frontmatter.js";
import fs from "node:fs";
import { DiscordChannel } from "./channels/discord.js";
import { SlackChannel } from "./channels/slack.js";
import { TelegramChannel } from "./channels/telegram.js";
import { builtinTools } from "./tools/builtin.js";
import type { ToolContext } from "./tools/types.js";
import { Learner } from "./learning/learner.js";
import { recordSkillUse } from "./learning/curator.js";
import { stampSkill } from "./learning/proposals.js";
import { recordTurn } from "./eval/metrics.js";
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

const backendsPlugin: Plugin = {
  name: "core-backends",
  setup(api) {
    api.registerBackend("local", () => new LocalBackend(api.home));
    api.registerBackend("docker", () => new DockerBackend(api.home, api.config));
    api.registerBackend("ssh", () => new SshBackend(api.config));
  },
};

const channelsPlugin: Plugin = {
  name: "core-channels",
  setup(api) {
    api.registerChannel("telegram", (ctx) => new TelegramChannel(ctx));
    api.registerChannel("discord", (ctx) => new DiscordChannel(ctx));
    api.registerChannel("slack", (ctx) => new SlackChannel(ctx));
  },
};

export const LOCAL_SUFFIX = ":local";

export const UNSANDBOXED_WARNING =
  "Commands the agent runs are NOT sandboxed: Docker was not found, so they run directly on this computer and can reach any file you can. " +
  "Each one is still checked against your policies, and the agent's own settings are put back if a command changes them. " +
  "To confine commands, install and start Docker Desktop. To accept this and stop the warning, set backend.type: local in System/config.md.";
/** Queue name for background work. No conversation key can equal it. */
const BACKGROUND = "\u0000background";

/** What one turn has written and read, kept per turn because turns of different conversations overlap. */
interface TurnState {
  files: Set<string>;
  skills: Set<string>;
}

/** The running agent system: kernel, plugins, memory, history and any number of conversations. */
export class App {
  readonly bus = new Bus();
  config: Config;
  policies: Policies;
  registry!: Registry;
  memory!: MemoryIndex;
  history!: VaultHistory;
  learner!: Learner;
  private sessions = new Map<string, Session>();
  private watcher?: VaultWatcher;
  private localModel: LocalModel;
  private providers = new Map<string, Provider>();
  private activeBackend?: Backend;
  /** How many characters this model's tokens cover, learned from the endpoint's own counts. */
  readonly calibration: Calibration;
  /** Messages logged while starting (for example a plugin that failed to load), for interfaces that attach afterwards. */
  readonly startupLogs: { level: "info" | "warn" | "error"; message: string }[] = [];
  /**
   * One queue per conversation, so a turn that is busy, or waiting for an approval, holds up only
   * its own conversation. Background work (reviews, cleanup, Inbox decisions) has a queue of its own.
   */
  private lanes = new Map<string, Promise<unknown>>();
  /** Hands requests to the model over one at a time (or as many as provider.max_parallel allows). */
  private modelGate = new Gate(() => this.config.provider.max_parallel);
  private gatedProviders = new WeakMap<Provider, Provider>();
  /** Puts the agent's own settings back if a command that ran on this computer changed them. */
  readonly guard: SettingsGuard;
  /** With backend.type "auto": what was found, and when it was last checked. */
  private sandbox: { choice: "docker" | "local"; checkedAt: number; probing?: Promise<void> } = { choice: "local", checkedAt: 0 };
  /** Turns that have finished but whose follow-up work has not been queued yet. */
  private followUps = 0;

  private constructor(readonly home: Home, private opts: AppOptions) {
    this.config = loadConfig(home);
    this.policies = loadPolicies(home);
    this.localModel = new LocalModel(home, () => this.config);
    this.calibration = new Calibration(home.data);
    this.guard = new SettingsGuard(home, () => {
      // changes to these files were not acted on while a command ran: look at the settled state now
      this.reloadConfig();
      void this.learner?.scanInbox().catch(() => {});
    }, (files) => {
      void this.bus.emit("log", {
        level: "error",
        message: `A command the agent ran changed files that control it (${files.join(", ")}). The changes were undone. If you edited one of these yourself in the last moments, please make your change again.`,
      });
    });
  }

  static async start(home: Home, opts: AppOptions = {}): Promise<App> {
    if (!home.exists()) throw new Error(`No OpenHermes home at ${home.root}. Run: openhermes init`);
    const app = new App(home, opts);
    const stopCollecting = app.bus.on("log", (e) => void app.startupLogs.push(e));
    app.registry = await loadPlugins(home, app.bus, () => app.config, [corePlugin, backendsPlugin, channelsPlugin], (name) => readSecret(home, name));
    app.memory = new MemoryIndex(path.join(home.data, "index.db"), home.vault);
    app.memory.sync();
    app.history = new VaultHistory(home.vault);
    await app.history.init();
    app.learner = new Learner(app);
    if (app.config.backend.type === "auto") {
      await app.probeSandbox();
      if (app.sandbox.choice === "local") void app.bus.emit("log", { level: "warn", message: UNSANDBOXED_WARNING });
    }
    void app.learner.scanInbox().catch(() => {});
    if (opts.watch !== false) {
      app.watcher = new VaultWatcher(home.vault, (abs, by) => void app.onFileChanged(abs, by));
      app.watcher.start();
    }
    stopCollecting();
    return app;
  }

  private async onFileChanged(abs: string, by: "agent" | "user"): Promise<void> {
    try {
      this.memory.update(abs);
    } catch {
      // a file that vanished or is mid-write is picked up by the next change event
    }
    // While a command runs on this computer, changes to the agent's own settings are not acted on:
    // if the command made them they are about to be undone, and the settled state is read afterwards.
    const held = this.guard.active && this.guard.covers(abs);
    if (!held && (abs === configPath(this.home) || abs === policiesPath(this.home))) this.reloadConfig();
    // a decision typed into an Inbox note in Obsidian
    if (!held && by === "user" && path.dirname(abs) === path.join(this.home.vault, "Inbox")) void this.learner.scanInbox().catch(() => {});
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

  /** The model for an agent. Every request made through it waits its turn at the model gate. */
  async getProvider(agent: string = this.defaultAgent): Promise<Provider> {
    const raw = await this.rawProvider(agent);
    let wrapped = this.gatedProviders.get(raw);
    if (!wrapped) this.gatedProviders.set(raw, (wrapped = gated(raw, this.modelGate)));
    return wrapped;
  }

  private async rawProvider(agent: string): Promise<Provider> {
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

  /**
   * Looks for a running Docker, for backend.type "auto". OPENHERMES_AUTO_BACKEND=local or =docker
   * settles the question without looking.
   */
  async probeSandbox(): Promise<"docker" | "local"> {
    const forced = process.env.OPENHERMES_AUTO_BACKEND;
    let choice: "docker" | "local";
    if (forced === "local" || forced === "docker") choice = forced;
    else {
      const r = await exec(this.config.backend.docker.binary, ["version", "--format", "{{.Server.Version}}"], { timeoutS: 8 });
      choice = r.code === 0 && r.output.trim() ? "docker" : "local";
    }
    const before = this.sandbox;
    this.sandbox = { choice, checkedAt: Date.now() };
    if (before.checkedAt && before.choice !== choice) {
      void this.bus.emit("log", choice === "docker"
        ? { level: "info", message: "Docker is now running: commands run in the sandbox from here on." }
        : { level: "warn", message: `Docker is no longer running. ${UNSANDBOXED_WARNING}` });
    }
    return choice;
  }

  /** "auto" resolved to what is in use right now. */
  backendType(): string {
    const type = this.config.backend.type;
    if (type !== "auto") return type;
    // Without a sandbox, look again now and then in the background: Docker may have been started since.
    if (this.sandbox.choice === "local" && Date.now() - this.sandbox.checkedAt > 5 * 60_000 && !this.sandbox.probing) {
      this.sandbox.probing = this.probeSandbox().then(() => {}, () => {});
    }
    return this.sandbox.choice;
  }

  /** Where shell commands run. A change of the setting, or of what "auto" finds, takes effect on the next command. */
  get backend(): Backend {
    const type = this.backendType();
    if (this.activeBackend?.name === type) return this.activeBackend;
    const factory = this.registry.backends.get(type);
    if (!factory) {
      void this.bus.emit("log", { level: "error", message: `backend.type '${type}' is not known (available: ${[...this.registry.backends.keys()].join(", ")}). Commands are refused until it is corrected.` });
      return { name: type, sandboxed: true, vaultWritable: false, describe: () => "", run: async () => ({ code: null, output: `Commands cannot run: backend.type '${type}' in System/config.md is not known.` }), check: async () => `backend.type '${type}' is not known`, stop: async () => {} };
    }
    void this.activeBackend?.stop().catch(() => {});
    return (this.activeBackend = factory());
  }

  /** The user answered "always": add the command or tool to its allowlist in System/policies.md. */
  private allowAlways(action: string, key: string, turn?: TurnState): void {
    const field = action === "mcp.call" ? "mcp_allowlist" : "command_allowlist";
    try {
      const file = policiesPath(this.home);
      const note = parseNote<Record<string, any>>(fs.readFileSync(file, "utf8"));
      const list: string[] = Array.isArray(note.data[field]) ? note.data[field].map(String) : [];
      if (list.includes(key)) return;
      note.data[field] = [...list, key];
      fs.writeFileSync(file, formatNote(note.data, note.body));
      this.recordWrite(file, turn);
      this.reloadConfig();
      void this.bus.emit("log", { level: "info", message: `Added to the ${action === "mcp.call" ? "tool" : "command"} allowlist: ${key}` });
    } catch (err) {
      void this.bus.emit("log", { level: "error", message: `Could not add to the allowlist: ${(err as Error).message}` });
    }
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

  /** Starts a conversation afresh at once. Use `resetWhenIdle` when a turn may be running in it. */
  newSession(key: string = this.defaultAgent + LOCAL_SUFFIX): void {
    const session = this.conversation(key);
    this.learner.beforeReset(session);
    session.reset();
  }

  /** Starts a conversation afresh once the turn running in it, if any, has finished. */
  resetWhenIdle(key: string = this.defaultAgent + LOCAL_SUFFIX): Promise<void> {
    return this.inLane(key, async () => this.newSession(key));
  }

  conversations(): Session[] {
    return [...this.sessions.values()];
  }

  /** Runs `fn` after whatever is already queued under `key`. */
  private inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return run;
  }

  /**
   * Runs background work (a review, the cleanup, an Inbox decision) after the background work queued
   * before it. It does not wait for conversations, and conversations do not wait for it.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.inLane(BACKGROUND, fn);
  }

  /** Resolves when nothing is running or queued: no turn in any conversation and no background work. */
  async idle(): Promise<void> {
    while (this.lanes.size || this.followUps) {
      if (this.lanes.size) await Promise.all([...this.lanes.values()]);
      else await new Promise((r) => setImmediate(r)); // follow-up work of a finished turn is about to be queued
    }
  }

  /**
   * Call after writing a file in the home folder, so it is indexed, versioned and not mistaken for a user edit.
   * Inside a turn the file is noted for that turn's own commit; otherwise for the next background commit.
   */
  recordWrite(abs: string, turn?: TurnState): void {
    this.watcher?.markAgentWrite(abs);
    if (turn) turn.files.add(abs);
    else this.history.touch(abs);
    try {
      this.memory.update(abs);
    } catch {
      // indexing is best effort; the next sync repairs it
    }
  }

  toolContext(agent: string, userText: string, approver: Approver | undefined, sessionId = "", sessionFile = "", turn?: TurnState): ToolContext {
    const policy = new PolicyEngine(
      () => this.policies,
      async (action, detail) => {
        await this.bus.emit("approval.requested", { sessionId, action, detail });
        const approved = approver ? await approver(action, detail) : false;
        await this.bus.emit("approval.resolved", { sessionId, action, approved: !!approved });
        return approved;
      },
      (action, key) => this.allowAlways(action, key, turn),
    );
    const skillPath = /^Skills\/([^/]+)\/SKILL\.md$/i;
    return {
      home: this.home,
      config: () => this.config,
      policy,
      memory: this.memory,
      backend: this.backend,
      guard: this.guard,
      agentName: agent,
      userText,
      wrote: (abs) => {
        const rel = path.relative(this.home.vault, abs).split(path.sep).join("/");
        if (skillPath.test(rel)) {
          try {
            stampSkill(abs, { agent, session: sessionFile });
          } catch {
            // a skill file without readable properties is left as the agent wrote it
          }
        }
        this.recordWrite(abs, turn);
      },
      read: (abs) => {
        const m = skillPath.exec(path.relative(this.home.vault, abs).split(path.sep).join("/"));
        if (m) {
          recordSkillUse(this.home, m[1]!);
          turn?.skills.add(m[1]!);
        }
      },
    };
  }

  send(text: string, options: SendOptions | AbortSignal = {}): Promise<TurnResult> {
    const o: SendOptions = options instanceof AbortSignal ? { signal: options } : options;
    // queued behind earlier turns of the same conversation only
    return this.inLane(o.conversation ?? (o.agent ?? this.defaultAgent) + LOCAL_SUFFIX, () => this.turn(text, o));
  }

  private async turn(text: string, o: SendOptions): Promise<TurnResult> {
    const session = this.conversation(o.conversation ?? (o.agent ?? this.defaultAgent) + LOCAL_SUFFIX, o.agent, o.persist);
    const agent = session.agentName;
    const provider = await this.getProvider(agent);
    const sessionFile = path.relative(this.home.vault, session.file).split(path.sep).join("/");
    // what this turn writes and reads is kept apart from other conversations running at the same time
    const state: TurnState = { files: new Set(), skills: new Set() };
    const ctx = this.toolContext(agent, text, o.approver ?? this.opts.approver, session.id, sessionFile, state);
    const tools = this.agentTools(agent);
    const system = this.systemFor(session, agent) + (o.systemNote ? `\n\n${o.systemNote}` : "");
    const budget = this.budgetFor(agent, system, tools);
    // room for this turn: the user's message comes off the top, and one tool result may take at most 40% of what is left
    const room = Math.max(1000, budget.conversationChars - text.length);
    const historyCap = this.config.session.history_max_chars;
    const hooks = this.registry.hooks;
    const hookInfo = { agent, conversation: session.key };
    let succeeded = false;
    try {
      const before = await hooks.run("turn.before", { ...hookInfo, text });
      if (typeof before.text === "string") text = before.text;
      ctx.userText = text;
      const result = await runTurn({
        hooks,
        hookInfo,
        sessionId: session.id,
        system,
        history: historyCap > 0 ? recentHistory(session.history, historyCap) : session.history,
        budgetChars: budget.conversationChars,
        onMeasured: (chars, tokens) => this.calibration.update(chars, tokens),
        userText: text,
        tools,
        provider,
        bus: this.bus,
        toolContext: ctx,
        maxSteps: this.config.agent_loop.max_steps,
        maxToolOutputChars: Math.min(this.config.agent_loop.max_tool_output_chars, Math.floor(room * 0.4)),
        signal: o.signal,
      });
      session.append(result.messages, o.persist ?? false);
      this.recordWrite(session.file, state);
      recordTurn(this.home, {
        at: new Date().toISOString(),
        agent,
        kind: /:(heartbeat|job):/.exec(session.key)?.[1] ?? (session.key.endsWith(LOCAL_SUFFIX) || session.key.endsWith(":obsidian") ? "local" : "chat"),
        ok: true,
        model_calls: result.usage.modelCalls,
        tool_calls: result.toolsUsed.length,
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        estimated: result.usage.estimated,
        ms: result.usage.ms,
        elided: result.usage.elided,
        dropped_turns: result.usage.droppedTurns,
        skills: [...state.skills],
      });
      await hooks.run("turn.after", { ...hookInfo, text: result.text, tools_used: result.toolsUsed });
      succeeded = true;
      return result;
    } finally {
      // files written before a failure are still recorded in the history
      await this.history.commitFiles(`Turn (${agent}): ${text.replace(/\s+/g, " ").slice(0, 60)}`, state.files).catch(() => {});
      // Follow-up work starts only now, when the turn is complete, so its messages (such as
      // "something is waiting for your approval") cannot overtake the turn's own reply.
      if (succeeded) {
        this.followUps++;
        setImmediate(() => {
          this.followUps--;
          this.afterTurn(session, agent, budget.conversationChars);
        });
      }
    }
  }

  private afterTurn(session: Session, agent: string, roomChars: number): void {
    this.learner.afterTurn(session);
    // Earlier turns that will not fit next time are summarised now, in the background, not while the user waits.
    if (this.config.session.summarize && !/:(heartbeat|job):/.test(session.key) && conversationSize(session.history) > roomChars * 0.8) {
      // in this conversation's own queue: its next turn waits for the summary, other conversations do not
      void this.inLane(session.key, () => this.compact(session, agent)).catch((err) => void this.bus.emit("log", { level: "warn", message: `could not summarise the earlier conversation: ${(err as Error).message}` }));
    }
  }

  /** The model's context window for an agent: the bundled server's own setting, or what the settings say about the endpoint. */
  contextWindow(agent: string = this.defaultAgent): number {
    const usesBundled = !(this.agentSettings(agent).provider.base_url ?? this.config.provider.base_url);
    return usesBundled && !this.opts.provider ? this.config.local_model.context_tokens : this.config.provider.context_tokens;
  }

  private systemFor(session: Session | undefined, agent: string): string {
    const base = buildSystemPrompt(this.home, agent, this.backend.describe());
    return session?.summary ? `${base}\n\n## Earlier in this conversation\n\n${session.summary}` : base;
  }

  private agentTools(agent: string) {
    const allowed = this.agentSettings(agent).tools;
    const tools = [...this.registry.tools.values()];
    return allowed ? tools.filter((t) => allowed.includes(t.name)) : tools;
  }

  private budgetFor(agent: string, system: string, tools: ReturnType<App["agentTools"]>): ContextBudget {
    return contextBudget({
      windowTokens: this.contextWindow(agent),
      reserveTokens: this.config.provider.reserve_output_tokens,
      system,
      specs: toolSpecs(tools),
      charsPerToken: this.calibration.charsPerToken,
    });
  }

  /** How the window is divided for an agent right now, for `doctor`. */
  describeContext(agent: string = this.defaultAgent): ContextBudget {
    return this.budgetFor(agent, this.systemFor(undefined, agent), this.agentTools(agent));
  }

  /**
   * Replaces the older half of a conversation by a summary the model writes, so the gist stays in
   * view when the turns themselves no longer fit. The full text stays in the session note and in search.
   */
  private async compact(session: Session, agent: string): Promise<void> {
    const budget = this.budgetFor(agent, this.systemFor(session, agent), this.agentTools(agent));
    const keepChars = Math.floor(budget.conversationChars * 0.4);
    const keep = historyToKeep(session.history, keepChars);
    const count = session.history.length - keep.length;
    // The newest turn is the whole history and is already over the slice. It stays as messages.
    // A summary is written once beside it, for a later request that cannot fit the turn itself.
    const summarizeBeside = count === 0 && session.history.length > 0 && recentHistory(session.history, keepChars).length === 0 && !session.summary;
    if (count <= 0 && !summarizeBeside) return;
    this.learner.beforeCompaction(session);
    const old = session.history.slice(0, count > 0 ? count : session.history.length);
    // the summarising call has to fit the window too
    const room = Math.max(1500, Math.floor((budget.windowTokens - budget.reserveTokens - 400) * budget.charsPerToken) - session.summary.length);
    const provider = await this.getProvider(agent);
    const result = await provider.chat(
      [
        { role: "system", content: SUMMARY_PROMPT.replace("{max}", String(Math.round(this.config.session.summary_max_chars / 6))) },
        { role: "user", content: `${session.summary ? `Summary so far:\n${session.summary}\n\n` : ""}Conversation to add to the summary:\n${renderTranscript(old, room)}` },
      ],
      [],
    );
    const summary = result.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, this.config.session.summary_max_chars);
    if (!summary) return; // nothing usable: the turns stay, and are simply left out when they do not fit
    session.compact(count, summary);
  }

  async stop(): Promise<void> {
    this.watcher?.stop();
    await this.idle();
    await this.activeBackend?.stop().catch(() => {});
    await Promise.all(this.registry.externals.map((p) => p.stop().catch(() => {})));
    await Promise.all(this.registry.mcp.map((c) => c.stop().catch(() => {})));
    this.localModel.stop();
    this.memory.close();
  }
}

const SUMMARY_PROMPT =
  "You are keeping notes on a conversation between a user and their assistant, for the assistant to rely on later. " +
  "Write one updated summary that merges the summary so far with the new part. Keep what will matter later: what the user wants, " +
  "decisions made, facts, names, file paths, numbers, and anything still to be done. Leave out greetings and the wording of tool calls. " +
  "Plain sentences, at most {max} words. Reply with the summary only.";

function loadAgentSettingsDefaults(): AgentSettings {
  return AgentSettingsSchema.parse({});
}
