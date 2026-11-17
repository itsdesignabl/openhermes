# OpenHermes: Design Proposal (v2)

> A self-hosted personal agent with **OpenClaw's reach** and **Hermes' ability to learn**, where **your notes vault is the agent's brain, configuration and control panel**.

Status: **draft for discussion**. Background is in [RESEARCH.md](RESEARCH.md). This version replaces the first plan. It is redesigned around three requirements: maximum customizability, a local structure such as Obsidian, and the best-fitting language.

## 1. Design principles

1. **The vault is the agent.** Personality, rules, memory, skills, schedules and pending approvals are plain Markdown files in a folder. Open the folder in Obsidian and you can read and change everything the agent knows or does.
2. **Small kernel, everything else a plugin.** The core only moves events between plugins and enforces permissions. Channels, model providers, memory search, tools, the learning loop and the scheduler are all replaceable.
3. **Customize without code first.** Most changes are edits to a note. Code is needed only for new integrations, and then in any language.
4. **Local-first.** It runs fully offline with a local model. Nothing leaves the machine unless you add a cloud provider or a chat channel.
5. **Every self-change is reversible.** The agent commits its own edits to git, so anything it learns can be reviewed and undone.
6. **Secure by default.** Carried over from v1: loopback only, authentication required, sandboxed tool execution, and no trusted marketplace.

## 2. The vault

The vault is an ordinary folder. Obsidian is the recommended way to view it but is never required to be running. Logseq, VS Code or a plain text editor work on the same files.

```
Vault/
├── Agents/
│   └── main/
│       ├── agent.md        ← frontmatter: model, tools, channels, policies
│       ├── SOUL.md         ← personality (OpenClaw-compatible)
│       ├── AGENTS.md       ← operating rules
│       └── HEARTBEAT.md    ← proactive checklist
├── Memory/
│   ├── MEMORY.md           ← curated facts, size-limited
│   ├── USER.md             ← what the agent knows about you
│   ├── Daily/2026-11-17.md ← append-only daily log
│   └── Entities/           ← one note per person, project, topic; [[wikilinks]]
├── Skills/
│   └── <name>/SKILL.md     ← Agent Skills format, with provenance in frontmatter
├── Jobs/                   ← one note per scheduled job (frontmatter: schedule, target)
├── Inbox/                  ← proposals waiting for your approval
├── Sessions/               ← conversation transcripts (optional)
└── System/
    ├── config.md           ← gateway, routing, providers, plugin list
    └── policies.md         ← what the agent may do on its own
```

Outside the vault, never synced:

- `~/.openhermes/index.db`: the SQLite search index. It is a cache and can be rebuilt from the vault at any time.
- Secrets (API keys, channel tokens): OS keychain, or an env file. They stay out of the vault because vaults are commonly synced.

### How Obsidian fits

| Mode | What it needs | What you get |
|---|---|---|
| **Files only** (default) | Nothing. OpenHermes watches the folder | Edit any note and the agent picks it up. Works with Obsidian closed |
| **Native Obsidian features** | Obsidian open | Graph view of memory through wikilinks; dashboards over frontmatter (Bases or Dataview) for skills, jobs and the inbox; mobile access through any sync you already use |
| **Companion plugin** (later, optional) | A small Obsidian plugin | Chat pane, approve/reject buttons, agent status |

The core does not depend on any Obsidian plugin or API. This keeps the agent working when Obsidian is closed and avoids breaking on Obsidian updates.

### Approvals as notes

When the learning loop wants to add a skill or run something outside its policy, it writes a note to `Inbox/` with `status: pending` in the frontmatter. You change it to `approved` or `rejected` in Obsidian, or reply in chat. The same mechanism serves every kind of approval.

### Write safety

- The agent writes only inside its own folders unless a policy grants more.
- Writes are atomic (write to a temporary file, then rename), and the agent re-reads a note before changing it, so it does not overwrite an edit you made in the meantime.
- Each agent write is a git commit with a message saying what changed and why.

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
| **backend** (where commands run) | Docker when available, otherwise local with allowlist | SSH, remote sandboxes |
| **scheduler** | heartbeat + jobs from `Jobs/` | external cron, event triggers |
| **learner** | reflection, proposals, curator (section 3.4) | a different reflection strategy, or none |
| **hook** | none | scripts that run before or after any event |

Plugins come in two forms:

- **In-process:** a TypeScript module. Fastest, full access to the event bus.
- **Out-of-process:** any executable that exchanges JSON over stdin/stdout (the same transport MCP uses). This is how a plugin can be written in Python, Go, Rust or a shell script.

### 3.3 Gateway and routing (from OpenClaw)

- A long-running local process bound to `127.0.0.1`. Binding elsewhere requires a token or device pairing, or it does not start.
- Routing rules in `System/config.md` map a channel, person or group to an agent folder under `Agents/`.
- The heartbeat keeps OpenClaw's behaviour: interval, skipped when `HEARTBEAT.md` is empty, silent when there is nothing to report.

### 3.4 Agent loop and learning (from Hermes)

- A tool-calling loop. Context is built from `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, the skills relevant to the turn, and search results from memory.
- Subagents handle delegated tasks with a restricted set of tools.
- The learning loop runs every N turns and at the end of a session:
  1. A reflection pass reads the transcript.
  2. It proposes memory edits, entity-note updates, and new or patched skills.
  3. `policies.md` decides: apply, send to `Inbox/`, or reject.
  4. A curator job merges duplicates, archives unused skills, and enforces the size limits on `MEMORY.md` and `USER.md`.

### 3.5 Skills and trust

Unchanged from v1 in substance: the `SKILL.md` format, provenance recorded per skill (now in frontmatter, so it is visible and filterable in Obsidian), trust tiers (`trusted`, `review`, `blocked`), a static scan on import, and scripts that run only in the sandbox backend.

## 4. Customization ladder

Each step up needs more skill and gives more control. Most users stay on the first three.

| Level | You edit | Changes |
|---|---|---|
| 0 | Markdown prose | Personality, rules, heartbeat checklist, memory |
| 1 | Frontmatter and `System/` notes | Models, routing, schedules, policies, which plugins load |
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

## 6. Local setup

- **Models:** Ollama, LM Studio or llama.cpp through their OpenAI-compatible endpoints. A cloud provider can be added per agent or per task, for example a small local model for the heartbeat and a larger one for hard tasks.
- **Search:** SQLite full-text search needs nothing extra. Vector search is optional and uses a local embedding model.
- **Sync and mobile:** whatever already syncs the vault (Obsidian Sync, Syncthing, git).

## 7. Compatibility and migration

- `openhermes import openclaw [--source ~/.openclaw] [--dry-run]`
- `openhermes import hermes [--source ~/.hermes] [--dry-run]`
- `openhermes init --vault <path>` adds the folder layout to an existing Obsidian vault without touching existing notes.

File names match OpenClaw's (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, `MEMORY.md`, `USER.md`) and skills match the format Hermes uses, so imports are copies, not conversions. Imported skills start in the `review` tier.

## 8. Roadmap

| Milestone | Scope |
|---|---|
| **M0: Kernel and vault** | Event bus, plugin loader, vault layout and watcher, CLI channel, one provider (OpenAI-compatible), tool loop, full-text memory search, git commits for agent writes |
| **M1: Gateway** | Daemon, authentication, routing, Telegram and Discord, heartbeat, jobs from `Jobs/` |
| **M2: Learning** | Reflection, proposals, `Inbox/` approvals, policies, curator, skill provenance |
| **M3: Isolation** | Docker and SSH backends, allowlist, skill scanner, out-of-process plugin protocol and hooks |
| **M4: Ecosystem** | Importers, MCP tools, more channels, Obsidian companion plugin |
| **M5: Evaluation** | Measure whether learned skills reduce cost and turns on repeated tasks |

## 9. Open questions

1. Should the agent be allowed to write into your existing notes, or only into its own folders? The default is its own folders.
2. How much may the learning loop apply without approval? The default is memory edits yes, skills with executable steps no.
3. Is one vault shared by all agents, or one vault per agent? The default is one shared vault with a folder per agent.
4. What is the project name and trademark position? "Hermes" is associated with Nous Research. Check before branding the project publicly.
