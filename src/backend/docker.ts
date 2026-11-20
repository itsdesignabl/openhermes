import crypto from "node:crypto";
import fs from "node:fs";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";
import { exec } from "./exec.js";
import { hitTimeLimit, type Backend, type RunResult } from "./types.js";

/**
 * Runs commands in a Docker container that can see only the workspace folder (read-write)
 * and, if configured, the vault (read-only by default). The container is started on the first
 * command, kept while the agent runs so installed tools persist, and removed on stop.
 */
export class DockerBackend implements Backend {
  readonly name = "docker";
  readonly sandboxed = true;
  readonly container: string;
  private starting?: Promise<void>;

  constructor(private home: Home, private config: () => Config) {
    this.container = "openhermes-" + crypto.createHash("sha256").update(home.root).digest("hex").slice(0, 12);
  }

  private get cfg() {
    return this.config().backend.docker;
  }

  describe(): string {
    const vault = this.cfg.mount_vault === "none" ? "" : ` The vault is at /vault (${this.cfg.mount_vault === "ro" ? "read-only" : "writable"}).`;
    const net = this.cfg.network === "none" ? " There is no network access." : "";
    return `Shell commands run inside a Linux container, not on the user's computer. They start in /workspace, which is the workspace folder.${vault}${net} Nothing else on the computer is visible to commands. Tools you install there are lost when the agent restarts.`;
  }

  private docker(args: string[], timeoutS?: number): Promise<RunResult> {
    return exec(this.cfg.binary, args, { timeoutS });
  }

  /** Arguments for `docker run` that create the container. Exposed for tests and `doctor`. */
  runArgs(): string[] {
    const c = this.cfg;
    const args = [
      "run", "-d", "--rm", "--name", this.container, "--init",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", String(c.pids_limit), "--memory", c.memory, "--cpus", String(c.cpus),
      "--network", c.network,
      "--mount", `type=bind,source=${this.home.workspace},target=/workspace`,
    ];
    if (c.mount_vault !== "none") args.push("--mount", `type=bind,source=${this.home.vault},target=/vault${c.mount_vault === "ro" ? ",readonly" : ""}`);
    // files created in the workspace should belong to the user, not to root
    if (process.platform !== "win32" && typeof process.getuid === "function") args.push("--user", `${process.getuid()}:${process.getgid!()}`, "-e", "HOME=/tmp");
    args.push("-w", "/workspace", ...c.extra_args, c.image, "sleep", "infinity");
    return args;
  }

  private async ensureStarted(): Promise<void> {
    const state = await this.docker(["inspect", "-f", "{{.State.Running}}", this.container], 20);
    if (state.code === 0 && state.output.trim() === "true") return;
    fs.mkdirSync(this.home.workspace, { recursive: true });
    await this.docker(["rm", "-f", this.container], 30);
    const started = await this.docker(this.runArgs(), 600);
    if (started.code !== 0) throw new Error(`The sandbox container did not start: ${lastLine(started.output)}`);
  }

  async run(command: string, timeoutS: number): Promise<RunResult> {
    try {
      await (this.starting ??= this.ensureStarted().finally(() => (this.starting = undefined)));
    } catch (err) {
      return { code: null, output: (err as Error).message };
    }
    // `timeout` inside the container ends the command itself; stopping only the docker client would leave it running
    const started = Date.now();
    const result = await this.docker(["exec", "-w", "/workspace", this.container, "timeout", "-s", "KILL", String(timeoutS), "sh", "-c", command], timeoutS + 15);
    if (hitTimeLimit(result.code, started, timeoutS)) return { code: null, output: `${result.output}\n[stopped: exceeded ${timeoutS}s]`.trim() };
    return result;
  }

  async check(): Promise<string | null> {
    const info = await this.docker(["version", "--format", "{{.Server.Version}}"], 20);
    if (info.code !== 0) {
      return `Docker is not available (${lastLine(info.output) || "no answer"}). Install and start Docker Desktop, or set backend.type to local in System/config.md.`;
    }
    const image = await this.docker(["image", "inspect", "-f", "{{.Id}}", this.cfg.image], 20);
    if (image.code !== 0) return `The image ${this.cfg.image} is not downloaded yet. It is fetched on the first command, or now with: docker pull ${this.cfg.image}`;
    return null;
  }

  async stop(): Promise<void> {
    await this.docker(["rm", "-f", this.container], 30);
  }
}

function lastLine(s: string): string {
  return s.trim().split("\n").at(-1) ?? "";
}
