import fs from "node:fs";
import type { Home } from "../kernel/home.js";
import { gatewayInfoFile, gatewayToken } from "./gateway.js";

export interface GatewayEvent {
  type: "delta" | "message" | "tool_requested" | "tool_finished" | "log" | "approval" | "done" | "error";
  [key: string]: any;
}

/** Talks to a running gateway on this computer. */
export class GatewayClient {
  constructor(readonly url: string, private token: string) {}

  private headers() {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(this.url + path, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Gateway answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async post<T = any>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(this.url + path, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Gateway answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Runs a turn in the gateway. Events arrive as they happen; resolves with the final answer. */
  async turn(body: { text: string; conversation?: string; agent?: string }, onEvent: (e: GatewayEvent) => void, signal?: AbortSignal): Promise<string> {
    const res = await fetch(this.url + "/v1/turn", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new Error(`Gateway answered ${res.status}: ${await res.text()}`);
    const decoder = new TextDecoder();
    let buffer = "";
    let final: string | undefined;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as GatewayEvent;
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") final = event.text;
        else onEvent(event);
      }
    }
    if (final === undefined) throw new Error("The gateway closed the connection before the turn finished.");
    return final;
  }
}

/** The running gateway for this home, or null when none answers. */
export async function findGateway(home: Home): Promise<GatewayClient | null> {
  let info: { host: string; port: number };
  try {
    info = JSON.parse(fs.readFileSync(gatewayInfoFile(home.data), "utf8"));
  } catch {
    return null;
  }
  const host = info.host === "0.0.0.0" || info.host === "::" ? "127.0.0.1" : info.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${info.port}`;
  try {
    const res = await fetch(url + "/health", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return new GatewayClient(url, gatewayToken(home.secrets));
}
