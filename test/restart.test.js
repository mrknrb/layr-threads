// Unit tests without Claude: turns cut off by the backend stopping (crash, kill, restart, layr quitting) are picked up
// again when it starts: recover() sets them aside, resumeAfterRestart() resumes each session (forked) with a note.
// The real thing, a backend killed mid-turn with haiku, is a step of backend.test.js. Run: node test/restart.test.js
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { Engine, restartNote } = await import("../backend/engine.js");
const { lastPrompt } = await import("../backend/autoCommit.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue, nowIso } = await import("../backend/util.js");

const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => true };

function newStore() {
  return new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-restart-")));
}

function thread(store, id, o = {}) {
  const meta = store.createThread({
    id, projectId: "_", title: id, kind: "thread", cwd: os.tmpdir(), workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s-old", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "running", turns: 1, lastActivity: nowIso(), ...o,
  });
  store.append(id, { type: "user", text: `first prompt of ${id}`, images: [] });
  return meta;
}

/** An engine whose queries are fakes: `opened` lists openLive's options, `pushed` the messages sent to Claude. */
function engineOn(store) {
  const engine = new Engine({ store, hub, account: { listModels: async () => [] } });
  engine.notificationsOn = async () => false;
  engine.opened = [];
  engine.pushed = [];
  engine.openLive = async (meta, opts) => {
    engine.opened.push({ id: meta.id, ...opts });
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
  return engine;
}

test("a turn the backend died in is picked up again: its session resumed (forked) with a note", async () => {
  const store = newStore();
  thread(store, "t_run", { background: [{ id: "a1", type: "local_agent", description: "Port the shell" }] });
  thread(store, "t_wait", { status: "waiting", pendingApprovals: ["r1"] });
  thread(store, "t_done", { status: "done" });
  store.saveIndexNow();
  const engine = engineOn(store);
  assert.equal(store.thread("t_run").status, "starting", "waits as starting, not interrupted");
  assert.equal(store.thread("t_wait").pendingApprovals.length, 0);
  assert.equal(store.thread("t_done").status, "done");
  assert.ok(store.readTranscript("t_run").some((e) => e.subtype === "restart" && /goes on by itself/.test(e.text)));
  assert.equal(engine.summary(store.thread("t_run")).resuming, true);
  await engine.resumeAfterRestart();
  assert.deepEqual(engine.opened.map((o) => [o.id, o.fork]), [["t_run", true], ["t_wait", true]]);
  const run = store.thread("t_run");
  assert.equal(run.status, "running");
  assert.equal(run.restartResumes, 1);
  assert.equal(run.restartResume, null);
  const user = store.readTranscript("t_run").findLast((e) => e.type === "user");
  assert.equal(user.auto, "restart");
  assert.match(user.text, /the Claude engine restarted .* cut your turn off/);
  const sent = engine.pushed.find((p) => p.id === "t_run").m.message.content;
  assert.match(sent, /^\[layr: these background tasks of yours were stopped.*Port the shell/s, "lost background work is told");
  assert.match(sent, /Carry on where you left off/);
  const waitSent = engine.pushed.find((p) => p.id === "t_wait").m.message.content;
  assert.match(waitSent, /ask again if you still need it/);
  // The turn ends: the count starts over.
  engine.endTurn(run, engine.lives.get("t_run"), { subtype: "success" });
  assert.equal(store.thread("t_run").restartResumes, 0);
});

test("a message sent while it waits to be picked up is queued, and sent after that turn", async () => {
  const store = newStore();
  thread(store, "t_q");
  store.saveIndexNow();
  const engine = engineOn(store);
  const r = await engine.send("t_q", { text: "and then this" });
  assert.equal(r.sent, "queued");
  await engine.resumeAfterRestart();
  engine.endTurn(store.thread("t_q"), engine.lives.get("t_q"), { subtype: "success" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const users = store.readTranscript("t_q").filter((e) => e.type === "user").map((e) => e.text);
  assert.equal(users.at(-1), "and then this");
});

test("not picked up: archived, stopped long ago, or a turn that keeps bringing the engine down", () => {
  const store = newStore();
  thread(store, "t_arch", { archived: true });
  thread(store, "t_old", { lastActivity: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  thread(store, "t_loop", { restartResumes: 3 });
  store.saveIndexNow();
  const engine = engineOn(store);
  for (const id of ["t_arch", "t_old", "t_loop"]) assert.equal(store.thread(id).status, "interrupted", id);
  assert.deepEqual(engine.toResume, []);
  assert.ok(store.readTranscript("t_loop").some((e) => /3 times in a row/.test(e.text ?? "")));
  assert.equal(store.thread("t_loop").restartResumes, 0, "the user's next message starts the count over");
});

test("a backend stopped on purpose marks its running turns, and the next one picks them up", async () => {
  const store = newStore();
  thread(store, "t_stop", { status: "done" });
  store.saveIndexNow();
  const first = engineOn(store);
  await first.send("t_stop", { text: "do the thing" });
  first.setBackground(store.thread("t_stop"), first.lives.get("t_stop"), []);
  store.updateThread("t_stop", { status: "waiting" });
  await first.shutdown();
  const marked = store.thread("t_stop");
  assert.equal(marked.status, "interrupted");
  assert.equal(marked.restartResume.waiting, true);
  assert.ok(!store.readTranscript("t_stop").some((e) => e.type === "turn_end"), "the closing query isn't a failed turn");
  const second = engineOn(store);
  assert.equal(store.thread("t_stop").status, "starting");
  await second.resumeAfterRestart();
  assert.equal(second.opened[0].fork, true);
  assert.match(second.pushed[0].m.message.content, /ask again/);
});

test("a thread whose session never started gets its first message again, as it was", async () => {
  const store = newStore();
  thread(store, "t_new", { status: "starting", sessionStarted: false, turns: 0 });
  store.saveIndexNow();
  const engine = engineOn(store);
  await engine.resumeAfterRestart();
  assert.equal(engine.opened[0].fork, false);
  assert.equal(engine.pushed[0].m.message.content, "first prompt of t_new");
  // And again after another restart: the user's prompt, not the copy layr sent.
  store.updateThread("t_new", { status: "running" });
  store.saveIndexNow();
  const again = engineOn(store);
  await again.resumeAfterRestart();
  assert.equal(again.pushed[0].m.message.content, "first prompt of t_new");
  assert.equal(lastPrompt(store.readTranscript("t_new")), "first prompt of t_new", "nor is it a commit's prompt");
});

test("the note", () => {
  assert.match(restartNote("2026-11-17T10:00:00Z", false), /^\[layr: the Claude engine restarted at 17\/11\/2026/);
  assert.doesNotMatch(restartNote("x", false), / at |ask again/);
});
