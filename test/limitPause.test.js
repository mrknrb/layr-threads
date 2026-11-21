// Unit tests without Claude: a turn that stops at the account's usage limit pauses instead of failing (0.9.0). The
// thread stays running, says until when, queues messages, goes on in the same session when the time comes (or the
// account has room again), Stop ends the wait, and a restart keeps it waiting. Run: node test/limitPause.test.js
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { Engine } = await import("../backend/engine.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue, nowIso } = await import("../backend/util.js");
const { FALLBACK_MS, LIMIT_NOTE, SLACK_MS, isLimitEnd, limitRoom, pauseUntil, resetFromText } =
  await import("../backend/limitPause.js");

const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => false };
const HOUR = 3_600_000;

function newStore() {
  return new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-limit-")));
}

function thread(store, id, o = {}) {
  return store.createThread({
    id, projectId: "_", title: id, kind: "thread", cwd: os.tmpdir(), workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s-real", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "done", turns: 1, lastActivity: nowIso(), ...o,
  });
}

/** An engine whose queries are fakes; `account` a fake account; `told` the notifications it gave. */
function engineOn(store, account = {}) {
  const engine = new Engine({
    store, hub,
    account: { listModels: async () => [], limits: {}, limitsAt: 0, usage: async () => ({}), setRateLimit() {}, ...account },
  });
  engine.told = [];
  engine.notifyUser = (meta, text, kind) => engine.told.push({ text, kind });
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
  return engine;
}

/** What Claude Code gives when the usage limit stops a turn: its own answer saying so, then a failed result. */
function hitLimit(engine, meta, text = "You've hit your limit · resets 4pm (Europe/Budapest)") {
  const live = engine.lives.get(meta.id);
  engine.handle(meta, live, { type: "assistant", error: "rate_limit", parent_tool_use_id: null, uuid: "u1",
    message: { id: "m1", content: [{ type: "text", text }] } });
  engine.handle(meta, live, { type: "result", subtype: "success", is_error: true, result: text, total_cost_usd: 0.1 });
}

test("a limit is spotted, and when it ends is read from its text", () => {
  assert.ok(isLimitEnd({ sawLimit: true }));
  assert.ok(isLimitEnd({ error: "Claude AI usage limit reached|1731000000" }));
  assert.ok(isLimitEnd({ error: "You've hit your limit · resets 4pm" }));
  assert.ok(!isLimitEnd({ error: "API Error: 500 Internal server error" }));
  const now = new Date(2026, 10, 20, 13, 0).getTime();
  assert.equal(new Date(resetFromText("You've hit your limit · resets 4pm", now)).getHours(), 16);
  assert.equal(resetFromText("limit reached|1731000000", now), new Date(1731000000 * 1000).toISOString());
});

test("when it goes on: the text, else the account's refusal, else 30 minutes", () => {
  const now = Date.now();
  const refused = new Date(now + 2 * HOUR).toISOString();
  const r = pauseUntil({ text: "", limits: { rejectedUntil: refused }, now });
  assert.deepEqual(r, { until: new Date(Date.parse(refused) + SLACK_MS).toISOString(), known: true });
  const full = new Date(now + HOUR).toISOString();
  assert.equal(pauseUntil({ limits: { fiveHour: { utilization: 100, resetsAt: full } }, now }).known, true);
  const guess = pauseUntil({ text: "hit your limit", limits: {}, now });
  assert.deepEqual(guess, { until: new Date(now + FALLBACK_MS).toISOString(), known: false });
});

test("room again: only from a reading after the pause began, with no refusal and no full window", () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const ok = { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: { utilization: 40 }, rejectedUntil: null };
  assert.ok(limitRoom(ok, Date.now(), since));
  assert.ok(!limitRoom(ok, Date.now() - 120_000, since), "a reading from before the pause");
  assert.ok(!limitRoom({ ...ok, rejectedUntil: new Date(Date.now() + HOUR).toISOString() }, Date.now(), since));
  assert.ok(!limitRoom({ ...ok, fiveHour: { utilization: 100 } }, Date.now(), since));
  assert.ok(!limitRoom({ fiveHour: null, sevenDay: null }, Date.now(), since), "another account, not read yet");
});

test("the turn pauses: no failure, no error, the thread stays running and says until when", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  const ended = [];
  engine.onTurnEnded = (m, status) => ended.push(status);
  await engine.send("t1", { text: "Start the work" });
  const reset = Math.floor((Date.now() + 2 * HOUR) / 1000);
  hitLimit(engine, meta, `You've hit your limit|${reset}`);
  const t = store.thread("t1");
  assert.equal(t.status, "running");
  assert.equal(t.error, null);
  const s = engine.summary(t);
  assert.equal(s.limitPause?.until, new Date(reset * 1000 + SLACK_MS).toISOString(), "until the reset it says");
  assert.equal(s.limitPause.tries, 1);
  const entries = store.readTranscript("t1");
  assert.ok(entries.some((e) => e.type === "turn_end" && e.status === "paused"));
  assert.ok(entries.some((e) => e.subtype === "limit_pause" && /goes on by itself at/.test(e.text)));
  assert.ok(!entries.some((e) => e.type === "error"), "no error box");
  assert.ok(!entries.some((e) => e.type === "text" && /hit your limit/.test(e.text)), "no limit message");
  assert.deepEqual(ended, ["paused"]);
  assert.deepEqual(engine.told, [], "a pause of a few hours is not told");
  assert.equal((await engine.send("t1", { text: "and this" })).sent, "queued", "messages queue meanwhile");
  clearInterval(engine.limitTimer);
});

test("it goes on in the same session when its time comes; stopping at the limit again is the same pause", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  await engine.send("t1", { text: "Start the work" });
  hitLimit(engine, meta, "hit your limit");
  assert.equal((await engine.checkLimitPauses()).length, 0, "not yet");
  const until = Date.parse(store.thread("t1").limitPause.until);
  assert.deepEqual(await engine.checkLimitPauses({ now: until + 1 }), ["t1"]);
  const last = engine.pushed.at(-1).m.message.content;
  assert.ok(String(JSON.stringify(last)).includes("usage limit, which is over now"));
  assert.equal(store.readTranscript("t1").findLast((e) => e.type === "user").auto, "limit");
  assert.equal(store.thread("t1").limitPause, null);
  assert.equal(store.thread("t1").status, "running");
  hitLimit(engine, meta, "hit your limit");
  assert.equal(store.thread("t1").limitPause.tries, 2, "one more try of the same pause");
  clearInterval(engine.limitTimer);
});

test("another account with room: it goes on before the reset", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const account = { limits: {}, limitsAt: 0 };
  account.usage = async () => {
    account.limits = { fiveHour: { utilization: 3, resetsAt: null }, sevenDay: { utilization: 10 }, rejectedUntil: null };
    account.limitsAt = Date.now() + 1;
  };
  const engine = engineOn(store, account);
  engine.account = account;
  await engine.send("t1", { text: "Start the work" });
  hitLimit(engine, meta);
  assert.deepEqual(await engine.checkLimitPauses({ read: true, now: Date.now() + 2 }), ["t1"]);
  assert.equal(engine.pushed.at(-1).m.message.content.includes?.("usage limit") ?? true, true);
  assert.equal(store.thread("t1").limitPause, null);
  clearInterval(engine.limitTimer);
});

test("Stop ends the wait; a long pause is told once", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  await engine.send("t1", { text: "Start the work" });
  const far = Math.floor((Date.now() + 3 * 24 * HOUR) / 1000);
  hitLimit(engine, meta, `Claude AI usage limit reached|${far}`);
  assert.equal(engine.told.length, 1);
  assert.match(engine.told[0].text, /paused for the usage limit until/);
  const r = await engine.interrupt("t1");
  assert.equal(r.interrupted, true);
  const t = store.thread("t1");
  assert.equal(t.status, "interrupted");
  assert.equal(t.limitPause, null);
  assert.deepEqual(await engine.checkLimitPauses({ now: Date.now() + 4 * 24 * HOUR }), []);
});

test("a restart keeps the thread waiting, not picked up as a cut-off turn", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  await engine.send("t1", { text: "Start the work" });
  hitLimit(engine, meta);
  clearInterval(engine.limitTimer);
  store.saveIndexNow();
  const again = engineOn(store);
  await again.resumeAfterRestart();
  const t = store.thread("t1");
  assert.equal(t.status, "running");
  assert.ok(t.limitPause);
  assert.ok(!store.readTranscript("t1").some((e) => e.subtype === "restart"));
  assert.ok(again.limitTimer, "it watches the pause");
  clearInterval(again.limitTimer);
});

test("another failure still fails", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  await engine.send("t1", { text: "Start the work" });
  engine.handle(meta, engine.lives.get("t1"), { type: "result", subtype: "success", is_error: true,
    result: "API Error: 500 Internal server error" });
  assert.equal(store.thread("t1").status, "failed");
  assert.equal(store.thread("t1").limitPause ?? null, null);
});
