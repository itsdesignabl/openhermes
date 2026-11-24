import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseNote } from "../vault/frontmatter.js";
import type { Home } from "./home.js";

const ChannelSchema = z.object({
  enabled: z.boolean().default(false),
  /** Name of the entry in secrets/keys.json that holds the bot token. */
  token_secret: z.string().default(""),
  /** Sender ids that may talk to the agent without pairing. */
  allow_from: z.array(z.coerce.string()).default([]),
  /** Unknown senders get a pairing code to be approved with `openhermes pair approve`. When false they are ignored. */
  pairing: z.boolean().default(true),
  /** In group chats, answer only when the bot is mentioned. */
  require_mention: z.boolean().default(true),
});

/** Per-agent settings from Agents/<name>/agent.md. Anything left out falls back to System/config.md. */
export const AgentSettingsSchema = z.object({
  provider: z
    .object({
      base_url: z.string().optional(),
      model: z.string().optional(),
      api_key_secret: z.string().optional(),
      temperature: z.number().optional(),
    })
    .prefault({}),
  /** If set, only these tools are offered to this agent. */
  tools: z.array(z.string()).optional(),
  heartbeat: z
    .object({
      /** "30m", "2h", or "0m" to turn it off. */
      every: z.string().default("30m"),
      /** "last" (the chat that last spoke to this agent), "none", or "<channel>:<chat id>". */
      target: z.string().default("last"),
      /** Local time window such as "08:00-22:00". Empty means always. */
      active_hours: z.string().default(""),
    })
    .prefault({}),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const ConfigSchema = z.object({
  agent: z.string().default("main"),
  provider: z
    .object({
      /** OpenAI-compatible endpoint. Empty means: start the bundled llama.cpp server. */
      base_url: z.string().default(""),
      model: z.string().default("local"),
      /** Name of an entry in secrets/keys.json. Not needed for local models. */
      api_key_secret: z.string().default(""),
      temperature: z.number().default(0.2),
      request_timeout_s: z.number().default(600),
      /** The model's context window when `base_url` is set. With the bundled server, local_model.context_tokens is used. */
      context_tokens: z.number().min(1024).default(8192),
      /**
       * How many requests may be sent to the model at the same time. 1 suits a single local model, which
       * answers one request at a time anyway. Raise it for a cloud model or a server set up for parallel requests.
       */
      max_parallel: z.number().int().min(1).default(1),
      /** Tokens kept free in the window for the model's answer. */
      reserve_output_tokens: z.number().min(128).default(1024),
    })
    .prefault({}),
  local_model: z
    .object({
      /** File name inside models/. */
      file: z.string().default(""),
      port: z.number().default(18790),
      context_tokens: z.number().default(8192),
      extra_args: z.array(z.string()).default([]),
    })
    .prefault({}),
  agent_loop: z
    .object({
      max_steps: z.number().default(12),
      max_tool_output_chars: z.number().default(8000),
    })
    .prefault({}),
  memory: z
    .object({
      memory_max_chars: z.number().default(4000),
      user_max_chars: z.number().default(2000),
      search_results: z.number().default(5),
    })
    .prefault({}),
  session: z
    .object({
      /** Optional extra cap on how much of the earlier conversation is sent. 0 means: as much as the model's window allows. */
      history_max_chars: z.number().default(0),
      /** Summarise earlier turns when they no longer fit, instead of only leaving them out. */
      summarize: z.boolean().default(true),
      summary_max_chars: z.number().default(1500),
    })
    .prefault({}),
  backend: z
    .object({
      /** Where shell commands run: on this computer, in a Docker container, or on another machine. */
      /**
       * "auto" (the default) uses the Docker sandbox when Docker is running and falls back to this
       * computer, with a warning, when it is not. "docker", "local" and "ssh" pin the choice.
       */
      type: z.string().default("auto"),
      docker: z
        .object({
          binary: z.string().default("docker"),
          image: z.string().default("python:3.12-slim"),
          /** "bridge" allows internet access from the container, "none" forbids it. */
          network: z.string().default("bridge"),
          /** Whether commands can see the vault: "ro" (read only), "rw", or "none". */
          mount_vault: z.enum(["ro", "rw", "none"]).default("ro"),
          memory: z.string().default("2g"),
          cpus: z.number().default(2),
          pids_limit: z.number().default(512),
          extra_args: z.array(z.string()).default([]),
        })
        .prefault({}),
      ssh: z
        .object({
          binary: z.string().default("ssh"),
          host: z.string().default(""),
          user: z.string().default(""),
          port: z.number().default(22),
          identity_file: z.string().default(""),
          workdir: z.string().default("openhermes-workspace"),
          extra_args: z.array(z.string()).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Programs run at fixed points; see System/config.md. */
  hooks: z
    .array(
      z.object({
        event: z.enum(["turn.before", "turn.after", "tool.before", "tool.after"]),
        /** For tool events: only this tool. */
        match: z.string().optional(),
        command: z.array(z.string()).min(1),
        timeout_s: z.number().default(15),
      }),
    )
    .default([]),
  /** Plugins that run as separate programs and speak JSON over stdin/stdout. */
  external_plugins: z
    .array(z.object({ name: z.string(), command: z.array(z.string()).min(1), timeout_s: z.number().default(60) }))
    .default([]),
  /** Tool servers that speak the Model Context Protocol. */
  mcp_servers: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/, "use letters, digits, - and _ (at most 24)"),
        command: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).default({}),
        url: z.string().optional(),
        /** Name of the entry in secrets/keys.json sent as a bearer token to a `url` server. */
        token_secret: z.string().default(""),
        tools: z.array(z.string()).optional(),
        timeout_s: z.number().default(120),
      }),
    )
    .default([]),
  learning: z
    .object({
      enabled: z.boolean().default(true),
      /** Review a conversation after this many of the user's messages. */
      reflect_every_turns: z.number().default(10),
      /** Review a conversation that has been quiet this long (while the gateway runs). 0 turns it off. */
      reflect_idle_minutes: z.number().default(30),
      /** Conversations shorter than this are not reviewed when they end. */
      min_turns: z.number().default(2),
      max_transcript_chars: z.number().default(12000),
      /** How often the cleanup runs while the gateway runs. "0m" turns it off. */
      curator_every: z.string().default("24h"),
      /** Skills the agent wrote itself and has not used for this long are moved to Skills/_archive. 0 turns it off. */
      archive_unused_days: z.number().default(60),
      /** Tell me in chat when something is waiting in the Inbox. */
      notify: z.boolean().default(true),
    })
    .prefault({}),
  gateway: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().default(18789),
      /** Must be set to true before the gateway will listen on anything other than this computer. */
      allow_remote: z.boolean().default(false),
      approval_timeout_s: z.number().default(300),
    })
    .prefault({}),
  channels: z
    .object({
      telegram: ChannelSchema.extend({ api_base: z.string().default("https://api.telegram.org") }).prefault({}),
      discord: ChannelSchema.extend({
        api_base: z.string().default("https://discord.com/api/v10"),
        gateway_url: z.string().default("wss://gateway.discord.gg/?v=10&encoding=json"),
      }).prefault({}),
      slack: ChannelSchema.extend({
        api_base: z.string().default("https://slack.com/api"),
        /** Name of the entry in secrets/keys.json that holds the app-level token (xapp-…). */
        app_token_secret: z.string().default(""),
      }).prefault({}),
    })
    .prefault({}),
  routing: z
    .object({
      default_agent: z.string().default(""),
      /** First match wins. A binding without `peer` matches every chat on that channel. */
      bindings: z.array(z.object({ channel: z.string(), peer: z.coerce.string().optional(), agent: z.string() })).default([]),
    })
    .prefault({}),
  plugins: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

export const PolicyValue = z.enum(["auto", "ask", "deny"]);
export type PolicyValue = z.infer<typeof PolicyValue>;

export const PoliciesSchema = z.object({
  policies: z
    .object({
      "memory.edit": PolicyValue.default("auto"),
      "vault.write": PolicyValue.default("auto"),
      "skill.edit": PolicyValue.default("auto"),
      "skill.edit_executable": PolicyValue.default("ask"),
      "command.allowlisted": PolicyValue.default("auto"),
      "command.other": PolicyValue.default("ask"),
      /** A command that is not on the allowlist, when commands run in the Docker sandbox. */
      "command.sandboxed": PolicyValue.default("ask"),
      /** Use a tool from a tool server (mcp_servers) that is not on mcp_allowlist. */
      "mcp.call": PolicyValue.default("ask"),
      "import.user": PolicyValue.default("auto"),
      "import.agent": PolicyValue.default("ask"),
    })
    .prefault({}),
  /** A command is allowlisted when it equals an entry or starts with an entry followed by a space. */
  command_allowlist: z.array(z.string()).default([]),
  /** Tool-server tools that may be used without asking, by their name in the agent (server__tool). */
  mcp_allowlist: z.array(z.string()).default([]),
});
export type Policies = z.infer<typeof PoliciesSchema>;
export type PolicyAction = keyof Policies["policies"];

function readFrontmatter(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  return parseNote(fs.readFileSync(file, "utf8")).data;
}

export function configPath(home: Home) { return path.join(home.vault, "System", "config.md"); }
export function policiesPath(home: Home) { return path.join(home.vault, "System", "policies.md"); }

export function loadConfig(home: Home): Config {
  return ConfigSchema.parse(readFrontmatter(configPath(home)));
}

export function loadPolicies(home: Home): Policies {
  return PoliciesSchema.parse(readFrontmatter(policiesPath(home)));
}

export function loadAgentSettings(home: Home, agent: string): AgentSettings {
  return AgentSettingsSchema.parse(readFrontmatter(path.join(home.vault, "Agents", agent, "agent.md")));
}

export function listAgents(home: Home): string[] {
  const dir = path.join(home.vault, "Agents");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
}

export { readSecret, writeSecret } from "./secrets.js";
