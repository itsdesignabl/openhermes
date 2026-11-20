import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
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
  gateway run              Run the always-on gateway in this window
  gateway start|stop|status  Run it in the background, stop it, or see what it is doing
  pair list                Who may talk to the agent, and who is waiting
  pair approve <code>      Approve a pairing code someone received from the bot
  pair revoke <channel:id> Remove someone's access
  secret set <name>        Store a bot token or API key (also: list, remove <name>)
  import openclaw|hermes   Bring in personality, memory and skills from another agent
        --source <folder>    where it is installed (default: found in your user folder)
        --dry-run            show what would happen without writing anything
  import vault <folder>    Copy an existing notes folder into the vault
  obsidian install         Put the chat pane plugin into this vault for Obsidian
  inbox                    What the agent wants to keep and is waiting for you to approve
  inbox approve <id>       Approve it (also: inbox reject <id>, inbox show <id>)
  reflect [session note]   Review a conversation now for things worth keeping (default: the latest)
  curate                   Tidy memory and archive unused skills now
  skills                   List skills with where they came from and how often they were used
  skills import <folder>   Copy in a skill from elsewhere; it is scanned and waits for your approval
  skills trust <name>      Approve an imported skill (also: skills scan <name>, skills block <name>)
  eval [--only <text>]     Run the tool-calling test against the configured model
  bench                    Measure whether learned skills make repeated tasks cheaper
        --trials <n>         runs per task type and arm (default 3)
        --only <a,b>         only task types whose name contains one of these
        --arms <a,b>         any of baseline, learned, reference
  stats [--days <n>]       What your recent turns cost, by week and by skill
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
      trials: { type: "string" },
      arms: { type: "string" },
      days: { type: "string" },
      force: { type: "boolean" },
      source: { type: "string" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
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
      const { openBackend } = await import("./tui/backend.js");
      const backend = await openBackend(home);
      backend.onNotice((level, message) => console.error(`[${level}] ${message}`));
      try {
        const answer = await backend.send(
          text,
          (e) => {
            if (e.type === "tool_requested") console.error(`  → ${e.name} ${JSON.stringify(e.args).slice(0, 160)}`);
            else if (e.type === "tool_finished") console.error(`  ${e.ok ? "✓" : "✗"} ${e.summary}`);
            else if (e.type === "log") console.error(`[${e.level}] ${e.message}`);
          },
          async (action, detail) => {
            if (!process.stdin.isTTY) {
              console.error(`[declined, not interactive] ${action}: ${detail}`);
              return false;
            }
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            const canAlways = action.startsWith("command.");
            const reply = (await rl.question(`Allow ${action}: ${detail}? [y/N${canAlways ? "/a = always" : ""}] `)).trim();
            rl.close();
            return canAlways && /^a/i.test(reply) ? "always" : /^y/i.test(reply);
          },
        );
        console.log(answer);
      } finally {
        await backend.close();
      }
      return 0;
    }

    case "gateway": {
      const sub = rest[0] ?? "run";
      const { findGateway } = await import("./gateway/client.js");
      if (sub === "run") {
        if (await findGateway(home)) throw new Error("A gateway is already running for this home. Stop it with: openhermes gateway stop");
        const { Gateway } = await import("./gateway/gateway.js");
        const app = await App.start(home);
        const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
        for (const e of app.startupLogs) console.log(`${stamp()} [${e.level}] ${e.message}`);
        app.bus.on("log", (e) => console.log(`${stamp()} [${e.level}] ${e.message}`));
        app.bus.on("config.reloaded", (e) => console.log(`${stamp()} ${e.ok ? "[info] Settings reloaded." : `[error] Settings not applied: ${e.error}`}`));
        const gateway = new Gateway(app);
        const { host, port } = await gateway.start();
        console.log(`${stamp()} [info] Gateway listening on ${host}:${port}. Home: ${home.root}`);
        const names = [...gateway.channels.keys()];
        console.log(`${stamp()} [info] Channels: ${names.length ? names.join(", ") : "none enabled (see channels in System/config.md)"}`);
        await new Promise<void>((resolve) => {
          gateway.onStopped = resolve;
          process.on("SIGINT", () => void gateway.stop());
          process.on("SIGTERM", () => void gateway.stop());
        });
        await app.stop();
        console.log(`${stamp()} [info] Gateway stopped.`);
        return 0;
      }
      if (sub === "start") {
        if (await findGateway(home)) {
          console.log("The gateway is already running.");
          return 0;
        }
        const { spawn } = await import("node:child_process");
        const logFile = path.join(home.data, "logs", "gateway.log");
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const out = fs.openSync(logFile, "a");
        const child = spawn(process.execPath, [process.argv[1]!, "gateway", "run", "--home", home.root], {
          detached: true,
          stdio: ["ignore", out, out],
          windowsHide: true,
        });
        child.unref();
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (await findGateway(home)) {
            console.log(`Gateway started in the background. Log: ${logFile}`);
            return 0;
          }
          if (child.exitCode !== null) break;
        }
        throw new Error(`The gateway did not start. See ${logFile}`);
      }
      const client = await findGateway(home);
      if (sub === "stop") {
        if (!client) console.log("The gateway is not running.");
        else {
          await client.post("/v1/shutdown");
          console.log("Gateway stopped.");
        }
        return 0;
      }
      if (sub === "status") {
        if (!client) {
          console.log("The gateway is not running.");
          return 1;
        }
        const st = await client.get("/v1/status");
        console.log(`Running (pid ${st.pid}, up ${Math.round(st.uptime_s / 60)} min) at ${client.url}`);
        console.log(`Model:    ${st.model}`);
        console.log(`Channels: ${st.channels.length ? "" : "none enabled"}`);
        for (const c of st.channels) console.log(`  ${c.name.padEnd(10)} ${c.state}`);
        console.log(`Jobs:     ${st.jobs.length ? "" : "none"}`);
        for (const j of st.jobs) console.log(`  ${j.name.padEnd(20)} agent ${j.agent}, next ${j.next}, last ${j.last}`);
        return 0;
      }
      throw new Error("Use: openhermes gateway run | start | stop | status");
    }

    case "obsidian": {
      if (rest[0] !== "install") throw new Error("Use: openhermes obsidian install");
      const built = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "obsidian");
      if (!fs.existsSync(path.join(built, "main.js"))) throw new Error("The plugin has not been built. Run `npm run build` in the runtime folder first.");
      const config = path.join(home.vault, ".obsidian");
      const dest = path.join(config, "plugins", "openhermes");
      fs.mkdirSync(dest, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(built, f), path.join(dest, f));
      // switch the plugin on, keeping whatever else is enabled
      const listFile = path.join(config, "community-plugins.json");
      let enabled: string[] = [];
      try {
        enabled = JSON.parse(fs.readFileSync(listFile, "utf8"));
      } catch {}
      if (!enabled.includes("openhermes")) fs.writeFileSync(listFile, JSON.stringify([...enabled, "openhermes"], null, 2));
      console.log(`Installed the OpenHermes plugin into ${home.display(dest)}.`);
      console.log("In Obsidian: open this vault, go to Settings → Community plugins, and choose \"Turn on community plugins\".");
      console.log("Then click the speech-bubble icon in the left ribbon, or run the command \"OpenHermes: Open chat\".");
      return 0;
    }

    case "import": {
      const [what, positional] = rest;
      const dryRun = !!values["dry-run"];
      const { importAgent, importVault, defaultSource } = await import("./import/importer.js");
      const commit = async (message: string) => {
        const { default: git } = await import("isomorphic-git");
        const history = new VaultHistory(home.vault);
        await history.init();
        for (const [file, head, workdir] of await git.statusMatrix({ fs, dir: home.vault })) {
          if (head === 1 && workdir === 0) await git.remove({ fs, dir: home.vault, filepath: file });
          else if (workdir !== 1) await git.add({ fs, dir: home.vault, filepath: file });
        }
        await git.commit({ fs, dir: home.vault, message, author: { name: "OpenHermes user", email: "user@openhermes.local" } });
      };
      if (what === "vault") {
        const src = positional ?? values.source;
        if (!src) throw new Error("Give the folder to copy: openhermes import vault <folder>");
        const r = importVault(home, src);
        await commit(`Import notes from ${src}`);
        console.log(`Copied ${r.files} files to ${home.display(r.dest)}. The original was not changed.`);
        return 0;
      }
      if (what === "openclaw" || what === "hermes") {
        const src = values.source ?? positional ?? defaultSource(what);
        if (!src) throw new Error(`No ${what === "openclaw" ? "OpenClaw" : "Hermes Agent"} folder was found in your user folder. Give its location with --source <folder>.`);
        const report = importAgent(home, loadConfig(home), what, src, { agent: values.agent, dryRun });
        console.log(`${dryRun ? "Dry run: nothing was written. This is what would happen" : "Imported"} from ${report.source}\n`);
        for (const s of report.steps) console.log(`${s.status.padEnd(8)}${s.what}\n        ${s.detail}`);
        if (!dryRun) {
          await commit(`Import from ${what}`);
          console.log(`\nThe originals and this report are in ${home.display(report.archive)}. Undo is possible through the vault history.`);
        }
        return 0;
      }
      throw new Error("Use: openhermes import openclaw | hermes [--source <folder>] [--dry-run] [--agent <name>]   or   openhermes import vault <folder>");
    }

    case "inbox": {
      const { listInbox, findPending } = await import("./learning/inbox.js");
      const sub = rest[0] ?? "list";
      if (sub === "list") {
        const pending = listInbox(home).filter((i) => i.status === "pending");
        if (!pending.length) console.log("Nothing is waiting for approval.");
        for (const i of pending) console.log(`${i.id}  ${i.title}`);
        if (pending.length) console.log(`\nApprove with: openhermes inbox approve <id>   (or set status in the note in ${home.display(path.join(home.vault, "Inbox"))})`);
        return 0;
      }
      if (sub === "show") {
        const item = rest[1] ? findPending(home, rest[1]) : undefined;
        if (!item) throw new Error("Nothing is waiting under that id. See: openhermes inbox");
        console.log(fs.readFileSync(item.file, "utf8"));
        return 0;
      }
      if ((sub === "approve" || sub === "reject") && rest[1]) {
        const { openBackend } = await import("./tui/backend.js");
        const backend = await openBackend(home);
        try {
          console.log(await backend.resolve(rest[1], sub === "approve"));
        } finally {
          await backend.close();
        }
        return 0;
      }
      throw new Error("Use: openhermes inbox [list] | show <id> | approve <id> | reject <id>");
    }

    case "reflect": {
      let file = rest[0];
      if (!file) {
        const dir = path.join(home.vault, "Sessions");
        const notes = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !/(heartbeat|job)_/.test(f)).sort() : [];
        if (!notes.length) throw new Error("There are no saved conversations yet.");
        file = `Sessions/${notes.at(-1)}`;
      }
      const { openBackend } = await import("./tui/backend.js");
      const backend = await openBackend(home);
      try {
        console.log(`Reviewing ${file} ...`);
        const r = await backend.reflect(file);
        for (const t of r.applied) console.log(`saved     ${t}`);
        for (const t of r.pending) console.log(`inbox     ${t}`);
        for (const t of r.skipped) console.log(`skipped   ${t}`);
        if (!r.applied.length && !r.pending.length && !r.skipped.length) console.log("Nothing worth keeping.");
      } finally {
        await backend.close();
      }
      return 0;
    }

    case "curate": {
      const { openBackend } = await import("./tui/backend.js");
      const backend = await openBackend(home);
      try {
        const actions = await backend.curate();
        console.log(actions.length ? actions.join("\n") : "Nothing to tidy.");
      } finally {
        await backend.close();
      }
      return 0;
    }

    case "skills": {
      const sub = rest[0];
      if (sub && sub !== "list") {
        const { importSkills, rescanSkill, trustSkill, blockSkill, formatFinding } = await import("./learning/skills.js");
        const show = (findings: { severity: string }[]) => (findings as any[]).forEach((f) => console.log("  " + formatFinding(f).replace(/\n/g, "\n  ")));
        const done = async () => {
          // the files changed outside a turn: record them in the vault history
          const { default: git } = await import("isomorphic-git");
          await git.add({ fs, dir: home.vault, filepath: "Skills" }).catch(() => {});
          await git.commit({ fs, dir: home.vault, message: `Skills: ${rest.join(" ")}`, author: { name: "OpenHermes user", email: "user@openhermes.local" } }).catch(() => {});
          return 0;
        };
        if (sub === "import" && rest[1]) {
          for (const r of importSkills(home, rest[1])) {
            console.log(`${r.name}: ${r.trust === "blocked" ? "BLOCKED by the scanner. The agent will not see it." : "imported for review. The agent may read it but not run anything from it."}`);
            show(r.findings);
            if (r.trust === "review") console.log(`  Read it in ${home.display(path.join(home.vault, "Skills", r.name))}, then approve with: openhermes skills trust ${r.name}`);
          }
          return done();
        }
        if (sub === "scan" && rest[1]) {
          const findings = rescanSkill(home, rest[1]);
          console.log(findings.length ? `${findings.length} finding(s):` : "Nothing found.");
          show(findings);
          return done();
        }
        if (sub === "trust" && rest[1]) {
          const findings = trustSkill(home, rest[1], values.force);
          console.log(`'${rest[1]}' is now trusted as it is. If its files change, it goes back under review.`);
          show(findings);
          return done();
        }
        if (sub === "block" && rest[1]) {
          blockSkill(home, rest[1]);
          console.log(`'${rest[1]}' is blocked. The agent will not see it.`);
          return done();
        }
        throw new Error("Use: openhermes skills [list] | import <folder> | scan <name> | trust <name> [--force] | block <name>");
      }
      const { effectiveTrust } = await import("./learning/scanner.js");
      const { readUsage } = await import("./learning/curator.js");
      const { bodyHash } = await import("./learning/proposals.js");
      const { parseNote } = await import("./vault/frontmatter.js");
      const dir = path.join(home.vault, "Skills");
      const usage = readUsage(home);
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith("_") && !n.startsWith(".") && fs.existsSync(path.join(dir, n, "SKILL.md"))) : [];
      if (!names.length) console.log("No skills yet.");
      for (const n of names.sort()) {
        const { data, body } = parseNote<Record<string, any>>(fs.readFileSync(path.join(dir, n, "SKILL.md"), "utf8"));
        const prov = data.provenance ?? {};
        const edited = prov.hash && prov.hash !== bodyHash(body) ? ", edited by hand since" : "";
        const trust = effectiveTrust(path.join(dir, n, "SKILL.md"));
        const source =
          prov.source === "self"
            ? `written by the agent (${prov.approved_by === "user" ? "you approved it" : "allowed by policy"}${edited})`
            : prov.source === "import"
              ? `imported from ${prov.imported_from}${data.trust === "trusted" && trust === "review" ? " (changed since you approved it)" : ""}`
              : "written by you";
        console.log(`${n}\n  ${data.description ?? ""}\n  ${source}; trust: ${trust}; used ${usage[n]?.uses ?? 0} time(s)\n`);
      }
      const archived = fs.existsSync(path.join(dir, "_archive")) ? fs.readdirSync(path.join(dir, "_archive")) : [];
      if (archived.length) console.log(`Archived (in Skills/_archive): ${archived.join(", ")}`);
      return 0;
    }

    case "pair": {
      const { Pairing } = await import("./gateway/pairing.js");
      const pairing = new Pairing(home);
      const sub = rest[0] ?? "list";
      if (sub === "list") {
        const { approved, pending } = pairing.list();
        console.log("Approved:");
        for (const [id, e] of Object.entries(approved)) console.log(`  ${id.padEnd(28)} ${e.name}`);
        if (!Object.keys(approved).length) console.log("  none");
        console.log("Waiting for approval:");
        for (const [code, e] of Object.entries(pending)) console.log(`  ${code}  ${e.channel}:${e.sender}  ${e.name}`);
        if (!Object.keys(pending).length) console.log("  none");
        return 0;
      }
      if (sub === "approve") {
        const entry = rest[1] ? pairing.approve(rest[1]) : null;
        if (!entry) throw new Error("No waiting request with that code. Codes expire after an hour. See: openhermes pair list");
        console.log(`Approved ${entry.name} (${entry.channel}:${entry.sender}).`);
        return 0;
      }
      if (sub === "revoke") {
        if (!rest[1] || !pairing.revoke(rest[1])) throw new Error("No approved sender with that id. See: openhermes pair list");
        console.log(`Revoked ${rest[1]}.`);
        return 0;
      }
      throw new Error("Use: openhermes pair list | approve <code> | revoke <channel:id>");
    }

    case "secret": {
      const { writeSecret, listSecretNames, secretsStatus } = await import("./kernel/secrets.js");
      const [sub, name] = rest;
      if (sub === "list") {
        const names = listSecretNames(home);
        console.log(names.length ? names.join("\n") : "No keys stored.");
        console.log(`\n(${secretsStatus(home).summary})`);
        return 0;
      }
      if (sub === "remove" && name) {
        writeSecret(home, name, "");
        console.log(`Removed ${name}.`);
        return 0;
      }
      if (sub === "set" && name) {
        let value: string;
        if (process.stdin.isTTY) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          value = await rl.question(`Value for ${name} (it will be visible while you paste): `);
          rl.close();
        } else {
          value = fs.readFileSync(0, "utf8");
        }
        value = value.trim();
        if (!value) throw new Error("No value given.");
        writeSecret(home, name, value);
        const status = secretsStatus(home);
        console.log(`Stored ${name}. The secrets folder now holds ${status.summary.replace(/\.$/, "")}.`);
        return 0;
      }
      throw new Error("Use: openhermes secret set <name> | list | remove <name>");
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

    case "bench": {
      const { runBench, ARMS } = await import("./eval/bench.js");
      const arms = values.arms ? (values.arms.split(",").map((a) => a.trim()) as (typeof ARMS)[number][]) : undefined;
      const bad = arms?.find((a) => !ARMS.includes(a));
      if (bad) throw new Error(`Unknown arm '${bad}'. Use any of: ${ARMS.join(", ")}`);
      const trials = values.trials ? Number(values.trials) : undefined;
      if (trials !== undefined && (!Number.isInteger(trials) || trials < 1)) throw new Error("--trials must be a whole number of 1 or more.");
      await runBench(home, { trials, only: values.only, arms, log: console.log });
      return 0;
    }

    case "stats": {
      const { readTurns, summarize, formatSummary } = await import("./eval/metrics.js");
      const days = values.days ? Number(values.days) : 30;
      if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number.");
      console.log(formatSummary(summarize(readTurns(home, Date.now() - days * 86_400_000), days)));
      return 0;
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
      {
        const app = await App.start(home, { watch: false });
        const problem = await app.backend.check();
        line(!problem, problem ? `commands (${app.backend.name}): ${problem}` : `commands run ${app.backend.name === "local" ? "on this computer, without a sandbox" : `in the ${app.backend.name} backend`}`);
        for (const name of [...config.plugins, ...config.external_plugins.map((p) => p.name)]) {
          const failure = app.startupLogs.find((e) => e.level === "error" && e.message.startsWith(`plugin '${name}'`));
          line(!failure, failure ? failure.message : `plugin '${name}' loaded`);
        }
        await app.stop();
      }
      {
        const { secretsStatus } = await import("./kernel/secrets.js");
        const status = secretsStatus(home);
        // unencrypted keys are worth knowing about but are not a fault; a store that cannot be opened is
        if (status.problem && status.protection === "none" && status.count) console.log(`warn  stored keys: ${status.summary}`);
        else line(!status.problem, `stored keys: ${status.summary}`);
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
