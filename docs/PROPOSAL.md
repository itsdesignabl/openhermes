# OpenHermes: Design Proposal (v3)

> A self-hosted personal agent with **OpenClaw's reach** and **Hermes' ability to learn**, where **your notes vault is the agent's brain, configuration and control panel**.

Status: **draft for discussion**. Background is in [RESEARCH.md](RESEARCH.md). It is designed around four requirements: maximum customizability, a local structure such as Obsidian, the best-fitting language, and one self-contained folder that holds the whole agent.

## 1. Design principles

1. **The vault is the agent.** Personality, rules, memory, skills, schedules and pending approvals are plain Markdown files in a folder. Open the folder in Obsidian and you can read and change everything the agent knows or does.
2. **Small kernel, everything else a plugin.** The core only moves events between plugins and enforces permissions. Channels, model providers, memory search, tools, the learning loop and the scheduler are all replaceable.
3. **Customize without code first.** Most changes are edits to a note. Code is needed only for new integrations, and then in any language.
4. **Local-first.** It runs fully offline with a local model. Nothing leaves the machine unless you add a cloud provider or a chat channel.
5. **Every self-change is reversible.** The agent commits its own edits to git, so anything it learns can be reviewed and undone.
6. **One folder holds everything.** The program, the vault, the model, the index, the keys and the logs all live in one home folder. The agent writes nowhere else. Deleting that folder deletes the agent and all of its data.
7. **Secure by default.** Carried over from v1: loopback only, authentication required, sandboxed tool execution, and no trusted marketplace.

## 2. The home folder and the vault

Everything lives in one home folder. The default is `C:\Openhermes Programming Files` and the path can be changed at install time.

```
C:\Openhermes Programming Files\
├── vault\       ← open this folder in Obsidian
├── models\      ← local model files
├── runtime\     ← the program itself and its bundled dependencies (portable, no installer)
├── data\        ← search index, logs, caches (all rebuildable)
├── secrets\     ← API keys and channel tokens, encrypted for your Windows account
└── workspace\   ← scratch area where the agent runs commands and code
```

### Containment rules

- **Writes:** every file tool resolves the real path (following links and junctions) and refuses anything outside the home folder. This is enforced in the kernel and cannot be relaxed by a skill or plugin.
- **Reads from outside:** when you or the agent reference a file or folder elsewhere on the machine, it is copied into `vault\Imports\` first, with a note of where it came from and when. The agent works on the copy. The original is never changed.
- **Commands:** shell commands start in `workspace\`. File tools are strictly contained. A shell command can in principle touch other paths, so commands go through the allowlist and approval policy. Strict containment of commands needs a sandbox (section 3.2, backend slot).
- **No installer footprint:** no registry entries, services or files in your user profile. Auto-start at login is opt-in and is the one thing that would live outside the folder.

### What deleting the folder does not remove

- Messages already sent to chat services, and bot accounts or tokens registered with them (revoke those at the service).
- Data sent to a cloud model provider, if you configure one.
- Optional external tools you install yourself, such as Docker or Obsidian, and Obsidian's own entry for the vault in its vault list.
- A copy of the vault on other devices, if you sync it.

### Vault layout

```
vault\
├── Agents\
│   └── main\
│       ├── agent.md        ← frontmatter: model, tools, channels, policies
│       ├── SOUL.md         ← personality (OpenClaw-compatible)
│       ├── AGENTS.md       ← operating rules
│       └── HEARTBEAT.md    ← proactive checklist
├── Memory\
│   ├── MEMORY.md           ← curated facts, size-limited
│   ├── USER.md             ← what the agent knows about you
│   ├── Daily\2026-11-17.md ← append-only daily log
│   └── Entities\           ← one note per person, project, topic; [[wikilinks]]
├── Skills\
│   └── <name>\SKILL.md     ← Agent Skills format, with provenance in frontmatter
├── Jobs\                   ← one note per scheduled job (frontmatter: schedule, target)
├── Inbox\                  ← proposals waiting for your approval
├── Imports\                ← copies of anything referenced from outside the home folder
├── Sessions\               ← conversation transcripts
└── System\
    ├── config.md           ← gateway, routing, providers, plugin list
    └── policies.md         ← what the agent may do on its own
```

One vault is shared by all agents, with a folder per agent under `Agents\`. Memory and skills are shared by default so that what one agent learns is available to the others; an agent can be given private memory in its own folder.

Only `vault\` is meant to be synced or opened in Obsidian. Keys stay in `secrets\`, outside the vault, so syncing the vault never copies them.

### How Obsidian fits

| Mode | What it needs | What you get |
|---|---|---|
| **Files only** (default) | Nothing. OpenHermes watches the folder | Edit any note and the agent picks it up. Works with Obsidian closed |
| **Native Obsidian features** | Obsidian open | Graph view of memory through wikilinks; dashboards over frontmatter (Bases or Dataview) for skills, jobs and the inbox; mobile access through any sync you already use |
| **Companion plugin** (later, optional) | A small Obsidian plugin | Chat pane, approve/reject buttons, agent status |

The core does not depend on any Obsidian plugin or API. This keeps the agent working when Obsidian is closed and avoids breaking on Obsidian updates.

### Approvals as notes

When an action needs your sign-off, the agent writes a note to `Inbox\` with `status: pending` in the frontmatter. You change it to `approved` or `rejected` in Obsidian, or reply in chat. The same mechanism serves every kind of approval.

What needs sign-off is set in `System\policies.md`, one line per kind of action, each set to `auto`, `ask` or `deny`. The starting values:

| Action | Default |
|---|---|
| Edit memory and entity notes | `auto` |
| Create or change a skill with no executable steps | `auto` |
| Create or change a skill with executable steps | `ask` |
| Run a command on the allowlist | `auto` |
| Run a command not on the allowlist | `ask` |
| Send a message to someone other than you | `ask` |
| Copy an outside file into `Imports\` | `auto` when you referenced it, `ask` when the agent wants it |
| Write outside the home folder | `deny` (fixed, not configurable) |

Rules can be overridden per agent in `agent.md` and per channel.

### Write safety

- The agent writes only inside the home folder (section 2, containment rules).
- Writes are atomic (write to a temporary file, then rename), and the agent re-reads a note before changing it, so it does not overwrite an edit you made in the meantime.
- Each agent write is a git commit with a message saying what changed and why. The git history is stored inside the home folder.

## 3. Architecture

```
   Chat channels          Vault (Markdown)            Local / cloud models
 Telegram Discord …      watched for changes         Ollama · OpenAI-compatible · …
        │                       │                              │
        ▼                       ▼                              ▼
┌──────────────────────────── Plugins ─────────────────────────────────┐
│ channel · provider · memory · tool (MCP) · backend · scheduler ·     │
│ learner · hook                                                       │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────── Kernel ──────────────────────────────────┐
│ event bus · plugin lifecycle · config from vault · permission checks │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Kernel

The kernel is deliberately small. It does four things:

- loads and supervises plugins
- passes typed events between them (`message.received`, `turn.started`, `tool.requested`, `memory.proposed`, `file.changed`, ...)
- reads configuration from the vault and reloads it when a note changes, without a restart
- checks every tool call and file write against `policies.md`

### 3.2 Plugin slots

Each slot has a small interface. The default implementation ships with the project and can be swapped.

| Slot | Default | Examples of replacements |
|---|---|---|
| **channel** | CLI, Telegram, Discord | WhatsApp, Signal, Slack, email, voice |
| **provider** | any OpenAI-compatible endpoint (covers Ollama, LM Studio, llama.cpp) | Anthropic, Gemini, routing between a small and a large model |
| **memory** | vault files + SQLite full-text search | vector search (sqlite-vec with local embeddings), a graph store |
| **tool** | files, shell, web fetch, any MCP server | anything that speaks MCP |
| **backend** (where commands run) | local in `workspace\` with allowlist; Docker when installed | SSH, remote sandboxes |
| **scheduler** | heartbeat + jobs from `Jobs\` | external cron, event triggers |
| **learner** | reflection, proposals, curator (section 3.4) | a different reflection strategy, or none |
| **hook** | none | scripts that run before or after any event |

Plugins come in two forms:

- **In-process:** a TypeScript module. Fastest, full access to the event bus.
- **Out-of-process:** any executable that exchanges JSON over stdin/stdout (the same transport MCP uses). This is how a plugin can be written in Python, Go, Rust or a shell script.

### 3.3 Gateway and routing (from OpenClaw)

- A long-running local process bound to `127.0.0.1`. Binding elsewhere requires a token or device pairing, or it does not start.
- Routing rules in `System\config.md` map a channel, person or group to an agent folder under `Agents\`.
- The heartbeat keeps OpenClaw's behaviour: interval, skipped when `HEARTBEAT.md` is empty, silent when there is nothing to report.

### 3.4 Agent loop and learning (from Hermes)

- A tool-calling loop. Context is built from `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, the skills relevant to the turn, and search results from memory.
- Subagents handle delegated tasks with a restricted set of tools.
- The learning loop runs every N turns and at the end of a session:
  1. A reflection pass reads the transcript.
  2. It proposes memory edits, entity-note updates, and new or patched skills.
  3. `policies.md` decides: apply, send to `Inbox\`, or reject.
  4. A curator job merges duplicates, archives unused skills, and enforces the size limits on `MEMORY.md` and `USER.md`.

### 3.5 Skills and trust

Unchanged from v1 in substance: the `SKILL.md` format, provenance recorded per skill (now in frontmatter, so it is visible and filterable in Obsidian), trust tiers (`trusted`, `review`, `blocked`), a static scan on import, and scripts that run only in the sandbox backend.

## 4. Customization ladder

Each step up needs more skill and gives more control. Most users stay on the first three.

| Level | You edit | Changes |
|---|---|---|
| 0 | Markdown prose | Personality, rules, heartbeat checklist, memory |
| 1 | Frontmatter and `System\` notes | Models, routing, schedules, policies, which plugins load |
| 2 | A `SKILL.md` | New procedures the agent can follow |
| 3 | A hook script, any language | React to or modify any event |
| 4 | An MCP server, any language | New tools |
| 5 | A TypeScript plugin | New channels, providers, memory engines |
| 6 | A slot replacement | Swap the agent loop, learner or scheduler itself |

## 5. Language

**Recommendation: TypeScript on Node.js (current LTS).**

| | TypeScript | Python | Rust / Go |
|---|---|---|---|
| Obsidian plugin | Same language (Obsidian plugins are TypeScript) | Separate codebase | Separate codebase |
| Chat bridges | Best libraries are native (WhatsApp/Baileys, Discord, Telegram) | Bridges needed for some | Bridges needed for most |
| Reuse from OpenClaw | Channel code and conventions port directly | Rewrite | Rewrite |
| Reuse from Hermes | Learning loop is re-implemented (it is prompts plus SQLite, with no ML libraries) | Ports directly | Rewrite |
| MCP SDK | First-party | First-party | Community or newer |
| Distribution | `npm`, or a single executable | Needs a Python environment | Single small binary |
| Iteration speed and contributor pool | High | High | Lower |

Reasons for the choice:

- One language covers the core, the plugins and the Obsidian companion plugin.
- The part taken from OpenClaw (many channel integrations) is far more code than the part taken from Hermes (the learning loop), so matching OpenClaw's language saves more work. This reverses the v1 recommendation of Python, which was made before Obsidian and plugin-first customization were requirements.
- Because out-of-process plugins and MCP servers can be in any language, the core language limits nobody who wants to extend it.

Rust would give the smallest and fastest binary, but an agent spends its time waiting on models and networks, so the speed would not be noticed, and development would be slower.

Stack: Node LTS, `better-sqlite3` with FTS5, a file watcher, `zod` for schemas, `vitest`, MIT license.

## 6. Local model

The model runs through a bundled llama.cpp server in `runtime\`, with model files in `models\`, so it is covered by the one-folder rule. Ollama or LM Studio can be used instead but keep their files elsewhere.

| Tier | Model | Download size (4-bit) | Use when |
|---|---|---|---|
| **Default** | Qwen 3.5 4B | about 3 GB | Any recent laptop, 8 GB RAM, no GPU needed |
| Step up | Qwen 3.5 9B | about 6 GB | 8 GB graphics card or 16 GB RAM |
| Agent fine-tune | Hermes 4 14B (Nous Research, fine-tuned from Qwen3 14B for tool use) | about 9 GB | 12 GB graphics card or 32 GB RAM |

- Qwen 3.5 4B is the smallest model that reviewers report as reliable at calling several tools in sequence. The evidence is one independent test of 13 models (97.5% pass rate) plus vendor benchmarks, so it must be confirmed on our own tasks in M0.
- Models below about 3B parameters handle a single tool call but fail multi-step plans. They are suitable only for the heartbeat check.
- Models can be assigned per task in `agent.md`: for example the 4B model for heartbeat and reflection, and a larger or cloud model for hard tasks.
- **Our own fine-tune (later):** approved sessions in `Sessions\` are training data in the making. A small adapter trained on them would fit the model to your tools and skill format. This belongs after M5, once there is an evaluation to prove it helps.
- **Search:** SQLite full-text search needs nothing extra. Vector search is optional and uses a small local embedding model.

## 7. Interfaces

Every interface is a channel plugin on the same kernel, so they can all be used at once and share one conversation history.

| Interface | Role | Built in |
|---|---|---|
| **CLI** | Install, start, stop, import, diagnose, script. The foundation the others call | M0 |
| **TUI** (full-screen terminal app) | Main local interface early on: chat, live tool activity, approvals, logs | M0-M1 |
| **Chat apps** (Telegram, Discord, ...) | Daily use away from the computer | M1 |
| **Obsidian pane** (companion plugin) | The graphical interface: chat beside your notes, approve buttons, status | M4 |

Recommendation: do not build a separate desktop GUI. Obsidian already is the GUI for everything the agent stores, and a standalone app would duplicate it and add a large codebase. The TUI comes first because it is cheap to build, shows what the agent is doing in real time, and is where development and debugging happen.

## 8. Compatibility and migration

- `openhermes import openclaw [--source ~/.openclaw] [--dry-run]`
- `openhermes import hermes [--source ~/.hermes] [--dry-run]`
- `openhermes import vault <path>` copies an existing Obsidian vault, or selected folders from it, into `vault\Imports\`. The original vault is not modified.

File names match OpenClaw's (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `MEMORY.md`, `USER.md`) and skills match the format Hermes uses, so imports are copies into the home folder, not conversions. Imported skills start in the `review` tier.

## 9. Roadmap

| Milestone | Scope |
|---|---|
| **M0: Kernel and vault** | Event bus, plugin loader, vault layout and watcher, home-folder containment, CLI and TUI, bundled local model (Qwen 3.5 4B) with a tool-calling test suite, tool loop, full-text memory search, git commits for agent writes |
| **M1: Gateway** | Daemon, authentication, routing, Telegram and Discord, heartbeat, jobs from `Jobs\` |
| **M2: Learning** | Reflection, proposals, `Inbox\` approvals, policies, curator, skill provenance |
| **M3: Isolation** | Docker and SSH backends, allowlist, skill scanner, out-of-process plugin protocol and hooks |
| **M4: Ecosystem** | Importers, MCP tools, more channels, Obsidian companion plugin |
| **M5: Evaluation** | Measure whether learned skills reduce cost and turns on repeated tasks |

## 10. Open questions

1. What hardware will it run on (RAM, graphics card)? This decides the model tier.
2. Should strict command containment be required from the start? It needs Docker, WSL or Windows Sandbox, which live outside the home folder.
3. What is the project name and trademark position? "Hermes" is associated with Nous Research. Check before branding the project publicly.
