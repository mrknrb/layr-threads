// Unit tests without Claude: Claude Code stopping at once because its global config (`~/.claude.json`) couldn't be
// read (left empty by another Claude Code). The thread keeps its session, waits and tries its turn again, then fails
// with Try again; `ask` asks again; the setting repairConfig puts the newest backup back. Run: node test/config.test.js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { Engine, sessionFile } = await import("../backend/engine.js");
const { Store } = await import("../backend/store.js");
const { AsyncQueue, nowIso } = await import("../backend/util.js");
const { isConfigBroken, newestBackup, repairEmptyConfig, restoreHint } = await import("../backend/claudeConfig.js");
const { ask } = await import("../backend/ask.js");

const BROKEN = "Configuration error in C:\\Users\\me\\.claude.json: JSON Parse error: Unexpected EOF\n" +
  "A backup file exists at: C:\\Users\\me\\.claude\\backups\\.claude.json.backup.1794967581521";
const hub = { available: false, emit() {}, notify() {}, settingsGet: async () => true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newStore() {
  return new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-config-")));
}

function thread(store, id, o = {}) {
  const meta = store.createThread({
    id, projectId: "_", title: id, kind: "thread", cwd: os.tmpdir(), workspace: { kind: "folder" },
    permissionMode: "default", sessionId: "s-real", sessionStarted: true, queue: [], queuePaused: false,
    pendingApprovals: [], todos: [], status: "done", turns: 1, lastActivity: nowIso(), ...o,
  });
  return meta;
}

/** An engine whose queries are fakes: `opened` lists openLive's calls, `pushed` the messages sent to Claude. */
function engineOn(store, config = {}) {
  const engine = new Engine({
    store, hub, account: { listModels: async () => [] },
    config: { retryMs: [20, 20], empty: () => true, hint: async () => ({ configPath: "C:\\me\\.claude.json",
      backup: "C:\\me\\.claude\\backups\\.claude.json.backup.1", command: "Copy-Item backup config" }),
    repairOn: async () => false, repair: async () => ({ repaired: false, why: "off" }), ...config },
  });
  engine.notificationsOn = async () => false;
  engine.opened = [];
  engine.pushed = [];
  engine.openLive = async (meta, opts = {}) => {
    engine.opened.push({ id: meta.id, sessionId: meta.sessionId, ...opts });
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

/** What a Claude Code that couldn't read its config gives: a result with a session id of its own, no init. */
function brokenResult() {
  return { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s-new-random",
    errors: [BROKEN] };
}

test("the error is recognised", () => {
  assert.ok(isConfigBroken(BROKEN));
  assert.ok(isConfigBroken("Claude configuration file at C:\\x\\.claude.json is corrupted: JSON Parse error"));
  assert.ok(!isConfigBroken("No conversation found with session ID: x"));
  assert.ok(!isConfigBroken(undefined));
});

test("a session id is taken only from Claude Code's init, never from a failure before it", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store, { retryMs: [60_000] });
  await engine.send("t1", { text: "Start the work" });
  const live = engine.lives.get("t1");
  engine.handle(meta, live, brokenResult());
  assert.equal(store.thread("t1").sessionId, "s-real", "the thread's session stays");
  engine.cancelConfigRetry("t1");

  const store2 = newStore();
  const meta2 = thread(store2, "t2");
  const engine2 = engineOn(store2);
  await engine2.send("t2", { text: "go on" });
  const live2 = engine2.lives.get("t2");
  live2.query.supportedModels = async () => [];
  engine2.handle(meta2, live2, { type: "system", subtype: "init", session_id: "s-forked", model: "m", mcp_servers: [] });
  assert.equal(store2.thread("t2").sessionId, "s-forked");
  assert.deepEqual(store2.thread("t2").earlierSessions, ["s-real"], "the one before is kept");
});

test("the turn waits and is sent again in the same session; an init ends the tries", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store);
  await engine.send("t1", { text: "Start the work" });
  engine.handle(meta, engine.lives.get("t1"), brokenResult());
  let t = store.thread("t1");
  assert.equal(t.status, "starting", "waits, not failed");
  assert.equal(t.configTries, 1);
  assert.ok(engine.summary(t).retrying);
  assert.ok(!engine.lives.has("t1"), "the failed Claude Code is closed");
  const entries = store.readTranscript("t1");
  assert.ok(entries.some((e) => e.type === "turn_end" && e.subtype === "config_unreadable"));
  assert.ok(entries.some((e) => e.subtype === "config_retry" && /Trying again in 0 s \(1 of 2\)/.test(e.text)));

  // A message sent meanwhile waits in the queue.
  const queued = await engine.send("t1", { text: "and this too" });
  assert.equal(queued.sent, "queued");

  await sleep(60);
  assert.equal(engine.opened.length, 2);
  assert.equal(engine.opened[1].sessionId, "s-real", "resumes the same session");
  assert.equal(engine.pushed[1].m.message.content, "Start the work", "the same message again");
  assert.equal(store.readTranscript("t1").filter((e) => e.type === "user").length, 1, "not written twice");
  t = store.thread("t1");
  assert.equal(t.status, "running");
  assert.equal(t.configRetry, null);
  const live = engine.lives.get("t1");
  live.query.supportedModels = async () => [];
  engine.handle(t, live, { type: "system", subtype: "init", session_id: "s-real", model: "m", mcp_servers: [] });
  assert.equal(store.thread("t1").configTries, 0, "started: the tries count again from 0");
});

test("after the last try the thread fails, says how to fix the file, and Try again sends the message again", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store, { retryMs: [] });
  const ended = [];
  engine.onTurnEnded = (m, status) => ended.push(status);
  await engine.send("t1", { text: "Start the work" });
  engine.handle(meta, engine.lives.get("t1"), brokenResult());
  await sleep(10);
  const t = store.thread("t1");
  assert.equal(t.status, "failed");
  assert.match(t.error, /couldn't read ~\/\.claude\.json/);
  assert.deepEqual(ended, ["failed"]);
  const box = store.readTranscript("t1").findLast((e) => e.type === "error");
  assert.equal(box.retry, true);
  assert.match(box.message, /C:\\me\\.claude\.json \(it is empty\)/);
  assert.match(box.message, /Copy-Item backup config/);
  assert.match(box.message, /Repair an empty ~\/\.claude\.json/);

  await engine.retry("t1");
  assert.equal(engine.opened.length, 2);
  assert.equal(engine.pushed[1].m.message.content, "Start the work");
  assert.equal(store.thread("t1").status, "running");
  await assert.rejects(engine.retry("t1"), /running/);
});

test("Stop while it waits: no more tries", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  const engine = engineOn(store, { retryMs: [30] });
  await engine.send("t1", { text: "Start the work" });
  engine.handle(meta, engine.lives.get("t1"), brokenResult());
  const r = await engine.interrupt("t1");
  assert.equal(r.interrupted, true);
  await sleep(60);
  assert.equal(engine.opened.length, 1, "not tried again");
  assert.equal(store.thread("t1").status, "interrupted");
});

test("with the setting on, an empty config is repaired before the try", async () => {
  const store = newStore();
  const meta = thread(store, "t1");
  let repairs = 0;
  const engine = engineOn(store, {
    retryMs: [10],
    repairOn: async () => true,
    repair: async () => (repairs++, { repaired: true, backup: "B1" }),
  });
  await engine.send("t1", { text: "Start the work" });
  engine.handle(meta, engine.lives.get("t1"), brokenResult());
  await sleep(50);
  assert.equal(repairs, 1);
  assert.ok(store.readTranscript("t1").some((e) => e.subtype === "config_repaired" && /B1/.test(e.text)));
  assert.equal(engine.opened.length, 2);
});

test("a try waiting when the backend stopped goes on waiting after the start", async () => {
  const store = newStore();
  thread(store, "t1", { status: "starting", configTries: 1, configRetry: { text: "Start the work", images: [], at: nowIso() } });
  store.saveIndexNow();
  const engine = engineOn(store, { retryMs: [10] });
  assert.equal(store.thread("t1").status, "starting");
  await engine.resumeAfterRestart();
  await sleep(40);
  assert.equal(engine.opened.length, 1);
  assert.equal(engine.pushed[0].m.message.content, "Start the work", "its own message, not a restart note");
});

test("a gone session: an earlier one still on disk is resumed instead of starting over", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "layr-claude-home-"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const store = newStore();
    const meta = thread(store, "t1", { sessionId: "s-wrong", earlierSessions: ["s-real"] });
    const file = sessionFile(meta.cwd, "s-real");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    assert.match(file, /projects[\\/][A-Za-z0-9-]+[\\/]s-real\.jsonl$/);
    const engine = engineOn(store);
    await engine.send("t1", { text: "what happened?" });
    const live = engine.lives.get("t1");
    await engine.restartFresh(meta, live);
    assert.equal(store.thread("t1").sessionId, "s-real");
    assert.equal(engine.opened[1].fresh, undefined, "resumed, not fresh");
    assert.equal(engine.pushed[1].m.message.content, "what happened?");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("ask asks again when Claude Code couldn't read its config, not for other errors", async () => {
  let calls = 0;
  let repairs = 0;
  const query = () => {
    calls++;
    const n = calls;
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        if (n === 1) yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [BROKEN] };
        else yield { type: "result", subtype: "success", result: "fine" };
      },
    };
  };
  const r = await ask({ prompt: "hi" }, { query, retryMs: [5, 5], beforeRetry: () => repairs++ });
  assert.equal(r.text, "fine");
  assert.equal(calls, 2);
  assert.equal(repairs, 1);

  let other = 0;
  const failing = () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      other++;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded"] };
    },
  });
  await assert.rejects(ask({ prompt: "hi" }, { query: failing, retryMs: [5] }), /overloaded/);
  assert.equal(other, 1);
});

// ------------------------------------------------------------------ the repair

function configHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layr-claude-json-"));
  const configPath = path.join(dir, ".claude.json");
  const backups = path.join(dir, "backups");
  mkdirSync(backups);
  return { dir, configPath, backups };
}

function backup(h, at, text) {
  const file = path.join(h.backups, `.claude.json.backup.${at}`);
  writeFileSync(file, text);
  return file;
}

function emptyFor(file, ms) {
  writeFileSync(file, "");
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
}

test("repair: an empty config is put back from the newest valid backup", async () => {
  const h = configHome();
  backup(h, Date.now() - 60_000, '{"old":true}');
  const good = backup(h, Date.now() - 30_000, '{"numStartups":5}');
  backup(h, Date.now() - 10_000, ""); // newest is empty itself: skipped
  emptyFor(h.configPath, 60_000);
  assert.equal((await newestBackup({ configPath: h.configPath, dir: h.backups })).file, good);
  const r = await repairEmptyConfig({ configPath: h.configPath, dir: h.backups });
  assert.equal(r.repaired, true, r.why);
  assert.equal(r.backup, good);
  assert.equal(readFileSync(h.configPath, "utf8"), '{"numStartups":5}');
  const hint = await restoreHint({ configPath: h.configPath, dir: h.backups });
  assert.ok(hint.command.includes(good) && hint.command.includes(h.configPath));
});

test("repair: never when the file has content, was emptied just now, the backup is old, or the lock is held", async () => {
  const h = configHome();
  backup(h, Date.now() - 30_000, '{"a":1}');
  writeFileSync(h.configPath, '{"live":true}');
  assert.equal((await repairEmptyConfig({ configPath: h.configPath, dir: h.backups })).repaired, false);
  assert.equal(readFileSync(h.configPath, "utf8"), '{"live":true}');

  emptyFor(h.configPath, 1_000);
  assert.match((await repairEmptyConfig({ configPath: h.configPath, dir: h.backups })).why, /just now/);

  emptyFor(h.configPath, 60_000);
  const old = await repairEmptyConfig({ configPath: h.configPath, dir: h.backups, maxAgeMs: 10_000 });
  assert.match(old.why, /no usable backup/);

  mkdirSync(`${h.configPath}.lock`); // Claude Code is writing it (a fresh lock)
  const locked = await repairEmptyConfig({ configPath: h.configPath, dir: h.backups, lockTimeoutMs: 600 });
  assert.equal(locked.repaired, false);
  assert.equal(readFileSync(h.configPath, "utf8"), "");
});
