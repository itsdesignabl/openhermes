# Installing OpenHermes on Windows

This guide takes you from nothing to a working chat with your agent, then covers the optional parts: Obsidian, chatting from your phone, and the sandbox.

**Before you start, know this:** the installer is run on Windows by the automated tests on every change (install, update, start at login, uninstall), but these steps have not yet been carried out by a person on their own Windows machine. If a step does not behave as described, [Troubleshooting](#troubleshooting) covers the likely causes.

Time needed: a few minutes, plus the time to download a model (3 GB or more).

## What you end up with

One folder, `C:\Openhermes Programming Files`, holding everything:

| Folder | Contents |
|---|---|
| `runtime` | The program |
| `node` | A private copy of Node.js, only if your computer had none |
| `vault` | The agent's notes: personality, memory, skills, settings. This is what you open in Obsidian |
| `models` | Model files, if you use the bundled model server |
| `data` | Search index, logs, measurements |
| `secrets` | Bot tokens and keys, encrypted for your Windows account |
| `workspace` | Scratch area where the agent runs commands |

Deleting that folder removes the agent and all of its data. See [Uninstalling](#uninstalling) for the few things that live outside it.

All commands below are for **PowerShell**, the default terminal in Windows 11. Open it from the Start menu by typing `powershell`.

## Part 1: Install the program

### Step 1. Run the installer

```bash
irm https://raw.githubusercontent.com/itsdesignabl/openhermes/main/install.ps1 | iex
```

That one line:

1. Creates `C:\Openhermes Programming Files`.
2. Uses Node.js 22.13 or newer if you have it. If not, it downloads a private copy into the `node` folder inside the home folder, checks the download against Node's published checksum, and leaves the rest of your computer alone.
3. Downloads the program. If a release package has been published it uses that, which needs nothing else. If none has been published yet, it downloads the source and builds it, which takes a few minutes longer. Git is not needed either way.
4. Creates the vault.
5. Adds the home folder to your PATH, so `openhermes` works in every terminal.

It ends by printing the installed version.

Nothing needs administrator rights. The only thing it changes outside the home folder is that PATH entry.

### Step 2. Check the command

Open a **new** PowerShell window, then:

```bash
openhermes version
```

It prints the version, which Node.js it runs on, and the home folder.

### Installer options

To use options, download the script first:

```bash
irm https://raw.githubusercontent.com/itsdesignabl/openhermes/main/install.ps1 -OutFile install.ps1
```

```bash
powershell -ExecutionPolicy Bypass -File install.ps1 -Autostart
```

| Option | What it does |
|---|---|
| `-HomePath "<folder>"` | Install somewhere else |
| `-Autostart` | Start the gateway each time you log in |
| `-NoPath` | Leave your PATH alone; you then run `"C:\Openhermes Programming Files\openhermes.cmd"` |
| `-Node bundled` | Download the private Node.js even if you have one |
| `-Node system` | Never download Node.js; stop if a suitable one is missing |
| `-Package <zip or link>` | Install a specific release package |
| `-Source <zip or link>` | Build from a specific source archive |

Running the installer again on an existing installation updates it and keeps your vault.

### Installing by hand instead

If you would rather see every step, or want a git checkout to work on the code:

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install Git.Git
```

Close PowerShell and open it again, then:

```bash
mkdir "C:\Openhermes Programming Files"
```

```bash
cd "C:\Openhermes Programming Files"
```

```bash
git clone -b main https://github.com/itsdesignabl/openhermes runtime
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

The folder name `runtime` matters: the program must sit in a folder with that name inside the home folder. This leaves you with the launcher `C:\Openhermes Programming Files\openhermes.cmd`; add the folder to your PATH yourself, or call the launcher by its full path.

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

4. Give the model enough room, and tell OpenHermes how much it has. In Ollama's settings, set the context length to at least 8192. Then make sure the same number is in the settings note, on the line `context_tokens:` under `provider:` (8192 is the default). OpenHermes fits every request into that number, so if Ollama's value is smaller than what the note says, requests get cut off by Ollama and the model may ignore its tools or forget instructions.

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

To have it start each time you log in:

```bash
openhermes autostart on
```

`openhermes autostart off` undoes that, and `openhermes autostart status` shows the current state. A console window may flash for a moment at login while it starts. The gateway's log is `data\logs\gateway.log`.

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

Without Docker, a command the agent runs can reach any file you can, and `openhermes doctor` warns you about it. With Docker running, commands are confined automatically: they see only the `workspace` folder and a read-only copy of the vault.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. Check:

```bash
openhermes doctor
```

The line about commands should say they run in the docker sandbox, found automatically. Nothing needs to be changed in the settings. The first command the agent runs downloads the container image, which takes a few minutes.

If you would rather not install Docker and want the warning to stop, set `type: local` under `backend:` in `vault\System\config.md`. Commands then run on your computer. The agent still cannot change its own settings through a command, and has to ask before running one that names them.

This has been tested with real containers on Linux, not with Docker Desktop on Windows.

## Updating

```bash
openhermes update
```

It stops the gateway if it is running, installs the new version, and starts the gateway again. Your vault, settings and keys are not touched. Things you added to the `runtime` folder (the bundled model server, plugins, hooks) are carried over, and the Obsidian pane is updated if you installed it.

Where the new version comes from depends on how you installed:

- **Installed by the installer:** the latest published release. Before the first release is published this reports that nothing is published; run the installer line from Step 1 again instead.
- **Installed by hand with git:** `git pull`, `npm install` and `npm run build` in the `runtime` folder.

If the new version does not start, the old one is left in place and the command says so.

## Uninstalling

```bash
powershell -ExecutionPolicy Bypass -File "C:\Openhermes Programming Files\uninstall.ps1"
```

It asks for confirmation, then stops the gateway, removes the startup entry and the PATH entry, and deletes the home folder: the program, the vault, the memory, the keys and the logs.

Deleting the folder by hand works too. It leaves behind only the PATH entry and, if you switched it on, the startup entry; both then point at nothing and do no harm.

What neither removes:

- Node.js and Git if you installed them yourself, and anything optional you installed (Ollama and its models, Obsidian, Docker Desktop). Remove these from Windows Settings → Apps if you no longer want them.
- Bots you registered with Telegram, Discord or Slack. Delete them there, or revoke their tokens.
- Messages already sent through those services.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| The installer says it could not create the folder | Your account may not create folders in `C:\` | Install somewhere else: download the script as shown under Installer options and add `-HomePath "$HOME\Openhermes Programming Files"` |
| The installer stops with a download error | No internet connection, or a firewall blocks `github.com` or `nodejs.org` | Try again later or on another network; or install by hand |
| `openhermes` "is not recognized" | The window was open before the install changed your PATH | Open a new PowerShell window |
| `openhermes update` says nothing is published | No release has been published yet | Run the installer line from Step 1 again; it updates the existing installation |
| `update` says the program folder is in use | A terminal is sitting inside `runtime`, or another OpenHermes window is open | Close them and run it again; nothing was changed |
| (Installing by hand) `npm` fails with "running scripts is disabled on this system" | PowerShell blocks npm's script | Use `npm.cmd install` and `npm.cmd run build` |
| `doctor` says the model endpoint is not reachable | Ollama is not running, or the address is wrong | Start Ollama; check `base_url` is `http://127.0.0.1:11434/v1` |
| The model answers but never uses tools, or `eval` mostly fails | The model is too small, does not support tools, or its context length is shorter than `context_tokens` in the settings | Make Ollama's context length and `provider.context_tokens` the same, 8192 or more; try a larger model |
| The agent seems to forget what a tool returned a few steps ago | The window is small, so older tool results were set aside to make room | Expected with small windows. `openhermes doctor` shows how much room the conversation has; a larger window or shorter memory files give it more |
| "Model endpoint returned 404" | The model name in the settings does not match | Use the exact name shown by `ollama list` |
| "Port 18789 is in use" | A gateway is already running | `openhermes gateway status`, then `openhermes gateway stop` |
| The Telegram bot does not answer | The channel is off, or the token is wrong | `openhermes gateway status` shows the channel's state and the reason |
| "encrypted for a different Windows account or computer" | The home folder was copied from another computer or account, or Windows was reinstalled | Store each key again with `openhermes secret set <name>` |
| `doctor` warns that commands are NOT sandboxed | Docker is not installed or not running | Start Docker Desktop, or set `backend.type: local` to accept running without it |
| A message says a command changed files that control the agent and the changes were undone | The agent ran a command that modified its own settings, or you edited one of those files while a command was running | Nothing is broken. If it was your edit, make it again |
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
