// Unit test of plugins in a thread (backend/threadPlugins.js) and the history beside a plugin's folder (git.js,
// autoCommit.js), without Claude or a core: mentions, the guard's decisions, one writer per plugin, a stand-in engine
// and hub for adding plugins, Claude asking to change one, commits per plugin and taking a thread's changes back.
// Run: node test/threadPlugins.test.js
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-tp-"));
const home = path.join(tmp, "home");
const packages = path.join(home, "packages");
process.env.LAYR_PACKAGES = packages;
delete process.env.LAYR_CLAUDE_PLUGINS_DIR;
const tp = await import("../backend/threadPlugins.js");
const { git, outsideGit } = await import("../backend/git.js");
const { autoCommit, initPluginRepo } = await import("../backend/autoCommit.js");
const { parseMentions, guardDecision, WriteLocks, ThreadPlugins, publicRow, pluginsPrompt } = tp;
const plainGit = (dir, ...args) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

// ------------------------------------------------------------------ mentions
check(JSON.stringify(parseMentions("change @youtube and @pipeline@0.10.2, not me@mail.com or @Nope.")) ===
  JSON.stringify([{ id: "youtube", version: null }, { id: "pipeline", version: "0.10.2" }, { id: "nope", version: null }]),
  "mentions: ids and versions, not e-mail addresses, no full stop", parseMentions("change @youtube and @pipeline@0.10.2, not me@mail.com or @Nope."));
check(parseMentions("(@a.b) @a.b").length === 1 && parseMentions("(@a.b)")[0].id === "a.b", "an id with a dot, once");

// ------------------------------------------------------------------ the guard
const mineA = path.join(packages, "alpha", "mine");
const mineB = path.join(packages, "beta", "mine");
const linked = path.join(tmp, "dev", "gamma");
const work = path.join(home, "plugin-data", "claude", "work", "w1");
const rows = [
  { id: "alpha", name: "Alpha", mode: "change", folder: mineA },
  { id: "beta", name: "Beta", mode: "read", folder: mineB },
];
const ctx = { cwd: work, rows, home, packages, installed: [{ id: "gamma", path: linked }, { id: "alpha", path: mineA }],
  allowed: [work], claim: () => null };
const deny = (tool, input) => guardDecision(tool, input, ctx);
check(deny("Edit", { file_path: path.join(mineA, "panels", "a.html") }) === null, "editing a plugin it may change");
check(/only read Beta/.test(deny("Write", { file_path: path.join(mineB, "x.js") }) ?? ""), "a read-only plugin is refused");
check(/gamma isn't among/.test(deny("Edit", { file_path: path.join(linked, "x.js") }) ?? ""), "a plugin not on the list");
check(/delta isn't among/.test(deny("Edit", { file_path: path.join(packages, "delta", "0.1.0", "x.js") }) ?? ""),
  "a folder in packages not on the list");
check(/history/.test(deny("Write", { file_path: path.join(packages, "alpha", "history.git", "HEAD") }) ?? ""), "its history");
check(/history/.test(deny("Edit", { file_path: path.join(mineA, ".git") }) ?? ""), "a .git in its folder");
check(/layr's own data/.test(deny("Write", { file_path: path.join(home, "layr.db") }) ?? ""), "layr's home");
check(deny("Write", { file_path: path.join(work, "notes.md") }) === null, "the thread's own folder");
check(deny("Write", { file_path: path.join(tmp, "elsewhere", "a.txt") }) === null, "elsewhere: Claude Code's own rules");
check(deny("Write", { file_path: "notes.md" }) === null, "a relative path, in its folder");
check(deny("Read", { file_path: path.join(mineB, "x.js") }) === null, "reading is never refused");
check(/history/.test(deny("Bash", { command: `git --git-dir=${packages}/alpha/history.git log` }) ?? ""), "git on a history");
check(/beta's folder/.test(deny("PowerShell", { command: `Remove-Item "${path.join(mineB, "x.js")}"` }) ?? ""),
  "a command naming a read-only plugin's folder");
check(deny("Bash", { command: `cd "${mineA.replace(/\\/g, "/")}" && npm test` }) === null, "a command in a plugin it may change");
check(/gamma's folder/.test(deny("Bash", { command: `rm -rf ${linked}` }) ?? ""), "a command naming a linked plugin's folder");
check(deny("Bash", { command: "npm test" }) === null, "other commands");
check(/being changed/.test(guardDecision("Edit", { file_path: path.join(mineA, "a") },
  { ...ctx, claim: () => "Alpha is being changed by another thread" }) ?? ""), "a plugin another thread holds");

// ------------------------------------------------------------------ one writer per plugin
const locks = new WriteLocks();
const active = new Set(["t1", "t2"]);
check(locks.claim("alpha", "t1", (t) => active.has(t)) === null, "the first thread takes the plugin");
check(locks.claim("alpha", "t2", (t) => active.has(t)) === "t1", "a second thread waits for it");
active.delete("t1");
check(locks.claim("alpha", "t2", (t) => active.has(t)) === null, "a turn that ended doesn't hold it");
locks.release("t2");
check(!locks.holders.size, "released at the end of the turn");

// ------------------------------------------------------------------ the history beside the folder
// A new plugin of your own: its repository is ../repo.git, the folder has no .git, and commits still work.
const fresh = path.join(packages, "fresh", "mine");
mkdirSync(fresh, { recursive: true });
writeFileSync(path.join(fresh, "layr.json"), JSON.stringify({ id: "fresh", name: "Fresh", version: "0.1.0" }));
await initPluginRepo(fresh, "fresh", { outside: true });
check(!existsSync(path.join(fresh, ".git")) && existsSync(path.join(packages, "fresh", "repo.git", "HEAD")),
  "a new plugin's repository is beside its folder");
let alone = null;
try {
  plainGit(fresh, "status");
} catch (error) {
  alone = String(error.stderr);
}
check(/not a git repository/i.test(alone ?? ""), "git on its own in the folder finds none", alone);
check(outsideGit(path.join(fresh, "panels"))?.workTree === fresh, "found from a folder inside it");
writeFileSync(path.join(fresh, "a.txt"), "one\n");
const saved = await autoCommit(fresh, { prompt: "Add a", reply: "Added", thread: "t_x", turn: 1 });
check(saved?.subject === "Add a" && (await git(fresh, ["log", "--format=%s"])).trim().split("\n").length === 2,
  "a turn's changes are committed through layr", saved);

// A worktree of a history whose .git file was taken out (as the core leaves `mine`).
const hist = path.join(packages, "alpha", "history.git");
mkdirSync(hist, { recursive: true });
plainGit(hist, "init", "-q", "--bare", "--initial-branch=main");
const seed = path.join(tmp, "seed");
mkdirSync(seed, { recursive: true });
writeFileSync(path.join(seed, "layr.json"), JSON.stringify({ id: "alpha", name: "Alpha", version: "0.1.0" }));
plainGit(seed, "init", "-q", "--initial-branch=main");
plainGit(seed, "add", "-A");
plainGit(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "alpha 0.1.0");
plainGit(seed, "push", "-q", hist, "main:main", "main:mine");
plainGit(hist, "worktree", "add", "-q", mineA, "mine");
rmSync(path.join(mineA, ".git"));
writeFileSync(path.join(mineA, "b.txt"), "b\n");
const saved2 = await autoCommit(mineA, { prompt: "Add b", thread: "t_y", turn: 2 });
check(saved2?.commit && plainGit(hist, "log", "-1", "--format=%s", "mine") === "Add b", "a worktree's turn is committed", saved2);
check(plainGit(hist, "log", "-1", "--format=%b", "mine").includes("Layr-Thread: t_y"), "with the thread's trailer");

// ------------------------------------------------------------------ the list: a stand-in engine and hub
mkdirSync(mineB, { recursive: true });
writeFileSync(path.join(mineB, "layr.json"), JSON.stringify({ id: "beta", name: "Beta", version: "0.2.0" }));
const storeV = path.join(packages, "store1", "key-x", "1.0.0");
mkdirSync(storeV, { recursive: true });
writeFileSync(path.join(storeV, "layr.json"), JSON.stringify({ id: "store1", name: "Store one", version: "1.0.0" }));
const store1Mine = path.join(packages, "store1", "mine");
const calls = [];
const history = [];
const hub = {
  available: true,
  url: null,
  async call(name, args) {
    calls.push({ name, args });
    if (name === "layr__plugin_repos") {
      return { git: true, gitOutside: true, plugins: [
        { id: "alpha", name: "Alpha", kind: "changed", path: mineA, linked: true, version: "0.1.0" },
        { id: "beta", name: "Beta", kind: "made", path: mineB, linked: true, version: "0.2.0" },
        { id: "store1", name: "Store one", kind: "store", path: storeV, linked: false, version: "1.0.0",
          sources: [{ source: "key-x", text: "the store", versions: ["1.0.0"] }] },
      ] };
    }
    if (name === "layr__plugin_edit") {
      mkdirSync(store1Mine, { recursive: true });
      writeFileSync(path.join(store1Mine, "layr.json"), JSON.stringify({ id: "store1", name: "Store one", version: "1.0.0" }));
      return { path: store1Mine, branch: "mine" };
    }
    if (name === "layr__plugin_history") return { commits: history, more: false };
    if (name === "layr__plugin_undo") {
      if (args.commit === "bad") throw new Error("later changes touch the same lines");
      return { commit: `undo-${args.commit}` };
    }
    throw new Error(`unexpected ${name}`);
  },
};
const threads = {};
const fakeStore = {
  thread: (id) => threads[id] ?? null,
  updateThread: (id, patch) => Object.assign(threads[id], patch),
  attachmentsDir: (id) => path.join(home, "plugin-data", "claude", "threads", id),
};
let asked = null;
let answer = { decision: "allow" };
const engine = {
  restarts: 0,
  markRestart() {
    this.restarts++;
  },
  emitThread() {},
  requireThread: (id) => threads[id],
  isTurnActive: () => false,
  async askUser(meta, entry) {
    asked = entry;
    return answer;
  },
};
const plugins = new ThreadPlugins({ engine, hub, store: fakeStore, dataDir: path.join(home, "plugin-data", "claude") });
threads.t1 = { id: "t1", cwd: work, plugins: [], permissionMode: "default" };
const t1 = threads.t1;

const added = await plugins.mentioned(t1, "please look at @beta and @unknown");
check(added.length === 1 && t1.plugins[0].id === "beta" && t1.plugins[0].mode === "read", "a mention adds it to read", t1.plugins);
check(/added Beta \(beta\) for you to read/.test(t1.pluginsNote ?? "") && engine.restarts === 1,
  "Claude is told, and the session starts again with its folder", t1.pluginsNote);
const extras = await plugins.sessionExtras(t1);
check(extras.directories.includes(mineB) && extras.mcpServer && /read only; folder/.test(extras.systemAppend),
  "the session gets the folder, the tools and the list in its prompt");
check(plugins.autoAllow(t1, "Read", { file_path: path.join(mineB, "layr.json") }) &&
  !plugins.autoAllow(t1, "Edit", { file_path: path.join(mineB, "layr.json") }) &&
  plugins.autoAllow(t1, "mcp__thread__plugin_add", {}), "reading it and the thread's tools need no asking");

// Claude asks to change a store plugin: the person allows; it gets your copy.
const r1 = await plugins.requestChange(t1, { plugin: "store1", why: "add a button" });
check(asked?.kind === "plugin" && /change Store one/.test(asked.title) && asked.reason === "add a button", "the person is asked", asked);
check(r1.allowed && r1.plugin.folder === store1Mine && r1.plugin.mode === "change" && r1.plugin.place === "changed",
  "allowed: your copy, to change", r1);
check(calls.some((c) => c.name === "layr__plugin_edit" && c.args.plugin === "store1"), "plugin_edit made the copy");
asked = null;
const again = await plugins.requestChange(t1, { plugin: "store1", why: "more" });
check(again.allowed && asked === null, "asking again for one it may change: no card");
answer = { decision: "deny", message: "not that one" };
const r2 = await plugins.requestChange(t1, { plugin: "alpha", why: "x" });
check(!r2.allowed && r2.message === "not that one" && !t1.plugins.some((r) => r.id === "alpha"), "refused: stays off", r2);
answer = { decision: "allow_always" };
await plugins.requestChange(t1, { plugin: "alpha", why: "x" });
asked = null;
await plugins.setMode(t1, "alpha", "read");
await plugins.requestChange(t1, { plugin: "alpha", why: "y" });
check(t1.allowAllPlugins === true && asked === null && t1.plugins.find((r) => r.id === "alpha").mode === "change",
  "allow always: later requests need no asking");
let versionError = null;
await plugins.add(t1, { plugin: "beta", version: "9.9.9", mode: "read" }).catch((e) => (versionError = e.message));
check(/isn't unpacked/.test(versionError ?? ""), "a version that isn't on this PC, to read", versionError);

// A new plugin from Claude: no asking, its repository beside it.
asked = null;
const made = await plugins.requestChange(t1, { newPlugin: { name: "Lab log" } });
const madeRow = t1.plugins.find((r) => r.isNew);
check(made.allowed && asked === null && madeRow?.id === "lab-log" && madeRow.mode === "change" &&
  existsSync(path.join(packages, "lab-log", "repo.git", "HEAD")) && !existsSync(path.join(madeRow.folder, ".git")),
  "a new plugin: made, allowed, its history beside it", madeRow);

// Commits per plugin after a turn: only the ones it may change, with changes.
writeFileSync(path.join(store1Mine, "c.txt"), "c\n");
writeFileSync(path.join(mineB, "x.txt"), "x\n");
plainGit(path.join(packages, "store1"), "init", "-q", "--initial-branch=mine", "--separate-git-dir",
  path.join(packages, "store1", "repo.git"), store1Mine);
rmSync(path.join(store1Mine, ".git"));
plainGit(path.join(packages, "store1", "repo.git"), "--work-tree", store1Mine, "add", "layr.json");
plainGit(path.join(packages, "store1", "repo.git"), "--work-tree", store1Mine, "-c", "user.name=t", "-c", "user.email=t@t",
  "commit", "-q", "-m", "store1 1.0.0");
const results = await plugins.commit(t1, { prompt: "Turn three", reply: "done", turn: 3 });
const ids = results.filter((x) => x.done?.commit).map((x) => x.row.id).sort();
check(JSON.stringify(ids) === JSON.stringify(["store1"]), "one commit per changed plugin it may change", ids);

// Take back: this thread's commits, newest first; stops at a conflict.
history.push({ sha: "c3", thread: "t1", subject: "three" }, { sha: "c2", thread: "t9", subject: "other" },
  { sha: "c1", thread: "t1", subject: "one" });
const back = await plugins.takeBack(t1, "alpha");
const undone = calls.filter((c) => c.name === "layr__plugin_undo").map((c) => c.args.commit);
check(back[0].undone === 2 && JSON.stringify(undone) === JSON.stringify(["c3", "c1"]), "only this thread's, newest first", back);
history.unshift({ sha: "bad", thread: "t1", subject: "conflicting" });
const stopped = await plugins.takeBack(t1, "alpha");
check(stopped[0].undone === 0 && /same lines/.test(stopped[0].error ?? ""), "a conflict stops it", stopped);

// Removing one; the prompt and the public rows.
plugins.remove(t1, "beta");
check(!t1.plugins.some((r) => r.id === "beta") && /took Beta \(beta\) off/.test(t1.pluginsNote), "removed, and Claude is told");
check(publicRow(t1.plugins[0]).folder && /none yet/.test(pluginsPrompt({ rows: [], workDir: work, hubUrl: null })),
  "rows and the prompt of an empty list");
const found = await plugins.find("store");
check(found[0]?.id === "store1" && found[0].sources.length === 1, "plugin_find", found);

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
