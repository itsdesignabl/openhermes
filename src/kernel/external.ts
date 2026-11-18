import type { Home } from "./home.js";
import { JsonRpcProcess } from "./rpc.js";

export interface ExternalSpec {
  name: string;
  command: string[];
  timeout_s: number;
}

export interface ExternalManifest {
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  hooks: string[];
}

export const PROTOCOL_VERSION = 1;

/**
 * A plugin that runs as a separate program in any language. The two sides exchange JSON-RPC 2.0
 * messages, one per line, over the program's stdin and stdout. See docs/PLUGINS.md.
 */
export class ExternalPlugin {
  private rpc: JsonRpcProcess;
  private stopped = false;
  manifest: ExternalManifest = { tools: [], hooks: [] };

  constructor(
    private home: Home,
    readonly spec: ExternalSpec,
    private log: (level: "info" | "warn" | "error", message: string) => void,
  ) {
    const label = `plugin '${spec.name}'`;
    this.rpc = new JsonRpcProcess({
      command: spec.command,
      cwd: home.runtime,
      env: { OPENHERMES_HOME: home.root },
      onStderr: (line) => log("warn", `${label}: ${line.slice(0, 500)}`),
      onBadLine: (line) => log("warn", `${label} wrote a line that is not JSON: ${line.slice(0, 200)}`),
      onExit: (code) => log("warn", `${label} stopped (exit code ${code}). It is started again when next needed.`),
      onNotification: (method, params) => {
        if (method !== "log") return;
        const level = ["info", "warn", "error"].includes(params?.level) ? params.level : "info";
        log(level, `${label}: ${String(params?.message ?? "").slice(0, 500)}`);
      },
    });
  }

  /** Starts the program and asks what it offers. */
  async start(): Promise<ExternalManifest> {
    this.rpc.start();
    const result = await this.rpc.request("initialize", { protocol: PROTOCOL_VERSION, home: this.home.root }, 20);
    this.manifest = {
      tools: Array.isArray(result?.tools) ? result.tools : [],
      hooks: Array.isArray(result?.hooks) ? result.hooks.map(String) : [],
    };
    return this.manifest;
  }

  /** Sends a request. A plugin that has stopped is started again once. */
  async call(method: string, params: unknown): Promise<any> {
    if (!this.rpc.running && !this.stopped) await this.start();
    return this.rpc.request(method, params, this.spec.timeout_s).catch((err: Error) => {
      throw new Error(err.message.replace("the program", "the plugin program"));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.rpc.stop(() => this.rpc.notify("shutdown"));
  }
}
