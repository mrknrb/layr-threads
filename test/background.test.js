// Unit tests without Claude: a thread's background work (subagents, background shells, monitors) keeps its query open
// past the idle timeout, and work lost anyway is said in the transcript and to Claude on the next message.
// Run: node test/background.test.js
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAYR_CLAUDE_IDLE_MS = "40";
const { Engine } = await import("../backend/engine.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue } = await import("../backend/util.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-bg-")));
  const notes = [];
  const hub = { available: false, emit() {}, notify: (text) => notes.push(text), settingsGet: async () => true };
  const engine = new Engine({ store, hub, account: { listModels: async () => [] } });
  engine.notificationsOn = async () => true;
  engine.hub.notify = (text) => notes.push(text);
  const meta = store.createThread({
    id: "t_test", projectId: "_", title: "Test", kind: "thread", cwd: os.tmpdir(), workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "running", turns: 0,
  });
  const live = {
    threadId: meta.id, input: new AsyncQueue(), query: { close() { live.queryClosed = true; } }, turnActive: true,
    interruptRequested: false, approvals: new Map(), streamBlocks: new Map(), streamKeyByIndex: new Map(),
    needsRestart: false, closed: false, idleTimer: null, background: new Map(), seenTasks: new Map(),
  };
  engine.lives.set(meta.id, live);
  return { engine, store, meta, live, notes };
}

const agent = { task_id: "a1", task_type: "local_agent", subagent_type: "general-purpose", description: "Port the shell" };
const watcher = { task_id: "w1", task_type: "monitor", description: "housekeeping", ambient: true };

test("an idle thread without background work closes", async () => {
  const { engine, meta, live } = setup();
  engine.endTurn(meta, live, { subtype: "success" });
  await sleep(80);
  assert.equal(engine.lives.has(meta.id), false);
  assert.equal(live.queryClosed, true);
});

test("background work keeps the query open past the idle timeout; it closes once the work is done", async () => {
  const { engine, store, meta, live } = setup();
  engine.handleSystem(meta, live, { subtype: "background_tasks_changed", tasks: [agent, watcher] });
  assert.deepEqual(store.thread(meta.id).background.map((t) => t.id), ["a1"], "ambient tasks are not work");
  assert.equal(engine.summary(meta).background[0].agent, "general-purpose");
  engine.endTurn(meta, live, { subtype: "success" });
  await sleep(80);
  assert.equal(engine.lives.has(meta.id), true, "still open while the agent runs");
  engine.handleSystem(meta, live, { subtype: "task_notification", task_id: "a1", status: "completed", summary: "" });
  engine.handleSystem(meta, live, { subtype: "background_tasks_changed", tasks: [watcher] });
  assert.deepEqual(store.thread(meta.id).background, []);
  const done = store.readTranscript(meta.id).find((e) => e.subtype === "background_done");
  assert.match(done.text, /completed: Port the shell/);
  await sleep(80);
  assert.equal(engine.lives.has(meta.id), false, "closed when idle with nothing in the background");
});

test("new settings wait for the background work before restarting the query", async () => {
  const { engine, meta, live } = setup();
  engine.handleSystem(meta, live, { subtype: "background_tasks_changed", tasks: [agent] });
  engine.endTurn(meta, live, { subtype: "success" });
  await engine.update(meta.id, { effort: "high" });
  assert.equal(engine.lives.has(meta.id), true);
  engine.handleSystem(meta, live, { subtype: "background_tasks_changed", tasks: [] });
  assert.equal(engine.lives.has(meta.id), false, "restarted (closed) once the work was done");
});

test("closing with background work says so, and the next message tells Claude", () => {
  const { engine, store, meta, live, notes } = setup();
  engine.handleSystem(meta, live, { subtype: "background_tasks_changed", tasks: [agent] });
  engine.closeLive(meta.id, "shutdown");
  const lost = store.readTranscript(meta.id).find((e) => e.subtype === "background_lost");
  assert.match(lost.text, /1 background task stopped unfinished \(the session closed: shutdown\): Port the shell/);
  assert.deepEqual(store.thread(meta.id).background, []);
  assert.equal(store.thread(meta.id).lostBackground.length, 1);
  return sleep(10).then(() => {
    assert.equal(notes.length, 1);
    const sdk = { message: { role: "user", content: "go on" } };
    engine.tellLostBackground(meta, sdk);
    assert.match(sdk.message.content, /^\[layr: these background tasks .*\n- Port the shell \(local_agent a1; the session/s);
    assert.match(sdk.message.content, /go on$/);
    assert.deepEqual(store.thread(meta.id).lostBackground, [], "told once");
  });
});

test("a backend that died with background work running reports it when it starts again", () => {
  const { store, meta } = setup();
  store.updateThread(meta.id, { background: [{ id: "a1", type: "local_agent", description: "Port the shell" }] });
  store.saveIndexNow();
  const again = new Engine({ store, hub: { available: false, emit() {}, notify() {} }, account: {} });
  again.notificationsOn = async () => false;
  assert.ok(store.readTranscript(meta.id).some((e) => e.subtype === "background_lost" && /engine restarted/.test(e.text)));
  assert.deepEqual(store.thread(meta.id).background, []);
  assert.equal(store.thread(meta.id).lostBackground.length, 1);
});

test("a subagent's model is kept on it from its first answer", () => {
  const { engine, store, meta, live } = setup();
  engine.subagentStarted(meta, { task_id: "a1", tool_use_id: "tu1", description: "Look", subagent_type: "Explore" });
  const answer = (model) => engine.handleAssistant(meta, live, {
    type: "assistant", parent_tool_use_id: "tu1", agent_id: "a1", uuid: `u-${model}`,
    message: { id: "m1", model, content: [{ type: "text", text: "found it" }] },
  });
  answer("claude-haiku-5-5");
  assert.equal(store.threads[meta.id].subagents[0].model, "claude-haiku-5-5");
  answer("claude-sonnet-5-5");
  assert.equal(store.threads[meta.id].subagents[0].model, "claude-sonnet-5-5");
});
