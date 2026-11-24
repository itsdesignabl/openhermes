import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGateway } from "./gateway/client.js";
import type { Home } from "./kernel/home.js";
import { extractZip } from "./util/zip.js";
import { nodeProgram, writeLauncher } from "./vault/layout.js";

export const REPOSITORY = "itsdesignabl/openhermes";
/** Where release packages are published. OPENHERMES_RELEASE_URL points somewhere else, for mirrors and tests. */
export function releaseBase(): string {
  return (process.env.OPENHERMES_RELEASE_URL || `https://github.com/${REPOSITORY}/releases/latest/download`).replace(/\/+$/, "");
}

/** The folder this program runs from: <home>/runtime in an installation. */
export function programDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export type VersionInfo = { version: string; commit: string; kind: "package" | "git" | "source" };

export function versionInfo(dir: string = programDir()): VersionInfo {
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? version;
  } catch {}
  try {
    const rel = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
    return { version: rel.version ?? version, commit: String(rel.commit ?? ""), kind: "package" };
  } catch {}
  if (fs.existsSync(path.join(dir, ".git"))) {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
    return { version, commit: r.status === 0 ? r.stdout.trim() : "", kind: "git" };
  }
  return { version, commit: "", kind: "source" };
}

export function describeVersion(v: VersionInfo): string {
  const how = v.kind === "package" ? "release package" : v.kind === "git" ? "git checkout" : "built from source";
  return `OpenHermes ${v.version} (${how}${v.commit ? `, commit ${v.commit.slice(0, 7)}` : ""})`;
}

// ---------------------------------------------------------------------------
// Start the gateway when the user logs in
// ---------------------------------------------------------------------------

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export type AutostartOptions = { name?: string; node?: string; cli?: string };
export type AutostartState = { enabled: boolean; command: string; where: string; forThisHome: boolean };

function autostartCommand(home: Home, o: AutostartOptions): string {
  const node = o.node ?? nodeProgram(home);
  const cli = o.cli ?? path.join(home.runtime, "dist", "src", "cli.js");
  return `"${node}" "${cli}" gateway start --home "${home.root}"`;
}

function desktopFile(name: string): string {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "autostart", `${name.toLowerCase()}.desktop`);
}

function requireSupported(): void {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("Starting at login is not supported on this system yet. Run `openhermes gateway start` after you log in.");
  }
}

export function autostartStatus(home: Home, o: AutostartOptions = {}): AutostartState {
  requireSupported();
  const name = o.name ?? "OpenHermes";
  let command = "";
  let where: string;
  if (process.platform === "win32") {
    where = `${RUN_KEY}\\${name}`;
    const r = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) command = /REG_(?:EXPAND_)?SZ\s+(.*)/.exec(r.stdout)?.[1]?.trim() ?? "";
  } else {
    where = desktopFile(name);
    try {
      command = /^Exec=(.*)$/m.exec(fs.readFileSync(where, "utf8"))?.[1] ?? "";
    } catch {}
  }
  return { enabled: !!command, command, where, forThisHome: command.includes(`"${home.root}"`) };
}

export function setAutostart(home: Home, on: boolean, o: AutostartOptions = {}): AutostartState {
  requireSupported();
  const name = o.name ?? "OpenHermes";
  if (process.platform === "win32") {
    const args = on ? ["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", autostartCommand(home, o), "/f"] : ["delete", RUN_KEY, "/v", name, "/f"];
    const r = spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
    // removing something that is not there is not a failure
    if (r.status !== 0 && (on || autostartStatus(home, o).enabled)) throw new Error(`Could not change the Windows startup entry: ${(r.stderr || r.stdout || "").trim()}`);
  } else {
    const file = desktopFile(name);
    if (on) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const exec = autostartCommand(home, o).replace(/[\\$`]/g, "\\$&");
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=OpenHermes gateway\nComment=Starts the OpenHermes gateway when you log in\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    } else fs.rmSync(file, { force: true });
  }
  return autostartStatus(home, o);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export type UpdateOptions = {
  /** A package to install: a .zip on this computer or a link to one. Default: the latest published release. */
  from?: string;
  /** Install even when the same version is already in place. */
  force?: boolean;
  log: (line: string) => void;
};

/** What only exists in a source tree. Not carried into a release package's folder. */
const SOURCE_ONLY = new Set([".git", ".github", ".gitignore", "src", "test", "docs", "scripts", "obsidian-plugin", "tsconfig.json", "release", "install.ps1"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renaming a folder on Windows fails while anything inside is still in use; a stopping gateway needs a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code ?? "")) throw err;
      await sleep(500);
    }
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 404) throw new Error(`Nothing is published at ${url}. No release may have been made yet.`);
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function runCli(node: string, cli: string, args: string[], show: boolean): { ok: boolean; out: string } {
  const r = spawnSync(node, [cli, ...args], { encoding: "utf8", stdio: show ? "inherit" : "pipe", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function run(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  // npm is a .cmd file on Windows, which only a shell can start
  const viaShell = process.platform === "win32" && program === "npm";
  const r = spawnSync(program, args, { cwd, env, stdio: "inherit", shell: viaShell });
  if (r.error) throw new Error(`Could not run ${program}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`\`${program} ${args.join(" ")}\` failed.`);
}

export async function update(home: Home, opts: UpdateOptions): Promise<void> {
  const { log } = opts;
  const runtime = home.runtime;
  const node = nodeProgram(home);
  const cli = path.join(runtime, "dist", "src", "cli.js");
  const current = versionInfo(runtime);
  const useGit = !opts.from && current.kind === "git";

  // Decide whether there is anything to do before touching the installation.
  let zip: Buffer | undefined;
  if (!useGit) {
    if (opts.from && !/^https?:\/\//i.test(opts.from)) zip = fs.readFileSync(path.resolve(opts.from));
    else {
      const base = opts.from ? undefined : releaseBase();
      if (base && !opts.force) {
        let latest: { version?: string; commit?: string } = {};
        try {
          latest = JSON.parse((await fetchBytes(`${base}/release.json`)).toString("utf8"));
        } catch (err) {
          throw new Error(`Could not look up the latest release. ${(err as Error).message}`);
        }
        if (latest.version === current.version && (latest.commit ?? "") === current.commit) {
          log(`Already up to date: ${describeVersion(current)}.`);
          return;
        }
        log(`Updating from ${current.version} to ${latest.version}.`);
      }
      const url = opts.from ?? `${base}/openhermes.zip`;
      log(`Downloading ${url}`);
      zip = await fetchBytes(url);
    }
  }

  const gateway = await findGateway(home);
  const stopGateway = async () => {
    if (!gateway) return;
    log("Stopping the gateway.");
    await gateway.post("/v1/shutdown").catch(() => {});
    for (let i = 0; i < 40 && (await findGateway(home)); i++) await sleep(250);
  };

  if (useGit) {
    await stopGateway();
    const env = { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}` };
    log("Fetching the latest source.");
    run("git", ["-C", runtime, "pull", "--ff-only"], runtime, env);
    run("npm", ["install", "--no-audit", "--no-fund"], runtime, env);
    run("npm", ["run", "build"], runtime, env);
  } else {
    const fresh = `${runtime}.new`;
    const old = `${runtime}.old`;
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    log("Unpacking.");
    extractZip(zip!, fresh);
    const freshCli = path.join(fresh, "dist", "src", "cli.js");
    // The new program must at least start before it replaces the working one.
    const probe = fs.existsSync(freshCli) ? runCli(node, freshCli, ["version", "--home", home.root], false) : { ok: false, out: "it has no dist/src/cli.js" };
    if (!probe.ok) {
      fs.rmSync(fresh, { recursive: true, force: true });
      throw new Error(`The package is not a working OpenHermes release (${probe.out.split("\n").pop()}). Nothing was changed.`);
    }

    await stopGateway();
    // a terminal sitting inside runtime would keep the folder in use
    // (on Windows a folder on another drive has no relative path, only an absolute one)
    const rel = path.relative(runtime, process.cwd());
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) process.chdir(home.root);
    try {
      await renameWithRetry(runtime, old);
    } catch (err) {
      fs.rmSync(fresh, { recursive: true, force: true });
      throw new Error(`The program folder is in use and could not be replaced (${(err as Error).message}). Close other OpenHermes windows and try again. Nothing was changed.`);
    }
    try {
      await renameWithRetry(fresh, runtime);
    } catch (err) {
      fs.renameSync(old, runtime);
      throw new Error(`Could not put the new version in place (${(err as Error).message}). The previous version was restored.`);
    }
    // What the user added to the program folder moves along: the model server, plugins, hooks.
    for (const name of fs.readdirSync(old)) {
      if (SOURCE_ONLY.has(name) || fs.existsSync(path.join(runtime, name))) continue;
      fs.renameSync(path.join(old, name), path.join(runtime, name));
    }
    fs.rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  // From here on the new program does the work.
  const after = runCli(node, cli, ["post-update", "--home", home.root], true);
  if (!after.ok) writeLauncher(home);
  if (gateway) {
    log("Starting the gateway again.");
    runCli(node, cli, ["gateway", "start", "--home", home.root], true);
  }
  log(`Now running ${describeVersion(versionInfo(runtime))}.`);
}

/** Put the built Obsidian plugin into the vault. Returns where it went. */
export function installObsidianPlugin(home: Home): string {
  const built = path.join(programDir(), "dist", "obsidian");
  if (!fs.existsSync(path.join(built, "main.js"))) throw new Error("The plugin has not been built. Run `npm run build` in the runtime folder first.");
  const dest = path.join(home.vault, ".obsidian", "plugins", "openhermes");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(built, f), path.join(dest, f));
  return dest;
}

export function obsidianPluginInstalled(home: Home): boolean {
  return fs.existsSync(path.join(home.vault, ".obsidian", "plugins", "openhermes", "main.js"));
}
