import { App } from "../app.js";
import { findGateway, type GatewayClient } from "../gateway/client.js";
import type { Home } from "../kernel/home.js";
import type { SearchHit } from "../memory/index.js";

export type UiEvent =
  | { type: "delta"; text: string }
  | { type: "message"; text: string }
  | { type: "tool_requested"; name: string; args: unknown }
  | { type: "tool_finished"; name: string; ok: boolean; summary: string }
  | { type: "log"; level: string; message: string };

export type Ask = (action: string, detail: string) => Promise<boolean>;

/** What `chat` and `ask` need from the agent, whether it runs in this process or in the gateway. */
export interface Backend {
  label: string;
  root: string;
  send(text: string, onEvent: (e: UiEvent) => void, ask: Ask, signal?: AbortSignal): Promise<string>;
  newSession(): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
  history(): Promise<{ date: string; message: string }[]>;
  policies(): Promise<Record<string, string>>;
  /** Messages that arrive outside a turn, such as "settings reloaded". */
  onNotice(fn: (level: string, message: string) => void): void;
  close(): Promise<void>;
}

class LocalBackend implements Backend {
  constructor(private app: App) {}
  get label() { return this.app.modelLabel(); }
  get root() { return this.app.home.root; }

  async send(text: string, onEvent: (e: UiEvent) => void, ask: Ask, signal?: AbortSignal): Promise<string> {
    const bus = this.app.bus;
    const offs = [
      bus.on("assistant.delta", (e) => onEvent({ type: "delta", text: e.text })),
      bus.on("assistant.message", (e) => onEvent({ type: "message", text: e.text })),
      bus.on("tool.requested", (e) => onEvent({ type: "tool_requested", name: e.name, args: e.args })),
      bus.on("tool.finished", (e) => onEvent({ type: "tool_finished", name: e.name, ok: e.ok, summary: e.summary })),
    ];
    try {
      return (await this.app.send(text, { signal, approver: ask })).text;
    } finally {
      offs.forEach((off) => off());
    }
  }
  async newSession() { this.app.newSession(); }
  async search(query: string) { return this.app.memory.search(query, 8); }
  async history() { return (await this.app.history.log(8)).map((e) => ({ date: e.date.toISOString(), message: e.message })); }
  async policies() { return { ...this.app.policies.policies }; }
  onNotice(fn: (level: string, message: string) => void) {
    this.app.bus.on("log", (e) => fn(e.level, e.message));
    this.app.bus.on("config.reloaded", (e) =>
      e.ok ? fn("info", "Settings reloaded.") : fn("error", `Settings not applied, keeping the previous ones: ${e.error}`),
    );
  }
  close() { return this.app.stop(); }
}

class RemoteBackend implements Backend {
  root: string;
  label: string;
  constructor(private client: GatewayClient, status: { home: string; model: string }) {
    this.root = status.home;
    this.label = `${status.model} · via gateway`;
  }
  send(text: string, onEvent: (e: UiEvent) => void, ask: Ask, signal?: AbortSignal): Promise<string> {
    return this.client.turn(
      { text },
      (e) => {
        if (e.type === "approval") {
          void ask(e.action, e.detail).then((approved) => this.client.post("/v1/approval", { id: e.id, approved }).catch(() => {}));
        } else onEvent(e as UiEvent);
      },
      signal,
    );
  }
  async newSession() { await this.client.post("/v1/new"); }
  async search(query: string) { return (await this.client.get(`/v1/search?q=${encodeURIComponent(query)}`)).hits; }
  async history() { return (await this.client.get("/v1/history")).entries; }
  async policies() { return (await this.client.get("/v1/policies")).policies; }
  onNotice() {}
  async close() {}
}

/**
 * When a gateway is running it owns the vault, so local commands go through it.
 * Otherwise the agent runs inside this process.
 */
export async function openBackend(home: Home): Promise<Backend> {
  const client = await findGateway(home);
  if (client) return new RemoteBackend(client, await client.get("/v1/status"));
  return new LocalBackend(await App.start(home));
}
