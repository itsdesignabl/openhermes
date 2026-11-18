import crypto from "node:crypto";
import http from "node:http";
import type { Gateway } from "./gateway.js";

const MAX_BODY = 1024 * 1024;

/**
 * Control API for local programs (the CLI, the TUI, later the Obsidian plugin).
 * Every request except /health needs the token from secrets/gateway-token.
 */
export class GatewayHttp {
  private server: http.Server;
  private approvals = new Map<string, (ok: boolean | "always") => void>();

  constructor(private gateway: Gateway, private token: string) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: (err as Error).message });
        else res.end();
      });
    });
  }

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", (err: NodeJS.ErrnoException) =>
        reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is in use. Is a gateway already running? (openhermes gateway status)`) : err),
      );
      this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(this.token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // A web page must never be able to drive the agent: browsers always send Origin on cross-site requests.
    if (req.headers.origin) return json(res, 403, { error: "requests from web pages are not accepted" });
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (!this.authorized(req)) return json(res, 401, { error: "missing or wrong token" });

    const app = this.gateway.app;
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /v1/status":
        return json(res, 200, this.gateway.status());
      case "GET /v1/search":
        return json(res, 200, { hits: app.memory.search(url.searchParams.get("q") ?? "", 8) });
      case "GET /v1/history":
        return json(res, 200, { entries: (await app.history.log(8)).map((e) => ({ date: e.date.toISOString(), message: e.message })) });
      case "GET /v1/policies":
        return json(res, 200, { policies: app.policies.policies });
      case "GET /v1/inbox":
        return json(res, 200, { items: app.learner.pending().map((i) => ({ id: i.id, title: i.title, created: i.created, file: app.home.display(i.file).replace(/^vault\//, "") })) });
      case "GET /v1/conversation": {
        const key = url.searchParams.get("key") ?? `${app.defaultAgent}:local`;
        const messages = app
          .conversation(key, undefined, true)
          .history.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
          .slice(-40)
          .map((m) => ({ role: m.role, text: m.content }));
        return json(res, 200, { messages });
      }
      case "POST /v1/inbox/resolve": {
        const body = await readBody(req);
        try {
          const r = await app.learner.resolve(String(body.ref ?? ""), body.approve === true);
          return json(res, 200, { outcome: r.outcome, message: r.message });
        } catch (err) {
          return json(res, 404, { error: (err as Error).message });
        }
      }
      case "POST /v1/curate":
        return json(res, 200, { actions: (await app.learner.curate()).actions });
      case "POST /v1/reflect": {
        const body = await readBody(req);
        try {
          return json(res, 200, await app.learner.reflectNote(String(body.file ?? "")));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      case "POST /v1/new": {
        const body = await readBody(req);
        app.newSession(typeof body.conversation === "string" ? body.conversation : undefined);
        return json(res, 200, { ok: true });
      }
      case "POST /v1/approval": {
        const body = await readBody(req);
        const resolve = this.approvals.get(String(body.id));
        if (!resolve) return json(res, 404, { error: "no such pending approval" });
        this.approvals.delete(String(body.id));
        resolve(body.approved === "always" ? "always" : body.approved === true);
        return json(res, 200, { ok: true });
      }
      case "POST /v1/shutdown":
        json(res, 200, { ok: true });
        setImmediate(() => void this.gateway.stop());
        return;
      case "POST /v1/turn":
        return this.turn(req, res);
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  /** Runs one turn and streams what happens as one JSON object per line. */
  private async turn(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) return json(res, 400, { error: "text is required" });
    const app = this.gateway.app;
    const agent = typeof body.agent === "string" ? body.agent : app.defaultAgent;
    const conversation = typeof body.conversation === "string" ? body.conversation : `${agent}:local`;
    const session = app.conversation(conversation, agent, body.persist === true);

    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const write = (event: Record<string, unknown>) => void res.write(JSON.stringify(event) + "\n");
    const abort = new AbortController();
    const mine = new Set<string>();
    res.on("close", () => {
      if (res.writableFinished) return;
      abort.abort();
      for (const id of mine) this.approvals.get(id)?.(false);
    });
    const forMe = (e: { sessionId: string }) => e.sessionId === session.id;
    const offs = [
      app.bus.on("assistant.delta", (e) => { if (forMe(e)) write({ type: "delta", text: e.text }); }),
      app.bus.on("assistant.message", (e) => { if (forMe(e)) write({ type: "message", text: e.text }); }),
      app.bus.on("tool.requested", (e) => { if (forMe(e)) write({ type: "tool_requested", name: e.name, args: e.args }); }),
      app.bus.on("tool.finished", (e) => { if (forMe(e)) write({ type: "tool_finished", name: e.name, ok: e.ok, summary: e.summary }); }),
      app.bus.on("log", (e) => write({ type: "log", level: e.level, message: e.message })),
    ];
    try {
      const result = await app.send(body.text, {
        conversation,
        agent,
        persist: body.persist === true,
        signal: abort.signal,
        approver: (action, detail) =>
          new Promise<boolean | "always">((resolve) => {
            const id = crypto.randomUUID();
            mine.add(id);
            this.approvals.set(id, (ok) => {
              mine.delete(id);
              this.approvals.delete(id);
              resolve(ok);
            });
            write({ type: "approval", id, action, detail });
          }),
      });
      write({ type: "done", text: result.text, steps: result.steps });
    } catch (err) {
      write({ type: "error", message: (err as Error).message });
    } finally {
      offs.forEach((off) => off());
      res.end();
    }
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}
