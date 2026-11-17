import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { App } from "./app.js";
import { loadConfig, loadPolicies } from "./kernel/config.js";
import { locateHome } from "./kernel/home.js";
import { MemoryIndex } from "./memory/index.js";
import { findModelFile, findServerBinary, installModel, installServer } from "./model/local.js";
import { scaffold } from "./vault/layout.js";
import { VaultHistory } from "./vault/git.js";

const HELP = `openhermes <command> [options]

  init                     Create the home folder and vault
  chat                     Open the full-screen chat (TUI)
  ask "<message>"          Send one message and print the answer
  search "<query>"         Search the vault
  index                    Rebuild the search index
  model install            Download the local model server and/or a model
        --server             the llama.cpp server for this computer
        --server-url <link>  a specific llama.cpp release archive
        --url <link>         a .gguf model file
  model status             Show what is installed
  eval [--only <text>]     Run the tool-calling test against the configured model
  history                  Show the agent's recent changes to the vault
  doctor                   Check the installation

Options:
  --home <path>            Use this home folder (default: OPENHERMES_HOME, the folder
                           this program is installed in, or the platform default)
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      help: { type: "boolean", short: "h" },
      server: { type: "boolean" },
      "server-url": { type: "string" },
      url: { type: "string" },
      only: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    console.log(HELP);
    return 0;
  }
  const home = locateHome(values.home);

  switch (command) {
    case "init": {
      const { created } = scaffold(home);
      await new VaultHistory(home.vault).init();
      console.log(`Home folder: ${home.root}`);
      console.log(created.length ? `Created ${created.length} starter notes in the vault.` : "Vault already set up; nothing was overwritten.");
      console.log(`Open ${home.vault} in Obsidian to view and edit it.`);
      return 0;
    }

    case "chat": {
      if (!process.stdin.isTTY) throw new Error("chat needs an interactive terminal. Use: openhermes ask \"<message>\"");
      const { runTui } = await import("./tui/app.js");
      await runTui(home);
      return 0;
    }

    case "ask": {
      const text = rest.join(" ").trim();
      if (!text) throw new Error('Give a message: openhermes ask "<message>"');
      const app = await App.start(home, {
        watch: false,
        approver: async (action, detail) => {
          if (!process.stdin.isTTY) {
            console.error(`[declined, not interactive] ${action}: ${detail}`);
            return false;
          }
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await rl.question(`Allow ${action}: ${detail}? [y/N] `);
          rl.close();
          return /^y/i.test(answer.trim());
        },
      });
      app.bus.on("log", (e) => console.error(`[${e.level}] ${e.message}`));
      app.bus.on("tool.requested", (e) => console.error(`  → ${e.name} ${JSON.stringify(e.args).slice(0, 160)}`));
      app.bus.on("tool.finished", (e) => console.error(`  ${e.ok ? "✓" : "✗"} ${e.summary}`));
      try {
        const result = await app.send(text);
        console.log(result.text);
      } finally {
        await app.stop();
      }
      return 0;
    }

    case "search": {
      const index = new MemoryIndex(path.join(home.data, "index.db"), home.vault);
      index.sync();
      const hits = index.search(rest.join(" "), 10);
      index.close();
      if (!hits.length) console.log("No matches.");
      for (const h of hits) console.log(`${h.path}${h.heading ? ` › ${h.heading}` : ""}\n  ${h.snippet}\n`);
      return 0;
    }

    case "index": {
      const file = path.join(home.data, "index.db");
      fs.rmSync(file, { force: true });
      const index = new MemoryIndex(file, home.vault);
      const { indexed } = index.sync();
      const stats = index.stats();
      index.close();
      console.log(`Indexed ${indexed} notes (${stats.chunks} sections).`);
      return 0;
    }

    case "model": {
      const sub = rest[0];
      if (sub === "install") {
        if (!values.server && !values["server-url"] && !values.url) {
          throw new Error("Say what to install: --server and/or --url <link to a .gguf file>");
        }
        home.ensureDirs();
        if (values.server || values["server-url"]) {
          const bin = await installServer(home, values["server-url"], console.log);
          console.log(`Model server installed: ${home.display(bin)}`);
        }
        if (values.url) {
          const file = await installModel(home, values.url, console.log);
          console.log(`Model saved: ${home.display(file)}`);
        }
        return 0;
      }
      if (sub === "status") {
        const config = loadConfig(home);
        const bin = findServerBinary(home);
        const model = findModelFile(home, config);
        console.log(`Endpoint:     ${config.provider.base_url || "bundled local model"}`);
        console.log(`Model server: ${bin ? home.display(bin) : "not installed"}`);
        console.log(`Model file:   ${model ? home.display(model) : "none (or more than one .gguf and local_model.file is not set)"}`);
        return 0;
      }
      throw new Error("Use: openhermes model install | status");
    }

    case "eval": {
      const { runEval } = await import("./eval/toolcalling.js");
      const report = await runEval(home, { only: values.only, log: console.log });
      return report.passed === report.total ? 0 : 2;
    }

    case "history": {
      const entries = await new VaultHistory(home.vault).log(15);
      for (const e of entries) console.log(`${e.date.toISOString().slice(0, 16).replace("T", " ")}  ${e.oid.slice(0, 7)}  ${e.message.split("\n")[0]}`);
      return 0;
    }

    case "doctor": {
      let problems = 0;
      const line = (ok: boolean, text: string) => {
        if (!ok) problems++;
        console.log(`${ok ? "ok  " : "FAIL"}  ${text}`);
      };
      console.log(`Home folder: ${home.root}`);
      line(home.exists(), "vault exists");
      if (!home.exists()) return 1;
      try {
        loadConfig(home);
        line(true, "System/config.md is valid");
      } catch (err) {
        line(false, `System/config.md: ${(err as Error).message}`);
      }
      try {
        loadPolicies(home);
        line(true, "System/policies.md is valid");
      } catch (err) {
        line(false, `System/policies.md: ${(err as Error).message}`);
      }
      const config = loadConfig(home);
      if (config.provider.base_url) {
        let ok = false;
        try {
          ok = (await fetch(config.provider.base_url.replace(/\/+$/, "") + "/models", { signal: AbortSignal.timeout(5000) })).ok;
        } catch {}
        line(ok, `model endpoint reachable: ${config.provider.base_url}`);
      } else {
        line(!!findServerBinary(home), "local model server installed in runtime/llama");
        line(!!findModelFile(home, config), "model file present in models/");
      }
      const probe = path.join(home.data, ".write-test");
      try {
        fs.writeFileSync(probe, "");
        fs.rmSync(probe);
        line(true, "home folder is writable");
      } catch {
        line(false, "home folder is writable");
      }
      return problems ? 1 : 0;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}
