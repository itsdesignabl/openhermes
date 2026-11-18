import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { DiscordChannel } from "../src/channels/discord.js";
import { TelegramChannel } from "../src/channels/telegram.js";
import type { ChannelContext, Inbound } from "../src/channels/types.js";
import { ConfigSchema } from "../src/kernel/config.js";

function context(channels: Record<string, unknown>, secrets: Record<string, string>) {
  const inbound: Inbound[] = [];
  const logs: string[] = [];
  let wake: (() => void) | undefined;
  const config = ConfigSchema.parse({ channels });
  const ctx: ChannelContext = {
    config: () => config,
    secret: (name) => secrets[name],
    onMessage: (m) => {
      inbound.push(m);
      wake?.();
    },
    log: (level, message) => {
      logs.push(`${level}: ${message}`);
      wake?.();
    },
  };
  const until = async (cond: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out waiting; logs: " + logs.join(" | "));
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
  };
  return { ctx, inbound, logs, until };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

/** A stand-in for the Telegram Bot API. */
async function fakeTelegram(updates: any[]) {
  const calls: { method: string; token: string; body: any }[] = [];
  let served = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const [, token, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url!) ?? [];
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: method!, token: token!, body });
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (token !== "GOOD") return reply(401, { ok: false, description: "Unauthorized" });
      if (method === "getMe") return reply(200, { ok: true, result: { id: 999, username: "hermes_bot" } });
      if (method === "getUpdates") {
        if (!served) {
          served = true;
          return reply(200, { ok: true, result: updates });
        }
        return void setTimeout(() => reply(200, { ok: true, result: [] }), 200); // long poll
      }
      reply(200, { ok: true, result: {} });
    });
  });
  const url = await listen(server);
  return { url, calls, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

test("telegram: receives direct and group messages, confirms them, and sends replies in parts", async () => {
  const api = await fakeTelegram([
    { update_id: 10, message: { text: "hello", chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Ada", last_name: "L" } } },
    { update_id: 11, message: { text: "@Hermes_Bot lunch?", chat: { id: -100, type: "supergroup" }, from: { id: 43, username: "bob" } } },
    { update_id: 12, message: { text: "just chatting", chat: { id: -100, type: "group" }, from: { id: 43, username: "bob" } } },
    { update_id: 13, message: { text: "from a bot", chat: { id: 1, type: "private" }, from: { id: 5, is_bot: true } } },
    { update_id: 14, message: { photo: [], chat: { id: 42, type: "private" }, from: { id: 42 } } },
  ]);
  const { ctx, inbound, logs, until } = context({ telegram: { enabled: true, api_base: api.url } }, { telegram_bot_token: "GOOD" });
  const channel = new TelegramChannel(ctx);
  try {
    await channel.start();
    await until(() => inbound.length === 3);
    assert.equal(channel.state, "connected");
    assert.ok(logs.includes("info: Telegram connected as @hermes_bot"));
    assert.deepEqual(inbound[0], { channel: "telegram", peer: "42", sender: "42", senderName: "Ada L", text: "hello", isGroup: false, mentioned: false });
    assert.deepEqual(inbound[1], { channel: "telegram", peer: "-100", sender: "43", senderName: "bob", text: "lunch?", isGroup: true, mentioned: true });
    assert.equal(inbound[2]!.mentioned, false);

    await until(() => api.calls.filter((c) => c.method === "getUpdates").length >= 2);
    assert.equal(api.calls.filter((c) => c.method === "getUpdates")[1]!.body.offset, 15, "handled updates are confirmed so they are not delivered again");

    await channel.send("42", "a".repeat(5000));
    await channel.typing("42");
    const sent = api.calls.filter((c) => c.method === "sendMessage");
    assert.deepEqual(sent.map((c) => [c.body.chat_id, c.body.text.length]), [["42", 4000], ["42", 1000]]);
    assert.ok(api.calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing"));
  } finally {
    await channel.stop();
    await api.close();
  }
  assert.equal(channel.state, "stopped");
});

test("telegram: a rejected or missing token stops the channel with a clear reason instead of retrying forever", async () => {
  const api = await fakeTelegram([]);
  try {
    const bad = context({ telegram: { enabled: true, api_base: api.url } }, { telegram_bot_token: "BAD" });
    const channel = new TelegramChannel(bad.ctx);
    await channel.start();
    await bad.until(() => channel.state !== "connecting");
    assert.equal(channel.state, "Telegram rejected the bot token");
    const callsAfter = api.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.calls.length, callsAfter, "no further requests");
    await channel.stop();

    const none = context({ telegram: { enabled: true, api_base: api.url } }, {});
    const channel2 = new TelegramChannel(none.ctx);
    await channel2.start();
    await none.until(() => channel2.state !== "connecting");
    assert.match(channel2.state, /no bot token\. Run: openhermes secret set telegram_bot_token/);
    await channel2.stop();
  } finally {
    await api.close();
  }
});

/** A stand-in for the Discord gateway (WebSocket) and REST API. */
async function fakeDiscord(opts: { closeWith?: number } = {}) {
  const rest: { path: string; auth: string; body: any }[] = [];
  const frames: any[] = [];
  let connections = 0;
  let limited = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      rest.push({ path: req.url!, auth: String(req.headers.authorization), body: raw ? JSON.parse(raw) : null });
      if (req.url!.includes("/channels/slow/") && !limited) {
        limited = true;
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ retry_after: 0.05 }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    connections++;
    const n = connections;
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60 } }));
    ws.on("message", (data) => {
      const p = JSON.parse(String(data));
      frames.push({ ...p, connection: n });
      if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (p.op === 2) {
        if (opts.closeWith) return ws.close(opts.closeWith);
        ws.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: "999", username: "hermes" }, session_id: "s" } }));
        if (n === 1) {
          const msg = (d: any, s: number) => ws.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s, d }));
          msg({ content: "hello", channel_id: "dm1", author: { id: "42", username: "ada", global_name: "Ada" } }, 2);
          msg({ content: "<@999> lunch?", channel_id: "c7", guild_id: "g1", author: { id: "43", username: "bob" }, mentions: [{ id: "999" }] }, 3);
          msg({ content: "bot noise", channel_id: "c7", guild_id: "g1", author: { id: "5", bot: true } }, 4);
          setTimeout(() => ws.send(JSON.stringify({ op: 7 })), 150); // ask the client to reconnect
        }
      }
    });
  });
  const url = await listen(server);
  return {
    apiBase: url,
    gatewayUrl: url.replace("http", "ws"),
    rest,
    frames,
    connections: () => connections,
    close: () => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), server.closeAllConnections(), server.close(() => r()))),
  };
}

test("discord: identifies, keeps the connection alive, receives messages, reconnects when asked, and sends replies", async () => {
  const srv = await fakeDiscord();
  const { ctx, inbound, logs, until } = context(
    { discord: { enabled: true, api_base: srv.apiBase, gateway_url: srv.gatewayUrl } },
    { discord_bot_token: "TOKEN" },
  );
  const channel = new DiscordChannel(ctx);
  try {
    await channel.start();
    await until(() => inbound.length === 2);
    const identify = srv.frames.find((f) => f.op === 2);
    assert.equal(identify.d.token, "TOKEN");
    assert.equal(identify.d.intents, 1 | 512 | 4096 | 32768, "guilds, guild messages, direct messages, message content");
    assert.deepEqual(inbound[0], { channel: "discord", peer: "dm1", sender: "42", senderName: "Ada", text: "hello", isGroup: false, mentioned: false });
    assert.deepEqual(inbound[1], { channel: "discord", peer: "c7", sender: "43", senderName: "bob", text: "lunch?", isGroup: true, mentioned: true });

    await until(() => srv.frames.some((f) => f.op === 1));
    assert.equal(srv.frames.find((f) => f.op === 1 && f.d !== null)?.d >= 1, true, "heartbeats carry the last sequence number");

    await until(() => srv.connections() === 2 && channel.state === "connected");
    assert.ok(srv.frames.some((f) => f.op === 2 && f.connection === 2), "identified again after the reconnect");
    assert.equal(inbound.length, 2);

    await channel.send("dm1", "b".repeat(2500));
    await channel.send("slow", "after a rate limit");
    await channel.typing("dm1");
    const posts = srv.rest.filter((r) => r.path.endsWith("/messages"));
    assert.deepEqual(posts.map((p) => [p.path, p.body.content.length]), [
      ["/channels/dm1/messages", 1900],
      ["/channels/dm1/messages", 600],
      ["/channels/slow/messages", 18],
      ["/channels/slow/messages", 18],
    ]);
    assert.ok(posts.every((p) => p.auth === "Bot TOKEN"));
    assert.ok(srv.rest.some((r) => r.path === "/channels/dm1/typing"));
    assert.ok(logs.includes("info: Discord connected as hermes"));
  } finally {
    await channel.stop();
    await srv.close();
  }
});

test("discord: a rejected token or a disabled intent stops the channel with the reason", async () => {
  for (const [code, reason] of [[4004, /rejected the bot token/], [4014, /Message Content intent is not enabled/]] as const) {
    const srv = await fakeDiscord({ closeWith: code });
    const { ctx, until } = context({ discord: { enabled: true, api_base: srv.apiBase, gateway_url: srv.gatewayUrl } }, { discord_bot_token: "T" });
    const channel = new DiscordChannel(ctx);
    try {
      await channel.start();
      await until(() => reason.test(channel.state));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(srv.connections(), 1, "no reconnect attempts");
    } finally {
      await channel.stop();
      await srv.close();
    }
  }
  const none = context({ discord: { enabled: true } }, {});
  const channel = new DiscordChannel(none.ctx);
  await channel.start();
  assert.match(channel.state, /no bot token\. Run: openhermes secret set discord_bot_token/);
});
