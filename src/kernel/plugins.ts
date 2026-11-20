import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Backend } from "../backend/types.js";
import { HookRunner, type HookEvent, type HookFn } from "../hooks/runner.js";
import { McpClient, mcpToolName } from "../mcp/client.js";
import { ExternalPlugin } from "./external.js";
import type { ChannelFactory } from "../channels/types.js";
import type { Provider } from "../provider/openai.js";
import type { Tool } from "../tools/types.js";
import type { Bus } from "./bus.js";
import type { Config } from "./config.js";
import type { Home } from "./home.js";

/** What a plugin receives. It adds to the registry and subscribes to bus events. */
export interface PluginApi {
  home: Home;
  bus: Bus;
  config: () => Config;
  registerTool(tool: Tool<any>): void;
  /** Add a chat channel. It is started by the gateway when channels.<name>.enabled is true, or always for channels the settings do not know. */
  registerChannel(name: string, factory: ChannelFactory): void;
  /** Add a place where shell commands can run, selected with backend.type in the settings. */
  registerBackend(name: string, factory: () => Backend): void;
  /** Run code before or after a turn or a tool call. A before-hook can change the input or refuse. */
  addHook(event: HookEvent, fn: HookFn, match?: string): void;
  /** Replace the model provider. The last plugin to call this wins. */
  setProvider(factory: () => Provider): void;
}

export interface Plugin {
  name: string;
  setup(api: PluginApi): void | Promise<void>;
}

export class Registry {
  readonly tools = new Map<string, Tool<any>>();
  readonly channels = new Map<string, ChannelFactory>();
  readonly backends = new Map<string, () => Backend>();
  readonly externals: ExternalPlugin[] = [];
  readonly mcp: McpClient[] = [];
  hooks!: HookRunner;
  providerFactory?: () => Provider;
  readonly loaded: string[] = [];
}

/**
 * Built-in features are registered through the same interface as user plugins.
 * User plugins are ES modules in runtime/plugins/, named in System/config.md.
 */
export async function loadPlugins(
  home: Home,
  bus: Bus,
  config: () => Config,
  builtins: Plugin[],
  secret: (name: string) => string | undefined = () => undefined,
): Promise<Registry> {
  const registry = new Registry();
  const log = (level: "info" | "warn" | "error", message: string) => void bus.emit("log", { level, message });
  registry.hooks = new HookRunner(home, config, log);
  let current = "";
  const api: PluginApi = {
    home,
    bus,
    config,
    registerTool: (tool) => void registry.tools.set(tool.name, tool),
    registerChannel: (name, factory) => void registry.channels.set(name, factory),
    registerBackend: (name, factory) => void registry.backends.set(name, factory),
    addHook: (event, fn, match) => registry.hooks.add(event, fn, `plugin ${current}`, match),
    setProvider: (factory) => void (registry.providerFactory = factory),
  };
  for (const plugin of builtins) {
    current = plugin.name;
    await plugin.setup(api);
    registry.loaded.push(plugin.name);
  }
  const dir = path.join(home.runtime, "plugins");
  for (const name of config().plugins) {
    try {
      const file = home.resolveInside(name.endsWith(".js") || name.endsWith(".mjs") ? name : `${name}.js`, dir);
      if (!fs.existsSync(file)) throw new Error(`not found in ${home.display(dir)}`);
      const mod = (await import(pathToFileURL(file).href)) as { default?: Plugin };
      if (!mod.default?.setup) throw new Error("module has no default export with a setup() function");
      current = mod.default.name ?? name;
      await mod.default.setup(api);
      registry.loaded.push(mod.default.name ?? name);
    } catch (err) {
      await bus.emit("log", { level: "error", message: `plugin '${name}' failed to load: ${(err as Error).message}` });
    }
  }
  for (const spec of config().external_plugins) {
    const plugin = new ExternalPlugin(home, spec, log);
    try {
      const manifest = await plugin.start();
      for (const t of manifest.tools) {
        if (typeof t?.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) throw new Error(`tool name '${t?.name}' is not valid`);
        if (registry.tools.has(t.name)) throw new Error(`tool '${t.name}' already exists`);
      }
      for (const t of manifest.tools) {
        registry.tools.set(t.name, {
          name: t.name,
          description: String(t.description ?? ""),
          schema: z.record(z.string(), z.unknown()),
          jsonSchema: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
          run: async (args) => {
            const result = await plugin.call("tool.call", { name: t.name, arguments: args });
            const content = result?.content ?? result;
            return typeof content === "string" ? content : JSON.stringify(content);
          },
        });
      }
      for (const event of manifest.hooks) {
        if (!["turn.before", "turn.after", "tool.before", "tool.after"].includes(event)) continue;
        registry.hooks.add(event as HookEvent, (ev, payload) => plugin.call("hook", { event: ev, payload }), `plugin ${spec.name}`);
      }
      registry.externals.push(plugin);
      registry.loaded.push(spec.name);
    } catch (err) {
      await plugin.stop().catch(() => {});
      await bus.emit("log", { level: "error", message: `plugin '${spec.name}' failed to load: ${(err as Error).message}` });
    }
  }
  // Tool servers are connected in parallel: one slow or broken server does not hold up the others.
  await Promise.all(
    config().mcp_servers.map(async (spec) => {
      let client: McpClient | undefined;
      try {
        client = new McpClient(home, spec, secret(spec.token_secret), log);
        const tools = (await client.listTools()).filter((t) => !spec.tools || spec.tools.includes(t.name));
        for (const t of tools) {
          const name = mcpToolName(spec.name, t.name);
          if (registry.tools.has(name)) {
            log("warn", `tool server '${spec.name}': the tool '${t.name}' is skipped because the name ${name} is taken`);
            continue;
          }
          const c = client;
          registry.tools.set(name, {
            name,
            // descriptions come from the server and are shown to the model: keep them short and labelled
            description: `[tool server ${spec.name}] ${t.description.replace(/\s+/g, " ").slice(0, 800)}`,
            schema: z.record(z.string(), z.unknown()),
            jsonSchema: t.inputSchema,
            run: async (args, ctx) => {
              if (!ctx.policy.mcpAllowed(name)) await ctx.policy.check("mcp.call", `use ${t.name} from the tool server '${spec.name}': ${JSON.stringify(args).slice(0, 300)}`, name);
              return c.callTool(t.name, args);
            },
          });
        }
        registry.mcp.push(client);
        registry.loaded.push(`mcp:${spec.name}`);
        log("info", `tool server '${spec.name}' connected with ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
      } catch (err) {
        await client?.stop().catch(() => {});
        log("error", `tool server '${spec.name}' failed to connect: ${(err as Error).message}`);
      }
    }),
  );
  return registry;
}
