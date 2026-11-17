# OpenHermes

A self-hosted personal AI agent that brings together two open-source approaches:

- **[OpenClaw](https://github.com/openclaw/openclaw):** a gateway-first design that reaches the user on any channel, routes messages to agents, and wakes on a heartbeat.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent):** a runtime-first design that learns skills from experience, keeps bounded memory with search, and runs tools in isolated backends.

Everything the agent knows and does lives as Markdown in a local vault you can open in Obsidian, inside one self-contained folder that can be deleted to remove the agent and all its data. The core is a small kernel with replaceable plugins. It will be secure by default and compatible with both projects' on-disk formats (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `HEARTBEAT.md`, `SKILL.md`).

**Status:** research and design phase. No code yet.

- [docs/RESEARCH.md](docs/RESEARCH.md): characteristics and differences of both projects
- [docs/PROPOSAL.md](docs/PROPOSAL.md): proposed architecture (v3: one home folder, vault-centred, plugin-first, TypeScript), customization levels and roadmap

## License

MIT
