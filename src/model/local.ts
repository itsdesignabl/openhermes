import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../kernel/config.js";
import type { Home } from "../kernel/home.js";

const SERVER_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server";

export function findServerBinary(home: Home): string | null {
  const dir = path.join(home.runtime, "llama");
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (path.basename(String(f)) === SERVER_NAME) return path.join(dir, String(f));
  }
  return null;
}

export function findModelFile(home: Home, config: Config): string | null {
  if (config.local_model.file) {
    const file = home.resolveInside(config.local_model.file, home.models);
    return fs.existsSync(file) ? file : null;
  }
  if (!fs.existsSync(home.models)) return null;
  const ggufs = fs.readdirSync(home.models).filter((f) => f.toLowerCase().endsWith(".gguf"));
  return ggufs.length === 1 ? path.join(home.models, ggufs[0]!) : null;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Runs the bundled llama.cpp server from runtime/llama with a model from models/. Loopback only. */
export class LocalModel {
  private child?: ChildProcess;
  constructor(private home: Home, private config: () => Config) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.config().local_model.port}/v1`;
  }

  async ensureRunning(onStatus: (msg: string) => void = () => {}): Promise<string> {
    const cfg = this.config().local_model;
    if (await healthy(cfg.port)) return this.baseUrl;
    const bin = findServerBinary(this.home);
    if (!bin) throw new Error("The local model server is not installed. Run: openhermes model install --server");
    const model = findModelFile(this.home, this.config());
    if (!model) {
      throw new Error(
        "No model file found. Put one .gguf file in the models folder (openhermes model install --url <link>), or set local_model.file in System/config.md.",
      );
    }
    const logDir = path.join(this.home.data, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, "llama-server.log"), "a");
    onStatus(`Starting local model ${path.basename(model)} …`);
    this.child = spawn(
      bin,
      ["-m", model, "--host", "127.0.0.1", "--port", String(cfg.port), "-c", String(cfg.context_tokens), "--jinja", ...cfg.extra_args],
      { cwd: path.dirname(bin), stdio: ["ignore", log, log], windowsHide: true },
    );
    let exited: number | null | undefined;
    this.child.on("exit", (code) => (exited = code));
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new Error(`The model server stopped (exit code ${exited}). See ${this.home.display(path.join(logDir, "llama-server.log"))}`);
      if (await healthy(cfg.port)) return this.baseUrl;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error("The model server did not become ready within 5 minutes.");
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

export async function download(url: string, dest: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "openhermes" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  const tmp = dest + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const source = Readable.fromWeb(res.body as any);
  source.on("data", (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.(done, total);
  });
  await pipeline(source, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function serverAssetPattern(): RegExp {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return new RegExp(`bin-win-cpu-${arch}\\.zip$`);
  if (process.platform === "darwin") return new RegExp(`bin-macos-${arch}\\.(zip|tar\\.gz)$`);
  return new RegExp(`bin-ubuntu-${arch}\\.(zip|tar\\.gz)$`);
}

/** Download the llama.cpp server for this platform into runtime/llama. */
export async function installServer(home: Home, directUrl: string | undefined, log: (msg: string) => void): Promise<string> {
  let url = directUrl;
  if (!url) {
    const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
      headers: { "user-agent": "openhermes", accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`Could not read the llama.cpp release list (${res.status}). Pass --server-url <link to a release archive> instead.`);
    const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const pattern = serverAssetPattern();
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) throw new Error(`No llama.cpp build for this platform in release ${release.tag_name}. Pass --server-url <link> instead.`);
    url = asset.browser_download_url;
    log(`Found ${asset.name} (${release.tag_name})`);
  }
  const dir = path.join(home.runtime, "llama");
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, path.basename(new URL(url).pathname));
  await download(url, archive, progressLogger(log));
  let r = spawnSync("tar", ["-xf", archive, "-C", dir], { stdio: "pipe" });
  if (r.status !== 0 && archive.endsWith(".zip")) r = spawnSync("unzip", ["-o", "-q", archive, "-d", dir], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`Could not unpack ${archive}: ${r.stderr?.toString().trim() || r.error?.message}`);
  fs.rmSync(archive);
  const bin = findServerBinary(home);
  if (!bin) throw new Error("The archive was unpacked but it does not contain llama-server.");
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

export async function installModel(home: Home, url: string, log: (msg: string) => void): Promise<string> {
  const name = path.basename(new URL(url).pathname);
  if (!name.toLowerCase().endsWith(".gguf")) throw new Error("The link must point to a .gguf file.");
  const dest = home.resolveInside(name, home.models);
  await download(url, dest, progressLogger(log));
  return dest;
}

function progressLogger(log: (msg: string) => void) {
  let last = 0;
  return (done: number, total: number) => {
    const now = Date.now();
    if (now - last < 2000 && done !== total) return;
    last = now;
    const mb = (n: number) => (n / 1e6).toFixed(0);
    log(total ? `  ${mb(done)} / ${mb(total)} MB (${Math.round((done / total) * 100)}%)` : `  ${mb(done)} MB`);
  };
}
