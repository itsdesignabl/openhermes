import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  providerFactory?: () => Provider;
  readonly loaded: string[] = [];
}

/**
 * Built-in features are registered through the same interface as user plugins.
 * User plugins are ES modules in runtime/plugins/, named in System/config.md.
 */
export async function loadPlugins(home: Home, bus: Bus, config: () => Config, builtins: Plugin[]): Promise<Registry> {
  const registry = new Registry();
  const api: PluginApi = {
    home,
    bus,
    config,
    registerTool: (tool) => void registry.tools.set(tool.name, tool),
    registerChannel: (name, factory) => void registry.channels.set(name, factory),
    setProvider: (factory) => void (registry.providerFactory = factory),
  };
  for (const plugin of builtins) {
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
      await mod.default.setup(api);
      registry.loaded.push(mod.default.name ?? name);
    } catch (err) {
      await bus.emit("log", { level: "error", message: `plugin '${name}' failed to load: ${(err as Error).message}` });
    }
  }
  return registry;
}
