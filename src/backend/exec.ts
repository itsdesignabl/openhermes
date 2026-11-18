import { spawn, type SpawnOptions } from "node:child_process";
import { MAX_OUTPUT, type RunResult } from "./types.js";

/** Runs a program, collects its output, and stops it after the time limit. Never rejects. */
export function exec(file: string, args: string[], options: SpawnOptions & { timeoutS?: number; input?: string } = {}): Promise<RunResult> {
  const { timeoutS, input, ...spawnOptions } = options;
  return new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: null, output: `Could not start ${file}: ${(err as Error).message}` });
    }
    let out = "";
    let stopped = false;
    const add = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    };
    child.stdout!.on("data", add);
    child.stderr!.on("data", add);
    child.stdin!.on("error", () => {});
    child.stdin!.end(input ?? "");
    const timer = timeoutS
      ? setTimeout(() => {
          stopped = true;
          child.kill("SIGKILL");
        }, timeoutS * 1000)
      : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `Could not start ${file}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: stopped ? null : code, output: out.trim() + (stopped ? `\n[stopped: exceeded ${timeoutS}s]` : "") });
    });
  });
}
