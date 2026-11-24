import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { autostartStatus, describeVersion, setAutostart, update, versionInfo } from "../src/install.js";
import { extractZip, filesUnder, readZip, writeZip } from "../src/util/zip.js";
import { launcherPath, writeLauncher } from "../src/vault/layout.js";
import { tempHome } from "./helpers.js";

test("zip: what is written can be read back, and an entry outside the folder is refused", () => {
  const { outside, cleanup } = tempHome();
  try {
    const big = Buffer.alloc(50_000, "abc");
    const zip = writeZip([
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "deep/er/ü.bin", data: big },
      { name: "empty", data: Buffer.alloc(0) },
    ]);
    assert.ok(zip.length < big.length, "repetitive data is compressed");
    assert.deepEqual(readZip(zip).map((e) => e.name), ["a.txt", "deep/er/ü.bin", "empty"]);
    const dest = path.join(outside, "out");
    assert.equal(extractZip(zip, dest), 3);
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "hello");
    assert.ok(fs.readFileSync(path.join(dest, "deep", "er", "ü.bin")).equals(big));
    assert.deepEqual([...filesUnder(dest)].map((e) => e.name), ["a.txt", "deep/er/ü.bin", "empty"]);

    const evil = writeZip([{ name: "../escaped.txt", data: Buffer.from("x") }]);
    assert.throws(() => extractZip(evil, path.join(outside, "jail")), /outside its folder/);
    assert.ok(!fs.existsSync(path.join(outside, "escaped.txt")));
    assert.throws(() => readZip(Buffer.from("not a zip at all, just some text")), /Not a zip/);
    const damaged = Buffer.from(zip);
    damaged[36] = damaged[36]! ^ 0xff;
    assert.throws(() => readZip(damaged));
  } finally {
    cleanup();
  }
});

test("launcher: prefers the Node.js in the home folder and is rewritten when out of date", () => {
  const { home, cleanup } = tempHome();
  try {
    const file = launcherPath(home);
    const body = fs.readFileSync(file, "utf8");
    assert.match(body, process.platform === "win32" ? /node\\node\.exe/ : /node\/bin\/node/);
    assert.match(body, /cli\.js/);
    fs.writeFileSync(file, "an old launcher");
    writeLauncher(home);
    assert.equal(fs.readFileSync(file, "utf8"), body);
  } finally {
    cleanup();
  }
});

/** A stand-in release package whose program records how it was called. */
function fakePackage(version: string, cliBody?: string): Buffer {
  const cli = cliBody ?? `import fs from "node:fs";\nfs.appendFileSync(new URL("../../calls.txt", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\n`;
  return writeZip([
    { name: "package.json", data: Buffer.from(JSON.stringify({ type: "module", version })) },
    { name: "release.json", data: Buffer.from(JSON.stringify({ version, commit: "abcdef1234" })) },
    { name: "dist/src/cli.js", data: Buffer.from(cli) },
    { name: "node_modules/lib/index.js", data: Buffer.from("export {};") },
  ]);
}

test("update: a package replaces the program, keeps what the user added, and leaves the vault alone", async () => {
  const { home, outside, cleanup } = tempHome();
  try {
    fs.writeFileSync(path.join(home.runtime, "package.json"), JSON.stringify({ version: "0.0.1" }));
    fs.mkdirSync(path.join(home.runtime, "dist"), { recursive: true });
    fs.writeFileSync(path.join(home.runtime, "dist", "old.js"), "old");
    fs.mkdirSync(path.join(home.runtime, "llama"));
    fs.writeFileSync(path.join(home.runtime, "llama", "server.bin"), "model server");
    fs.mkdirSync(path.join(home.runtime, "src"));
    const soul = path.join(home.vault, "Agents", "main", "SOUL.md");
    fs.writeFileSync(soul, "my own personality");
    fs.writeFileSync(launcherPath(home), "stale");
    const zip = path.join(outside, "pkg.zip");
    fs.writeFileSync(zip, fakePackage("9.9.9"));

    const lines: string[] = [];
    await update(home, { from: zip, log: (l) => lines.push(l) });

    assert.equal(versionInfo(home.runtime).version, "9.9.9");
    assert.equal(describeVersion(versionInfo(home.runtime)), "OpenHermes 9.9.9 (release package, commit abcdef1)");
    assert.ok(!fs.existsSync(path.join(home.runtime, "dist", "old.js")), "old program files are gone");
    assert.equal(fs.readFileSync(path.join(home.runtime, "llama", "server.bin"), "utf8"), "model server");
    assert.ok(!fs.existsSync(path.join(home.runtime, "src")), "source folders are not carried into a package install");
    assert.ok(!fs.existsSync(`${home.runtime}.old`) && !fs.existsSync(`${home.runtime}.new`));
    assert.equal(fs.readFileSync(soul, "utf8"), "my own personality");
    // the new program was tried before the swap, then asked to finish the update
    const calls = fs.readFileSync(path.join(home.runtime, "calls.txt"), "utf8");
    assert.match(calls, /^version --home /m);
    assert.match(calls, /^post-update --home /m);
    assert.match(lines.join("\n"), /Now running OpenHermes 9\.9\.9/);
  } finally {
    cleanup();
  }
});

test("update: a package that does not start changes nothing", async () => {
  const { home, outside, cleanup } = tempHome();
  try {
    fs.writeFileSync(path.join(home.runtime, "package.json"), JSON.stringify({ version: "0.0.1" }));
    const broken = path.join(outside, "broken.zip");
    fs.writeFileSync(broken, fakePackage("9.9.9", "process.exit(3);\n"));
    await assert.rejects(update(home, { from: broken, log: () => {} }), /not a working OpenHermes release.*Nothing was changed/s);
    const empty = path.join(outside, "empty.zip");
    fs.writeFileSync(empty, writeZip([{ name: "readme.txt", data: Buffer.from("hi") }]));
    await assert.rejects(update(home, { from: empty, log: () => {} }), /Nothing was changed/);
    assert.equal(versionInfo(home.runtime).version, "0.0.1");
    assert.ok(!fs.existsSync(`${home.runtime}.new`));
  } finally {
    cleanup();
  }
});

test("autostart: can be switched on, reports which home it is for, and off again", { skip: !["win32", "linux"].includes(process.platform) }, () => {
  const { home, outside, cleanup } = tempHome();
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(outside, "config");
  const o = { name: `OpenHermesTest${process.pid}` };
  try {
    assert.equal(autostartStatus(home, o).enabled, false);
    const on = setAutostart(home, true, o);
    assert.equal(on.enabled, true);
    assert.equal(on.forThisHome, true);
    assert.match(on.command, /gateway start --home/);
    assert.ok(on.command.includes(home.root));
    const other = tempHome();
    try {
      assert.equal(autostartStatus(other.home, o).forThisHome, false);
    } finally {
      other.cleanup();
    }
    assert.equal(setAutostart(home, false, o).enabled, false);
    assert.equal(setAutostart(home, false, o).enabled, false, "switching it off twice is fine");
  } finally {
    try {
      setAutostart(home, false, o);
    } catch {}
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    cleanup();
  }
});
