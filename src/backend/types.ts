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
  /** One or two sentences for the model: where commands run and which paths exist there. */
  describe(): string;
  run(command: string, timeoutS: number): Promise<RunResult>;
  /** Null when the backend is usable, otherwise what is wrong and how to fix it. */
  check(): Promise<string | null>;
  stop(): Promise<void>;
}

export const MAX_OUTPUT = 200_000;
