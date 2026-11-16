# OpenClaw vs. Hermes Agent: Research Notes

*Compiled 2026-11-16. Most details come from third-party guides and doc mirrors. The official doc sites (docs.openclaw.ai, hermes-agent.nousresearch.com) could not be fetched from the research environment. Re-check any specific value (default, path, count) against upstream before building on it.*

## 1. At a glance

| | **OpenClaw** | **Hermes Agent** |
|---|---|---|
| Origin | Community project, formerly *Clawdbot* / *Moltbot* | Nous Research, released Feb 2026 |
| License | MIT | MIT |
| Language | TypeScript / Node | Python |
| Design center | **Gateway-first**: one always-on process that owns every messaging channel and routes messages to agents | **Agent-runtime-first**: an agent loop that learns from experience and turns repeated work into reusable skills |
| Core question it answers | *Which agent should get this message?* | *Which agent or skill can finish this task, and what should we learn from it?* |
| Traction (approximate, changes quickly) | ~390k GitHub stars, 50+ integrations | ~250k GitHub stars, fewer but deeper integrations |

## 2. OpenClaw characteristics

- **Gateway:** A single long-running TypeScript process. It owns the messaging connections, routes sessions, dispatches tools and loads skills when they are needed. It binds to `127.0.0.1:18789` by default.
- **Channels:** A large set of chat surfaces (WhatsApp, Telegram, Discord, Slack, Signal, iMessage and others), added through *channel plugins*.
- **Plugin taxonomy:** channel, memory (storage backends), tool and provider (LLM) plugins.
- **Workspace files (Markdown as configuration):**
  - `SOUL.md`: personality and voice
  - `AGENTS.md`: operating rules and multi-agent handoffs
  - `USER.md`: facts about the user
  - `IDENTITY.md`: the agent's identity
  - `MEMORY.md`: curated long-term facts
  - `memory/YYYY-MM-DD.md`: daily notes
  - `HEARTBEAT.md`: checklist for proactive work
- **Memory:** Markdown files are the source of truth. They are indexed into a per-agent SQLite database for search.
- **Heartbeat:** The agent wakes on a timer (`agents.defaults.heartbeat.every`, default `30m`, `0m` turns it off), reads `HEARTBEAT.md`, and replies `HEARTBEAT_OK` when nothing needs attention. The run is skipped when `HEARTBEAT.md` is empty. A delivery `target` such as `none` or `last` controls where any output goes.
- **Skills:** Markdown instruction packages, loaded only when they are relevant to the current turn. They are distributed through **ClawHub**, a public registry with roughly 10k+ packages.
- **Multi-agent:** Routing based: incoming messages and channels are bound to agents.
- **Config:** `~/.openclaw/openclaw.json`.

### Known weaknesses

- **Skill supply chain:** Koi Security's "ClawHavoc" report found 341 malicious skills out of 2,857 audited. Later counts went above 1,100. Unit 42 found skills that slipped past ClawHub's VirusTotal and ClawScan screening. Some carried infostealers such as Atomic Stealer.
- **Exposed gateways:** Censys counted about 21k gateways reachable from the internet in January 2026, many with no authentication.
- **CVE-2026-25253** (CVSS 8.8): token exfiltration leading to full gateway compromise.
- **ClawHub ranking manipulation:** download counts could be inflated. The bug was fixed within 24 hours in March 2026.

## 3. Hermes Agent characteristics

- **Learning loop:** Every N turns (about 10) the agent reviews the conversation. It decides whether to save facts to memory or to write or refine a skill. A curator prunes and archives stale skills.
- **Memory:**
  - Bounded Markdown files with character limits: `MEMORY.md` (agent notes) and `USER.md` (user model)
  - Cross-session recall through **SQLite FTS5** search with LLM summarization
  - Optional **Honcho** user modeling
- **Skills:** One Markdown `SKILL.md` per skill under `~/.hermes/skills/`, following the open Agent Skills format (agentskills.io). Skills are mostly created by the agent itself, not downloaded from a marketplace.
- **Terminal backends:** Where tool commands actually run. Options are local, Docker, SSH, Daytona, Modal and Vercel Sandbox, plus plugins such as Singularity. Switch with `hermes config set terminal.backend <name>`. Daytona and Modal can hibernate when idle.
- **Tools:** Grouped into toolsets.
  - `delegate_task` starts subagents with their own conversation and a restricted toolset. Subagents cannot delegate, clarify, write memory, send messages or run `execute_code`.
  - `execute_code` runs Python scripts.
  - `cronjob` schedules tasks.
  - MCP client support.
- **Messaging gateway:** Present, but secondary to the runtime. It covers Telegram, Discord, Slack (Socket Mode), WhatsApp (Baileys bridge and/or Cloud API), Signal (signal-cli bridge) and more. Cron runs inside the gateway process, checks about every 60 seconds, and runs each job in an isolated session.
- **Security posture:** Capabilities are created inside the agent instead of installed from a public marketplace. There is a command allowlist with approvals, and backends can isolate execution.
- **OpenClaw migration is built in:** `hermes claw migrate --dry-run` / `--preset user-data`.
  - It reads `~/.openclaw` and falls back to `~/.clawdbot` and `~/.moltbot`.
  - `SOUL.md` is copied over.
  - `MEMORY.md` and `USER.md` are split into entries and deduplicated. Anything over the size limit goes to an overflow file for manual review.
  - Skills go to `~/.hermes/skills/openclaw-imports/`.
  - Command approvals are merged into the allowlist.
  - `IDENTITY.md` is archived for manual merging into `SOUL.md`.

## 4. Key distinctions

| Dimension | OpenClaw | Hermes |
|---|---|---|
| Where intelligence accumulates | In what people write: workspace Markdown and installed skills | In the agent itself: learned skills and refined memory |
| Skill source | Public marketplace (ClawHub) | Self-authored and curated, from an open standard |
| Memory model | Unbounded daily logs plus curated file, indexed in SQLite | Bounded curated files plus FTS5 episodic recall plus user model |
| Proactivity | Heartbeat checklist | Cron jobs plus the learning-loop review |
| Execution isolation | Mostly the host machine. A sandbox is optional | Pluggable backends (Docker, SSH, Modal...) |
| Multi-agent | Route messages to agents | Delegate tasks to subagents |
| Reach | Wider (50+ integrations) | Narrower but sufficient (~15-20 platforms) |
| Main risk | Supply chain and exposed gateways | Fewer integrations; skills can drift or bloat without curation |

## 5. Are they complementary?

Yes, and the comparison articles agree that neither is strictly better. Each project's strong side covers the other's weak side:

- **OpenClaw contributes:**
  - breadth of channels
  - routing and identity
  - the readable, human-authored workspace convention (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`)
  - a heartbeat that is cheap to run
- **Hermes contributes:**
  - the closed learning loop
  - bounded memory with real recall
  - isolated execution backends
  - delegation
  - a security posture that does not trust a marketplace

Both are MIT-licensed, so combining or borrowing code is legally simple: keep the copyright notices. The languages differ (TypeScript vs. Python), so a literal code merge is impractical. A merge at the protocol and convention level is practical.

## Sources

- OpenClaw architecture: [fast.io](https://fast.io/resources/openclaw-architecture-overview/), [Atlantic.net](https://www.atlantic.net/cloud-platform/how-openclaw-works/), [clawdocs.org](https://clawdocs.org/architecture/overview), [Kanerika](https://kanerika.com/blogs/openclaw-architecture/)
- OpenClaw workspace and heartbeat: [clawpane.co](https://clawpane.co/blog/openclaw-workspace-files-guide), [clawdocs heartbeat](https://clawdocs.org/guides/heartbeat), [open-claw.bot heartbeat](https://open-claw.bot/docs/gateway/heartbeat/)
- OpenClaw security: [eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub), [Dark Reading](https://www.darkreading.com/cyber-risk/malicious-openclaw-skills-clawhub-threaten-ai-supply-chain), [clawdocs known vulnerabilities](https://clawdocs.org/security/known-vulnerabilities), [bitdoze security guide](https://www.bitdoze.com/openclaw-security-guide/)
- Hermes: [official docs](https://hermes-agent.nousresearch.com/docs), [Better Stack guide](https://betterstack.com/community/guides/ai/hermes-agent/), [Inside Hermes Agent](https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving), [tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools), [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/), [terminal backends](https://hermes-tutorials.dev/blog/hermes-terminal-backends-comparison-2026/), [architecture write-up](https://yoniebans.github.io/hermes-architecture/)
- Migration: [Migrate from OpenClaw](https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw), [glukhov.org](https://www.glukhov.org/ai-systems/hermes/migrate-from-openclaw/)
- Comparisons: [Composio](https://composio.dev/blog/openclaw-vs-hermes-agent), [Hostinger](https://www.hostinger.com/my/tutorials/?p=130826), [ToolRadar](https://toolradar.com/blog/openclaw-vs-hermes-agent), [OpenAlternative](https://openalternative.co/compare/hermes-agent/vs/openclaw), [OrcaRouter](https://www.orcarouter.ai/blog/hermes-agent-vs-openclaw-two-open-agents-compared)
