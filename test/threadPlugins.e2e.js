// A thread with a plugin list against the real backend and real Claude (haiku, a tiny prompt), on a stand-in hub:
// a mention puts a plugin on the list to read, Claude asks to change another one and waits for the answer, writes
// there, is refused in the read-only one, and the turn's change is committed into the history beside the folder.
// Not in CI (it uses your Claude plan). Run: node test/threadPlugins.e2e.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeHub } from "../dev/fakehub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-tp-e2e-"));
const packages = path.join(tmp, "home", "packages");
process.env.LAYR_PACKAGES = packages;
const { initPluginRepo } = await import("../backend/autoCommit.js");

async function plugin(id, name) {
  const dir = path.join(packages, id, "mine");
  mkdirSync(path.join(dir, "panels"), { recursive: true });
  writeFileSync(path.join(dir, "layr.json"), JSON.stringify({ id, name, version: "0.1.0", layr: "^0.1", permissions: ["data"],
    panels: [{ id: "main", title: name, page: "panels/main.html" }] }, null, 2));
  writeFileSync(path.join(dir, "panels", "main.html"), `<h1>${name}</h1>\n`);
  await initPluginRepo(dir, id, { outside: true });
  return dir;
}
const alpha = await plugin("alpha", "Alpha");
const beta = await plugin("beta", "Beta");
const hub = await startFakeHub();
hub.repos.push(
  { id: "alpha", name: "Alpha", kind: "made", path: alpha, linked: true, version: "0.1.0" },
  { id: "beta", name: "Beta", kind: "made", path: beta, linked: true, version: "0.1.0" },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pluginDir, "backend", "server.js")],
  cwd: pluginDir,
  env: { ...process.env, LAYR_HUB_URL: hub.url, LAYR_HUB_TOKEN: hub.pluginToken, LAYR_DATA_DIR: path.join(tmp, "data"),
    LAYR_PLUGIN_ID: "claude", LAYR_PACKAGES: packages },
  stderr: "pipe",
});
const client = new Client({ name: "e2e", version: "1" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if (r.isError) throw new Error(r.content?.map((c) => c.text).join("\n"));
  return r.structuredContent;
};

try {
  const prompt = "This is a test; be very brief. Do exactly these steps: 1) Read @beta's layr.json. 2) Ask to change the " +
    "plugin alpha with mcp__thread__plugin_change (why: 'add hello.txt'). 3) Once allowed, create hello.txt in alpha's " +
    "folder containing the word hi. 4) Try to create x.txt in beta's folder with the Write tool (it should be refused). " +
    "Then reply in one sentence.";
  const started = await call("thread_start", { target: { kind: "plugins" }, prompt, model: "haiku",
    permissionMode: "bypassPermissions" });
  const id = started.thread.id;
  check(started.plugins.length === 1 && started.plugins[0].id === "beta" && started.plugins[0].mode === "read",
    "the mention in the first message: beta, to read", started.plugins);
  check(!existsSync(path.join(started.folder, ".git")) && started.folder.includes("work"), "it starts in an empty folder", started.folder);
  // Answer Claude's request when it comes.
  let asked = null;
  const deadline = Date.now() + 5 * 60_000;
  let status = null;
  while (Date.now() < deadline) {
    const w = await call("thread_wait", { thread: id, timeoutSec: 20 });
    status = w.thread.status;
    if (status === "waiting") {
      const { approvals } = await call("approvals_list");
      const mine = approvals.find((a) => a.thread === id || a.threadId === id) ?? approvals[0];
      const entry = mine?.approval ?? mine;
      asked = entry;
      await call("answer_approval", { thread: id, requestId: entry.requestId, decision: "allow" });
      continue;
    }
    if (status !== "running" && status !== "starting") break;
  }
  check(asked?.kind === "plugin" && /Alpha/.test(asked.title ?? ""), "Claude asked to change alpha", asked);
  check(status === "done", "the turn ended", status);
  await new Promise((r) => setTimeout(r, 3000)); // the commit after the turn
  check(readFileSync(path.join(alpha, "hello.txt"), "utf8").includes("hi"), "it wrote in alpha");
  check(!existsSync(path.join(beta, "x.txt")), "the read-only beta stayed as it was");
  const log = execFileSync("git", ["--git-dir", path.join(packages, "alpha", "repo.git"), "log", "-1", "--format=%s%n%b"],
    { encoding: "utf8" });
  check(log.includes(`Layr-Thread: ${id}`), "the turn was committed into alpha's history, with the thread", log.split("\n")[0]);
  const t = (await call("thread_plugins", { thread: id })).plugins;
  check(t.find((p) => p.id === "alpha")?.mode === "change" && t.find((p) => p.id === "beta")?.mode === "read", "the list", t);
  const tr = await call("thread_transcript", { thread: id, limit: 400 });
  const refused = tr.entries.some((e) => e.type === "tool_result" && /only read Beta/.test(JSON.stringify(e)));
  check(refused, "the write into beta was refused by the guard");
  check(tr.entries.some((e) => e.type === "system" && e.subtype === "saved" && e.plugin === "alpha"), "a saved entry for alpha");
} catch (error) {
  check(false, "the run", error.message);
} finally {
  await client.close().catch(() => {});
  await hub.close?.();
}
console.log(failures ? `\n${failures} check(s) failed (files in ${tmp})` : "\nall checks passed");
process.exit(failures ? 1 : 0);
