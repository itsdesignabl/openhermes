import type { Home } from "../kernel/home.js";
import { JsonRpcProcess } from "../kernel/rpc.js";

export interface McpServerSpec {
  name: string;
  /** Start the server as a local program... */
  command?: string[];
  env: Record<string, string>;
  /** ...or reach it over HTTP. */
  url?: string;
  token_secret: string;
  /** If set, only these tools of the server are offered. */
  tools?: string[];
  timeout_s: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "openhermes", version: "0.1.0" };

interface Transport {
  request(method: string, params: unknown, timeoutS: number): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  connected: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
}

class StdioTransport implements Transport {
  private rpc: JsonRpcProcess;
  constructor(home: Home, spec: McpServerSpec, log: (level: "info" | "warn" | "error", message: string) => void) {
    const label = `tool server '${spec.name}'`;
    this.rpc = new JsonRpcProcess({
      command: spec.command!,
      cwd: home.workspace,
      env: spec.env,
      // servers log freely on stderr; only keep what looks like a problem
      onStderr: (line) => /error|fail|exception|denied/i.test(line) && log("warn", `${label}: ${line.slice(0, 300)}`),
      onExit: (code) => log("warn", `${label} stopped (exit code ${code}). It is started again when next needed.`),
    });
  }
  get connected() { return this.rpc.running; }
  async connect() { this.rpc.start(); }
  request(method: string, params: unknown, timeoutS: number) { return this.rpc.request(method, params, timeoutS); }
  async notify(method: string, params?: unknown) { this.rpc.notify(method, params); }
  close() { return this.rpc.stop(); }
}

/** MCP "Streamable HTTP": each request is a POST; the answer is JSON or a short event stream. */
class HttpTransport implements Transport {
  connected = false;
  private session?: string;
  private nextId = 1;
  constructor(private url: string, private token: string | undefined) {}

  async connect() { this.connected = true; }

  private async post(body: unknown, timeoutS: number): Promise<Response> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) this.session = session;
    return res;
  }

  async request(method: string, params: unknown, timeoutS: number): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, timeoutS);
    if (res.status === 404 && this.session) {
      this.session = undefined;
      this.connected = false;
      throw new Error("the server ended the session");
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}${res.status === 401 || res.status === 403 ? " (check the token)" : ""}`);
    const type = res.headers.get("content-type") ?? "";
    let messages: any[];
    if (type.includes("text/event-stream")) {
      messages = (await res.text())
        .split(/\r?\n\r?\n/)
        .map((block) => block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"))
        .filter(Boolean)
        .flatMap((data) => {
          try {
            return [JSON.parse(data)];
          } catch {
            return [];
          }
        });
    } else messages = [await res.json()].flat();
    const answer = messages.find((m) => m?.id === id);
    if (!answer) throw new Error("the server sent no answer to the request");
    if (answer.error) throw new Error(String(answer.error.message ?? "the server reported an error"));
    return answer.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, 15).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.session) {
      await fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.session, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    this.connected = false;
  }
}

/** A connection to one Model Context Protocol server, used for its tools only. */
export class McpClient {
  private transport: Transport;
  private ready?: Promise<void>;
  private stopped = false;

  constructor(home: Home, readonly spec: McpServerSpec, token: string | undefined, log: (level: "info" | "warn" | "error", message: string) => void) {
    if (spec.command?.length) this.transport = new StdioTransport(home, spec, log);
    else if (spec.url) this.transport = new HttpTransport(spec.url, token);
    else throw new Error("it needs either a command or a url");
  }

  private async handshake(): Promise<void> {
    await this.transport.connect();
    await this.transport.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, 30);
    await this.transport.notify("notifications/initialized");
  }

  /** Connects if needed. A server that stopped is started again on the next use. */
  private ensure(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("the tool server was shut down"));
    if (this.ready && this.transport.connected) return this.ready;
    return (this.ready = this.handshake().catch((err) => {
      this.ready = undefined;
      throw err;
    }));
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensure();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.transport.request("tools/list", cursor ? { cursor } : {}, 30);
      for (const t of result?.tools ?? []) {
        if (typeof t?.name !== "string") continue;
        tools.push({
          name: t.name,
          description: String(t.description ?? ""),
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Calls a tool and returns its result as text. A tool-level error is thrown so the model sees it as an error. */
  async callTool(name: string, args: unknown): Promise<string> {
    await this.ensure();
    const result = await this.transport.request("tools/call", { name, arguments: args ?? {} }, this.spec.timeout_s);
    const parts: string[] = [];
    for (const item of result?.content ?? []) {
      if (item?.type === "text") parts.push(String(item.text ?? ""));
      else if (item?.type === "resource" && typeof item.resource?.text === "string") parts.push(item.resource.text);
      else if (item?.type === "resource_link") parts.push(`[link: ${item.uri ?? item.name ?? "resource"}]`);
      else parts.push(`[${item?.type ?? "content"} omitted: only text is passed on]`);
    }
    if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    const text = parts.join("\n").trim() || "(no output)";
    if (result?.isError) throw new Error(text);
    return text;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.transport.close();
  }
}

/** The name a server's tool gets in the agent: unique, and valid for every model API. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${clean(server)}__${clean(tool)}`.slice(0, 64);
}
