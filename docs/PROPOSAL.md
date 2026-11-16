# OpenHermes: Design Proposal

> A self-hosted personal agent with **OpenClaw's reach** and **Hermes' ability to learn**, built secure by default.

Status: **draft for discussion**. Background is in [RESEARCH.md](RESEARCH.md).

## 1. Goals

1. **Reach:** Talk to the user on any channel and route each message to the right agent, as OpenClaw does.
2. **Learning:** Close the loop: review conversations, distill skills, curate memory, as Hermes does.
3. **Compatibility:** Read both ecosystems' on-disk formats as they are, so existing users can switch without converting anything:
   - `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `memory/*.md`
   - Agent Skills `SKILL.md`
4. **Secure by default:**
   - No public marketplace trusted implicitly.
   - Loopback and authentication required.
   - Tool execution isolated.
5. **Small core, plugins at the edges.**

### Non-goals

- Forking and gluing the two codebases. They are written in different languages, and keeping a fork of both in sync would be expensive.
- Hosting a skill marketplace.

## 2. Architecture

```
            ┌──────────────── Channels (plugins) ────────────────┐
            │ Telegram  Discord  Slack  WhatsApp  Signal  CLI  … │
            └───────────────┬────────────────────────────────────┘
                            ▼
┌────────────────────── Gateway (OpenClaw-style) ──────────────────────┐
│  authn (token/pairing) · session router · agent bindings             │
│  scheduler: heartbeat (HEARTBEAT.md) + cron jobs                     │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────── Agent Runtime (Hermes-style) ────────────────────┐
│  loop: plan → tool calls → observe        delegate_task (subagents)  │
│  Context builder: SOUL + AGENTS + USER + MEMORY + relevant skills    │
│  Learning loop (every N turns / session end):                        │
│     reflect → propose memory edits / new or refined SKILL.md         │
│     → policy check → (auto-apply | ask user) → curator prunes        │
└──────┬─────────────────────┬──────────────────────┬──────────────────┘
       ▼                     ▼                      ▼
  Memory store         Skill store              Execution backends
  Markdown (truth)     SKILL.md dirs            local · docker · ssh
  + SQLite FTS5        provenance + hash        · remote sandboxes
  bounded + episodic   trust tiers              command allowlist
```

### 2.1 Gateway (from OpenClaw)

- A long-running daemon bound to `127.0.0.1` by default. Binding to a non-loopback address requires an auth token or device pairing; without one, the gateway does not start. This directly addresses the exposed-gateway problem.
- Channel adapters implement a small interface: `connect()`, `on_message()`, `send()`, plus a capabilities descriptor. Adapters run out-of-process over a local RPC. Bridges such as Baileys and signal-cli can then stay in Node or Java while the core stays in a single language.
- **Routing:** bindings map (channel, peer or group, pattern) to an agent. Each agent has its own workspace directory.
- **Scheduler:**
  - OpenClaw's heartbeat semantics are kept: interval, skip when `HEARTBEAT.md` is empty, an `HEARTBEAT_OK` reply means nothing to report, and a delivery target.
  - Hermes-style cron jobs run in isolated sessions.

### 2.2 Agent runtime (from Hermes)

- A tool-calling loop that works with any provider through an adapter (OpenAI-compatible, Anthropic, local models).
- MCP client support for tools.
- `delegate_task` subagents run with a restricted toolset. They cannot delegate further, write memory or send messages.
- **Learning loop**, the main thing Hermes adds:
  1. Every N turns, and at the end of a session, a *reflection* pass reads the transcript.
  2. It outputs structured proposals: `memory.add / edit / remove` and `skill.create / patch`.
  3. A policy engine decides: auto-apply, queue for user approval, or reject. The default is to auto-apply memory edits and require approval for skills that contain executable steps.
  4. A *curator* job merges duplicates, archives skills that go unused, and enforces memory size limits.

### 2.3 Memory (merged)

- **Markdown files are the source of truth** (OpenClaw's convention, readable and editable by hand):
  - `MEMORY.md` and `USER.md` are curated and **bounded**, following Hermes. They have character limits, and anything over the limit goes to an overflow file.
  - `memory/YYYY-MM-DD.md` daily logs are append-only.
- **Index:** SQLite with FTS5 over the files and session transcripts, used for episodic recall. Recall results are summarized by an LLM before they are added to the context. Vector search is an optional plugin.
- **User model:** a pluggable interface. A Honcho adapter is optional.

### 2.4 Skills: Agent Skills standard plus provenance

- Skills use the `SKILL.md` format (agentskills.io), which both ecosystems can already read.
- Only the frontmatter is indexed. The full body is loaded only when a skill is relevant to the current turn.
- Every skill records **provenance** in `.provenance.json`:
  - source (`self`, `user`, `import:openclaw`, `url`)
  - content hash
  - author
  - creation and approval times
- **Trust tiers:**

  | Tier | Source | What it may do |
  |---|---|---|
  | `trusted` | self-authored and approved, or written by the user | runs normally |
  | `review` | imported | instructions only; any scripts are disabled until approved |
  | `blocked` | failed a static scan | does not load |

- Imported skills get a static scan: obfuscated shell, `curl \| sh`, credential paths, network calls to unknown hosts. Any script a skill ships always runs in the sandbox backend, never on the host.

### 2.5 Execution backends (from Hermes)

- Backends: `local`, `docker` (the default when Docker is available), `ssh`, and remote-sandbox plugins.
- A command allowlist with interactive approvals applies to every channel. Approvals can be answered from the chat itself.

## 3. Compatibility and migration

- `openhermes import openclaw [--source ~/.openclaw] [--dry-run]`
- `openhermes import hermes [--source ~/.hermes] [--dry-run]`
- Both commands are non-destructive. They copy files, write a report, and put imported skills in the `review` tier.

## 4. Tech-stack recommendation

**Python 3.12+ core** (asyncio), for these reasons:

- The learning loop, memory and evaluation work are closest to Hermes and to the ML ecosystem.
- Python has strong SDKs for most model providers and for MCP.
- Channel bridges that are best in Node (WhatsApp/Baileys) run as out-of-process adapters, so a single-language core does not cost any reach.

The alternative is a TypeScript core, which would make it easy to reuse OpenClaw channel plugins. The trade-off is that the learning loop would have to be re-implemented. Choose before writing any code.

Other stack choices:

- packaging with `uv`
- `pydantic` for configuration and schemas
- `sqlite3` with FTS5
- `pytest`
- MIT license, to match both upstream projects

## 5. Roadmap

| Milestone | Scope |
|---|---|
| **M0: Skeleton** | Package layout, config, CLI REPL channel, a single provider, tool loop, Markdown memory with FTS5 |
| **M1: Gateway** | Daemon, authentication, routing, Telegram and Discord adapters, heartbeat and cron |
| **M2: Learning loop** | Reflection, proposals, policy engine, curator, skill store with provenance |
| **M3: Isolation** | Docker and SSH backends, allowlist and approvals, skill scanner |
| **M4: Migration** | OpenClaw and Hermes importers, more channels, MCP |
| **M5: Evaluation** | Benchmark whether learned skills actually reduce cost and turns on repeated tasks |

## 6. Open questions

1. Python or TypeScript core? Section 4 recommends Python.
2. How much should the learning loop apply on its own, and what needs approval?
3. Should OpenHermes offer a skill-sharing mechanism at all? If it does, it should be a signed, opt-in federation rather than a marketplace.
4. What is the project name and trademark position? "Hermes" is associated with Nous Research. Check before branding the project publicly.
