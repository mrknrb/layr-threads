// Unit tests without Claude (0.3.12): a thread whose folder is gone says so (folderGone); Restore worktree makes a
// worktree again now, and Claude is told with the next message; a folder that isn't a worktree is refused with a clear
// error instead of starting Claude Code in a missing folder. Real git in a temp repo. Run: node test/restore.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { Engine } = await import("../backend/engine.js");
const { Store } = await import("../backend/store.js");
const { createWorktree } = await import("../backend/git.js");
const { AsyncQueue, nowIso } = await import("../backend/util.js");

const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => true };
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString().trim();

/** An engine on a temp repo whose queries are fakes: `pushed` lists the messages sent to Claude. */
function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-restore-"));
  const dir = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(path.join(dir, "README.md"), "# Test\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const store = new Store(path.join(tmp, "data"));
  const project = store.addProject({ path: dir });
  const engine = new Engine({ store, hub, account: { listModels: async () => [] } });
  engine.notificationsOn = async () => false;
  engine.pushed = [];
  engine.openLive = async (meta) => {
    const input = new AsyncQueue();
    const push = input.push.bind(input);
    input.push = (m) => {
      engine.pushed.push({ id: meta.id, m });
      push(m);
    };
    const live = {
      threadId: meta.id, input, query: { close() {}, interrupt: async () => {} }, turnActive: false,
      interruptRequested: false, approvals: new Map(), streamBlocks: new Map(), streamKeyByIndex: new Map(),
      needsRestart: false, closed: false, idleTimer: null, background: new Map(), seenTasks: new Map(),
    };
    engine.lives.set(meta.id, live);
    return live;
  };
  return { tmp, dir, store, project, engine };
}

function thread(store, project, id, cwd, workspace) {
  return store.createThread({
    id, projectId: project.id, title: id, kind: "thread", cwd, workspace,
    permissionMode: "default", sessionId: "s1", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "done", turns: 1, lastActivity: nowIso(),
  });
}

const sentText = (p) => JSON.stringify(p.m.message.content);

test("Restore worktree makes a removed worktree again now, and Claude hears of it with the next message", async () => {
  const s = setup();
  const tree = await createWorktree({ projectPath: s.dir, name: "t_a", worktreesRoot: path.join(s.tmp, "worktrees") });
  const meta = thread(s.store, s.project, "t_a", tree.path,
    { kind: "worktree", path: tree.path, branch: tree.branch, base: tree.base, created: true });
  assert.equal(s.engine.summary(meta).folderGone, false);
  const again = await s.engine.restoreNow("t_a");
  assert.equal(again.restored, false, "nothing to do while the folder is there");

  git(s.dir, "worktree", "remove", "--force", tree.path);
  assert.equal(s.engine.summary(meta).folderGone, true);
  const r = await s.engine.restoreNow("t_a");
  assert.equal(r.restored, true);
  assert.equal(r.thread.folderGone, false);
  assert.ok(existsSync(path.join(tree.path, "README.md")), "the worktree is back in the same folder");
  assert.equal(git(tree.path, "rev-parse", "--abbrev-ref", "HEAD"), tree.branch);
  assert.ok(s.store.readTranscript("t_a").some((e) => e.subtype === "worktree_restored"));
  assert.equal(s.engine.pushed.length, 0, "no turn started");

  await s.engine.send("t_a", { text: "go on" });
  assert.equal(s.engine.pushed.length, 1);
  assert.match(sentText(s.engine.pushed[0]), /\[layr: your worktree was removed.*go on/s, "Claude is told once");
  assert.equal(meta.restoreNote, null);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});

test("a folder that isn't a worktree and is gone: a clear error, Claude Code isn't started", async () => {
  const s = setup();
  const gone = path.join(s.tmp, "gone");
  const meta = thread(s.store, s.project, "t_f", gone, { kind: "folder", path: gone });
  assert.equal(s.engine.summary(meta).folderGone, true);
  await assert.rejects(s.engine.restoreNow("t_f"), /folder is gone/);
  await assert.rejects(s.engine.send("t_f", { text: "hello" }), /folder is gone.*new thread/);
  assert.equal(s.engine.pushed.length, 0);
  await assert.rejects(s.engine.restoreNow("t_missing"), /No thread t_missing/);
  rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 });
});
