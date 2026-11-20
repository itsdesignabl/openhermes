import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface TurnEvent {
  type: "delta" | "message" | "tool_requested" | "tool_finished" | "log" | "approval";
  [key: string]: any;
}

export interface InboxEntry {
  id: string;
  title: string;
  file: string;
}

export class GatewayDown extends Error {}

/**
 * Talks to the OpenHermes gateway on this computer. Uses Node's http module rather than the
 * browser's fetch: the gateway refuses requests that come from web pages, and this way the
 * answer can be read as it streams. No Obsidian imports, so it can be tested on its own.
 */
export class HermesClient {
  constructor(readonly home: string) {}

  /** True when the vault this plugin runs in belongs to an OpenHermes home folder. */
  isHome(): boolean {
    return fs.existsSync(path.join(this.home, "vault")) && fs.existsSync(path.join(this.home, "runtime"));
  }

  private endpoint(): { host: string; port: number; token: string } {
    let info: { host: string; port: number };
    let token: string;
    try {
      info = JSON.parse(fs.readFileSync(path.join(this.home, "data", "gateway", "gateway.json"), "utf8"));
      token = fs.readFileSync(path.join(this.home, "secrets", "gateway-token"), "utf8").trim();
    } catch {
      throw new GatewayDown("The gateway is not running.");
    }
    const host = info.host === "0.0.0.0" || info.host === "::" ? "127.0.0.1" : info.host;
    return { host, port: info.port, token };
  }

  private open(method: string, route: string, body: unknown, onResponse: (res: http.IncomingMessage) => void, onError: (err: Error) => void): http.ClientRequest {
    const { host, port, token } = this.endpoint();
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host, port, path: route, method, headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } },
      onResponse,
    );
    req.on("error", (err: NodeJS.ErrnoException) => onError(err.code === "ECONNREFUSED" ? new GatewayDown("The gateway is not running.") : err));
    req.end(data);
    return req;
  }

  request<T = any>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        const req = this.open(
          method,
          route,
          body,
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (d) => (text += d));
            res.on("end", () => {
              let parsed: any = {};
              try {
                parsed = JSON.parse(text);
              } catch {}
              if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `The gateway answered ${res.statusCode}.`));
              else resolve(parsed as T);
            });
          },
          reject,
        );
        req.setTimeout(15000, () => req.destroy(new Error("The gateway did not answer in time.")));
      } catch (err) {
        reject(err);
      }
    });
  }

  status() {
    return this.request<{ model: string; default_agent: string; channels: { name: string; state: string }[] }>("GET", "/v1/status");
  }
  inbox() {
    return this.request<{ items: InboxEntry[] }>("GET", "/v1/inbox").then((r) => r.items);
  }
  resolve(ref: string, approve: boolean) {
    return this.request<{ message: string }>("POST", "/v1/inbox/resolve", { ref, approve }).then((r) => r.message);
  }
  approve(id: string, approved: boolean | "always") {
    return this.request("POST", "/v1/approval", { id, approved });
  }
  conversation(key: string) {
    return this.request<{ messages: { role: "user" | "assistant"; text: string }[] }>("GET", `/v1/conversation?key=${encodeURIComponent(key)}`).then((r) => r.messages);
  }
  newConversation(key: string) {
    return this.request("POST", "/v1/new", { conversation: key });
  }

  /**
   * Sends a message and reports what happens as it happens. Resolves with the final answer.
   * Call the returned `stop` to interrupt the turn.
   */
  turn(body: { text: string; conversation: string; agent?: string }, onEvent: (e: TurnEvent) => void): { done: Promise<string>; stop: () => void } {
    let req: http.ClientRequest | undefined;
    const done = new Promise<string>((resolve, reject) => {
      try {
        req = this.open(
          "POST",
          "/v1/turn",
          { ...body, persist: true },
          (res) => {
            if ((res.statusCode ?? 500) >= 400) {
              let text = "";
              res.on("data", (d) => (text += d));
              res.on("end", () => reject(new Error(safeError(text) ?? `The gateway answered ${res.statusCode}.`)));
              return;
            }
            let buffer = "";
            let final: string | undefined;
            let failed = false;
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              buffer += chunk;
              let nl: number;
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let event: any;
                try {
                  event = JSON.parse(line);
                } catch {
                  continue;
                }
                if (event.type === "done") final = String(event.text ?? "");
                else if (event.type === "error") {
                  failed = true;
                  reject(new Error(String(event.message)));
                } else onEvent(event);
              }
            });
            res.on("end", () => {
              if (failed) return;
              if (final === undefined) reject(new Error("The connection closed before the answer was complete."));
              else resolve(final);
            });
            res.on("error", reject);
          },
          reject,
        );
      } catch (err) {
        reject(err);
      }
    });
    return { done, stop: () => req?.destroy(new Error("Stopped.")) };
  }
}

function safeError(text: string): string | undefined {
  try {
    return JSON.parse(text).error;
  } catch {
    return undefined;
  }
}
