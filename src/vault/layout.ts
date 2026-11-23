import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";

const DIRS = [
  "Agents/main", "Memory/Daily", "Memory/Entities", "Skills", "Jobs", "Inbox", "Imports", "Sessions", "System",
];

/** The notes a new vault starts with. Importers use them to tell an untouched note from one you edited. */
export const STARTER_NOTES: Record<string, string> = {
  "Agents/main/agent.md": `---
heartbeat:
  every: 30m          # 0m turns it off
  target: last        # last | none | telegram:<chat id> | discord:<channel id>
  active_hours: ""    # for example 08:00-22:00
---

# Agent settings

Optional overrides for this agent only:

- \`provider\`: \`base_url\`, \`model\`, \`api_key_secret\`, \`temperature\`
- \`tools\`: a list of tool names; when present, only these are offered
- \`heartbeat\`: how often the agent checks \`HEARTBEAT.md\` and where it reports

To add another agent, copy this folder under a new name and add a binding in \`System/config.md\`.
`,
  "Agents/main/SOUL.md": `# Soul

You are a capable, direct personal assistant. You say what you did and what you could not do.
You prefer doing the task over describing it. You keep answers short unless asked for depth.
`,
  "Agents/main/AGENTS.md": `# Operating rules

- Everything you know and do lives in the home folder. You cannot write outside it.
- To use a file from elsewhere on the machine, import it first with \`import_file\`. You then work on the copy.
- Before answering questions about the user, their projects or earlier conversations, search memory.
- Save durable facts with \`memory_add\`. Keep entries short. One fact per entry.
- When a tool fails, read the error and try a different approach before giving up.
`,
  "Agents/main/HEARTBEAT.md": `# Heartbeat

<!-- Checklist for proactive work, read on every heartbeat while the gateway runs.
     While there are no items here the heartbeat is skipped and costs nothing. Example:
     - If a note in Inbox/ is older than two days, remind me about it. -->
`,
  "Memory/MEMORY.md": `# Memory

<!-- Curated long-term facts. Size-limited: see memory.memory_max_chars in System/config.md. -->
`,
  "Memory/USER.md": `# User

<!-- What the agent knows about you. Size-limited: see memory.user_max_chars in System/config.md. -->
`,
  "System/config.md": `---
agent: main
provider:
  # Leave base_url empty to use the bundled local model in models/.
  # For Ollama use http://127.0.0.1:11434/v1, for LM Studio http://127.0.0.1:1234/v1
  base_url: ""
  model: local
  api_key_secret: ""
  temperature: 0.2
  context_tokens: 8192        # the model's context window when base_url is set; must match the model server
local_model:
  file: ""
  port: 18790
  context_tokens: 8192
agent_loop:
  max_steps: 12
memory:
  memory_max_chars: 4000
  user_max_chars: 2000
  search_results: 5
session:
  summarize: true             # when earlier turns no longer fit the model, keep a summary of them
backend:
  type: local                 # local | docker | ssh : where shell commands run
  docker:
    image: python:3.12-slim
    network: bridge           # none = commands have no internet access
    mount_vault: ro           # ro | rw | none : whether commands can see the vault
  ssh:
    host: ""
    user: ""
hooks: []                     # for example: - { event: tool.before, match: run_command, command: [python, hooks/audit.py] }
external_plugins: []          # for example: - { name: weather, command: [python, plugins/weather.py] }
mcp_servers: []               # for example: - { name: files, command: [npx, -y, "@modelcontextprotocol/server-filesystem", "C:/Some/Folder"] }
learning:
  enabled: true
  reflect_every_turns: 10     # review a conversation after this many of your messages
  reflect_idle_minutes: 30    # ... or once it has been quiet this long (gateway only)
  curator_every: 24h          # tidy memory and skills this often (gateway only)
  archive_unused_days: 60     # archive skills the agent wrote and has not used this long
  notify: true                # tell me in chat when something waits in the Inbox
gateway:
  host: 127.0.0.1
  port: 18789
  approval_timeout_s: 300
channels:
  telegram:
    enabled: false
    allow_from: []      # Telegram user ids that need no pairing
    pairing: true
    require_mention: true
  discord:
    enabled: false
    allow_from: []
    pairing: true
    require_mention: true
  slack:
    enabled: false
    allow_from: []
    pairing: true
    require_mention: true
routing:
  default_agent: main
  bindings: []          # for example: - { channel: telegram, peer: "12345", agent: work }
plugins: []
---

# Configuration

Edit the properties above. Changes are picked up without a restart.

- \`provider\`: which model endpoint to talk to. \`context_tokens\` must match the window your model server actually gives the model (in Ollama, its context length setting). The agent fits each request into it: older tool results and turns are left out or summarised when space runs short.
- \`local_model\`: the model file in \`models/\` and how the bundled server runs it.
- \`backend\`: where shell commands run. \`docker\` runs them in a container that sees only the workspace folder and, read-only, the vault. It needs Docker Desktop. \`ssh\` runs them on another machine.
- \`hooks\`: programs run before or after a turn or tool call. They start in the \`runtime\` folder, receive JSON on standard input, and can refuse or change the action.
- \`external_plugins\`: plugins written in any language. See \`docs/PLUGINS.md\` in the program folder.
- \`mcp_servers\`: tool servers that speak the Model Context Protocol. Give each a \`name\` and either a \`command\` (a local program) or a \`url\` (with \`token_secret\` naming a stored key). \`tools: [a, b]\` limits which of its tools are offered. The agent asks before using a tool until you answer "always".
- \`learning\`: when the agent reviews conversations for things worth keeping. What it may save on its own is in \`policies.md\`.
- \`gateway\`: where the always-on process listens. It only accepts connections from this computer.
- \`channels\`: chat services. Store the bot token with \`openhermes secret set telegram_bot_token\` (or \`discord_bot_token\`; Slack needs both \`slack_bot_token\` and \`slack_app_token\`), set \`enabled: true\`, and restart the gateway.
- \`routing\`: which agent answers which chat. The first matching binding wins.
- \`plugins\`: extra plugin modules to load from \`runtime/plugins/\`.
`,
  "Jobs/README.md": `# Jobs

Each note in this folder with a schedule in its properties is a job. The text below the properties is the instruction the agent receives. Jobs run while the gateway is running.

\`\`\`
---
schedule: "0 9 * * 1-5"   # minute hour day month weekday, local time
agent: main
target: last              # last | none | telegram:<chat id> | discord:<channel id>
---

Summarise yesterday's daily note in three bullet points.
\`\`\`

Use \`every: 2h\` for a fixed interval or \`at: 2026-12-01T09:00\` for a single run, in place of \`schedule\`. Add \`enabled: false\` to pause a job.
`,
  "System/policies.md": `---
policies:
  memory.edit: auto
  vault.write: auto
  skill.edit: auto
  skill.edit_executable: ask
  command.allowlisted: auto
  command.other: ask
  command.sandboxed: ask
  mcp.call: ask
  import.user: auto
  import.agent: ask
command_allowlist:
  - git status
  - git log
  - git diff
  - node --version
mcp_allowlist: []
---

# Policies

Each action is \`auto\` (do it), \`ask\` (ask me first) or \`deny\` (never).

| Action | Meaning |
|---|---|
| \`memory.edit\` | Change MEMORY.md, USER.md, daily notes, entity notes |
| \`vault.write\` | Create or change any other note in the vault |
| \`skill.edit\` | Create or change a skill that has no scripts |
| \`skill.edit_executable\` | Create or change a skill that contains scripts or commands |
| \`command.allowlisted\` | Run a command listed in \`command_allowlist\` |
| \`command.other\` | Run any other command |
| \`command.sandboxed\` | Run any other command when \`backend.type\` is \`docker\` (used in place of \`command.other\`) |
| \`mcp.call\` | Use a tool from a tool server that is not listed in \`mcp_allowlist\` |
| \`import.user\` | Copy in an outside file that you named in your message |
| \`import.agent\` | Copy in an outside file the agent chose itself |

The same rules apply when the agent reviews a conversation afterwards. Where a rule says \`ask\`, the suggestion is written to the \`Inbox\` folder and waits there until you set its \`status\` to \`approved\` or \`rejected\`.

When asked about a command or a tool-server tool you can answer "always": that adds it to \`command_allowlist\` or \`mcp_allowlist\` above.

Writing outside the home folder is always refused and cannot be changed here. The agent can also never edit the notes in this \`System\` folder, an agent's \`agent.md\`, or the notes in \`Inbox\`.
`,
};

/** Create the home folder structure. Existing files are never overwritten. */
export function scaffold(home: Home): { created: string[] } {
  home.ensureDirs();
  const created: string[] = [];
  for (const d of DIRS) fs.mkdirSync(path.join(home.vault, d), { recursive: true });
  for (const [rel, content] of Object.entries(STARTER_NOTES)) {
    const file = path.join(home.vault, rel);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, content);
      created.push(rel);
    }
  }
  const launcher = path.join(home.root, process.platform === "win32" ? "openhermes.cmd" : "openhermes.sh");
  if (!fs.existsSync(launcher)) {
    const body =
      process.platform === "win32"
        ? `@echo off\r\nset "OPENHERMES_HOME=%~dp0."\r\nnode "%~dp0runtime\\dist\\src\\cli.js" %*\r\n`
        : `#!/bin/sh\nd="$(cd "$(dirname "$0")" && pwd)"\nOPENHERMES_HOME="$d" exec node "$d/runtime/dist/src/cli.js" "$@"\n`;
    fs.writeFileSync(launcher, body, { mode: 0o755 });
  }
  return { created };
}
