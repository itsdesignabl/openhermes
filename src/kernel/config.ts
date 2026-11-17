import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseNote } from "../vault/frontmatter.js";
import type { Home } from "./home.js";

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
      "import.user": PolicyValue.default("auto"),
      "import.agent": PolicyValue.default("ask"),
    })
    .prefault({}),
  /** A command is allowlisted when it equals an entry or starts with an entry followed by a space. */
  command_allowlist: z.array(z.string()).default([]),
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

export function readSecret(home: Home, name: string): string | undefined {
  if (!name) return undefined;
  const file = path.join(home.secrets, "keys.json");
  if (!fs.existsSync(file)) return undefined;
  const keys = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  return keys[name];
}
