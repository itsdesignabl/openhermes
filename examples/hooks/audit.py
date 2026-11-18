#!/usr/bin/env python3
"""Example OpenHermes hook: keeps a log of every command the agent runs.

A hook is a program that gets one JSON object on stdin and may print one JSON object.
Printing nothing means "carry on". For a before-event, a non-zero exit code blocks the action.

Install: copy to <home>/runtime/hooks/ and add to System/config.md:
  hooks:
    - { event: tool.before, match: run_command, command: [python, hooks/audit.py] }
"""
import datetime
import json
import os
import sys

event = json.load(sys.stdin)
log = os.path.join(os.environ["OPENHERMES_HOME"], "data", "logs", "commands.log")
os.makedirs(os.path.dirname(log), exist_ok=True)
with open(log, "a", encoding="utf-8") as f:
    f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {event.get('agent')} {event['args']['command']}\n")

# To refuse instead, print: {"decision": "deny", "reason": "why"}
# To change the command, print: {"args": {"command": "...", "timeout_s": 60}}
