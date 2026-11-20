#!/usr/bin/env python3
"""Example OpenHermes plugin in Python.

Adds one tool (dice) and one hook that refuses any command containing "shutdown".
The protocol is JSON-RPC 2.0, one message per line, on stdin and stdout.
Anything written to stderr appears in the OpenHermes log.

Install: copy to <home>/runtime/plugins/ and add to System/config.md:
  external_plugins:
    - { name: example, command: [python, plugins/weather.py] }
"""
import json
import random
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def handle(method, params):
    if method == "initialize":
        return {
            "tools": [
                {
                    "name": "roll_dice",
                    "description": "Roll dice and return the total.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "count": {"type": "integer", "minimum": 1, "maximum": 20},
                            "sides": {"type": "integer", "minimum": 2, "maximum": 100},
                        },
                        "required": ["count", "sides"],
                    },
                }
            ],
            "hooks": ["tool.before"],
        }
    if method == "tool.call":
        args = params["arguments"]
        if params["name"] == "roll_dice":
            rolls = [random.randint(1, int(args["sides"])) for _ in range(int(args["count"]))]
            return {"content": f"rolled {rolls}, total {sum(rolls)}"}
        raise ValueError(f"unknown tool {params['name']}")
    if method == "hook":
        payload = params["payload"]
        if payload.get("tool") == "run_command" and "shutdown" in str(payload.get("args", {}).get("command", "")):
            return {"decision": "deny", "reason": "commands that shut the computer down are not allowed"}
        return {}
    raise ValueError(f"unknown method {method}")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("method") == "shutdown":
        break
    if "id" not in request:
        continue
    try:
        send({"jsonrpc": "2.0", "id": request["id"], "result": handle(request["method"], request.get("params") or {})})
    except Exception as err:  # report the failure to OpenHermes instead of crashing
        send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32000, "message": str(err)}})
