# OpenHermes

A self-hosted personal AI agent that brings together two open-source approaches:

- **[OpenClaw](https://github.com/openclaw/openclaw):** a gateway-first design that reaches the user on any channel, routes messages to agents, and wakes on a heartbeat.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent):** a runtime-first design that learns skills from experience, keeps bounded memory with search, and runs tools in isolated backends.

Everything the agent knows and does lives as Markdown in a local vault you can open in Obsidian, inside one self-contained folder. Delete that folder and the agent and all its data are gone.

**Status:** milestones M0 (kernel and vault), M1 (gateway, Telegram, Discord, heartbeat, jobs) and M2 (learning loop) are built. Sandboxed commands come in M3; see [docs/PROPOSAL.md](docs/PROPOSAL.md).

## What works in M0

- One home folder (`C:\Openhermes Programming Files` on Windows) holding the program, vault, model, index, keys and logs
- File tools that refuse to write anywhere outside the home folder, and copy outside files into `vault\Imports\` before reading them
- A tool-calling agent loop against any OpenAI-compatible endpoint, or a bundled llama.cpp server
- Vault notes for personality, rules, memory, skills, settings and approval policies, reloaded when you edit them
- Full-text search over the whole vault, including past conversations
- A git history of every change the agent makes, stored inside the vault
- A full-screen terminal chat (`chat`), one-shot command (`ask`), and a plugin loader
- A 12-case tool-calling test (`eval`) for checking a model before relying on it

## What M1 adds

- An always-on gateway (`gateway start`) that keeps the agent reachable and runs scheduled work
- Telegram and Discord channels, each chat with its own conversation that survives a restart
- Pairing: an unknown person gets a code and reaches the agent only after you approve it
- Routing: different chats can go to different agents, each with its own personality, tools and model
- Heartbeat: the agent checks `HEARTBEAT.md` on a timer and messages you only when something needs attention
- Jobs: a note in `vault\Jobs\` with a schedule runs on time and sends you the result
- Approvals in chat: the agent asks in the conversation and waits for yes or no
- A local control API with a token, used by `chat` and `ask` while the gateway runs

## What M2 adds

- After a conversation the agent reviews it and keeps what is worth keeping: facts about you, notes on people and projects, and step-by-step skills
- Your policies decide what it may save on its own. By default facts and plain skills are saved, and skills that contain commands or code wait for you
- Waiting items are notes in `vault\Inbox\`. Approve one by setting `status: approved` in Obsidian, by `/approve <id>` in chat, or by `openhermes inbox approve <id>`. You can edit the proposed text first
- Every skill records where it came from, who approved it, and how often it is used
- A cleanup removes repeated memory entries, merges a memory file that is nearly full, and archives skills the agent wrote and no longer uses
- The agent cannot approve its own suggestions, and passwords or keys are never written to memory

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

| `gateway start`, `stop`, `status` | Run the always-on gateway in the background |
| `gateway run` | Run it in the current window, with its log on screen |
| `inbox`, `inbox approve <id>`, `inbox reject <id>` | See and decide what the agent wants to keep |
| `skills` | List skills with their origin and use count |
| `reflect [session note]` | Review a conversation now (default: the latest) |
| `curate` | Run the cleanup now |
| `pair list`, `approve <code>`, `revoke <id>` | Manage who may talk to the agent |
| `secret set <name>`, `list`, `remove <name>` | Store bot tokens and API keys |

Open `C:\Openhermes Programming Files\vault` as a vault in Obsidian to read and edit everything.

## Chat from Telegram or Discord

**Telegram**

1. In Telegram, message `@BotFather`, send `/newbot`, and copy the token it gives you.
2. Store the token:

```bash
openhermes secret set telegram_bot_token
```

3. In `vault\System\config.md` set `channels.telegram.enabled: true`.
4. Start the gateway:

```bash
openhermes gateway start
```

5. Message your bot. It replies with a pairing code. Approve it:

```bash
openhermes pair approve <code>
```

**Discord**

1. In the Discord developer portal create an application, add a bot, and copy its token.
2. On the bot's page turn on **Message Content Intent**. Without it the gateway reports the reason and stops the channel.
3. Invite the bot to your server with permission to read and send messages.
4. Store the token with `openhermes secret set discord_bot_token`, set `channels.discord.enabled: true`, and restart the gateway.
5. Send the bot a direct message and approve the pairing code as above.

In group chats and servers the agent answers only when mentioned, and only to people you have approved. `/new` in a chat starts a fresh conversation.

## Scheduled work

- **Heartbeat:** write items in `vault\Agents\main\HEARTBEAT.md`. While the list is empty nothing runs. Interval, target chat and active hours are in `agent.md` in the same folder.
- **Jobs:** see `vault\Jobs\README.md` for the note format (`schedule`, `every` or `at`).

Both run only while the gateway is running. Results go to the chat that last spoke to the agent unless the note names another target.

## How it learns

A conversation is reviewed after every 10 of your messages, when you start a new one with `/new`, and, while the gateway runs, once it has been quiet for 30 minutes. Heartbeat and job runs are not reviewed. The review is a separate model call, so it takes model time but does not appear in the chat.

Each thing the review wants to keep is checked against `vault\System\policies.md`:

| Policy value | What happens |
|---|---|
| `auto` | Saved straight away |
| `ask` | Written to `vault\Inbox\` and you are told in your last chat |
| `deny` | Dropped |

Decided items move to `vault\Inbox\Done\`. Everything the review saves is one commit in the vault history (`openhermes history`), so it can be undone. The timings are under `learning` in `vault\System\config.md`; `enabled: false` turns it off.

Single `openhermes ask` commands without a running gateway are separate one-message conversations and are not reviewed automatically. Use `openhermes reflect` for those.

## Customize

| To change | Edit |
|---|---|
| Personality | `vault\Agents\main\SOUL.md` |
| Rules | `vault\Agents\main\AGENTS.md` |
| What it remembers | `vault\Memory\MEMORY.md`, `USER.md` |
| Model, limits, channels, routing, plugins | `vault\System\config.md` |
| One agent's model, tools, heartbeat | `vault\Agents\<name>\agent.md` |
| Scheduled jobs | `vault\Jobs\<name>.md` |
| What needs your approval | `vault\System\policies.md` |
| Procedures | `vault\Skills\<name>\SKILL.md` |
| New tools or chat channels | a plugin in `runtime\plugins\`, named under `plugins:` in `config.md` |

The agent cannot edit `policies.md`, anything in `secrets\` or `runtime\`, or the git history.

## Known gaps

- **Nothing has been run against a real model, real Telegram or real Discord.** The agent loop is tested against a scripted stand-in, and the channels against local stand-ins for both services. `eval` measures a real model.
- **The local model download is untested.** `model install` was written without access to GitHub or Hugging Face, so the first real run may need a fix. Pointing `provider.base_url` at Ollama or LM Studio does not depend on it.
- **Commands are not sandboxed.** File tools are strictly contained, but a shell command the agent runs can touch other paths. Commands not on the allowlist ask for approval first.
- **How well a real model reviews conversations is unmeasured.** The review logic is tested with scripted replies. A small local model may save too much, too little, or badly worded skills; check the first few results in `Inbox` and `openhermes history`.
- **Similar skills are not merged.** The cleanup archives unused skills but does not combine two that overlap.
- **One turn at a time.** Messages from different chats queue behind each other, and a turn waiting for an approval holds the queue until you answer or the time limit (5 minutes by default) passes.
- **The gateway does not start with Windows.** Run `openhermes gateway start` after logging in.
- **Missed schedules are not caught up.** A job due while the gateway was off is skipped, except a one-time `at` job less than a day late.
- **Only text messages** are handled in chats; images, voice and files are ignored.
- **Keys are stored unencrypted** in `secrets\keys.json`.
- **Node.js and git are installed outside the home folder.** A portable bundle is planned.
- Approvals for actions during a conversation (running a command, importing a file) are still asked live in the chat, not through `Inbox\`.

## Development

```bash
npm test
```

## License

MIT
