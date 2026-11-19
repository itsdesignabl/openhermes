# OpenHermes

A self-hosted personal AI agent that brings together two open-source approaches:

- **[OpenClaw](https://github.com/openclaw/openclaw):** a gateway-first design that reaches the user on any channel, routes messages to agents, and wakes on a heartbeat.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent):** a runtime-first design that learns skills from experience, keeps bounded memory with search, and runs tools in isolated backends.

Everything the agent knows and does lives as Markdown in a local vault you can open in Obsidian, inside one self-contained folder. Delete that folder and the agent and all its data are gone.

**Status:** all planned milestones, M0 to M5, are built. Nothing has yet been run with a real model or on Windows; see [Known gaps](#known-gaps).

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

## What M3 adds

- **Sandboxed commands:** with `backend.type: docker` the agent's shell commands run in a container that sees only the workspace folder and, read-only, the vault. Your keys, the program and the rest of the computer are not visible to it
- **Commands on another machine:** `backend.type: ssh` runs them over SSH
- **"Always" for commands:** when asked to approve a command you can answer always, which adds it to the allowlist
- **Skill import with a scanner:** `skills import <folder>` copies a skill in, checks every file for known attack patterns, and holds it for review. The agent can read a skill under review but cannot run anything from it until you approve it. If its files change later, it goes back under review
- **Hooks:** small programs in any language that run before or after a turn or tool call and can refuse or change it
- **Plugins in any language:** a separate program that adds tools and hooks over a simple JSON protocol. See [docs/PLUGINS.md](docs/PLUGINS.md) and the Python examples in `examples/`
- **Settings are off limits to the agent:** it can no longer edit anything in `vault\System\` or an agent's `agent.md`

## What M4 adds

- **Import from OpenClaw or Hermes Agent:** personality, memory, daily notes, heartbeat checklist and skills. Nothing in the source is changed, keys and settings are never copied, and imported skills go through the scanner and wait for your approval
- **Import an existing notes folder** into the vault, so the agent can search it
- **Tool servers (MCP):** connect any Model Context Protocol server, local or over HTTP. Its tools appear beside the built-in ones, and the agent asks before using one until you answer always
- **Slack** as a third chat channel
- **Obsidian pane:** chat with the agent beside your notes, with live tool activity, approval buttons, and the Inbox

## What M5 adds

- **Cost of every turn:** model calls, tokens and time are counted for each turn and logged as numbers only, never text
- **`openhermes stats`:** what your recent turns cost, by week and by skill
- **`openhermes bench`:** a controlled test of whether learned skills make repeated tasks cheaper, with your own model

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
| `bench` | Measure whether learned skills make repeated tasks cheaper |
| `stats` | What your recent turns cost, by week and by skill |
| `doctor` | Check the installation |

| `gateway start`, `stop`, `status` | Run the always-on gateway in the background |
| `gateway run` | Run it in the current window, with its log on screen |
| `import openclaw`, `import hermes`, `import vault <folder>` | Bring in another agent's setup, or a folder of notes |
| `obsidian install` | Put the chat pane plugin into the vault |
| `inbox`, `inbox approve <id>`, `inbox reject <id>` | See and decide what the agent wants to keep |
| `skills` | List skills with their origin, trust level and use count |
| `skills import <folder>`, `skills trust <name>`, `skills scan <name>`, `skills block <name>` | Bring in a skill from elsewhere and decide whether to trust it |
| `reflect [session note]` | Review a conversation now (default: the latest) |
| `curate` | Run the cleanup now |
| `pair list`, `approve <code>`, `revoke <id>` | Manage who may talk to the agent |
| `secret set <name>`, `list`, `remove <name>` | Store bot tokens and API keys |

Open `C:\Openhermes Programming Files\vault` as a vault in Obsidian to read and edit everything.

## Chat inside Obsidian

```bash
openhermes obsidian install
```

Then open `C:\Openhermes Programming Files\vault` in Obsidian, go to Settings → Community plugins, and turn on community plugins. Click the speech-bubble icon in the left ribbon.

The pane talks to the gateway. If the gateway is not running, the pane shows a button that starts it. Waiting Inbox items appear at the top with Approve and Reject buttons, and a request to run a command shows Allow, Always allow and Decline.

## Move over from OpenClaw or Hermes Agent

See what would happen first:

```bash
openhermes import openclaw --dry-run
```

Then run it without `--dry-run`. Use `hermes` in place of `openclaw` for Hermes Agent, and `--source <folder>` if it is not in the usual place in your user folder.

| Item | What happens |
|---|---|
| `SOUL.md`, `IDENTITY.md` | Become the agent's personality, unless you have already edited yours |
| `MEMORY.md`, `USER.md` | Split into facts and merged into memory. Repeats are dropped, anything that looks like a password is left out, and what does not fit the size limit goes to a searchable overflow note |
| Daily notes | Copied to `Memory\Daily` |
| `HEARTBEAT.md` | Adopted if your checklist is empty |
| Skills | Scanned and imported for review. Approve each with `openhermes skills trust <name>` |
| `AGENTS.md`, `TOOLS.md` | Kept for you to merge by hand, because they refer to the other program's tools |
| Settings, API keys, tokens | Not imported |

The originals and a report are saved in `vault\Imports\openclaw` (or `hermes`). The import is one entry in the vault history.

## Connect tool servers (MCP)

Add servers under `mcp_servers` in `vault\System\config.md`:

```yaml
mcp_servers:
  - name: files
    command: [npx, -y, "@modelcontextprotocol/server-filesystem", "C:/Some/Folder"]
  - name: kb
    url: https://example.com/mcp
    token_secret: kb_token        # stored with: openhermes secret set kb_token
    tools: [search]               # optional: offer only these
```

Restart the agent or gateway after changing the list. `openhermes doctor` shows whether each server connected.

A tool server runs outside the home folder and can do whatever it was built to do, so the agent asks before each use (`mcp.call` in `policies.md`). Answer always to stop being asked about that tool.

## Chat from Telegram, Discord or Slack

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

**Slack**

1. At api.slack.com create an app and turn on **Socket Mode**. That gives an app-level token starting with `xapp-`.
2. Under Event Subscriptions subscribe the bot to `message.im` and `message.channels`. Under OAuth add the scopes `chat:write`, `im:history` and `channels:history`, install the app, and copy the bot token starting with `xoxb-`.
3. Store both with `openhermes secret set slack_app_token` and `openhermes secret set slack_bot_token`, set `channels.slack.enabled: true`, and restart the gateway.
4. Send the bot a direct message and approve the pairing code.

In group chats and servers the agent answers only when mentioned, and only to people you have approved. `/new` in a chat starts a fresh conversation.

## Run commands in a sandbox

Without a sandbox, a shell command the agent runs can reach any file you can. To confine commands:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. In `vault\System\config.md` set `backend.type: docker`.
3. Check it:

```bash
openhermes doctor
```

Commands then start in `/workspace` (your `workspace` folder) inside a Linux container. The vault is at `/vault`, read-only. The container is created on the first command, kept while the agent runs so installed tools persist, and removed when it stops.

| Setting under `backend.docker` | Default | Meaning |
|---|---|---|
| `image` | `python:3.12-slim` | What is installed in the container |
| `network` | `bridge` | `none` cuts the container off from the internet |
| `mount_vault` | `ro` | `rw` lets commands change the vault, `none` hides it |
| `memory`, `cpus`, `pids_limit` | `2g`, `2`, `512` | Limits |

Commands that are not on the allowlist follow the `command.sandboxed` policy when the sandbox is on. Set it to `auto` in `policies.md` if you want the agent to work in the sandbox without asking.

If Docker is not running, commands fail with a message. They never fall back to running on your computer.

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

## Measure whether learning helps

```bash
openhermes bench
```

The benchmark uses four kinds of task whose correct handling depends on conventions written down somewhere in a vault (a weekly report format, a release process, a people-note template, an order lookup). Each is run three ways, in throwaway homes under `data\bench` so your own vault is not touched:

| Arm | Setup |
|---|---|
| `baseline` | No skill. The agent has to find the convention |
| `learned` | The agent first does one practice task of the same kind and reviews it, as it would in normal use. Then it gets a second, different task |
| `reference` | A correct hand-written skill is installed |

For each arm it reports how often the task was done correctly, and the model calls, tokens and time it took. It then compares the arms over matched runs and says "lower" or "higher" only when there are at least six matched correct runs, the gap is beyond the run-to-run noise, and it is at least 5%. It also reports how often the review wrote a skill, what the review cost, and after how many repeats that cost is paid back.

The two skill arms separate two questions. If `reference` helps and `learned` does not, the model follows skills but its reviews write poor ones. If neither helps, or the skill is rarely opened, the model is not using skills.

By default this is 36 measured runs plus 12 practice runs and reviews. With a small local model that can take an hour or more. To shorten it:

```bash
openhermes bench --only weekly,release --trials 2
```

With fewer than six matched runs the report says there are too few to judge cost.

`openhermes stats` shows the same measures for your real conversations. Those are different tasks each time, so it describes your usage and is not a comparison.

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

- **Nothing has been run against a real model, or the real Telegram, Discord or Slack services.** The agent loop is tested against a scripted stand-in, and the channels against local stand-ins for both services. `eval` measures a real model.
- **The local model download is untested.** `model install` was written without access to GitHub or Hugging Face, so the first real run may need a fix. Pointing `provider.base_url` at Ollama or LM Studio does not depend on it.
- **Commands are not sandboxed by default.** With `backend.type: local`, a shell command can touch any path, including the settings files the agent's file tools are barred from. Commands not on the allowlist ask for approval first. Use the Docker backend to confine them.
- **The Docker backend was tested on Linux only**, with a real Docker daemon and an Alpine image. It has not been run with Docker Desktop on Windows, and the default image `python:3.12-slim` could not be downloaded in the test environment.
- **The SSH backend was tested against a stand-in**, not a real remote machine.
- **The scanner matches known patterns.** It catches the common attack shapes and is not a guarantee. Read an imported skill before trusting it.
- **Hooks and plugins run on your computer without a sandbox,** with your rights.
- **The importers were written from descriptions of the OpenClaw and Hermes folder layouts**, not tested against real installations. Run with `--dry-run` first and check the report.
- **Tool servers were tested against stand-in servers** over both transports, not against a published MCP server.
- **Slack was tested against a stand-in** for Slack's API.
- **The Obsidian pane has never been opened in Obsidian.** It type-checks against Obsidian's API and its gateway client is tested, but the interface itself is unverified.
- **WhatsApp and Signal are not built.** Both need a separate bridge program.
- **Whether learned skills help is unmeasured.** `bench` is the instrument for it and has only been run with a simulated model. Its four task types are small and synthetic, so a result there is an indication, not proof for your own work.
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
