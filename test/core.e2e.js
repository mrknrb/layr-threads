// The panels against the real core (`layr serve`), as the shell would host them: a shell WebSocket creates the
// threads panel, `shell:open` notifications open the panels it asks for. Real Claude (haiku, a tiny prompt).
//   layr serve --port 4391 --token dev --home <tmp> --link plugins/threads
//   PLAYWRIGHT_DIR=<folder with playwright> node test/core.e2e.js [ws://127.0.0.1:4391/_layr/ws?token=dev] [outDir]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.resolve(here, ".."), "package.json"));
const { chromium } = require("playwright");
const wsUrl = process.argv[2] || "ws://127.0.0.1:4391/_layr/ws?token=dev";
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), "layr-claude-core-shots"));
mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Shell connection
const ws = new WebSocket(wsUrl);
let nextId = 1;
const waiting = new Map();
const opened = [];
const notes = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "event") {
    const { topic, data } = msg.params;
    if (topic === "shell:open") opened.push(data);
    if (topic === "shell:notify") notes.push(data);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-core-"));
const repo = path.join(tmp, "core-demo");
execFileSync("git", ["init", "-q", repo]);
writeFileSync(path.join(repo, "README.md"), "# Demo\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

const browser = await chromium.launch();
const errors = [];
try {
  const state = await rpc("shell.state", {});
  const claude = state.plugins.find((p) => p.id === "threads");
  check(Boolean(claude), "threads plugin installed in the core", claude ? `${claude.version} backend ${claude.backend?.status}` : "missing");
  check(state.commands.some((c) => (c.id ?? "").endsWith("make-plugin")), "commands registered", state.commands.filter((c) => String(c.id).startsWith("threads.")).map((c) => c.id).join(", "));

  const panel = await rpc("panels.create", { plugin: "threads", panel: "threads" });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(panel.url);
  await page.locator(".empty .btn.primary, .project-head").first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(out, "c1-threads.png") });
  if (await page.locator(".empty .btn.primary").count()) await page.locator(".empty .btn.primary").click();
  else await page.locator("#add-project").click();
  await page.getByPlaceholder("Folder path").fill(repo);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".project-head .name", { hasText: "core-demo" }).waitFor();
  await page.locator("textarea").fill("Create a file hi.txt containing exactly: hello\nUse the Write tool, then reply with one word: done.");
  await page.locator("select").nth(1).selectOption("haiku");
  await page.getByRole("button", { name: "Start" }).click();

  // The threads panel asks the shell to open the thread panel.
  const start = Date.now();
  while (!opened.length && Date.now() - start < 30_000) await new Promise((r) => setTimeout(r, 200));
  check(opened.length > 0 && opened[0].panel === "thread", "shell:open for the thread panel", opened[0]?.title);
  const tpage = await browser.newPage({ viewport: { width: 1000, height: 860 } });
  tpage.on("pageerror", (e) => errors.push(e.message));
  tpage.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await tpage.goto(opened[0].url);
  await tpage.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 180_000 });
  await tpage.screenshot({ path: path.join(out, "c2-approval.png") });
  await page.screenshot({ path: path.join(out, "c3-threads-waiting.png") });
  await tpage.getByRole("button", { name: "Allow", exact: true }).click();
  await tpage.locator(".turn-end").first().waitFor({ timeout: 180_000 });
  await tpage.waitForTimeout(800);
  await tpage.screenshot({ path: path.join(out, "c4-done.png") });
  const file = path.join(repo, "hi.txt");
  check(existsSync(file) && readFileSync(file, "utf8").trim() === "hello", "hi.txt written through the real core");
  const title = (await rpc("panels.get", { instance: opened[0].instance })).title;
  check(/hi\.txt/i.test(title ?? ""), "panel title set from the first prompt", title);

  // Claude can use the hub's tools through the agent token.
  await tpage.locator("#input").fill("Call the mcp__layr__layr__plugins_list tool and reply with only the number of plugins it lists.");
  await tpage.locator("#input").press("Enter");
  // MCP tools ask first in the default mode: allow them as they come.
  for (const until = Date.now() + 180_000; Date.now() < until && !(await tpage.locator(".turn-end").nth(1).count()); ) {
    const allow = tpage.getByRole("button", { name: "Allow", exact: true });
    if (await allow.count()) await allow.first().click().catch(() => {});
    await tpage.waitForTimeout(500);
  }
  const lastTool = await tpage.locator("details.tool .name").last().textContent();
  check(/plugins_list/.test(lastTool ?? ""), "Claude called a layr hub tool", lastTool);
  await tpage.screenshot({ path: path.join(out, "c5-hub-tool.png") });
} catch (error) {
  failures++;
  console.error("ERROR", error);
} finally {
  await browser.close();
  ws.close();
}
check(!errors.length, "no page errors", errors.slice(0, 5).join(" | "));
console.log(`screenshots in ${out}`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
