import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app.js";
import { Gateway } from "../src/gateway/gateway.js";
import { PASSPHRASE_ENV, SecretsError, listSecretNames, readSecret, resetSecretsCache, secretsStatus, writeSecret } from "../src/kernel/secrets.js";
import { main } from "../src/main.js";
import { ScriptedProvider, tempHome } from "./helpers.js";

const TOKEN = "123456:AAH-very-secret-bot-token";
const windows = process.platform === "win32";

/** Runs with the passphrase variable set to `value` (or unset), restoring it afterwards. */
function withPassphrase<T>(value: string | undefined, fn: () => T): T {
  const before = process.env[PASSPHRASE_ENV];
  if (value === undefined) delete process.env[PASSPHRASE_ENV];
  else process.env[PASSPHRASE_ENV] = value;
  resetSecretsCache();
  const restore = () => {
    if (before === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = before;
    resetSecretsCache();
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

const files = (home: { secrets: string }) => fs.readdirSync(home.secrets).sort();
const raw = (home: { secrets: string }) => fs.readFileSync(path.join(home.secrets, "keys.enc.json"), "utf8");

test("with a passphrase: keys are encrypted on disk, read back, listed and removed", () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase("correct horse", () => {
      writeSecret(home, "telegram_bot_token", TOKEN);
      writeSecret(home, "kb_token", "second-secret-value");
      assert.deepEqual(files(home), ["keys.enc.json"], "no plain-text file is written");
      const onDisk = raw(home);
      assert.ok(!onDisk.includes(TOKEN) && !onDisk.includes("second-secret-value") && !onDisk.includes("telegram_bot_token"), "neither values nor names are readable in the file");
      assert.equal(JSON.parse(onDisk).protection, "passphrase");

      resetSecretsCache(); // as a newly started program
      assert.equal(readSecret(home, "telegram_bot_token"), TOKEN);
      assert.equal(readSecret(home, "missing"), undefined);
      assert.equal(readSecret(home, ""), undefined);
      assert.deepEqual(listSecretNames(home), ["kb_token", "telegram_bot_token"]);
      assert.deepEqual(secretsStatus(home), { protection: "passphrase", count: 2, summary: `2 keys, encrypted with the passphrase in ${PASSPHRASE_ENV}` });

      const before = JSON.parse(raw(home));
      writeSecret(home, "kb_token", "");
      const after = JSON.parse(raw(home));
      assert.deepEqual(listSecretNames(home), ["telegram_bot_token"]);
      assert.equal(after.salt, before.salt, "the data key is kept");
      assert.notEqual(after.iv, before.iv, "but every write uses a fresh nonce");
    });
  } finally {
    cleanup();
  }
});

test("a wrong or missing passphrase, or a damaged file, is refused with a clear reason", () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase("correct horse", () => writeSecret(home, "k", TOKEN));
    withPassphrase("wrong", () => assert.throws(() => readSecret(home, "k"), (e: Error) => e instanceof SecretsError && /passphrase in OPENHERMES_PASSPHRASE is wrong, or the file is damaged/.test(e.message)));
    if (!windows) {
      withPassphrase(undefined, () => assert.throws(() => readSecret(home, "k"), /protected by a passphrase\. Set the OPENHERMES_PASSPHRASE environment variable/));
    }
    withPassphrase("correct horse", () => {
      const file = path.join(home.secrets, "keys.enc.json");
      const sealed = JSON.parse(fs.readFileSync(file, "utf8"));
      const data = Buffer.from(sealed.data, "base64");
      data[0] = data[0]! ^ 1; // one flipped bit
      fs.writeFileSync(file, JSON.stringify({ ...sealed, data: data.toString("base64") }));
      resetSecretsCache();
      assert.throws(() => readSecret(home, "k"), SecretsError, "a tampered file is detected, not decrypted to garbage");
      assert.match(secretsStatus(home).problem!, /could not be opened/);
      fs.writeFileSync(file, "not json");
      resetSecretsCache();
      assert.throws(() => readSecret(home, "k"), /the file is damaged/);
    });
  } finally {
    cleanup();
  }
});

test("plain-text keys from an earlier version are encrypted on first use and the plain file is removed", () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase("correct horse", () => {
      writeSecret(home, "old_one", "already-encrypted");
      fs.writeFileSync(path.join(home.secrets, "keys.json"), JSON.stringify({ telegram_bot_token: TOKEN, old_one: "edited-by-hand" }));
      resetSecretsCache();
      assert.equal(readSecret(home, "telegram_bot_token"), TOKEN);
      assert.deepEqual(files(home), ["keys.enc.json"]);
      assert.equal(readSecret(home, "old_one"), "edited-by-hand", "the plain-text file was the newer one");
      assert.ok(!raw(home).includes(TOKEN));
    });
  } finally {
    cleanup();
  }
});

test("a key stored by another process is picked up without a restart", () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase("correct horse", () => {
      writeSecret(home, "a", "one");
      assert.equal(readSecret(home, "a"), "one");
      const file = path.join(home.secrets, "keys.enc.json");
      const first = fs.readFileSync(file);
      writeSecret(home, "a", "two-and-longer");
      const second = fs.readFileSync(file);
      // put the first version back, then the second, the way another process's writes would appear
      fs.writeFileSync(file, first);
      assert.equal(readSecret(home, "a"), "one");
      fs.writeFileSync(file, second);
      assert.equal(readSecret(home, "a"), "two-and-longer");
    });
  } finally {
    cleanup();
  }
});

test("without a passphrase on a system with no built-in protection, keys stay in plain text and that is reported", { skip: windows ? "Windows always has a protection" : false }, () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase(undefined, () => {
      assert.match(secretsStatus(home).summary, /no keys stored yet\. New keys would be stored unencrypted\. Set OPENHERMES_PASSPHRASE/);
      writeSecret(home, "k", TOKEN);
      assert.deepEqual(files(home), ["keys.json"]);
      assert.equal(readSecret(home, "k"), TOKEN);
      const status = secretsStatus(home);
      assert.equal(status.protection, "none");
      assert.match(status.problem!, /keys are stored unencrypted\. Set OPENHERMES_PASSPHRASE to a passphrase to encrypt them\./);
    });
    // setting a passphrase later encrypts what is there
    withPassphrase("now protected", () => {
      assert.equal(readSecret(home, "k"), TOKEN);
      assert.deepEqual(files(home), ["keys.enc.json"]);
    });
  } finally {
    cleanup();
  }
});

test("on Windows, keys are sealed for the current account by Windows itself", { skip: windows ? false : "needs Windows Data Protection" }, () => {
  const { home, cleanup } = tempHome();
  try {
    withPassphrase(undefined, () => {
      assert.match(secretsStatus(home).summary, /^no keys stored yet$/);
      writeSecret(home, "telegram_bot_token", TOKEN);
      assert.deepEqual(files(home), ["keys.enc.json"]);
      const sealed = JSON.parse(raw(home));
      assert.equal(sealed.protection, "dpapi");
      assert.ok(sealed.wrapped_key.length > 100, "the data key is stored only in the form Windows sealed it");
      assert.ok(!raw(home).includes(TOKEN));

      resetSecretsCache(); // a new process has to ask Windows to unseal the data key
      assert.equal(readSecret(home, "telegram_bot_token"), TOKEN);
      assert.deepEqual(secretsStatus(home), { protection: "dpapi", count: 1, summary: "1 key, encrypted for this Windows account" });

      writeSecret(home, "second", "another-value");
      assert.equal(JSON.parse(raw(home)).wrapped_key, sealed.wrapped_key, "later writes reuse the sealed data key");
      resetSecretsCache();
      assert.deepEqual(listSecretNames(home), ["second", "telegram_bot_token"]);

      // plain-text keys left by an earlier version are sealed on first use
      fs.writeFileSync(path.join(home.secrets, "keys.json"), JSON.stringify({ legacy: "from-before" }));
      resetSecretsCache();
      assert.equal(readSecret(home, "legacy"), "from-before");
      assert.deepEqual(files(home), ["keys.enc.json"]);

      // a sealed key that this account cannot open (as after copying the folder to another computer)
      const file = path.join(home.secrets, "keys.enc.json");
      const broken = JSON.parse(raw(home));
      broken.wrapped_key = Buffer.from("not something Windows sealed for this account, just bytes").toString("base64");
      fs.writeFileSync(file, JSON.stringify(broken));
      resetSecretsCache();
      assert.throws(() => readSecret(home, "legacy"), /encrypted for a different Windows account or computer and cannot be opened here\. Store them again/);
    });
  } finally {
    cleanup();
  }
});

test("the commands store and list keys without ever printing a value", async () => {
  const { home, cleanup } = tempHome();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await withPassphrase("correct horse", async () => {
      writeSecret(home, "telegram_bot_token", TOKEN);
      assert.equal(await main(["secret", "list", "--home", home.root]), 0);
      assert.deepEqual(lines, ["telegram_bot_token", `\n(1 key, encrypted with the passphrase in ${PASSPHRASE_ENV})`]);
      lines.length = 0;
      assert.equal(await main(["secret", "remove", "telegram_bot_token", "--home", home.root]), 0);
      assert.equal(await main(["secret", "list", "--home", home.root]), 0);
      assert.equal(lines[1], "No keys stored.");
      assert.ok(!lines.join("\n").includes(TOKEN));
    });
  } finally {
    console.log = log;
    cleanup();
  }
});

test("the running agent uses encrypted keys, and a key store it cannot open does not stop the gateway", async () => {
  const { home, cleanup } = tempHome();
  fs.writeFileSync(path.join(home.vault, "System", "config.md"), `---\n${JSON.stringify({ gateway: { port: 0 }, learning: { enabled: false } })}\n---\n`);
  try {
    await withPassphrase("correct horse", async () => {
      writeSecret(home, "telegram_bot_token", TOKEN);
      const app = await App.start(home, { provider: new ScriptedProvider([]), watch: false });
      const logs: string[] = [];
      app.bus.on("log", (e) => void logs.push(e.message));
      const gateway = new Gateway(app);
      let seen: (string | undefined)[] = [];
      app.registry.channels.clear();
      app.registry.channels.set("probe", (ctx) => ({
        name: "probe",
        state: "connected",
        start: async () => void (seen = [ctx.secret("telegram_bot_token"), ctx.secret("nope")]),
        stop: async () => {},
        send: async () => {},
      }));
      await gateway.start({ scheduler: false });
      assert.deepEqual(seen, [TOKEN, undefined]);
      await gateway.stop();

      // now the store cannot be opened
      process.env[PASSPHRASE_ENV] = "wrong";
      resetSecretsCache();
      const gateway2 = new Gateway(app);
      await gateway2.start({ scheduler: false });
      assert.deepEqual(seen, [undefined, undefined]);
      assert.ok(logs.some((l) => /passphrase in OPENHERMES_PASSPHRASE is wrong/.test(l)), "the reason is logged");
      await gateway2.stop();
      await app.stop();
    });
  } finally {
    cleanup();
  }
});
