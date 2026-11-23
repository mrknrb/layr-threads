// The backend's link to the core's MCP hub (docs/ARCHITECTURE.md > The MCP hub): events to panels, the agent
// token that gives Claude every plugin's tools, and packages_link for the plugin maker.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errorMessage, log } from "./util.js";

export class Hub {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.client = null;
    this.connecting = null;
    /** Thread id → its agent token (each thread asks for its own, labelled with its id). */
    this.agentTokens = new Map();
    /** Thread id → the title its token was last given (asked again when the title changes). */
    this.agentTitles = new Map();
    this.warned = false;
  }

  get available() {
    return Boolean(this.url && this.token);
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.available) throw new Error("No hub: LAYR_HUB_URL and LAYR_HUB_TOKEN are not set");
    this.connecting ??= (async () => {
      const client = new Client({ name: "layr-plugin-threads", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
      });
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** Call a hub tool; gives its structured content, or its text parsed as JSON when it is JSON. */
  async call(name, args = {}) {
    let client = await this.connect();
    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      // The core may have restarted its HTTP session: connect once more.
      this.client = null;
      client = await this.connect();
      result = await client.callTool({ name, arguments: args });
    }
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(text || `${name} failed`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Fire and forget: an event for the panels. Failures are logged once, not thrown. */
  emit(topic, data) {
    if (!this.available) return;
    this.call("layr__events_emit", { topic, data }).catch((error) => {
      if (!this.warned) {
        this.warned = true;
        log(`events_emit failed (further failures not logged): ${errorMessage(error)}`);
      }
    });
  }

  notify(text, kind = "info") {
    if (!this.available) return;
    this.call("layr__notify", { text, kind }).catch(() => {});
  }

  /**
   * The token a thread's Claude gets for the hub (it lives until the core restarts; the backend restarts with it).
   * Its label is the thread's id: plugins see it in a tool call's `_meta["layr/caller"].label` (docs/ARCHITECTURE.md
   * › The MCP hub), so they know which thread called. Its title is the thread's title, which the shell shows when it
   * asks the user whether the thread may use a plugin's tools; a new title is told to the core by asking again (the
   * new token is kept; the old one stays valid for a session already running).
   */
  async getAgentToken(threadId, title) {
    const label = String(threadId || "Claude Code threads");
    const name = String(title ?? "").trim();
    const known = this.agentTokens.get(label);
    if (known && (!name || this.agentTitles.get(label) === name)) return known;
    const result = await this.call("layr__agent_token", name ? { label, title: name } : { label });
    const token = typeof result === "string" ? result : (result?.token ?? null);
    if (!token) throw new Error("layr__agent_token gave no token");
    this.agentTokens.set(label, token);
    if (name) this.agentTitles.set(label, name);
    return token;
  }

  /** One of this plugin's settings (layr.json `settings`): the user's value or its default. */
  async settingsGet(id) {
    if (!this.available) return undefined;
    const value = await this.call("layr__settings_get", { id });
    return value && typeof value === "object" && "result" in value ? value.result : value;
  }

  async linkPackage(dir) {
    return this.call("layr__packages_link", { path: dir });
  }

  async openPanel(panel, params) {
    return this.call("layr__panels_open", { plugin: "threads", panel, params });
  }

  async close() {
    try {
      await this.client?.close();
    } catch {
      // closing anyway
    }
  }
}
