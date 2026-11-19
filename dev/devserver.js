// Run the plugin's panels in a browser against the real backend, without the core (not used in production).
//   node dev/devserver.js [--port 4310] [--data <dir>]      then open http://127.0.0.1:4310/
// It starts a fake hub (dev/fakehub.js), the backend over stdio as the core would, and serves the panels with
// dev/mock-layr.js as /_layr/layr.js. dev/shell.html shows the threads panel with thread panels as tabs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeHub } from "./fakehub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", 4310));
const dataDir = path.resolve(arg("data", path.join(os.tmpdir(), "layr-claude-dev")));

const hub = await startFakeHub();
// --repos <file.json>: what layr__plugin_repos answers (threads on plugins and extensions), e.g. [{id, name, kind, path}].
if (arg("repos")) hub.repos.push(...JSON.parse(readFileSync(path.resolve(arg("repos")), "utf8")));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginDir, "backend", "server.js")],
  cwd: pluginDir,
  env: { ...process.env, LAYR_HUB_URL: hub.url, LAYR_HUB_TOKEN: hub.pluginToken, LAYR_DATA_DIR: dataDir, LAYR_PLUGIN_ID: "claude", LAYR_DEVICE: "dev" },
  stderr: "inherit",
});
const client = new Client({ name: "devserver", version: "1" });
await client.connect(transport);

const sse = new Set();
hub.events.on("event", (topic, data) => {
  const line = `data: ${JSON.stringify({ topic, data })}\n\n`;
  for (const res of sse) res.write(line);
});

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const coreCss = path.resolve(pluginDir, "..", "..", "core", "layr_core", "assets", "layr.css");

function sendFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === "/") return sendFile(res, path.join(here, "shell.html"));
    if (p === "/_layr/layr.js") return sendFile(res, path.join(here, "mock-layr.js"));
    if (p === "/_layr/layr.css") return existsSync(coreCss) ? sendFile(res, coreCss) : res.writeHead(200, { "content-type": "text/css" }).end("");
    if (p === "/dev/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hi\n\n");
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    if (p === "/dev/call" && req.method === "POST") {
      const { tool, args } = await body(req);
      const result = await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: 30 * 60_000 });
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
    }
    if (p === "/dev/emit" && req.method === "POST") {
      const { topic, data } = await body(req);
      hub.events.emit("event", topic, data);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: null }));
    }
    if (p === "/dev/tools" && req.method === "POST") {
      const r = await client.listTools();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: r.tools }));
    }
    const file = path.resolve(pluginDir, `.${p}`);
    if (!file.startsWith(pluginDir)) return res.writeHead(403).end();
    return sendFile(res, file);
  } catch (error) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`claude panels dev server: http://127.0.0.1:${port}/  (data ${dataDir})`));

const stop = async () => {
  await client.close().catch(() => {});
  await hub.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
