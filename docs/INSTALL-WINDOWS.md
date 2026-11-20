# Installing OpenHermes on Windows

This guide takes you from nothing to a working chat with your agent, then covers the optional parts: Obsidian, chatting from your phone, and the sandbox.

**Before you start, know this:** the automated tests pass on Windows, but these steps have not yet been carried out by a person on a real Windows machine. If a step does not behave as described, [Troubleshooting](#troubleshooting) covers the likely causes.

Time needed: about 20 minutes, plus the time to download a model (3 GB or more).

## What you end up with

One folder, `C:\Openhermes Programming Files`, holding everything:

| Folder | Contents |
|---|---|
| `runtime` | The program |
| `vault` | The agent's notes: personality, memory, skills, settings. This is what you open in Obsidian |
| `models` | Model files, if you use the bundled model server |
| `data` | Search index, logs, measurements |
| `secrets` | Bot tokens and keys, encrypted for your Windows account |
| `workspace` | Scratch area where the agent runs commands |

Deleting that folder removes the agent and all of its data. See [Uninstalling](#uninstalling) for the few things that live outside it.

All commands below are for **PowerShell**, the default terminal in Windows 11. Open it from the Start menu by typing `powershell`.

## Part 1: Install the program

### Step 1. Install Node.js and Git

OpenHermes needs Node.js 22.13 or newer, and Git to download it.

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install Git.Git
```

Close PowerShell and open it again so the new programs are found. Then check:

```bash
node --version
```

```bash
git --version
```

The first should print `v22.13` or higher. If you prefer, download the installers from [nodejs.org](https://nodejs.org) and [git-scm.com](https://git-scm.com) instead of using `winget`.

### Step 2. Create the home folder and download the program

```bash
mkdir "C:\Openhermes Programming Files"
```

```bash
cd "C:\Openhermes Programming Files"
```

```bash
git clone -b main https://github.com/itsdesignabl/openhermes runtime
```

The last word, `runtime`, matters: the program must sit in a folder with that name inside the home folder.

If the repository is private, Git opens a browser window asking you to sign in to GitHub.

### Step 3. Build it

```bash
cd runtime
```

```bash
npm install
```

```bash
npm run build
```

`npm install` downloads the libraries the program uses. `npm run build` prints nothing when it succeeds.

### Step 4. Create the vault

```bash
node dist\src\cli.js init
```

Expected output:

```
Home folder: C:\Openhermes Programming Files
Created 9 starter notes in the vault.
Open C:\Openhermes Programming Files\vault in Obsidian to view and edit it.
```

This also creates the launcher `C:\Openhermes Programming Files\openhermes.cmd`.

### Step 5. Make the `openhermes` command available

For the current PowerShell window:

```bash
Set-Alias openhermes "C:\Openhermes Programming Files\openhermes.cmd"
```

Check it:

```bash
openhermes help
```

The alias lasts until you close the window. To have it in every new window, add that same `Set-Alias` line to your PowerShell profile (open it with `notepad $PROFILE`). The profile is a file in your user folder, so it is one of the few things outside the home folder.

The rest of this guide uses `openhermes`.

## Part 2: Connect a model

The agent needs a language model. Pick **one** of the two options. Option A is the easier one.

Whatever you choose, the model must be able to call tools. The plan's suggestion for a modest computer is Qwen 3.5 4B (about 3 GB, runs in 8 GB of memory without a graphics card); with a 12 GB graphics card or 32 GB of memory, Hermes 4 14B is the stronger choice.

### Option A: Ollama

Ollama is a separate program that downloads and runs models. It installs outside the home folder and keeps its models in your user folder.

1. Install it:

```bash
winget install Ollama.Ollama
```

2. Download a model. Look up the exact name on [ollama.com/library](https://ollama.com/library), then:

```bash
ollama pull <model name>
```

3. Tell OpenHermes to use it. Open the settings note:

```bash
notepad "C:\Openhermes Programming Files\vault\System\config.md"
```

Near the top, change these two lines under `provider:` and save:

```yaml
provider:
  base_url: "http://127.0.0.1:11434/v1"
  model: <model name>
```

Use exactly the name you gave to `ollama pull`.

4. Give the model enough room. The agent's instructions and tool list take a few thousand tokens before the conversation starts. In Ollama's settings, set the context length to at least 8192. With a smaller value the model may ignore its tools or forget instructions.

### Option B: The bundled model server

This keeps the model inside the home folder. **This path is the least tested part of the program**: it was written without being able to try the downloads.

1. Download the model server:

```bash
openhermes model install --server
```

2. Download a model file. Find the model on [huggingface.co](https://huggingface.co), pick a 4-bit `.gguf` file, copy its download link, then:

```bash
openhermes model install --url <link to the .gguf file>
```

3. Leave `base_url` in the settings empty. The server starts by itself the first time the agent needs it. The first answer takes longer while the model loads.

If either download fails, use Option A and report the error text as an issue on the repository.

## Part 3: Check that it works

### Step 6. Run the health check

```bash
openhermes doctor
```

Every line should start with `ok`. A line starting with `FAIL` says what is wrong, for example that the model endpoint cannot be reached.

### Step 7. Test the model

```bash
openhermes eval
```

This gives the model 12 small tasks that need tools (read a file, edit a note, remember a fact, refuse to write outside the home folder) and prints `PASS` or `FAIL` for each, then a total.

- 10 or more passing: the model is good enough to use.
- Fewer than 8: try a larger model. A model that cannot call tools reliably makes everything else unreliable.

On a computer without a graphics card each task can take a minute or more.

### Step 8. Talk to it

```bash
openhermes chat
```

Type a message and press Enter. While it works you see each tool it uses. If it wants to run a command, it asks first:

- `y` allows it once
- `a` allows that command from now on
- `n` declines

Type `/help` for the chat's commands and `/quit` to leave.

A good first message: `Remember that I prefer short answers.` Then look at `vault\Memory\USER.md`; the fact should be there.

## Part 4: Optional extras

Each of these is independent. Skip any you don't need.

### Obsidian: see and edit everything, and chat beside your notes

1. Install [Obsidian](https://obsidian.md).
2. Install the chat pane into the vault:

```bash
openhermes obsidian install
```

3. In Obsidian choose "Open folder as vault" and pick `C:\Openhermes Programming Files\vault`.
4. Go to Settings → Community plugins and choose "Turn on community plugins".
5. Click the speech-bubble icon in the left ribbon.

The pane talks to the gateway (next section). If the gateway is not running, the pane shows a button that starts it.

The chat pane has not yet been opened in a real Obsidian. If it does not appear or shows an error, everything else still works: use `openhermes chat`.

### The gateway: keep the agent running in the background

The gateway is what makes heartbeats, scheduled jobs, phone chat and the Obsidian pane work.

```bash
openhermes gateway start
```

```bash
openhermes gateway status
```

```bash
openhermes gateway stop
```

It does not start with Windows. Run `openhermes gateway start` after you log in. Its log is `data\logs\gateway.log`.

### Telegram: chat from your phone

1. In Telegram, message `@BotFather`, send `/newbot`, follow the prompts, and copy the token it gives you.
2. Store the token (paste it when asked). It is saved encrypted for your Windows account:

```bash
openhermes secret set telegram_bot_token
```

3. In `vault\System\config.md`, under `channels:` → `telegram:`, change `enabled: false` to `enabled: true`.
4. Restart the gateway:

```bash
openhermes gateway stop
```

```bash
openhermes gateway start
```

5. Send your bot any message. It answers with a pairing code. Approve it:

```bash
openhermes pair approve <code>
```

From then on the bot answers you, and only you. Discord and Slack are set up the same way; the README has their steps.

### Docker: run the agent's commands in a sandbox

Without this, a command the agent runs can reach any file you can. With it, commands see only the `workspace` folder and a read-only copy of the vault.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. In `vault\System\config.md`, under `backend:`, change `type: local` to `type: docker`.
3. Check:

```bash
openhermes doctor
```

The line about commands should say they run in the docker backend. The first command the agent runs downloads the container image, which takes a few minutes.

This has been tested with real containers on Linux, not with Docker Desktop on Windows.

## Updating

```bash
openhermes gateway stop
```

```bash
cd "C:\Openhermes Programming Files\runtime"
```

```bash
git pull
```

```bash
npm install
```

```bash
npm run build
```

Your vault, settings and keys are not touched by an update. Keys saved by a version from before they were encrypted are encrypted the first time they are used. If you use the Obsidian pane, run `openhermes obsidian install` again to update it.

## Uninstalling

1. Stop the gateway:

```bash
openhermes gateway stop
```

2. Delete the folder `C:\Openhermes Programming Files`.

That removes the program, the vault, the memory, the keys and the logs. What it does not remove:

- Node.js, Git, and anything optional you installed (Ollama and its models, Obsidian, Docker Desktop). Remove these from Windows Settings → Apps if you no longer want them.
- The `Set-Alias` line, if you added it to your PowerShell profile.
- Bots you registered with Telegram, Discord or Slack. Delete them there, or revoke their tokens.
- Messages already sent through those services.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| `node` or `git` "is not recognized" | The terminal was open during the install | Close PowerShell and open it again |
| `npm` fails with "running scripts is disabled on this system" | PowerShell blocks npm's script | Use `npm.cmd install` and `npm.cmd run build`, or run those two commands in Command Prompt |
| "Access is denied" when creating the folder in `C:\` | Your account may not create folders there | Use another location, for example `mkdir "$HOME\Openhermes Programming Files"`, and use that path everywhere in this guide |
| `openhermes` "is not recognized" | The alias only exists in the window where you set it | Run the `Set-Alias` line from Step 5 again |
| `doctor` says the model endpoint is not reachable | Ollama is not running, or the address is wrong | Start Ollama; check `base_url` is `http://127.0.0.1:11434/v1` |
| The model answers but never uses tools, or `eval` mostly fails | The model is too small, does not support tools, or its context length is too short | Raise Ollama's context length to 8192 or more; try a larger model |
| "Model endpoint returned 404" | The model name in the settings does not match | Use the exact name shown by `ollama list` |
| "Port 18789 is in use" | A gateway is already running | `openhermes gateway status`, then `openhermes gateway stop` |
| The Telegram bot does not answer | The channel is off, or the token is wrong | `openhermes gateway status` shows the channel's state and the reason |
| "encrypted for a different Windows account or computer" | The home folder was copied from another computer or account, or Windows was reinstalled | Store each key again with `openhermes secret set <name>` |
| A change in `config.md` has no effect | A typo made the settings invalid, so the old ones are kept | `openhermes doctor` names the invalid line |

If something else goes wrong, these three outputs show what is happening and are the ones to include in a bug report:

```bash
openhermes doctor
```

```bash
openhermes gateway status
```

```bash
Get-Content "C:\Openhermes Programming Files\data\logs\gateway.log" -Tail 30
```
