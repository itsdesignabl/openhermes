// Bundles the Obsidian plugin into dist/obsidian (main.js, manifest.json, styles.css).
import { build } from "esbuild";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "dist", "obsidian");
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(here, "src", "main.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  outfile: path.join(out, "main.js"),
  logLevel: "warning",
});
for (const f of ["manifest.json", "styles.css"]) fs.copyFileSync(path.join(here, f), path.join(out, f));
