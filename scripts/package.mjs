// Builds the release package: release/openhermes.zip and release/release.json.
// The zip holds the built program and the libraries it needs, so installing it
// takes no git, no compiler and no `npm install`. Run `npm run build` first.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { writeZip, filesUnder } = await import(new URL("../dist/src/util/zip.js", import.meta.url).href).catch(() => {
  console.error("Run `npm run build` first.");
  process.exit(1);
});

const out = path.join(root, "release");
const stage = path.join(out, "stage");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const name of ["package.json", "package-lock.json", "LICENSE", "README.md", "uninstall.ps1"]) fs.copyFileSync(path.join(root, name), path.join(stage, name));
fs.cpSync(path.join(root, "examples"), path.join(stage, "examples"), { recursive: true });
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), {
  recursive: true,
  filter: (src) => !["test", "obsidian-plugin"].includes(path.relative(path.join(root, "dist"), src).split(path.sep)[0]),
});

// only what the program needs to run, exactly as the lock file says
const npm = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
if (npm.status !== 0) process.exit(npm.status ?? 1);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let commit = process.env.GITHUB_SHA ?? "";
if (!commit) {
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
}
const release = { version: pkg.version, commit, built: new Date().toISOString() };
fs.writeFileSync(path.join(stage, "release.json"), JSON.stringify(release, null, 2) + "\n");
fs.copyFileSync(path.join(stage, "release.json"), path.join(out, "release.json"));

const zip = writeZip(filesUnder(stage, (rel) => rel === "package-lock.json" || rel.startsWith("node_modules/.")));
fs.writeFileSync(path.join(out, "openhermes.zip"), zip);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`release/openhermes.zip  ${(zip.length / 1e6).toFixed(1)} MB  version ${release.version}  commit ${commit.slice(0, 7)}`);
