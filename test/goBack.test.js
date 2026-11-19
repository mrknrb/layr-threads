// Unit tests without Claude: going back in a thread (goBack.js, Store.cutTranscript, Engine.goBack, sessionOptions).
// The chat is cut before one of your messages (kept in a side file) and the next query resumes Claude's session up to
// the entry before it, forked. Run: node test/goBack.test.js
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const claudeHome = mkdtempSync(path.join(os.tmpdir(), "layr-claude-goback-home-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const { Engine, sessionFile, sessionOptions } = await import("../backend/engine.js");
const { findForkPoint, mainChain, promptText } = await import("../backend/goBack.js");
const { Store } = await import("../backend/store.js");
const { nowIso } = await import("../backend/util.js");

const hub = { available: false, events: [], emit(name, payload) { this.events.push({ name, payload }); }, notify() {} };

/** A Claude Code session transcript: prompts, replies, a tool call, noise that isn't on the chain or isn't a prompt. */
function sessionLines() {
  let n = 0;
  let parent = null;
  const out = [{ type: "queue-operation", operation: "enqueue" }];
  const add = (e) => {
    const full = { uuid: `u${++n}`, parentUuid: parent, ...e };
    out.push(full);
    parent = full.uuid;
    return full;
  };
  add({ type: "user", message: { role: "user", content: "Fix the login" } });
  add({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
  add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  add({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } }); // u4
  add({ type: "user", message: { content: "go on" } }); // u5
  add({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }); // u6
  add({ type: "user", isMeta: true, message: { content: "<system-reminder>skill</system-reminder>" } }); // u7
  add({
    type: "user",
    message: { content: "[layr: these background tasks of yours were stopped ...\n- x]\n\ngo on" },
  }); // u8: the same text again, with the note about lost background tasks in front
  add({ type: "assistant", message: { content: [{ type: "text", text: "Again." }] } }); // u9
  add({
    type: "user",
    message: { content: [{ type: "image", source: {} }, { type: "text", text: "(Attached image saved at: x.png)" }] },
  }); // u10: only an image
  add({ type: "assistant", message: { content: [{ type: "text", text: "A cat." }] } }); // u11
  add({ type: "user", message: { content: "<command-name>/review</command-name><command-args>x</command-args>" } }); // u12
  add({ type: "assistant", message: { content: [{ type: "text", text: "Reviewed." }] } });
  out.push({ uuid: "side1", parentUuid: "u13", type: "assistant", isSidechain: true, message: { content: [] } });
  return out;
}

const layrUsers = [
  { seq: 2, type: "user", text: "Fix the login" },
  { seq: 9, type: "user", text: "go on" },
  { seq: 14, type: "user", text: "go on" },
  { seq: 20, type: "user", text: "", images: [{ name: "x.png", mediaType: "image/png" }] },
  { seq: 25, type: "user", text: "/review x" },
];

test("the chain entry before a message is found in Claude Code's session transcript", () => {
  const lines = sessionLines();
  assert.equal(mainChain(lines).at(-1).uuid, "u13", "a subagent's entries are not the main chain");
  assert.equal(promptText(lines.find((e) => e.uuid === "u8").message.content), "go on");
  assert.deepEqual(findForkPoint(lines, layrUsers, layrUsers[0]), { fresh: true }, "the first message starts over");
  assert.deepEqual(findForkPoint(lines, layrUsers, layrUsers[1]), { at: "u4" }, "the earlier of two identical ones");
  assert.deepEqual(findForkPoint(lines, layrUsers, layrUsers[2]), { at: "u7" }, "the later one, past a meta entry");
  assert.deepEqual(findForkPoint(lines, layrUsers, layrUsers[3]), { at: "u9" }, "an image without text");
  assert.deepEqual(findForkPoint(lines, layrUsers, layrUsers[4]), { at: "u11" }, "a slash command, kept expanded");
  assert.equal(findForkPoint(lines, layrUsers, { seq: 30, type: "user", text: "never sent" }), null);
});

test("a query resumes the session forked at the go-back point", () => {
  const meta = { sessionId: "s1" };
  assert.deepEqual(sessionOptions(meta, { resume: false }), { sessionId: "s1" });
  assert.deepEqual(sessionOptions(meta, { resume: true }), { resume: "s1" });
  assert.deepEqual(sessionOptions(meta, { resume: true, fork: true }), { resume: "s1", forkSession: true });
  assert.deepEqual(sessionOptions(meta, { resume: true, goBack: { at: "u4" } }),
    { resume: "s1", resumeSessionAt: "u4", forkSession: true });
});

function setup(o = {}) {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-goback-")));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "layr-claude-goback-cwd-"));
  const meta = store.createThread({
    id: "t1", projectId: "_", title: "t1", kind: "thread", cwd, workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s1", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "done", turns: 2, lastActivity: nowIso(), earlierSessions: ["s0"], ...o,
  });
  const append = (e) => store.append("t1", e);
  append({ type: "created" });
  append({ type: "user", text: "Fix the login", images: [] }); // seq 2
  append({ type: "turn_start", turn: 1 });
  append({ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "a", status: "done" }] } });
  append({ type: "text", id: "x", text: "Fixed." });
  append({ type: "turn_end", turn: 1, status: "done" });
  store.saveAttachment("t1", "cat.png", Buffer.from("png!"));
  append({ type: "user", text: "go on", images: [{ name: "cat.png", mediaType: "image/png" }] }); // seq 7
  append({ type: "turn_start", turn: 2 });
  append({ type: "user", text: "and the tests", images: [], steer: true }); // seq 9
  append({ type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [{ content: "b", status: "pending" }] } });
  append({ type: "text", id: "y", text: "Done." });
  append({ type: "turn_end", turn: 2, status: "done" });
  const file = sessionFile(cwd, "s1");
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = sessionLines().slice(0, 7); // up to "Done."
  lines[5].message.content = [{ type: "image", source: {} }, { type: "text", text: "go on\n\n(Attached image saved at: x)" }];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  hub.events = [];
  const engine = new Engine({ store, hub, account: { listModels: async () => [] } });
  return { store, engine, meta };
}

test("going back cuts the chat before the message, keeps what it took out, and resumes forked next time", async () => {
  const { store, engine } = setup();
  const r = await engine.goBack("t1", 7);
  assert.equal(r.text, "go on");
  assert.deepEqual(r.images, [{ name: "cat.png", mediaType: "image/png", data: Buffer.from("png!").toString("base64") }]);
  const left = store.readTranscript("t1");
  assert.deepEqual(left.slice(0, -1).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  const marker = left.at(-1);
  assert.equal(marker.subtype, "went_back");
  assert.equal(marker.seq, 13, "numbering goes on after what was taken out");
  assert.match(marker.text, /^Went back to before "go on": it, with Claude's work, left the chat/, "a steer is no message");
  const kept = readFileSync(store.wentBackFile("t1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((e) => e.seq), [7, 8, 9, 10, 11, 12]);
  const meta = store.thread("t1");
  assert.deepEqual(meta.goBack, { at: "u4", from: "s1" });
  assert.equal(meta.sessionId, "s1", "the session is forked on the next message, not now");
  assert.deepEqual(meta.earlierSessions, [], "earlier sessions hold what was taken out");
  assert.deepEqual(meta.todos, [{ content: "a", status: "done", activeForm: undefined }], "the todos of then");
  assert.equal(meta.preview, "Fixed.");
  assert.ok(hub.events.some((e) => e.name === "claude:thread.t1" && e.payload.kind === "reset"), "panels draw it again");
  // After a restart of the backend, numbering still goes on.
  const again = new Store(store.dataDir);
  assert.equal(again.append("t1", { type: "system", text: "x" }).seq, 14);
});

test("going back to the first message starts a new session", async () => {
  const { store, engine } = setup();
  await engine.goBack("t1", 2);
  const meta = store.thread("t1");
  assert.notEqual(meta.sessionId, "s1");
  assert.equal(meta.sessionStarted, false);
  assert.equal(meta.goBack, null);
  assert.deepEqual(store.readTranscript("t1").map((e) => e.type), ["created", "system"]);
  assert.match(store.readTranscript("t1").at(-1).text, /it and the 1 message after it, with/);
});

test("going back waits for Claude, and only works on messages that started a turn", async () => {
  const { engine, store } = setup();
  store.updateThread("t1", { status: "running" });
  await assert.rejects(engine.goBack("t1", 7), /Claude is working/);
  store.updateThread("t1", { status: "done" });
  await assert.rejects(engine.goBack("t1", 9), /started a turn/, "a steer");
  await assert.rejects(engine.goBack("t1", 5), /started a turn/, "a reply");
  store.updateThread("t1", { sessionId: "gone" });
  await assert.rejects(engine.goBack("t1", 7), /doesn't have this message/, "a session that started over");
  assert.equal(store.readTranscript("t1").length, 12, "nothing taken out when going back fails");
  assert.ok(!existsSync(store.wentBackFile("t1")));
});
