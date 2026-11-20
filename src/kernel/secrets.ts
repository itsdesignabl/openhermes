import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Home } from "./home.js";

/**
 * Bot tokens and API keys, encrypted on disk.
 *
 * The keys are encrypted with AES-256-GCM under a random data key. What protects the data key
 * depends on where the program runs:
 *
 * - "dpapi" (Windows, the default there): the data key is sealed with Windows Data Protection for the
 *   current user account. Only that account on that computer can open it; nothing has to be remembered.
 * - "passphrase" (any system, chosen by setting OPENHERMES_PASSPHRASE): the data key is derived from
 *   the passphrase.
 * - "none": plain text in keys.json. Used only where neither of the above is available.
 *
 * This protects the keys when the folder is copied, backed up, synced or read by another account.
 * It does not protect them from a program running as you: such a program can ask Windows to open
 * them just as this one does.
 */
export type Protection = "dpapi" | "passphrase" | "none";

interface Sealed {
  format: 1;
  protection: "dpapi" | "passphrase";
  /** dpapi: the data key, sealed by Windows. */
  wrapped_key?: string;
  /** passphrase: salt for deriving the data key. */
  salt?: string;
  iv: string;
  tag: string;
  data: string;
}

export class SecretsError extends Error {}

const AAD = Buffer.from("openhermes-secrets-v1");
export const PASSPHRASE_ENV = "OPENHERMES_PASSPHRASE";

const plainFile = (home: Home) => path.join(home.secrets, "keys.json");
const sealedFile = (home: Home) => path.join(home.secrets, "keys.enc.json");

// ---------- Windows Data Protection, through the PowerShell that ships with Windows ----------

const DPAPI_SCRIPT = (op: "Protect" | "Unprotect") =>
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  `$o=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  "[Console]::Out.Write([Convert]::ToBase64String($o))";

function dpapi(op: "Protect" | "Unprotect", input: Buffer): Buffer {
  // The value travels on standard input, never on the command line, where other programs could see it.
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT(op)], {
    input: input.toString("base64"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.error) throw new SecretsError(`Windows Data Protection could not be used: ${r.error.message}`);
  if (r.status !== 0 || !r.stdout.trim()) {
    if (op === "Unprotect") {
      throw new SecretsError(
        "The stored keys were encrypted for a different Windows account or computer and cannot be opened here. Store them again with: openhermes secret set <name>",
      );
    }
    throw new SecretsError(`Windows Data Protection failed: ${r.stderr.trim().split("\n")[0] ?? "no details"}`);
  }
  return Buffer.from(r.stdout.trim(), "base64");
}

// ---------- data key ----------

/** Unsealed data keys, so Windows is asked once per process and not on every read. */
const dataKeys = new Map<string, Buffer>();

function passphrase(): string {
  const p = process.env[PASSPHRASE_ENV];
  if (!p) throw new SecretsError(`The stored keys are protected by a passphrase. Set the ${PASSPHRASE_ENV} environment variable to it.`);
  return p;
}

function dataKeyFor(sealed: Sealed): Buffer {
  if (sealed.protection === "dpapi") {
    if (process.platform !== "win32") throw new SecretsError("The stored keys were encrypted by Windows and can only be opened on that Windows account.");
    const id = `dpapi:${sealed.wrapped_key}`;
    let key = dataKeys.get(id);
    if (!key) dataKeys.set(id, (key = dpapi("Unprotect", Buffer.from(sealed.wrapped_key ?? "", "base64"))));
    return key;
  }
  const id = `pass:${sealed.salt}:${crypto.createHash("sha256").update(passphrase()).digest("hex")}`;
  let key = dataKeys.get(id);
  if (!key) dataKeys.set(id, (key = crypto.scryptSync(passphrase(), Buffer.from(sealed.salt ?? "", "base64"), 32)));
  return key;
}

/** What a new store on this system would be protected by. */
export function defaultProtection(): Protection {
  if (process.env[PASSPHRASE_ENV]) return "passphrase";
  return process.platform === "win32" ? "dpapi" : "none";
}

// ---------- reading and writing ----------

function open(sealed: Sealed): Record<string, string> {
  const key = dataKeyFor(sealed);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as Record<string, string>;
  } catch {
    throw new SecretsError(
      sealed.protection === "passphrase"
        ? `The stored keys could not be opened: the passphrase in ${PASSPHRASE_ENV} is wrong, or the file is damaged.`
        : "The stored keys could not be opened: the file is damaged. Store them again with: openhermes secret set <name>",
    );
  }
}

function seal(home: Home, keys: Record<string, string>, previous: Sealed | null, protection: "dpapi" | "passphrase"): void {
  let sealed: Partial<Sealed>;
  let key: Buffer;
  if (previous && previous.protection === protection) {
    key = dataKeyFor(previous); // keep the same data key: no need to ask Windows to seal a new one
    sealed = { wrapped_key: previous.wrapped_key, salt: previous.salt };
  } else if (protection === "dpapi") {
    key = crypto.randomBytes(32);
    const wrapped = dpapi("Protect", key).toString("base64");
    dataKeys.set(`dpapi:${wrapped}`, key);
    sealed = { wrapped_key: wrapped };
  } else {
    const salt = crypto.randomBytes(16);
    key = crypto.scryptSync(passphrase(), salt, 32);
    sealed = { salt: salt.toString("base64") };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const out: Sealed = { format: 1, protection, ...sealed, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  fs.mkdirSync(home.secrets, { recursive: true });
  const file = sealedFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readSealed(home: Home): Sealed | null {
  const file = sealedFile(home);
  if (!fs.existsSync(file)) return null;
  let sealed: Sealed;
  try {
    sealed = JSON.parse(fs.readFileSync(file, "utf8")) as Sealed;
  } catch {
    throw new SecretsError("The stored keys could not be opened: the file is damaged. Store them again with: openhermes secret set <name>");
  }
  if (sealed.format !== 1 || (sealed.protection !== "dpapi" && sealed.protection !== "passphrase")) {
    throw new SecretsError("The stored keys were written by a newer version of this program.");
  }
  return sealed;
}

function readPlain(home: Home): Record<string, string> | null {
  const file = plainFile(home);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    throw new SecretsError("secrets/keys.json is not valid JSON.");
  }
}

/** Decrypted keys per home, reused while the file on disk is unchanged. */
const cache = new Map<string, { stamp: string; keys: Record<string, string> }>();

function stamp(home: Home): string {
  return [sealedFile(home), plainFile(home)]
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * All stored keys. Plain-text keys left by an earlier version are encrypted on the way,
 * wherever this system offers a protection, and the plain-text file is removed.
 */
function load(home: Home): Record<string, string> {
  const cached = cache.get(home.root);
  const now = stamp(home);
  if (cached && cached.stamp === now) return cached.keys;

  const sealed = readSealed(home);
  let keys = sealed ? open(sealed) : {};
  const plain = readPlain(home);
  const protection = sealed?.protection ?? defaultProtection();
  if (plain && protection !== "none") {
    keys = { ...keys, ...plain }; // a plain-text file is newer than whatever was encrypted before it appeared
    seal(home, keys, sealed, protection);
    fs.rmSync(plainFile(home), { force: true });
  } else if (plain) keys = plain;
  cache.set(home.root, { stamp: stamp(home), keys });
  return keys;
}

export function readSecret(home: Home, name: string): string | undefined {
  if (!name) return undefined;
  return load(home)[name];
}

/** Stores a key, or removes it when `value` is empty. */
export function writeSecret(home: Home, name: string, value: string): void {
  const keys = { ...load(home) };
  if (value) keys[name] = value;
  else delete keys[name];
  const sealed = readSealed(home);
  const protection = sealed?.protection ?? defaultProtection();
  if (protection === "none") {
    fs.mkdirSync(home.secrets, { recursive: true });
    fs.writeFileSync(plainFile(home), JSON.stringify(keys, null, 2), { mode: 0o600 });
  } else {
    seal(home, keys, sealed, protection);
    fs.rmSync(plainFile(home), { force: true });
  }
  cache.delete(home.root);
}

export function listSecretNames(home: Home): string[] {
  return Object.keys(load(home)).sort();
}

export interface SecretsStatus {
  /** How the keys on disk are protected right now. */
  protection: Protection;
  count: number;
  /** One sentence for `doctor` and `secret list`. */
  summary: string;
  problem?: string;
}

export function secretsStatus(home: Home): SecretsStatus {
  let names: string[];
  try {
    names = listSecretNames(home);
  } catch (err) {
    return { protection: "none", count: 0, summary: (err as Error).message, problem: (err as Error).message };
  }
  const sealed = fs.existsSync(sealedFile(home));
  const protection: Protection = sealed ? readSealed(home)!.protection : fs.existsSync(plainFile(home)) ? "none" : defaultProtection();
  const n = `${names.length} key${names.length === 1 ? "" : "s"}`;
  if (protection === "dpapi") return { protection, count: names.length, summary: `${n}, encrypted for this Windows account` };
  if (protection === "passphrase") return { protection, count: names.length, summary: `${n}, encrypted with the passphrase in ${PASSPHRASE_ENV}` };
  const how = process.platform === "win32" ? "" : ` Set ${PASSPHRASE_ENV} to a passphrase to encrypt them.`;
  return names.length
    ? { protection, count: names.length, summary: `${n}, stored unencrypted.${how}`, problem: `keys are stored unencrypted.${how}` }
    : { protection, count: 0, summary: `no keys stored yet${how ? ". New keys would be stored unencrypted." + how : ""}` };
}

/** For tests: forget everything held in memory, as a newly started program would. */
export function resetSecretsCache(): void {
  cache.clear();
  dataKeys.clear();
}
