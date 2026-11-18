import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Home } from "../kernel/home.js";

interface Entry {
  channel: string;
  sender: string;
  name: string;
  at: string;
}
interface Store {
  approved: Record<string, Entry>;
  pending: Record<string, Entry>;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes
const CODE_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 20;

/**
 * Who may talk to the agent. Read from disk on every check, so `openhermes pair approve`
 * in another terminal takes effect in the running gateway immediately.
 */
export class Pairing {
  private file: string;
  constructor(home: Home) {
    this.file = path.join(home.data, "gateway", "pairing.json");
  }

  private load(): Store {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8")) as Store;
      return { approved: s.approved ?? {}, pending: s.pending ?? {} };
    } catch {
      return { approved: {}, pending: {} };
    }
  }

  private save(store: Store): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, this.file);
  }

  isApproved(channel: string, sender: string): boolean {
    return `${channel}:${sender}` in this.load().approved;
  }

  /** The code to show an unknown sender. The same sender gets the same code until it expires. */
  request(channel: string, sender: string, name: string): string | null {
    const store = this.load();
    const now = Date.now();
    for (const [code, e] of Object.entries(store.pending)) {
      if (now - Date.parse(e.at) > CODE_TTL_MS) delete store.pending[code];
    }
    for (const [code, e] of Object.entries(store.pending)) {
      if (e.channel === channel && e.sender === sender) return code;
    }
    if (Object.keys(store.pending).length >= MAX_PENDING) {
      this.save(store);
      return null;
    }
    const bytes = crypto.randomBytes(8);
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    store.pending[code] = { channel, sender, name, at: new Date().toISOString() };
    this.save(store);
    return code;
  }

  approve(code: string): Entry | null {
    const store = this.load();
    const key = code.trim().toUpperCase();
    const entry = store.pending[key];
    if (!entry || Date.now() - Date.parse(entry.at) > CODE_TTL_MS) return null;
    delete store.pending[key];
    store.approved[`${entry.channel}:${entry.sender}`] = { ...entry, at: new Date().toISOString() };
    this.save(store);
    return entry;
  }

  revoke(id: string): boolean {
    const store = this.load();
    if (!(id in store.approved)) return false;
    delete store.approved[id];
    this.save(store);
    return true;
  }

  list(): Store {
    return this.load();
  }
}
