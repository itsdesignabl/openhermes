import { Box, Static, Text, render, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { openBackend, type Backend } from "./backend.js";
import type { Home } from "../kernel/home.js";
import type { UiEvent } from "./backend.js";

type Item =
  | { id: number; kind: "user" | "assistant" | "info" | "error"; text: string }
  | { id: number; kind: "tool"; name: string; args: string; ok?: boolean; summary?: string };

interface Pending {
  action: string;
  detail: string;
  resolve: (ok: boolean) => void;
}

const HELP = [
  "/help            this list",
  "/new             start a new conversation",
  "/search <text>   search the vault",
  "/history         the agent's recent changes",
  "/policy          current approval settings",
  "/quit            exit (also Ctrl+C)",
].join("\n");

let nextId = 1;

function Chat({ app }: { app: Backend }) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([
    { id: nextId++, kind: "info", text: `OpenHermes · ${app.label} · ${app.root}\nType a message, or /help.` },
  ]);
  const [live, setLive] = useState("");
  const [tools, setTools] = useState<Extract<Item, { kind: "tool" }>[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const abort = useRef<AbortController | null>(null);
  const push = (item: Omit<Item, "id"> & Record<string, unknown>) => setItems((prev) => [...prev, { ...item, id: nextId++ } as Item]);

  useEffect(() => {
    app.onNotice((level, message) => push({ kind: level === "error" ? "error" : "info", text: message }));
  }, []);

  const onEvent = (e: UiEvent) => {
    if (e.type === "delta") setLive((t) => t + e.text);
    else if (e.type === "message") {
      setLive("");
      push({ kind: "assistant", text: e.text });
    } else if (e.type === "tool_requested") setTools((t) => [...t, { id: nextId++, kind: "tool", name: e.name, args: compact(e.args) }]);
    else if (e.type === "tool_finished") {
      setTools((t) => t.filter((x) => x.name !== e.name));
      push({ kind: "tool", name: e.name, args: "", ok: e.ok, summary: e.summary });
    } else if (e.type === "log") push({ kind: e.level === "error" ? "error" : "info", text: e.message });
  };
  const ask = (action: string, detail: string) => new Promise<boolean>((resolve) => setPending({ action, detail, resolve }));

  const submit = async (text: string) => {
    if (text.startsWith("/")) return command(text);
    push({ kind: "user", text });
    setBusy(true);
    abort.current = new AbortController();
    try {
      await app.send(text, onEvent, ask, abort.current.signal);
    } catch (err) {
      push({ kind: "error", text: abort.current.signal.aborted ? "Stopped." : (err as Error).message });
    } finally {
      setLive("");
      setTools([]);
      setBusy(false);
    }
  };

  const command = async (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();
    if (cmd === "quit" || cmd === "exit") return exit();
    if (cmd === "help") return push({ kind: "info", text: HELP });
    if (cmd === "new") {
      await app.newSession();
      return push({ kind: "info", text: "New conversation started." });
    }
    if (cmd === "search") {
      const hits = await app.search(arg);
      return push({ kind: "info", text: hits.length ? hits.map((h) => `${h.path}${h.heading ? " › " + h.heading : ""}\n  ${h.snippet}`).join("\n") : "No matches." });
    }
    if (cmd === "history") {
      const log = await app.history();
      return push({ kind: "info", text: log.map((e) => `${e.date.slice(0, 16).replace("T", " ")}  ${e.message.split("\n")[0]}`).join("\n") });
    }
    if (cmd === "policy") {
      const p = await app.policies();
      return push({ kind: "info", text: Object.entries(p).map(([k, v]) => `${k.padEnd(24)} ${v}`).join("\n") + "\nEdit vault/System/policies.md to change these." });
    }
    push({ kind: "error", text: `Unknown command /${cmd}. Try /help.` });
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (busy) abort.current?.abort();
      else exit();
      return;
    }
    if (pending) {
      const answer = ch.toLowerCase();
      if (answer === "y" || answer === "n" || key.escape) {
        pending.resolve(answer === "y");
        push({ kind: "info", text: `${answer === "y" ? "Allowed" : "Declined"}: ${pending.detail}` });
        setPending(null);
      }
      return;
    }
    if (busy) {
      if (key.escape) abort.current?.abort();
      return;
    }
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (text) void submit(text);
    } else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
    else if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
  });

  return (
    <>
      <Static items={items}>{(item) => <Line key={item.id} item={item} />}</Static>
      <Box flexDirection="column" marginTop={1}>
        {live ? <Text>{live}</Text> : null}
        {tools.map((t) => (
          <Text key={t.id} color="yellow">⋯ {t.name} {t.args}</Text>
        ))}
        {pending ? (
          <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
            <Text color="yellow" bold>Approval needed ({pending.action})</Text>
            <Text>{pending.detail}</Text>
            <Text dimColor>y = allow · n = decline</Text>
          </Box>
        ) : busy ? (
          <Text dimColor>working… (Esc to stop)</Text>
        ) : (
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="cyan">› </Text>
            <Text>{input}</Text>
            <Text inverse> </Text>
          </Box>
        )}
      </Box>
    </>
  );
}

function Line({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>you  </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text color="green" bold>agent  </Text>
          <Box flexShrink={1}><Text>{item.text}</Text></Box>
        </Box>
      );
    case "tool":
      return (
        <Text color={item.ok ? "gray" : "red"}>
          {"  "}{item.ok ? "✓" : "✗"} {item.name}  {item.summary}
        </Text>
      );
    case "error":
      return <Text color="red">{item.text}</Text>;
    default:
      return <Text dimColor>{item.text}</Text>;
  }
}

function compact(args: unknown): string {
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

export async function runTui(home: Home): Promise<void> {
  const backend = await openBackend(home);
  const ui = render(<Chat app={backend} />, { exitOnCtrlC: false });
  await ui.waitUntilExit();
  await backend.close();
}
