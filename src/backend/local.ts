import fs from "node:fs";
import type { Home } from "../kernel/home.js";
import { exec } from "./exec.js";
import type { Backend, RunResult } from "./types.js";

/** Runs commands directly on this computer, starting in the workspace folder. Not a sandbox. */
export class LocalBackend implements Backend {
  readonly name = "local";
  readonly sandboxed = false;
  constructor(private home: Home) {}

  describe(): string {
    return "Shell commands run directly on this computer and start in the workspace folder.";
  }

  run(command: string, timeoutS: number): Promise<RunResult> {
    fs.mkdirSync(this.home.workspace, { recursive: true });
    return exec(command, [], { cwd: this.home.workspace, shell: true, timeoutS, env: { ...process.env, OPENHERMES_HOME: this.home.root } });
  }

  async check(): Promise<string | null> {
    return null;
  }

  async stop(): Promise<void> {}
}
