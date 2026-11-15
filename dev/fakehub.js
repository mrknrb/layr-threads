// A tiny stand-in for the core's MCP hub (docs/ARCHITECTURE.md > The MCP hub), for tests and the dev server:
// streamable HTTP at /mcp with the layr__* tools a backend uses, plus one demo plugin tool for agents.
// Not loaded in production.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { z } from "zod";

export async function startFakeHub({ port = 0, pluginToken = "plugin-token" } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const emitted = [];
  const data = new Map();
  const linked = [];
  const notifications = [];
  const opened = [];
  const agentTokens = new Set();
  const calls = [];

  function makeServer(who) {
    const server = new McpServer({ name: "layr-fake-hub", version: "0.0.1" });
    const reply = (value) => ({
      content: [{ type: "text", text: JSON.stringify(value ?? null) }],
      ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    });
    const t = (name, shape, fn) =>
      server.registerTool(name, { description: name, inputSchema: shape }, async (args) => {
        calls.push({ who, name, args });
        return reply(await fn(args));
      });
    t("layr__events_emit", { topic: z.string(), data: z.any() }, ({ topic, data: d }) => {
      emitted.push({ topic, data: d, at: Date.now() });
      events.emit("event", topic, d);
      return null;
    });
    t("layr__notify", { text: z.string(), kind: z.string().optional() }, (a) => {
      notifications.push(a);
      return null;
    });
    t("layr__panels_open", { plugin: z.string().optional(), panel: z.string(), params: z.any().optional() }, (a) => {
      opened.push(a);
      events.emit("open", a);
      return { instance: `p_fake${opened.length}` };
    });
    t("layr__data_get", { key: z.string() }, ({ key }) => data.get(key) ?? null);
    t("layr__data_set", { key: z.string(), value: z.any() }, ({ key, value }) => (data.set(key, value), null));
    t("layr__data_delete", { key: z.string() }, ({ key }) => (data.delete(key), null));
    t("layr__data_list", { prefix: z.string().optional(), limit: z.number().optional() }, ({ prefix = "", limit = 100 }) => ({
      items: [...data.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([key, value]) => ({ key, value })),
    }));
    t("layr__plugins_list", {}, () => ({ plugins: [{ id: "claude", name: "Claude Code" }, { id: "demo", name: "Demo" }] }));
    if (who === "plugin") {
      t("layr__agent_token", { label: z.string().optional() }, () => {
        const token = `agent-${randomUUID()}`;
        agentTokens.add(token);
        return { token };
      });
      t("layr__packages_link", { path: z.string() }, ({ path }) => {
        linked.push(path);
        return { id: path.split(/[\\/]/).pop(), name: path.split(/[\\/]/).pop(), version: "0.1.0-dev", linked: true, path };
      });
    } else {
      t("demo__echo", { text: z.string() }, ({ text }) => ({ echoed: text }));
    }
    return server;
  }

  const sessions = new Map();
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const who = auth === pluginToken ? "plugin" : agentTokens.has(auth) ? "agent" : null;
    if (!who) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad token" }));
      return;
    }
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    }
    const sid = req.headers["mcp-session-id"];
    let transport = sid ? sessions.get(sid) : null;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No session" }, id: null }),
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await makeServer(who).connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const actual = httpServer.address().port;
  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    port: actual,
    pluginToken,
    events,
    emitted,
    data,
    linked,
    notifications,
    opened,
    calls,
    close: () =>
      new Promise((resolve) => {
        for (const t of sessions.values()) t.close().catch(() => {});
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
