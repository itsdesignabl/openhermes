import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";

const DIRS = [
  "Agents/main", "Memory/Daily", "Memory/Entities", "Skills", "Jobs", "Inbox", "Imports", "Sessions", "System",
];

const FILES: Record<string, string> = {
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
  history_max_chars: 16000
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
routing:
  default_agent: main
  bindings: []          # for example: - { channel: telegram, peer: "12345", agent: work }
plugins: []
---

# Configuration

Edit the properties above. Changes are picked up without a restart.

- \`provider\`: which model endpoint to talk to.
- \`local_model\`: the model file in \`models/\` and how the bundled server runs it.
- \`learning\`: when the agent reviews conversations for things worth keeping. What it may save on its own is in \`policies.md\`.
- \`gateway\`: where the always-on process listens. It only accepts connections from this computer.
- \`channels\`: chat services. Store the bot token with \`openhermes secret set telegram_bot_token\` (or \`discord_bot_token\`), set \`enabled: true\`, and restart the gateway.
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
  import.user: auto
  import.agent: ask
command_allowlist:
  - git status
  - git log
  - git diff
  - node --version
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
| \`import.user\` | Copy in an outside file that you named in your message |
| \`import.agent\` | Copy in an outside file the agent chose itself |

The same rules apply when the agent reviews a conversation afterwards. Where a rule says \`ask\`, the suggestion is written to the \`Inbox\` folder and waits there until you set its \`status\` to \`approved\` or \`rejected\`.

Writing outside the home folder is always refused and cannot be changed here. The agent can also never edit this file or the notes in \`Inbox\`.
`,
};

/** Create the home folder structure. Existing files are never overwritten. */
export function scaffold(home: Home): { created: string[] } {
  home.ensureDirs();
  const created: string[] = [];
  for (const d of DIRS) fs.mkdirSync(path.join(home.vault, d), { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
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
