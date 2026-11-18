import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Home } from "./home.js";

export interface ExternalSpec {
  name: string;
  command: string[];
  timeout_s: number;
}

export interface ExternalManifest {
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  hooks: string[];
}

interface Waiting {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export const PROTOCOL_VERSION = 1;

/**
 * A plugin that runs as a separate program in any language. The two sides exchange JSON-RPC 2.0
 * messages, one per line, over the program's stdin and stdout. See docs/PLUGINS.md.
 */
export class ExternalPlugin {
  private child?: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private stopped = false;
  manifest: ExternalManifest = { tools: [], hooks: [] };

  constructor(
    private home: Home,
    readonly spec: ExternalSpec,
    private log: (level: "info" | "warn" | "error", message: string) => void,
  ) {}

  /** Starts the program and asks what it offers. */
  async start(): Promise<ExternalManifest> {
    const child = spawn(this.spec.command[0]!, this.spec.command.slice(1), {
      cwd: this.home.runtime,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OPENHERMES_HOME: this.home.root },
    });
    this.child = child;
    const failAll = (reason: string) => {
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error(reason));
        this.waiting.delete(id);
      }
    };
    child.on("error", (err) => {
      this.child = undefined;
      failAll(`could not start: ${err.message}`);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      failAll(`the plugin program stopped (exit code ${code})`);
      if (!this.stopped) this.log("warn", `plugin '${this.spec.name}' stopped (exit code ${code}). It is started again when next needed.`);
    });
    child.stdin!.on("error", () => {});
    readline.createInterface({ input: child.stderr! }).on("line", (line) => this.log("warn", `plugin '${this.spec.name}': ${line.slice(0, 500)}`));
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.log("warn", `plugin '${this.spec.name}' wrote a line that is not JSON: ${line.slice(0, 200)}`);
      }
      if (msg.id !== undefined && this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id)!;
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(String(msg.error.message ?? "the plugin reported an error")));
        else w.resolve(msg.result);
      } else if (msg.method === "log") {
        const level = ["info", "warn", "error"].includes(msg.params?.level) ? msg.params.level : "info";
        this.log(level, `plugin '${this.spec.name}': ${String(msg.params?.message ?? "").slice(0, 500)}`);
      }
    });
    const result = await this.request("initialize", { protocol: PROTOCOL_VERSION, home: this.home.root }, 20);
    this.manifest = {
      tools: Array.isArray(result?.tools) ? result.tools : [],
      hooks: Array.isArray(result?.hooks) ? result.hooks.map(String) : [],
    };
    return this.manifest;
  }

  private request(method: string, params: unknown, timeoutS: number): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("the plugin program is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no answer within ${timeoutS}s`));
      }, timeoutS * 1000);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Sends a request. A plugin that has stopped is started again once. */
  async call(method: string, params: unknown): Promise<any> {
    if (!this.child && !this.stopped) await this.start();
    return this.request(method, params, this.spec.timeout_s);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "shutdown" }) + "\n");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.stdin!.end();
    });
  }
}
