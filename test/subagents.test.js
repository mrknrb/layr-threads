// Unit tests without Claude: a thread's subagents (0.3.9). Their whole conversations are kept under their Agent call
// with their ids, the thread knows them and their state, and a message to one goes through the main agent, which is
// asked to pass it on with SendMessage. The SDK messages are shaped as Claude Code 0.3.325 sends them.
// Run: node test/subagents.test.js
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { relayFold } from "../panels/folds.js";

const { Engine } = await import("../backend/engine.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue } = await import("../backend/util.js");
const { agentIdIn, findSubagent, relayPrompt, subagentEntries, userText } = await import("../backend/subagents.js");

function setup({ turnActive = true } = {}) {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-sub-")));
  const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => false };
  const engine = new Engine({ store, hub, account: { listModels: async () => [] } });
  engine.notificationsOn = async () => false;
  const meta = store.createThread({
    id: "t_sub", projectId: "_", title: "Test", kind: "thread", cwd: os.tmpdir(), workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: turnActive ? "running" : "done", turns: 1,
  });
  const backgrounded = [];
  const live = {
    threadId: meta.id, input: new AsyncQueue(), turnActive, interruptRequested: false, approvals: new Map(),
    streamBlocks: new Map(), streamKeyByIndex: new Map(), needsRestart: false, closed: false, idleTimer: null,
    background: new Map(), seenTasks: new Map(),
    query: { close() {}, backgroundTasks: async (id) => (backgrounded.push(id), true) },
  };
  engine.lives.set(meta.id, live);
  return { engine, store, meta, live, backgrounded };
}

const CALL = "toolu_agent";
const ID = "a385f95c514b594f6";
const started = { type: "system", subtype: "task_started", task_id: ID, tool_use_id: CALL, description: "count fruit",
  subagent_type: "general-purpose" };
const fromSub = (type, content) => ({ type, parent_tool_use_id: CALL, agent_id: ID, message: { role: type, content } });

test("a subagent's whole conversation is kept under its Agent call, with its id", () => {
  const { engine, store, meta, live } = setup();
  engine.handle(meta, live, { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [
    { type: "tool_use", id: CALL, name: "Agent", input: { description: "count fruit", prompt: "Name three fruits." } }] } });
  engine.handle(meta, live, started);
  engine.handle(meta, live, fromSub("user", [{ type: "text", text: "Name three fruits." }]));
  engine.handle(meta, live, fromSub("assistant", [{ type: "thinking", thinking: "easy" }, { type: "text", text: "Apple, banana." }]));
  engine.handle(meta, live, fromSub("user", [{ type: "text", text: "<system-reminder>\nnot shown\n</system-reminder>" }]));
  const entries = store.readTranscript(meta.id).filter((e) => e.parent === CALL);
  assert.deepEqual(entries.map((e) => [e.type, e.agent]), [["user", ID], ["thinking", ID], ["text", ID]]);
  assert.equal(entries[0].by, "claude", "what it was told is from the main agent");
  assert.equal(entries[0].text, "Name three fruits.");
  const subs = engine.summary(meta).subagents;
  assert.deepEqual(subs.map((s) => [s.id, s.toolUseId, s.description, s.type, s.status]),
    [[ID, CALL, "count fruit", "general-purpose", "running"]]);
});

test("a subagent's state follows its task events; resumed, it keeps its first Agent call", () => {
  const { engine, meta, live } = setup();
  engine.handle(meta, live, started);
  engine.handle(meta, live, { type: "system", subtype: "task_notification", task_id: ID, tool_use_id: CALL, status: "completed" });
  assert.equal(engine.summary(meta).subagents[0].status, "done");
  engine.handle(meta, live, { ...started, tool_use_id: "toolu_sendmessage" });
  const [sub] = engine.summary(meta).subagents;
  assert.equal(sub.status, "running");
  assert.equal(sub.toolUseId, CALL);
  engine.lives.delete(meta.id);
  assert.equal(engine.summary(meta).subagents[0].status, "stopped", "one running when its query is gone stopped");
});

test("a message to a subagent in a running turn is steered in for the main agent to pass on", async () => {
  const { engine, store, meta, live, backgrounded } = setup();
  engine.handle(meta, live, started);
  live.background.set(ID, { id: ID });
  const r = await engine.send(meta.id, { text: "Now two vegetables.", agent: ID });
  assert.equal(r.sent, "steer");
  assert.deepEqual(backgrounded, [], "a background subagent isn't moved");
  const entry = store.readTranscript(meta.id).at(-1);
  assert.equal(entry.type, "user");
  assert.equal(entry.text, "Now two vegetables.", "the transcript keeps what you wrote");
  assert.deepEqual(entry.relay, { agent: ID, toolUseId: CALL, description: "count fruit" });
  const sdk = { value: live.input.items.shift() };
  assert.equal(sdk.value.priority, "now");
  assert.match(sdk.value.message.content, /SendMessage with to: "a385f95c514b594f6"/);
  assert.match(sdk.value.message.content, /<message>\nNow two vegetables.\n<\/message>$/);
});

test("a subagent running in the foreground goes to the background first", async () => {
  const { engine, meta, live, backgrounded } = setup();
  engine.handle(meta, live, started);
  await engine.send(meta.id, { text: "Stop after two.", agent: ID });
  assert.deepEqual(backgrounded, [CALL]);
});

test("an idle thread starts a turn for it; a subagent from an older thread is found by its Agent call's result", async () => {
  const { engine, store, meta, live } = setup({ turnActive: false });
  store.append(meta.id, { type: "tool_use", id: CALL, name: "Agent", input: { description: "old one", prompt: "x" } });
  store.append(meta.id, { type: "tool_result", id: CALL, content: `Done.\nagentId: ${ID} (internal ID - do not mention)` });
  const r = await engine.send(meta.id, { text: "And one more?", agent: ID });
  assert.equal(r.sent, "turn");
  const entry = store.readTranscript(meta.id).find((e) => e.type === "user");
  assert.equal(entry.relay.description, "old one");
  assert.equal(entry.relay.toolUseId, CALL);
  const sdk = { value: live.input.items.shift() };
  assert.match(sdk.value.message.content, /"old one" \(agent id a385f95c514b594f6\)/);
  assert.match(engine.lastUserInput(meta.id).text, /SendMessage/, "trying again sends what the main agent got");
  await assert.rejects(engine.send(meta.id, { text: "hi", agent: "ffffffffff" }), /No subagent/);
});

test("helpers: ids in results, what a subagent is told, its conversation from Claude Code's transcript", () => {
  assert.equal(agentIdIn("agentId: a7a496aa2b82eeb8e (internal ID"), "a7a496aa2b82eeb8e");
  assert.equal(agentIdIn("no id"), null);
  assert.equal(userText("hello"), "hello");
  assert.equal(userText([{ type: "tool_result", content: "x" }]), "");
  assert.equal(findSubagent({ subagents: [] }, [], "nope"), null);
  assert.match(relayPrompt({ agent: "a1", description: "" }, "hi"), /subagent with agent id a1/);
  const entries = subagentEntries([
    { type: "user", uuid: "u1", message: { role: "user", content: "Do it." } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Reading." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "data" }] }] } },
  ], CALL, ID);
  assert.deepEqual(entries.map((e) => [e.type, e.parent, e.agent]), [
    ["user", CALL, ID], ["text", CALL, ID], ["tool_use", CALL, ID], ["tool_result", CALL, ID]]);
  assert.equal(entries[0].by, "claude");
  assert.equal(entries[3].content, "data");
});

test("a turn that passed a message on folds away whole", () => {
  const items = [{ kind: "tool" }, { kind: "text" }, { kind: "end", entry: { status: "done" } }];
  assert.deepEqual([...relayFold(items).hidden], [0, 1, 2]);
  assert.equal(relayFold(items).label, "Passed on to the subagent");
  assert.equal(relayFold(items.slice(0, 2)), null, "not before it ends");
  assert.deepEqual([...relayFold([{ kind: "text" }, { kind: "end", entry: { status: "failed" } }]).hidden], [0]);
});
