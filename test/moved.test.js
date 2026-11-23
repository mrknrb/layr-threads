// Unit tests without Claude (0.6.0): plugin folders layr moved (backend/moved.js). A core with one folder for each
// plugin moves `~/layr-plugins/<id>` to `<home>/packages/<id>/mine` and lists it in `<home>/moved-plugins.json`; the
// projects and threads that were in the old folder follow, once, Claude Code's sessions are copied under the new
// folder's name (never changed, never removed), the thread says so, and Claude is told with its next message. Also
// the backend itself: it does this when it starts, and plugins_folder says where plugins go, on an older core too.
// Real git for the worktrees. Run: node test/moved.test.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const claudeHome = mkdtempSync(path.join(os.tmpdir(), "layr-claude-moved-home-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const { Engine, sessionFile } = await import("../backend/engine.js");
const { promptText } = await import("../backend/goBack.js");
const { APPLIED_FILE, MOVED_FILE, applyMoves, layrHome, movedPath, readMoves } = await import("../backend/moved.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue, nowIso } = await import("../backend/util.js");

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString().trim();

/** A home with one folder for each plugin, the old folder for every plugin beside it, and this plugin's store. */
function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-moved-"));
  const home = path.join(tmp, "home");
  const old = path.join(tmp, "layr-plugins");
  mkdirSync(path.join(home, "packages"), { recursive: true });
  mkdirSync(old, { recursive: true });
  const store = new Store(path.join(tmp, "data"));
  return { tmp, home, old, store, moves: [] };
}

/** A plugin made in the old folder, as the plugin maker left it. */
function oldPlugin(s, id, manifest = { id, name: id }) {
  const dir = path.join(s.old, id);
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(path.join(dir, "layr.json"), JSON.stringify(manifest));
  return dir;
}

/** What the core does at its start: the folder becomes `<home>/packages/<id>/mine`, and the move is listed. */
function coreMoves(s, id, from = path.join(s.old, id)) {
  const to = path.join(s.home, "packages", id, "mine");
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  s.moves.push({ id, from, to, at: Date.now() + s.moves.length });
  writeFileSync(path.join(s.home, MOVED_FILE), `${JSON.stringify(s.moves, null, 2)}\n`);
  return to;
}

function thread(store, project, id, cwd, more = {}) {
  return store.createThread({
    id, projectId: project.id, title: id, kind: "plugin", cwd, workspace: { kind: "folder", path: cwd, branch: "main" },
    permissionMode: "default", sessionId: `s-${id}`, sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "done", turns: 1, lastActivity: nowIso(), ...more,
  });
}

/** A Claude Code session transcript on disk, where Claude Code keeps it for a folder. */
function session(cwd, id, text = `{"type":"user","cwd":${JSON.stringify(cwd)},"sessionId":"${id}"}\n`) {
  const file = sessionFile(cwd, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test("movedPath: the folder itself and what is inside it, nothing else", () => {
  const from = path.join(os.tmpdir(), "layr-plugins", "notes");
  const to = path.join(os.tmpdir(), "home", "packages", "notes", "mine");
  assert.equal(movedPath(from, from, to), to);
  assert.equal(movedPath(`${from}${path.sep}`, from, to), to);
  assert.equal(movedPath(path.join(from, "panels", "a.html"), from, to), path.join(to, "panels", "a.html"));
  assert.equal(movedPath(`${from}-2`, from, to), null, "another plugin whose name starts the same");
  assert.equal(movedPath(path.dirname(from), from, to), null, "the folder it was in");
  assert.equal(movedPath(null, from, to), null);
  assert.equal(movedPath(undefined, from, to), null);
  if (process.platform === "win32") {
    assert.equal(movedPath(from.toUpperCase(), from, to), to, "Windows paths compare without case");
    assert.equal(movedPath(from.replace(/\\/g, "/"), from, to), to, "and with either slash");
  }
});

test("the home and its list of moves", () => {
  const s = setup();
  assert.equal(layrHome({ LAYR_HOME: s.home }), s.home);
  assert.equal(layrHome({ LAYR_PACKAGES: path.join(s.home, "packages") }), s.home, "the folder the packages are in");
  assert.equal(layrHome({}), null, "no core");
  assert.deepEqual(readMoves(s.home), [], "no list: nothing moved (an older core)");
  assert.deepEqual(applyMoves({ store: s.store, home: s.home }), []);
  writeFileSync(path.join(s.home, MOVED_FILE), "not json");
  assert.deepEqual(readMoves(s.home), []);
  const list = [{ id: "a", from: "x", to: "y", at: 5 }, { id: "b" }, null, 3];
  writeFileSync(path.join(s.home, MOVED_FILE), JSON.stringify(list));
  assert.deepEqual(readMoves(s.home), [{ id: "a", from: "x", to: "y", at: 5 }], "only whole entries");
  assert.deepEqual(applyMoves({ store: s.store, home: null }), [], "no home");
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("a moved plugin's projects and threads follow, with Claude's sessions, once", () => {
  const s = setup();
  const from = oldPlugin(s, "notes", { id: "notes", name: "Notes" });
  const other = oldPlugin(s, "notes-2");
  const elsewhere = path.join(s.tmp, "code");
  mkdirSync(path.join(from, "panels"), { recursive: true });
  mkdirSync(elsewhere);
  const own = s.store.addProject({ path: from, name: "Notes", kind: "plugin", pluginId: "notes" });
  const root = s.store.addProject({ path: s.old }); // the old plugin maker's one project for every plugin
  const code = s.store.addProject({ path: elsewhere });
  const two = s.store.addProject({ path: other, kind: "plugin", pluginId: "notes-2" });
  const json = (p) => JSON.stringify(p).slice(1, -1);
  const a = thread(s.store, own, "t_a", from, {
    earlierSessions: ["s-early", "s-pruned"],
    extra: { pluginId: "notes", folder: from, target: "plugin", place: "made", isNew: true },
    systemAppend: `Work only inside this folder: ${from}\ncall packages_link with { "path": "${json(from)}" }`,
  });
  const b = thread(s.store, root, "t_b", from, { sessionStarted: false }); // the old plugin maker's thread
  const c = thread(s.store, own, "t_c", path.join(from, "panels")); // inside the folder; its session is pruned
  const d = thread(s.store, code, "t_d", elsewhere, { kind: "thread" });
  const e = thread(s.store, two, "t_e", other);
  s.store.saveIndexNow();
  const main = session(from, "s-t_a");
  const early = session(from, "s-early");
  const sub = path.join(main.slice(0, -".jsonl".length), "subagents", "agent-x.jsonl");
  mkdirSync(path.dirname(sub), { recursive: true });
  writeFileSync(sub, '{"type":"assistant"}\n');
  const unrelated = session(from, "s-someone-elses");
  const otherSession = session(other, "s-t_e");

  const to = coreMoves(s, "notes");
  // Something already under the new folder's name stays as it is.
  const kept = session(to, "s-early", "already here\n");
  const before = readFileSync(main, "utf8");

  const applied = applyMoves({ store: s.store, home: s.home });
  assert.equal(applied.length, 1);
  assert.deepEqual({ ...applied[0], at: 0 }, { id: "notes", from, to, at: 0, projects: 1, threads: 3, sessions: 1 });

  // Projects: the plugin's own one moved; the others are where they were.
  assert.equal(own.path, to);
  assert.equal(own.name, "Notes");
  assert.equal(root.path, s.old);
  assert.equal(code.path, elsewhere);
  assert.equal(two.path, other);

  // Threads in the folder (or inside it) work in the new one.
  assert.equal(a.cwd, to);
  assert.equal(a.workspace.path, to);
  assert.equal(a.workspace.branch, "main", "the rest of its workspace stays");
  assert.equal(a.extra.folder, to);
  assert.equal(a.extra.pluginId, "notes");
  assert.equal(a.systemAppend,
    `Work only inside this folder: ${to}\ncall packages_link with { "path": "${json(to)}" }`);
  assert.equal(a.projectId, own.id);
  assert.equal(a.sessionId, "s-t_a", "the same Claude session");
  assert.equal(a.sessionStarted, true);
  assert.equal(c.cwd, path.join(to, "panels"));
  assert.equal(c.projectId, own.id);
  assert.equal(b.cwd, to);
  assert.equal(b.projectId, own.id, "the old plugin maker's thread joins the plugin's own project");
  assert.equal(d.cwd, elsewhere);
  assert.equal(e.cwd, other, "another plugin whose folder's name starts the same stays");
  assert.equal(e.projectId, two.id);

  // Claude Code's sessions: copied under the new folder's name; the old files untouched.
  assert.equal(readFileSync(sessionFile(to, "s-t_a"), "utf8"), before, "the session it resumes");
  assert.equal(readFileSync(main, "utf8"), before, "the old one is as it was");
  assert.ok(existsSync(early) && existsSync(unrelated) && existsSync(otherSession));
  assert.equal(readFileSync(kept, "utf8"), "already here\n", "nothing there is overwritten");
  assert.equal(
    readFileSync(path.join(sessionFile(to, "s-t_a").slice(0, -".jsonl".length), "subagents", "agent-x.jsonl"), "utf8"),
    '{"type":"assistant"}\n', "its subagents' conversations come along");
  assert.ok(!existsSync(sessionFile(to, "s-someone-elses")), "only the threads' sessions are copied");
  assert.ok(!existsSync(sessionFile(to, "s-pruned")), "a session that is gone stays gone");

  // Each moved thread says it once; Claude is told with the next message when it has a session.
  for (const [id, sess] of [["t_a", "carried"], ["t_b", "none"], ["t_c", "missing"]]) {
    const said = s.store.readTranscript(id).filter((x) => x.subtype === "folder_moved");
    assert.equal(said.length, 1, id);
    assert.equal(said[0].type, "system");
    assert.match(said[0].text, /folder of its own now.*goes on in the new folder/);
    assert.ok(!said[0].text.includes(s.tmp), "no long paths in what the user reads");
    assert.equal(said[0].session, sess, id);
    assert.equal(said[0].to, s.store.thread(id).cwd);
  }
  assert.equal(s.store.readTranscript("t_d").length + s.store.readTranscript("t_e").length, 0);
  assert.match(a.movedNote, /^\[layr: this plugin's folder moved/);
  assert.ok(a.movedNote.includes(from) && a.movedNote.includes(to));
  assert.ok(c.movedNote.includes(path.join(to, "panels")));
  assert.equal(b.movedNote, undefined, "Claude never ran there: nothing to tell it");
  assert.equal(d.movedNote, undefined);

  // It is on disk, and done once: a folder made again in the old place later is somebody else.
  const reread = new Store(s.store.dataDir);
  assert.equal(reread.thread("t_a").cwd, to);
  assert.equal(reread.findProject(own.id).path, to);
  const kept2 = JSON.parse(readFileSync(path.join(s.store.dataDir, APPLIED_FILE), "utf8"));
  assert.equal(kept2.length, 1);
  assert.equal(kept2[0].from, from);
  assert.ok(kept2[0].appliedAt);
  mkdirSync(from);
  const later = thread(s.store, root, "t_later", from);
  assert.deepEqual(applyMoves({ store: s.store, home: s.home }), []);
  assert.equal(later.cwd, from);
  assert.equal(s.store.readTranscript("t_a").filter((x) => x.subtype === "folder_moved").length, 1);

  // A later move is applied by itself; the earlier one isn't applied again.
  const to2 = coreMoves(s, "notes-2");
  const next = applyMoves({ store: s.store, home: s.home });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "notes-2");
  assert.equal(e.cwd, to2);
  assert.equal(two.path, to2);
  assert.equal(later.cwd, from);
  assert.equal(readFileSync(sessionFile(to2, "s-t_e"), "utf8"), readFileSync(otherSession, "utf8"));
  assert.equal(JSON.parse(readFileSync(path.join(s.store.dataDir, APPLIED_FILE), "utf8")).length, 2);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("the old plugin maker's threads get a project for the plugin; one there already is used", () => {
  const s = setup();
  const from = oldPlugin(s, "lab", { id: "lab", name: "Lab notebook" });
  const root = s.store.addProject({ path: s.old });
  const a = thread(s.store, root, "t_a", from, { sessionStarted: false });
  const to = coreMoves(s, "lab");
  applyMoves({ store: s.store, home: s.home });
  const made = s.store.findProject(to);
  assert.ok(made && made.id !== root.id);
  assert.deepEqual([made.kind, made.pluginId, made.name], ["plugin", "lab", "Lab notebook"]);
  assert.equal(a.projectId, made.id);
  assert.equal(s.store.projects.length, 2);

  // The new folder is a project already (added by hand): the old folder's project isn't kept beside it.
  const from2 = oldPlugin(s, "quiet");
  const to2 = path.join(s.home, "packages", "quiet", "mine");
  const was = s.store.addProject({ path: from2, kind: "plugin", pluginId: "quiet" });
  const b = thread(s.store, was, "t_b", from2, { sessionStarted: false });
  coreMoves(s, "quiet");
  const there = s.store.addProject({ path: to2 });
  applyMoves({ store: s.store, home: s.home });
  assert.equal(b.projectId, there.id);
  assert.equal(b.cwd, to2);
  assert.ok(!s.store.projects.some((p) => p.id === was.id));
  assert.equal(s.store.projects.filter((p) => p.path === to2).length, 1);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("a renamed plugin (claude became threads): its own threads follow its data, with Claude's sessions", () => {
  const s = setup();
  const from = path.join(s.home, "plugin-data", "claude");
  const to = path.join(s.home, "plugin-data", "threads");
  const before = new Store(from);
  const project = before.addProject({ path: path.join(from, "threads") });
  const cwd = path.join(from, "threads", "t_a");
  mkdirSync(cwd, { recursive: true });
  thread(before, project, "t_a", cwd, { kind: "thread", plugins: [] });
  before.saveProjects();
  before.saveIndexNow();
  const main = session(cwd, "s-t_a");
  // What the core does at its start: the plugin's data folder gets the new name, and the move is listed.
  renameSync(from, to);
  const move = { id: "threads", from, to, at: 1, renamed: { from: "claude", to: "threads" } };
  writeFileSync(path.join(s.home, MOVED_FILE), JSON.stringify([move]));
  assert.deepEqual(readMoves(s.home)[0].renamed, { from: "claude", to: "threads" });
  const store = new Store(to);
  const out = applyMoves({ store, home: s.home });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessions, 1);
  const a = store.thread("t_a");
  assert.equal(a.cwd, path.join(to, "threads", "t_a"));
  assert.equal(store.projects[0].path, path.join(to, "threads"));
  assert.equal(readFileSync(sessionFile(a.cwd, "s-t_a"), "utf8"), readFileSync(main, "utf8"), "resumes there");
  const said = store.readTranscript("t_a").filter((x) => x.subtype === "folder_moved");
  assert.equal(said.length, 1);
  assert.match(said[0].text, /The plugin claude is called threads now/);
  assert.match(a.movedNote, /^\[layr: this thread's folder moved.*the plugin claude is called threads now/);
  assert.deepEqual(applyMoves({ store, home: s.home }), [], "once");
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("a move whose new folder isn't there waits", () => {
  const s = setup();
  const from = oldPlugin(s, "notes");
  const own = s.store.addProject({ path: from });
  const a = thread(s.store, own, "t_a", from);
  const to = path.join(s.home, "packages", "notes", "mine");
  s.moves.push({ id: "notes", from, to, at: 1 });
  writeFileSync(path.join(s.home, MOVED_FILE), JSON.stringify(s.moves));
  assert.deepEqual(applyMoves({ store: s.store, home: s.home }), []);
  assert.equal(a.cwd, from);
  assert.ok(!existsSync(path.join(s.store.dataDir, APPLIED_FILE)));
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  assert.equal(applyMoves({ store: s.store, home: s.home }).length, 1);
  assert.equal(a.cwd, to);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("a worktree thread of a moved repository: git finds its way again", async () => {
  const s = setup();
  const from = oldPlugin(s, "notes");
  execFileSync("git", ["init", "-q", "-b", "main", from]);
  git(from, "add", ".");
  git(from, "commit", "-q", "-m", "init");
  const tree = path.join(s.tmp, "worktrees", "notes-a");
  git(from, "worktree", "add", "-q", "-b", "layr/a", tree);
  const own = s.store.addProject({ path: from, kind: "plugin", pluginId: "notes" });
  const w = thread(s.store, own, "t_w", tree, { workspace: { kind: "worktree", path: tree, branch: "layr/a" } });
  const to = coreMoves(s, "notes");
  assert.throws(() => git(tree, "status", "--porcelain"), "moving the repository broke its worktree");
  const applied = applyMoves({ store: s.store, home: s.home });
  assert.equal(applied[0].threads, 0, "the worktree's own folder didn't move");
  assert.equal(await applied[0].repair, true);
  assert.equal(git(tree, "status", "--porcelain"), "");
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), "layr/a");
  assert.equal(w.cwd, tree);
  assert.equal(own.path, to);
  assert.equal(s.store.readTranscript("t_w").length, 0);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("Claude is told the new folder with the next message, once", async () => {
  const s = setup();
  const from = oldPlugin(s, "notes");
  const own = s.store.addProject({ path: from, kind: "plugin", pluginId: "notes" });
  const a = thread(s.store, own, "t_a", from);
  const to = coreMoves(s, "notes");
  applyMoves({ store: s.store, home: s.home });
  const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => true };
  const engine = new Engine({ store: s.store, hub, account: { listModels: async () => [] } });
  engine.notificationsOn = async () => false;
  const pushed = [];
  const opened = [];
  engine.openLive = async (meta) => {
    opened.push(meta.cwd);
    const input = new AsyncQueue();
    const push = input.push.bind(input);
    input.push = (m) => (pushed.push(m), push(m));
    const live = {
      threadId: meta.id, input, query: { close() {}, interrupt: async () => {} }, turnActive: false,
      interruptRequested: false, approvals: new Map(), streamBlocks: new Map(), streamKeyByIndex: new Map(),
      needsRestart: false, closed: false, idleTimer: null, background: new Map(), seenTasks: new Map(),
    };
    engine.lives.set(meta.id, live);
    return live;
  };
  assert.equal(engine.summary(a).folderGone, false);
  await engine.send("t_a", { text: "go on" });
  assert.deepEqual(opened, [to], "Claude Code starts in the new folder");
  const said = JSON.stringify(pushed[0].message.content);
  assert.match(said, /\[layr: this plugin's folder moved since your last turn.*go on/s);
  assert.equal(a.movedNote, null);
  assert.equal(promptText(pushed[0].message.content), "go on", "going back still finds the message under the note");
  const live = engine.lives.get("t_a");
  engine.endTurn(a, live, { subtype: "success" });
  await engine.send("t_a", { text: "and more" });
  assert.ok(!JSON.stringify(pushed[1].message.content).includes("folder moved"), "only once");
  engine.closeLive("t_a", "test");
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

// ------------------------------------------------------------------ the backend itself

async function backend(env) {
  const base = { ...process.env };
  const core = ["LAYR_HOME", "LAYR_PACKAGES", "LAYR_HUB_URL", "LAYR_HUB_TOKEN", "LAYR_CLAUDE_PLUGINS_DIR"];
  for (const key of core) delete base[key];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginDir, "backend", "server.js")],
    cwd: pluginDir,
    env: { ...base, LAYR_CLAUDE_BUILD_IMPORT: "0", LAYR_CLAUDE_RESUME: "0", ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  };
  return { call, close: () => client.close(), log: () => stderr };
}

test("the backend follows the moves when it starts, and says where plugins go", async () => {
  const s = setup();
  const from = oldPlugin(s, "notes", { id: "notes", name: "Notes" });
  const own = s.store.addProject({ path: from, name: "Notes", kind: "plugin", pluginId: "notes" });
  thread(s.store, own, "t_a", from, { extra: { pluginId: "notes", folder: from, target: "plugin", place: "made" } });
  s.store.saveIndexNow();
  session(from, "s-t_a");
  const dataDir = s.store.dataDir;
  const packages = path.join(s.home, "packages");

  // An older core: no packages folder told, no list of moves. Everything is as it was.
  let b = await backend({ LAYR_DATA_DIR: dataDir, LAYR_HOME: s.home, LAYR_CLAUDE_PLUGINS_DIR: s.old });
  assert.deepEqual(await b.call("plugins_folder"), { folder: s.old });
  assert.equal((await b.call("thread_list", { archived: "all" })).threads[0].cwd, from);
  await b.close();

  // The core moved the plugin; the backend starts on it.
  const to = coreMoves(s, "notes");
  b = await backend(
    { LAYR_DATA_DIR: dataDir, LAYR_HOME: s.home, LAYR_PACKAGES: packages, LAYR_CLAUDE_PLUGINS_DIR: s.old });
  assert.deepEqual(await b.call("plugins_folder"),
    { folder: packages, layout: 2, plugin: path.join(packages, "<id>", "mine"), oldFolder: s.old });
  const { threads } = await b.call("thread_list", { plugin: "notes" });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].cwd, to);
  assert.equal(threads[0].folderGone, false);
  assert.equal(threads[0].sessionId, "s-t_a");
  const { projects } = await b.call("projects_list");
  assert.deepEqual(projects.map((p) => [p.path, p.kind, p.exists]), [[to, "plugin", true]]);
  const { entries } = await b.call("thread_transcript", { thread: "t_a" });
  assert.equal(entries.filter((e) => e.subtype === "folder_moved").length, 1);
  assert.ok(existsSync(sessionFile(to, "s-t_a")), "Claude's session is under the new folder's name");
  assert.ok(existsSync(sessionFile(from, "s-t_a")), "and still under the old one");
  assert.match(b.log(), /notes: its folder moved to .*1 project\(s\), 1 thread\(s\) follow, 1 with Claude's session/);
  await b.close();

  // Started again: nothing more happens.
  b = await backend({ LAYR_DATA_DIR: dataDir, LAYR_PACKAGES: packages, LAYR_CLAUDE_PLUGINS_DIR: s.old });
  const again = await b.call("thread_transcript", { thread: "t_a" });
  assert.equal(again.entries.filter((e) => e.subtype === "folder_moved").length, 1);
  assert.ok(!/its folder moved/.test(b.log()));
  await b.close();
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});
