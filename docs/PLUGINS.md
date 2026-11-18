# Extending OpenHermes: plugins and hooks

There are three ways to extend the agent with code. All of them live in the `runtime` folder of the home folder, which the agent itself cannot write to, and all are switched on in `vault/System/config.md`, which the agent cannot edit either.

| | Written in | Can add | Runs |
|---|---|---|---|
| Hook | anything | a check or change around turns and tool calls | once per event, as a short program |
| External plugin | anything | tools, hooks | as a long-running program |
| In-process plugin | JavaScript | tools, hooks, chat channels, command backends, a model provider | inside OpenHermes |

Code you add here runs on your computer with your rights, outside any sandbox. Only install what you have read.

## Hooks

A hook is a program that receives one JSON object on standard input and may print one JSON object.

```yaml
hooks:
  - event: tool.before
    match: run_command          # optional: only for this tool
    command: [python, hooks/audit.py]
    timeout_s: 15
```

The program starts in the `runtime` folder. `OPENHERMES_HOME` holds the home folder path.

| Event | Input fields | What the output may contain |
|---|---|---|
| `turn.before` | `text`, `agent`, `conversation` | `text` to replace the message; `decision: deny` |
| `tool.before` | `tool`, `args`, `agent`, `conversation` | `args` to replace the arguments; `decision: deny` |
| `tool.after` | `tool`, `args`, `output`, `ok`, `agent`, `conversation` | `output` to replace what the model sees |
| `turn.after` | `text`, `tools_used`, `agent`, `conversation` | nothing |

Every input also has an `event` field. A `deny` may carry a `reason`, which the model is told.

- Printing nothing means "carry on".
- For the two before-events, a hook that exits with a non-zero code, runs past its time limit, or prints something that is not JSON **blocks** the action. A broken guard never lets things through.
- For the two after-events a failure is logged and ignored.
- Replacement arguments are checked against the tool's schema before use.

Example: [`examples/hooks/audit.py`](../examples/hooks/audit.py).

## External plugins

An external plugin is a program that stays running and exchanges JSON-RPC 2.0 messages with OpenHermes, one per line, over its standard input and output. Anything it writes to standard error goes to the OpenHermes log.

```yaml
external_plugins:
  - name: example
    command: [python, plugins/weather.py]
    timeout_s: 60
```

Requests from OpenHermes:

| Method | Params | Expected result |
|---|---|---|
| `initialize` | `protocol` (currently 1), `home` | `tools`: list of `{name, description, parameters}` where `parameters` is a JSON Schema object; `hooks`: list of event names |
| `tool.call` | `name`, `arguments` | `content`: the text the model sees |
| `hook` | `event`, `payload` | the same output object as a hook program |
| `shutdown` | none (a notification, no answer expected) | the program exits |

The plugin may send the notification `log` with `level` (`info`, `warn`, `error`) and `message`.

- A JSON-RPC `error` answer to `tool.call` is shown to the model as the tool's error.
- Tool names use letters, digits, `_` and `-`, and must not clash with an existing tool. A clash stops the plugin from loading and is reported by `openhermes doctor`.
- If the program stops, it is started again the next time one of its tools or hooks is needed.
- The plugin validates its own tool arguments; OpenHermes passes them through as the model gave them.

Example: [`examples/plugins/weather.py`](../examples/plugins/weather.py).

## In-process plugins

A JavaScript module in `runtime/plugins/`, listed by file name under `plugins:`.

```js
import { z } from "zod";

export default {
  name: "dice",
  setup(api) {
    api.registerTool({
      name: "roll_dice",
      description: "Roll one die.",
      schema: z.object({ sides: z.number().int().min(2) }),
      run: async ({ sides }) => `rolled ${1 + Math.floor(Math.random() * sides)}`,
    });
    api.addHook("tool.before", async (event, payload) => {
      if (payload.tool === "run_command" && /shutdown/.test(payload.args.command)) return { decision: "deny", reason: "not allowed" };
    });
  },
};
```

`api` also offers `registerChannel(name, factory)`, `registerBackend(name, factory)`, `setProvider(factory)`, the event `bus`, the `home` paths and the live `config()`.
