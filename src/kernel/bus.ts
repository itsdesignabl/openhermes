/** Typed events passed between the kernel and plugins. */
export interface Events {
  "turn.started": { sessionId: string; text: string };
  "turn.finished": { sessionId: string; text: string; steps: number };
  "assistant.delta": { sessionId: string; text: string };
  "assistant.message": { sessionId: string; text: string };
  "tool.requested": { sessionId: string; id: string; name: string; args: unknown };
  "tool.finished": { sessionId: string; id: string; name: string; ok: boolean; summary: string };
  "approval.requested": { sessionId: string; action: string; detail: string };
  "approval.resolved": { sessionId: string; action: string; approved: boolean };
  "file.changed": { path: string; by: "agent" | "user" };
  "config.reloaded": { ok: boolean; error?: string };
  "proposal.created": { id: string; title: string; file: string; agent: string; conversation?: string };
  "proposal.resolved": { id: string; title: string; outcome: "applied" | "rejected" | "failed"; message: string };
  "learning.reflected": { session: string; applied: string[]; pending: string[]; skipped: string[] };
  "log": { level: "info" | "warn" | "error"; message: string };
}

export type EventName = keyof Events;
type Handler<K extends EventName> = (payload: Events[K]) => void | Promise<void>;

export class Bus {
  private handlers = new Map<EventName, Set<Handler<any>>>();

  on<K extends EventName>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Handlers run in registration order. A failing handler is logged and does not stop the others. */
  async emit<K extends EventName>(name: K, payload: Events[K]): Promise<void> {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        await fn(payload);
      } catch (err) {
        if (name !== "log") {
          await this.emit("log", { level: "error", message: `handler for ${name} failed: ${(err as Error).message}` });
        }
      }
    }
  }
}
