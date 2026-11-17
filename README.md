# OpenHermes

A self-hosted personal AI agent that brings together two open-source approaches:

- **[OpenClaw](https://github.com/openclaw/openclaw):** a gateway-first design that reaches the user on any channel, routes messages to agents, and wakes on a heartbeat.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent):** a runtime-first design that learns skills from experience, keeps bounded memory with search, and runs tools in isolated backends.

Everything the agent knows and does lives as Markdown in a local vault you can open in Obsidian, inside one self-contained folder. Delete that folder and the agent and all its data are gone.

**Status:** milestone M0 (kernel and vault). Chat channels, the heartbeat and the learning loop come in later milestones; see [docs/PROPOSAL.md](docs/PROPOSAL.md).

## What works in M0

- One home folder (`C:\Openhermes Programming Files` on Windows) holding the program, vault, model, index, keys and logs
- File tools that refuse to write anywhere outside the home folder, and copy outside files into `vault\Imports\` before reading them
- A tool-calling agent loop against any OpenAI-compatible endpoint, or a bundled llama.cpp server
- Vault notes for personality, rules, memory, skills, settings and approval policies, reloaded when you edit them
- Full-text search over the whole vault, including past conversations
- A git history of every change the agent makes, stored inside the vault
- A full-screen terminal chat (`chat`), one-shot command (`ask`), and a plugin loader
- A 12-case tool-calling test (`eval`) for checking a model before relying on it

## Install (Windows)

Needs [Node.js](https://nodejs.org) 22.13 or newer and git.

```bash
mkdir "C:\Openhermes Programming Files"
```

```bash
cd /d "C:\Openhermes Programming Files"
```

```bash
git clone https://github.com/itsdesignabl/openhermes runtime
```

```bash
cd runtime
```

```bash
npm install
```

```bash
npm run build
```

```bash
node dist\src\cli.js init
```

`init` creates the vault and a launcher, `C:\Openhermes Programming Files\openhermes.cmd`. The examples below use it.

On macOS and Linux the default home is `~/Openhermes Programming Files` and the launcher is `openhermes.sh`.

## Connect a model

Pick one.

**A. Bundled local model** (everything stays in the home folder):

```bash
openhermes model install --server
```

```bash
openhermes model install --url <link to a .gguf file>
```

The plan's default model is Qwen 3.5 4B in 4-bit GGUF form (about 3 GB). Copy the download link for the `.gguf` file from its Hugging Face page.

**B. A model server you already run** (Ollama, LM Studio): open `vault\System\config.md` and set `provider.base_url`, for example `http://127.0.0.1:11434/v1` for Ollama, and `provider.model` to the model's name.

Then check the setup and the model:

```bash
openhermes doctor
```

```bash
openhermes eval
```

## Use

```bash
openhermes chat
```

```bash
openhermes ask "what do you remember about my projects?"
```

| Command | What it does |
|---|---|
| `chat` | Full-screen chat with live tool activity and approval prompts. `/help` lists commands |
| `ask "<message>"` | One message, answer printed |
| `search "<query>"` | Search the vault |
| `index` | Rebuild the search index |
| `history` | The agent's recent changes to the vault |
| `model install`, `model status` | Manage the local model |
| `eval` | Run the tool-calling test |
| `doctor` | Check the installation |

Open `C:\Openhermes Programming Files\vault` as a vault in Obsidian to read and edit everything.

## Customize

| To change | Edit |
|---|---|
| Personality | `vault\Agents\main\SOUL.md` |
| Rules | `vault\Agents\main\AGENTS.md` |
| What it remembers | `vault\Memory\MEMORY.md`, `USER.md` |
| Model, limits, plugins | `vault\System\config.md` |
| What needs your approval | `vault\System\policies.md` |
| Procedures | `vault\Skills\<name>\SKILL.md` |
| New tools | a plugin in `runtime\plugins\`, named under `plugins:` in `config.md` |

The agent cannot edit `policies.md`, anything in `secrets\` or `runtime\`, or the git history.

## Known gaps in M0

- **Commands are not sandboxed.** File tools are strictly contained, but a shell command the agent runs can touch other paths. Commands not on the allowlist ask for approval first.
- **The local model download is untested.** `model install` was written without access to GitHub or Hugging Face, so the first real run may need a fix. Option B above does not depend on it.
- **No real model has been run yet.** The agent loop is tested against a scripted stand-in. `eval` exists to measure a real model.
- **Keys are stored unencrypted** in `secrets\keys.json`. Local models need no key.
- **Node.js and git are installed outside the home folder.** A portable bundle is planned.
- Approvals happen in the chat. Approval notes in `Inbox\` arrive with the learning loop in M2.

## Development

```bash
npm test
```

## License

MIT
