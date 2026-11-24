import type { Config } from "../kernel/config.js";
import { exec } from "./exec.js";
import { hitTimeLimit, type Backend, type RunResult } from "./types.js";

/** Quote a string for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs commands on another machine over SSH. Files there are separate from the home folder:
 * the vault is not visible to commands, and what commands create stays on that machine.
 */
export class SshBackend implements Backend {
  readonly name = "ssh";
  readonly sandboxed = false;
  readonly vaultWritable = false; // another machine: it cannot see the vault at all
  constructor(private config: () => Config) {}

  private get cfg() {
    return this.config().backend.ssh;
  }

  describe(): string {
    return `Shell commands run on a separate machine (${this.cfg.host}) over SSH, starting in ${this.cfg.workdir}. That machine cannot see the vault or the workspace folder, and files created there stay there.`;
  }

  /** Arguments for the ssh program, without the remote command. */
  baseArgs(): string[] {
    const c = this.cfg;
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-p", String(c.port)];
    if (c.identity_file) args.push("-i", c.identity_file);
    args.push(...c.extra_args, c.user ? `${c.user}@${c.host}` : c.host);
    return args;
  }

  async run(command: string, timeoutS: number): Promise<RunResult> {
    if (!this.cfg.host) return { code: null, output: "backend.ssh.host is not set in System/config.md." };
    const remote = `mkdir -p ${shellQuote(this.cfg.workdir)} && cd ${shellQuote(this.cfg.workdir)} && timeout -s KILL ${timeoutS} sh -c ${shellQuote(command)}`;
    const started = Date.now();
    const result = await exec(this.cfg.binary, [...this.baseArgs(), remote], { timeoutS: timeoutS + 20 });
    if (hitTimeLimit(result.code, started, timeoutS)) return { code: null, output: `${result.output}\n[stopped: exceeded ${timeoutS}s]`.trim() };
    if (result.code === 255) return { code: null, output: `Could not reach ${this.cfg.host} over SSH: ${result.output.split("\n").at(-1)}` };
    return result;
  }

  async check(): Promise<string | null> {
    if (!this.cfg.host) return "backend.ssh.host is not set in System/config.md.";
    const result = await exec(this.cfg.binary, [...this.baseArgs(), "echo ok"], { timeoutS: 25 });
    return result.code === 0 ? null : `Cannot run commands on ${this.cfg.host} over SSH: ${result.output.split("\n").at(-1) || "no answer"}. Key-based login without a passphrase prompt is required.`;
  }

  async stop(): Promise<void> {}
}
