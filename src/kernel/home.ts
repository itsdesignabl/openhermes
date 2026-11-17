import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME_DIR_NAME = "Openhermes Programming Files";
const SUBDIRS = ["vault", "models", "runtime", "data", "secrets", "workspace"] as const;

export class ContainmentError extends Error {
  constructor(public readonly attempted: string, public readonly root: string) {
    super(`Path is outside the home folder and cannot be used: ${attempted}`);
    this.name = "ContainmentError";
  }
}

/** The one folder that holds the agent and all of its data. */
export class Home {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get vault() { return path.join(this.root, "vault"); }
  get models() { return path.join(this.root, "models"); }
  get runtime() { return path.join(this.root, "runtime"); }
  get data() { return path.join(this.root, "data"); }
  get secrets() { return path.join(this.root, "secrets"); }
  get workspace() { return path.join(this.root, "workspace"); }

  exists(): boolean {
    return fs.existsSync(this.vault);
  }

  ensureDirs(): void {
    for (const d of SUBDIRS) fs.mkdirSync(path.join(this.root, d), { recursive: true });
  }

  /**
   * Resolve `p` (absolute, or relative to `base`) and guarantee the result is
   * inside the home folder, after following symlinks and junctions.
   * Throws ContainmentError otherwise. This is the single gate every file
   * tool goes through.
   */
  resolveInside(p: string, base: string = this.vault): string {
    const lexical = path.resolve(base, p);
    const real = realpathDeepest(lexical);
    const rootReal = realpathDeepest(this.root);
    if (!isInside(rootReal, real) || !isInside(this.root, lexical)) {
      throw new ContainmentError(lexical, this.root);
    }
    return lexical;
  }

  isInside(p: string): boolean {
    try {
      this.resolveInside(p, this.root);
      return true;
    } catch {
      return false;
    }
  }

  /** Path shown to the model and the user: relative to the home root, forward slashes. */
  display(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the non-existing tail re-attached. */
function realpathDeepest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function defaultHomePath(): string {
  if (process.platform === "win32") {
    const drive = process.env.SystemDrive || "C:";
    return path.join(drive + path.sep, HOME_DIR_NAME);
  }
  return path.join(os.homedir(), HOME_DIR_NAME);
}

/**
 * Order: explicit flag, OPENHERMES_HOME, the home this program is installed in
 * (it lives in <home>/runtime), then the platform default.
 */
export function locateHome(explicit?: string): Home {
  if (explicit) return new Home(explicit);
  if (process.env.OPENHERMES_HOME) return new Home(process.env.OPENHERMES_HOME);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (path.basename(dir) === "runtime") return new Home(path.dirname(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return new Home(defaultHomePath());
}
