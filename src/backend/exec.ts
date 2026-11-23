import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { MAX_OUTPUT, type RunResult } from "./types.js";

/**
 * Stops a program and anything it started. A signal to the shell alone leaves its children running,
 * so a command the time limit "stopped" would keep deleting, downloading or looping.
 */
function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    // Spawned as its own process group, so this reaches the program and the children it started.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a program, collects its output, and stops it after the time limit. Never rejects.
 * Returns as soon as the program has exited, even if a child it left behind still holds the output pipes.
 * The time limit stops that child too. A child left running on purpose, after the program itself has exited, is left running.
 */
export function exec(file: string, args: string[], options: SpawnOptions & { timeoutS?: number; input?: string } = {}): Promise<RunResult> {
  const { timeoutS, input, ...spawnOptions } = options;
  return new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group, so the time limit can stop this program and anything it started
        // without signalling the agent itself. Windows stops the tree with taskkill instead.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return resolve({ code: null, output: `Could not start ${file}: ${(err as Error).message}` });
    }
    let out = "";
    let stopped = false;
    // Set once the program has exited, so a time limit that lands while its last output is still arriving
    // does not relabel a finished command as stopped, or kill a child it left behind on purpose.
    let exited = false;
    const add = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    };
    child.stdout!.on("data", add);
    child.stderr!.on("data", add);
    child.stdin!.on("error", () => {});
    child.stdin!.end(input ?? "");
    const timer = timeoutS
      ? setTimeout(() => {
          if (exited) return;
          stopped = true;
          stopTree(child);
        }, timeoutS * 1000)
      : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `Could not start ${file}: ${err.message}` });
    });
    // Finish when the program itself ends. Waiting for its output pipes to close would hang whenever
    // it left a child behind that still holds them (a background job, or a child that outlived a kill).
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout!.destroy();
      child.stderr!.destroy();
      resolve({ code: stopped ? null : code, output: out.trim() + (stopped ? `\n[stopped: exceeded ${timeoutS}s]` : "") });
    };
    child.on("close", (code) => finish(code));
    // give output that is already in the pipe a moment to arrive
    child.on("exit", (code) => {
      exited = true;
      setTimeout(() => finish(code), 200);
    });
  });
}
