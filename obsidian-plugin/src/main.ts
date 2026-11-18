import { spawn } from "node:child_process";
import path from "node:path";
import { FileSystemAdapter, ItemView, MarkdownRenderer, Notice, Plugin, WorkspaceLeaf, setIcon } from "obsidian";
import { GatewayDown, HermesClient, type InboxEntry, type TurnEvent } from "./client";

const VIEW = "openhermes-chat";

export default class OpenHermesPlugin extends Plugin {
  client!: HermesClient;

  async onload() {
    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    this.client = new HermesClient(path.dirname(vaultPath));
    this.registerView(VIEW, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("message-circle", "OpenHermes chat", () => void this.openChat());
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.openChat() });
    this.addCommand({
      id: "new-conversation",
      name: "Start a new conversation",
      callback: async () => (await this.openChat())?.newConversation(),
    });
  }

  async openChat(): Promise<ChatView | undefined> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : undefined;
  }

  /** Starts the gateway in the background with the program in the home folder's runtime. */
  startGateway(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cli = path.join(this.client.home, "runtime", "dist", "src", "cli.js");
      const child = spawn("node", [cli, "gateway", "start", "--home", this.client.home], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (err) => reject(new Error(`Could not run Node.js (${err.message}). Start the gateway from a terminal: openhermes gateway start`)));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(out.trim().split("\n").pop() || "The gateway did not start."))));
    });
  }
}

class ChatView extends ItemView {
  private log!: HTMLElement;
  private live?: HTMLElement;
  private liveText = "";
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private inboxEl!: HTMLElement;
  private banner!: HTMLElement;
  private stop?: () => void;
  private agent = "main";
  private timer?: number;

  constructor(leaf: WorkspaceLeaf, private plugin: OpenHermesPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW;
  }
  getDisplayText() {
    return "OpenHermes";
  }
  getIcon() {
    return "message-circle";
  }

  private get client() {
    return this.plugin.client;
  }
  private get conversationKey() {
    return `${this.agent}:obsidian`;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("openhermes");

    const header = root.createDiv("openhermes-header");
    this.statusEl = header.createSpan({ cls: "openhermes-status", text: "Connecting…" });
    const fresh = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Start a new conversation" } });
    setIcon(fresh, "plus");
    fresh.onclick = () => void this.newConversation();

    this.banner = root.createDiv("openhermes-banner");
    this.inboxEl = root.createDiv("openhermes-inbox");
    this.log = root.createDiv("openhermes-log");

    const form = root.createDiv("openhermes-form");
    this.input = form.createEl("textarea", { attr: { rows: "2", placeholder: "Message your agent. Enter sends, Shift+Enter adds a line." } });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.sendButton = form.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.onclick = () => (this.stop ? this.stop() : void this.submit());

    await this.connect(true);
    this.timer = window.setInterval(() => void this.connect(false), 30_000);
    this.registerInterval(this.timer);
  }

  /** Checks the gateway and refreshes the status line and the Inbox. Loads earlier messages on first contact. */
  private async connect(loadHistory: boolean) {
    this.banner.empty();
    if (!this.client.isHome()) {
      this.statusEl.setText("Not available");
      this.banner.createEl("p", { text: "This vault is not inside an OpenHermes home folder, so there is no agent to talk to here." });
      this.setEnabled(false);
      return;
    }
    try {
      const status = await this.client.status();
      this.agent = status.default_agent || "main";
      this.statusEl.setText(status.model);
      this.setEnabled(true);
      if (loadHistory) {
        this.log.empty();
        for (const m of await this.client.conversation(this.conversationKey)) await this.addMessage(m.role === "user" ? "user" : "agent", m.text);
      }
      await this.refreshInbox();
    } catch (err) {
      this.statusEl.setText("Gateway not running");
      this.setEnabled(false);
      this.inboxEl.empty();
      const p = this.banner.createEl("p", { text: err instanceof GatewayDown ? "The OpenHermes gateway is not running." : (err as Error).message });
      const start = p.createEl("button", { text: "Start it" });
      start.onclick = async () => {
        start.disabled = true;
        start.setText("Starting…");
        try {
          await this.plugin.startGateway();
          await this.connect(true);
        } catch (e) {
          new Notice((e as Error).message, 10_000);
          start.disabled = false;
          start.setText("Start it");
        }
      };
    }
  }

  private setEnabled(on: boolean) {
    this.input.disabled = !on;
    this.sendButton.disabled = !on;
  }

  private async refreshInbox() {
    let items: InboxEntry[] = [];
    try {
      items = await this.client.inbox();
    } catch {
      return;
    }
    this.inboxEl.empty();
    if (!items.length) return;
    this.inboxEl.createEl("div", { cls: "openhermes-inbox-title", text: `Waiting for your approval (${items.length})` });
    for (const item of items) {
      const row = this.inboxEl.createDiv("openhermes-inbox-item");
      const title = row.createEl("a", { text: item.title });
      title.onclick = () => void this.app.workspace.openLinkText(item.file, "", true);
      const buttons = row.createDiv("openhermes-buttons");
      const decide = async (approve: boolean) => {
        try {
          new Notice(await this.client.resolve(item.id, approve));
        } catch (e) {
          new Notice((e as Error).message, 10_000);
        }
        await this.refreshInbox();
      };
      buttons.createEl("button", { text: "Approve", cls: "mod-cta" }).onclick = () => void decide(true);
      buttons.createEl("button", { text: "Reject" }).onclick = () => void decide(false);
    }
  }

  private async addMessage(kind: "user" | "agent" | "tool" | "note" | "error", text: string): Promise<HTMLElement> {
    const el = this.log.createDiv(`openhermes-msg openhermes-${kind}`);
    if (kind === "agent") await MarkdownRenderer.render(this.app, text, el, "", this);
    else el.setText(text);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  /** Shows an approval card and resolves with the user's choice. */
  private askApproval(e: TurnEvent): void {
    const card = this.log.createDiv("openhermes-msg openhermes-approval");
    card.createEl("strong", { text: "Approval needed" });
    card.createEl("div", { text: String(e.detail) });
    const buttons = card.createDiv("openhermes-buttons");
    const answer = async (value: boolean | "always", label: string) => {
      buttons.remove();
      card.createEl("em", { text: label });
      await this.client.approve(String(e.id), value).catch((err) => new Notice((err as Error).message));
    };
    buttons.createEl("button", { text: "Allow", cls: "mod-cta" }).onclick = () => void answer(true, "Allowed");
    if (/^(command\.|mcp\.)/.test(String(e.action))) buttons.createEl("button", { text: "Always allow" }).onclick = () => void answer("always", "Allowed from now on");
    buttons.createEl("button", { text: "Decline" }).onclick = () => void answer(false, "Declined");
    this.log.scrollTop = this.log.scrollHeight;
  }

  private onEvent = (e: TurnEvent) => {
    if (e.type === "delta") {
      this.liveText += e.text;
      this.live ??= this.log.createDiv("openhermes-msg openhermes-agent openhermes-live");
      this.live.setText(this.liveText);
      this.log.scrollTop = this.log.scrollHeight;
    } else if (e.type === "message") {
      this.live?.remove();
      this.live = undefined;
      this.liveText = "";
      void this.addMessage("agent", e.text);
    } else if (e.type === "tool_finished") void this.addMessage("tool", `${e.ok ? "✓" : "✗"} ${e.name}  ${e.summary}`);
    else if (e.type === "approval") this.askApproval(e);
    else if (e.type === "log" && e.level !== "info") void this.addMessage("note", e.message);
  };

  private async submit() {
    const text = this.input.value.trim();
    if (!text || this.stop) return;
    this.input.value = "";
    await this.addMessage("user", text);
    this.sendButton.setText("Stop");
    const turn = this.client.turn({ text, conversation: this.conversationKey, agent: this.agent }, this.onEvent);
    this.stop = turn.stop;
    try {
      await turn.done;
    } catch (err) {
      await this.addMessage("error", (err as Error).message);
      if (err instanceof GatewayDown) await this.connect(false);
    } finally {
      this.live?.remove();
      this.live = undefined;
      this.liveText = "";
      this.stop = undefined;
      this.sendButton.setText("Send");
      void this.refreshInbox();
      this.input.focus();
    }
  }

  async newConversation() {
    try {
      await this.client.newConversation(this.conversationKey);
      this.log.empty();
      await this.addMessage("note", "New conversation started.");
    } catch (err) {
      new Notice((err as Error).message);
    }
  }
}
