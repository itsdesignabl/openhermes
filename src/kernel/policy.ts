import type { Policies, PolicyAction, PolicyValue } from "./config.js";

export type Approver = (action: PolicyAction, detail: string) => Promise<boolean>;

export class PolicyDenied extends Error {
  constructor(action: string, reason: string) {
    super(`Not allowed (${action}): ${reason}`);
    this.name = "PolicyDenied";
  }
}

/** Decides auto / ask / deny for each kind of action, asking the user through the active channel. */
export class PolicyEngine {
  constructor(private getPolicies: () => Policies, private approver: Approver) {}

  valueOf(action: PolicyAction): PolicyValue {
    return this.getPolicies().policies[action];
  }

  isAllowlisted(command: string): boolean {
    const cmd = command.trim();
    // Chaining or redirection could smuggle a second command past a prefix match.
    if (/[;&|<>`\n]|\$\(/.test(cmd)) return false;
    return this.getPolicies().command_allowlist.some((entry) => {
      const e = entry.trim();
      return e.length > 0 && (cmd === e || cmd.startsWith(e + " "));
    });
  }

  async check(action: PolicyAction, detail: string): Promise<void> {
    const value = this.valueOf(action);
    if (value === "auto") return;
    if (value === "deny") throw new PolicyDenied(action, "policy is set to deny");
    const ok = await this.approver(action, detail);
    if (!ok) throw new PolicyDenied(action, "the user declined");
  }
}
