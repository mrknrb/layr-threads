// End-to-end test with real Claude Code (small: haiku, tiny prompts) of a thread whose plugin folder layr moved
// (backend/moved.js): the thread is started by a backend on an older core, in `~/layr-plugins/<id>`; then the folder
// becomes `<home>/packages/<id>/mine` and is listed in `<home>/moved-plugins.json`, as a core with one folder for
// each plugin does at its start; a backend on that core then goes on in the same Claude session, in the new folder:
// Claude remembers what was said before the move, and going back (a fork of the session at an earlier message) works
// there too. Claude Code's transcript under the old folder's name is never touched.
// Run: node test/movedSession.test.js   (uses this PC's Claude Code sign-in, as backend.test.js does)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeHub } from "../dev/fakehub.js";
import { sessionFile } from "../backend/engine.js";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.LAYR_TEST_MODEL || "haiku";
const WORD = "PLUM-4821";
let failures = 0;

function step(name) {
  console.log(`\n=== ${name}`);
}
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
  return ok;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-moved-real-"));
const home = path.join(tmp, "home");
const packages = path.join(home, "packages");
const old = path.join(tmp, "layr-plugins");
const from = path.join(old, "word-keeper");
const to = path.join(packages, "word-keeper", "mine");
const dataDir = path.join(tmp, "data");
mkdirSync(packages, { recursive: true });
mkdirSync(from, { recursive: true });
// A plugin as the plugin maker leaves it: its own repository with a layr.json.
writeFileSync(path.join(from, "layr.json"), `${JSON.stringify({ id: "word-keeper", name: "Word keeper", version: "0.1.0" }, null, 2)}\n`);
execFileSync("git", ["init", "-q", "-b", "main", from]);
execFileSync("git", ["-C", from, "add", "."]);
execFileSync("git", ["-C", from, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "New plugin word-keeper"]);
console.log(`temp: ${tmp}`);

const hub = await startFakeHub();
let client = null;
/** The backend as a core starts it; `layout2`: a core with one folder for each plugin (it says where its packages are). */
async function startBackend({ layout2 }) {
  const env = { ...process.env };
  for (const key of ["LAYR_PACKAGES", "LAYR_HOME"]) delete env[key];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginDir, "backend", "server.js")],
    cwd: pluginDir,
    env: {
      ...env, LAYR_HUB_URL: hub.url, LAYR_HUB_TOKEN: hub.pluginToken, LAYR_DATA_DIR: dataDir, LAYR_PLUGIN_ID: "threads",
      LAYR_DEVICE: "test", LAYR_HOME: home, LAYR_CLAUDE_PLUGINS_DIR: old, LAYR_CLAUDE_BUILD_IMPORT: "0",
      ...(layout2 ? { LAYR_PACKAGES: packages } : {}),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => {
    const s = String(d);
    if (process.env.LAYR_TEST_VERBOSE || /error|fail|uncaught|moved/i.test(s)) process.stderr.write(`  [backend] ${s}`);
  });
  client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60_000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}
async function runToEnd(thread, timeoutSec = 240) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const w = await call("thread_wait", { thread, timeoutSec: Math.max(5, Math.round((deadline - Date.now()) / 1000)) });
    if (w.thread.status === "waiting") {
      const st = await call("thread_status", { thread });
      for (const a of st.approvals) await call("answer_approval", { thread, requestId: a.requestId, decision: "deny", message: "No tools here" });
      continue;
    }
    return w;
  }
}

try {
  step("a thread in the plugin's old folder (an older core)");
  await startBackend({ layout2: false });
  const where = await call("plugins_folder");
  check(where.folder === old && where.layout === undefined, "an older core: plugins go in the old folder", where);
  const { project } = await call("project_add", { path: from, defaultModel: MODEL, defaultEffort: "low" });
  const { thread } = await call("thread_start", {
    project: project.id,
    prompt: `Remember this word for later: ${WORD}. Use no tools. Reply with one word: OK.`,
  });
  const end1 = await runToEnd(thread.id);
  check(end1.thread.status === "done" && end1.thread.cwd === from, "the first turn ended, in the old folder",
    `${end1.thread.status} ${end1.thread.error ?? ""}`);
  await call("thread_send", { thread: thread.id, text: "Now reply with one word: READY. Use no tools." });
  const end2 = await runToEnd(thread.id);
  check(end2.thread.status === "done", "a second turn", `${end2.thread.status} ${end2.last ?? ""}`);
  const sessionId = end2.thread.sessionId;
  const oldFile = sessionFile(from, sessionId);
  check(existsSync(oldFile), "Claude Code keeps the session under the old folder's name", oldFile);
  await client.close();

  step("layr moves the folder (a core with one folder for each plugin, at its start)");
  mkdirSync(path.dirname(to), { recursive: true });
  // The old backend's Claude Code process may still be closing in the folder.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      break;
    } catch (error) {
      if (i > 60) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  writeFileSync(path.join(home, "moved-plugins.json"), `${JSON.stringify([{ id: "word-keeper", from, to, at: Date.now() }], null, 2)}\n`);
  const oldText = readFileSync(oldFile, "utf8");
  check(!existsSync(from) && existsSync(path.join(to, "layr.json")), "the plugin is in packages/<id>/mine");

  step("the backend starts on that core: the thread follows, with its session");
  await startBackend({ layout2: true });
  const where2 = await call("plugins_folder");
  check(where2.layout === 2 && where2.folder === packages, "plugins go in their own folders now", where2);
  const st = (await call("thread_status", { thread: thread.id })).thread;
  check(st.cwd === to && st.folderGone === false && st.workspace.path === to, "the thread works in the new folder", st.cwd);
  check(st.sessionId === sessionId, "with the same Claude session", st.sessionId);
  const pl = await call("projects_list");
  check(pl.projects.length === 1 && pl.projects[0].path === to && pl.projects[0].exists, "its project moved too", pl.projects.map((p) => p.path));
  const tr = await call("thread_transcript", { thread: thread.id });
  const said = tr.entries.filter((e) => e.type === "system" && e.subtype === "folder_moved");
  check(said.length === 1 && said[0].session === "carried", "the thread says its folder moved, once", said.map((e) => `${e.session}: ${e.text}`));
  const newFile = sessionFile(to, sessionId);
  check(existsSync(newFile) && readFileSync(newFile, "utf8") === oldText, "Claude's session is copied under the new folder's name");

  await call("thread_send", { thread: thread.id, text: "Which word did I ask you to remember at the start? Use no tools. Reply with the word only." });
  const end3 = await runToEnd(thread.id);
  check(end3.thread.status === "done" && end3.last?.includes(WORD), "Claude remembers the conversation from before the move", end3.last);
  check(end3.thread.sessionId === sessionId, "in the same session (resumed, not started over)", end3.thread.sessionId);
  const tr3 = await call("thread_transcript", { thread: thread.id });
  check(!tr3.entries.some((e) => e.type === "system" && /session was gone|started a new one/i.test(e.text ?? "")),
    "no new session was needed");
  check(readFileSync(oldFile, "utf8") === oldText, "Claude Code's old transcript is untouched");
  const newText = readFileSync(newFile, "utf8");
  check(newText.length > oldText.length && newText.startsWith(oldText), "it writes on in the copy");
  check(newText.includes("[layr: this plugin's folder moved since your last turn"), "and was told that the folder moved");

  step("going back works in the moved session");
  const ready = tr3.entries.find((e) => e.type === "user" && /READY/.test(e.text ?? ""));
  const back = await call("thread_go_back", { thread: thread.id, seq: ready.seq });
  check(/READY/.test(back.text), "went back to before the second message", back.text);
  await call("thread_send", { thread: thread.id, text: "Which word did I ask you to remember? Use no tools. Reply with the word only." });
  const end4 = await runToEnd(thread.id);
  check(end4.thread.status === "done" && end4.last?.includes(WORD), "the fork of the moved session remembers the word", end4.last);
  check(end4.thread.sessionId !== sessionId, "in a fork of the session", `${sessionId} → ${end4.thread.sessionId}`);
  const tr4 = await call("thread_transcript", { thread: thread.id });
  check(!tr4.entries.some((e) => e.type === "system" && /didn't work|session was gone/i.test(e.text ?? "")),
    "the fork was made from Claude Code's own transcript, not from a retelling");
  check(existsSync(sessionFile(to, end4.thread.sessionId)), "the fork is kept under the new folder's name");
} catch (error) {
  failures++;
  console.error("ERROR", error);
} finally {
  await client?.close().catch(() => {});
  await hub.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
