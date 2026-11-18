import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

interface Waiting {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Lines the program writes to standard error. */
  onStderr?: (line: string) => void;
  /** Messages from the program that are not answers to a request. */
  onNotification?: (method: string, params: any) => void;
  /** The program ended without being asked to. */
  onExit?: (code: number | null) => void;
  onBadLine?: (line: string) => void;
}

/** A child program that exchanges JSON-RPC 2.0 messages, one per line, on its stdin and stdout. */
export class JsonRpcProcess {
  private child?: ChildProcess;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private closing = false;

  constructor(private o: RpcOptions) {}

  get running(): boolean {
    return !!this.child;
  }

  start(): void {
    this.closing = false;
    // On Windows, launchers such as npx are .cmd files and are only found through the shell,
    // which does not quote arguments itself.
    const viaShell = process.platform === "win32";
    const [file, ...args] = viaShell ? this.o.command.map(quoteForCmd) : this.o.command;
    const child = spawn(file!, args, {
      cwd: this.o.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: viaShell,
      env: { ...process.env, ...this.o.env },
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
      if (this.child === child) this.child = undefined;
      failAll(`could not start: ${err.message}`);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      failAll(`the program stopped (exit code ${code})`);
      if (!this.closing) this.o.onExit?.(code);
    });
    child.stdin!.on("error", () => {});
    readline.createInterface({ input: child.stderr! }).on("line", (line) => this.o.onStderr?.(line));
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.o.onBadLine?.(line);
      }
      if (msg.id !== undefined && msg.method === undefined && this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id)!;
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(String(msg.error.message ?? "the program reported an error")));
        else w.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        if (msg.id !== undefined) {
          // a request from the program to us: nothing is supported in that direction
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
        } else this.o.onNotification?.(msg.method, msg.params);
      }
    });
  }

  private write(message: unknown): void {
    this.child?.stdin!.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: unknown, timeoutS: number): Promise<any> {
    if (!this.child) return Promise.reject(new Error("the program is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no answer within ${timeoutS}s`));
      }, timeoutS * 1000);
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Ends the program: closes its input, and kills it if it has not exited shortly after. */
  async stop(farewell?: () => void): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    farewell?.();
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

/** Quote one argument for cmd.exe so spaces and special characters survive. */
export function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}
