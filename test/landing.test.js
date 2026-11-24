// 0.15.5: landing a thread's own copy of a plugin: what went into the plugin since the copy was made goes to the thread
// first (landReview), the plugin's self-test runs in the copy (landCheck) and again on the landed plugin; after the
// thread's turn it lands by itself when that turn ended with Status: done. A fake hub and engine; a real self-test.
// Run: node test/landing.test.js
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPrompt, reviewPrompt, runSelfTest, ThreadPlugins } from "../backend/threadPlugins.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.stack || error.message}`);
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "threads-landing-"));

/** A copy folder with a manifest and (optionally) a self-test that passes or fails. */
function copyFolder(check) {
  const dir = mkdtempSync(path.join(tmp, "copy-"));
  writeFileSync(path.join(dir, "layr.json"), JSON.stringify({ id: "notes", name: "Notes", version: "1.2.0", ...(check ? { check: "check.mjs" } : {}) }));
  if (check) writeFileSync(path.join(dir, "check.mjs"), check === "pass" ? "console.log('fine')\n" : "console.error('sorting broke'); process.exit(1)\n");
  return dir;
}

function setup({ check = null, history = [], settings = {}, afterCheck = { ran: false } } = {}) {
  const calls = [];
  const sent = [];
  const folder = copyFolder(check);
  const since = new Date(Date.now() - 60_000).toISOString();
  let meta = { id: "t_1", plugins: [{ id: "notes", name: "Notes", mode: "change", folder, at: since,
    copy: { name: "w_1", branch: "work/w_1", base: "main", trying: false, since } }] };
  const hub = {
    available: false,
    settingsGet: async (id) => settings[id],
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "layr__plugin_worktrees") return { worktrees: [{ name: "w_1", ahead: 1, dirty: 0, conflicts: [] }] };
      if (tool === "layr__plugin_history") return { commits: history };
      if (tool === "layr__plugin_worktree_land") return { landed: true, commit: "abc", changes: 1 };
      if (tool === "layr__plugin_check") return afterCheck;
      throw new Error(`no ${tool}`);
    },
  };
  const store = { updateThread: (id, patch) => (meta = { ...meta, ...patch }) };
  const engine = {
    requireThread: () => meta,
    markRestart() {},
    emitThread() {},
    send: async (id, { text }) => sent.push(text),
  };
  const plugins = new ThreadPlugins({ engine, hub, store, dataDir: tmp });
  return { plugins, calls, sent, meta: () => meta, landed: () => calls.some(([t]) => t === "layr__plugin_worktree_land") };
}

const newer = (subject, ago = 10_000) => ({ sha: `s${subject.length}`, short: "1234567", subject, time: Date.now() - ago,
  thread: "t_other", files: [{ path: "panels/main.js", status: "M" }] });

await test("nothing went in meanwhile, no self-test: it lands at once", async () => {
  const s = setup();
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].landed, true);
  assert.equal(r[0].version, "1.2.0");
  assert.equal(s.sent.length, 0);
});

await test("changes went in meanwhile: the thread checks them first; it lands by itself after a turn that ends done", async () => {
  const s = setup({ history: [newer("Rename sortBy to orderBy"), newer("Older, before the copy", 10 * 60_000)] });
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].review, true);
  assert.equal(r[0].commits, 1, "only what went in after the copy was made");
  assert.equal(s.landed(), false, "nothing landed yet");
  assert.match(s.sent[0], /Rename sortBy to orderBy/);
  assert.match(s.sent[0], /plugin_diff/);
  assert.match(s.sent[0], /lands your copy by itself/);
  const row = s.meta().plugins[0];
  assert.equal(row.copy.landAfter.why, "review");
  assert.equal(row.copy.landAfter.auto, true);
  // The turn ends done: it lands now, without asking again about the same changes.
  const out = await s.plugins.afterLandTurn(s.meta(), "Checked: nothing contradicts.\n\nStatus: done · Risk: none · Try: ready");
  assert.equal(out.results[0].landed, true);
  assert.equal(s.sent.length, 1, "not asked twice");
});

await test("the turn that checked asks the person: it doesn't land", async () => {
  const s = setup({ history: [newer("Remove the export")] });
  await s.plugins.land(s.meta(), null, { reopen: false });
  const out = await s.plugins.afterLandTurn(s.meta(), "It removes what I use.\n\nStatus: asks · Risk: breaking · Try: none");
  assert.deepEqual(out.waits, ["notes"]);
  assert.equal(s.landed(), false);
  assert.equal(s.meta().plugins[0].copy.landAfter, undefined, "Land is offered again");
});

await test("the pipeline lands it itself after the check (afterTurn false)", async () => {
  const s = setup({ history: [newer("Something new")] });
  await s.plugins.land(s.meta(), null, { reopen: false, afterTurn: false });
  assert.match(s.sent[0], /the pipeline lands your copy/);
  assert.equal(await s.plugins.afterLandTurn(s.meta(), "Status: done"), null, "Threads doesn't land it");
  const r = await s.plugins.land(s.meta(), null, { reopen: false, afterTurn: false });
  assert.equal(r[0].landed, true, "the pipeline's second Land lands");
});

await test("landReview off: it lands without the check", async () => {
  const s = setup({ history: [newer("Something new")], settings: { landReview: false } });
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].landed, true);
  assert.equal(s.sent.length, 0);
});

await test("the self-test fails in the copy: the thread fixes it; landCheck off skips it", async () => {
  const s = setup({ check: "fail" });
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].checkFailed, true);
  assert.match(r[0].output, /sorting broke/);
  assert.match(s.sent[0], /self-test of Notes/);
  assert.equal(s.landed(), false);
  const off = setup({ check: "fail", settings: { landCheck: false } });
  assert.equal((await off.plugins.land(off.meta(), null, { reopen: false }))[0].landed, true);
});

await test("the self-test passes in the copy but fails on the landed plugin: landed, and said", async () => {
  const s = setup({ check: "pass", afterCheck: { ran: true, ok: false, output: "merged: orderBy is not defined" } });
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].landed, true);
  assert.equal(r[0].afterCheck.ok, false);
  assert.match(s.meta().pluginsNote ?? "", /orderBy is not defined/);
});

await test("after three rounds it stops instead of asking again", async () => {
  const s = setup({ history: [newer("Keeps changing")] });
  for (let i = 0; i < 3; i++) {
    const row = s.meta().plugins[0];
    // Something new each round.
    s.meta().plugins[0] = { ...row, copy: { ...row.copy, reviewedAt: new Date(Date.now() - 60_000).toISOString() } };
    await s.plugins.land(s.meta(), null, { reopen: false });
  }
  const row = s.meta().plugins[0];
  s.meta().plugins[0] = { ...row, copy: { ...row.copy, reviewedAt: new Date(Date.now() - 60_000).toISOString() } };
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].stuck, true);
});

// 0.15.6: what the review of task #186 showed.
await test("this copy's own earlier landing doesn't count as changed meanwhile", async () => {
  const s = setup({ history: [{ ...newer("Land w_1"), thread: null }] });
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].landed, true);
  assert.equal(s.sent.length, 0, "no review of its own landing");
});

await test("a copy that is gone (it landed while Threads restarted): landed already, nothing asked", async () => {
  const s = setup({ history: [{ ...newer("Land w_1"), thread: null, sha: "f00d" }, newer("Other change")] });
  const call = s.plugins.hub.call.bind(s.plugins.hub);
  s.plugins.hub.call = async (tool, args) => (tool === "layr__plugin_worktrees" ? { worktrees: [] } : call(tool, args));
  const r = await s.plugins.land(s.meta(), null, { reopen: false });
  assert.equal(r[0].landed, true);
  assert.equal(r[0].already, true);
  assert.equal(r[0].commit, "f00d");
  assert.equal(s.landed(), false, "nothing landed again");
  assert.equal(s.sent.length, 0, "no review");
  assert.equal(s.meta().plugins[0].copy, null, "the row follows: no copy");
  assert.equal(s.meta().plugins[0].landed.commit, "f00d");
});

await test("the prompts and the self-test runner", async () => {
  const p = reviewPrompt({ id: "notes", name: "Notes" }, [newer("A"), newer("B")]);
  assert.match(p, /2 changes went in/);
  assert.match(p, /Status: done/);
  assert.match(checkPrompt({ id: "notes", name: "Notes" }, "check.mjs", "boom"), /boom/);
  assert.deepEqual((await runSelfTest(copyFolder(null), "check.mjs")).ran, false, "no check file: nothing ran");
  assert.equal((await runSelfTest(copyFolder("pass"), "check.mjs")).ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
