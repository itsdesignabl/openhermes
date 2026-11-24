export interface RunResult {
  /** Exit code, or null when the command could not be started or was stopped. */
  code: number | null;
  output: string;
}

/** Where the agent's shell commands run. */
export interface Backend {
  readonly name: string;
  /** True when a command cannot reach files outside what the backend was given. */
  readonly sandboxed: boolean;
  /** True when a command could change files in the vault, including the agent's own settings. */
  readonly vaultWritable: boolean;
  /** One or two sentences for the model: where commands run and which paths exist there. */
  describe(): string;
  run(command: string, timeoutS: number): Promise<RunResult>;
  /** Null when the backend is usable, otherwise what is wrong and how to fix it. */
  check(): Promise<string | null>;
  stop(): Promise<void>;
}

export const MAX_OUTPUT = 200_000;

/**
 * Whether a command wrapped in `timeout -s KILL` was ended by it. The exit code differs between
 * implementations (137 from GNU and BusyBox, 124 from others), and a command may also return those
 * codes by itself, so the code only counts once the time limit has actually passed.
 */
export function hitTimeLimit(code: number | null, startedMs: number, timeoutS: number): boolean {
  return (code === 137 || code === 124) && Date.now() - startedMs >= timeoutS * 1000 - 250;
}
