import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";

const DIRS = [
  "Agents/main", "Memory/Daily", "Memory/Entities", "Skills", "Jobs", "Inbox", "Imports", "Sessions", "System",
];

const FILES: Record<string, string> = {
  "Agents/main/agent.md": `---
name: main
---

Settings for this agent. Values here override \`System/config.md\` for this agent (from M1).
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

<!-- Checklist for proactive work. Empty means the heartbeat is skipped. Used from M1. -->
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
plugins: []
---

# Configuration

Edit the properties above. Changes are picked up without a restart.

- \`provider\`: which model endpoint to talk to.
- \`local_model\`: the model file in \`models/\` and how the bundled server runs it.
- \`plugins\`: extra plugin modules to load from \`runtime/plugins/\`.
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

Writing outside the home folder is always refused and cannot be changed here.
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
